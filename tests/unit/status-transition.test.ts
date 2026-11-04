import type { Pool, PoolClient } from 'pg';
import {
  claimQueuedScan,
  markScanFailed,
  releaseScanClaim,
  saveScanResult,
} from '../../services/worker/src/repository';

const queuedScan = {
  id: 'e4a3204b-5743-4dd3-9cec-1841cbf04e88',
  sha256: 'a'.repeat(64),
  stored_path: '/tmp/scan.bin',
  original_filename: 'scan.bin',
};

function poolWithStatus(status: string | undefined) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT id')) {
      return { rows: status ? [{ ...queuedScan, status }] : [] };
    }
    return { rows: [] };
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, query };
}

describe('scan status transitions', () => {
  it('moves Queued to Scanning within a row-locking transaction', async () => {
    const { pool, query } = poolWithStatus('Queued');

    await expect(claimQueuedScan(pool, queuedScan.id, queuedScan.sha256, false)).resolves.toEqual(
      queuedScan,
    );

    expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'UPDATE',
      'COMMIT',
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE');
  });

  it('does not claim an already Scanning job from a duplicate delivery', async () => {
    const { pool, query } = poolWithStatus('Scanning');

    await expect(
      claimQueuedScan(pool, queuedScan.id, queuedScan.sha256, false),
    ).resolves.toBeNull();

    expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'COMMIT',
    ]);
  });

  it('allows a broker redelivery to recover a job left Scanning by a worker crash', async () => {
    const { pool } = poolWithStatus('Scanning');

    await expect(claimQueuedScan(pool, queuedScan.id, queuedScan.sha256, true)).resolves.toEqual(
      queuedScan,
    );
  });

  it('does not move a terminal status back into Scanning', async () => {
    const { pool, query } = poolWithStatus('Clean');

    await expect(claimQueuedScan(pool, queuedScan.id, queuedScan.sha256, true)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('persists a clean or malicious result only from Scanning', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as Pool;
    const result = {
      status: 'Malicious' as const,
      details: { reasons: ['known_bad_hash'], sizeBytes: 4, sha256: 'b'.repeat(64) },
    };

    await saveScanResult(pool, queuedScan.id, result);

    expect(query.mock.calls[0]?.[0]).toContain("WHERE id = $1 AND status = 'Scanning'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      queuedScan.id,
      'Malicious',
      JSON.stringify(result.details),
    ]);
  });

  it('returns a failed scan to Queued before another attempt', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as Pool;

    await releaseScanClaim(pool, queuedScan.id);

    expect(query.mock.calls[0]?.[0]).toContain("SET status = 'Queued'");
    expect(query.mock.calls[0]?.[0]).toContain("WHERE id = $1 AND status = 'Scanning'");
  });

  it('marks exhausted queued or scanning work as Failed with a reason', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as Pool;

    await markScanFailed(pool, queuedScan.id, 'retry_limit_exceeded');

    expect(query.mock.calls[0]?.[0]).toContain("SET status = 'Failed'");
    expect(query.mock.calls[0]?.[0]).toContain("status IN ('Queued', 'Scanning')");
    expect(query.mock.calls[0]?.[1]).toEqual([
      queuedScan.id,
      JSON.stringify({ reason: 'retry_limit_exceeded' }),
    ]);
  });
});
