import type { Pool, PoolClient } from 'pg';
import { insertQueuedScan } from '../../services/api/src/scans/repository';

const scan = {
  id: 'd69ba071-b0c9-4dd7-9fb6-269c4a369f03',
  sha256: 'c'.repeat(64),
  stored_path: '/data/uploads/scan.bin',
  original_filename: 'scan.bin',
  status: 'Queued' as const,
  result_details: null,
  created_at: new Date('2026-11-04T00:00:00Z'),
  updated_at: new Date('2026-11-04T00:00:00Z'),
};

function fakePool(options: { inserted?: boolean; outboxError?: Error } = {}) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    void _params;
    if (sql.includes('INSERT INTO scans')) {
      return { rows: options.inserted === false ? [] : [scan] };
    }
    if (sql.includes('SELECT * FROM scans')) return { rows: [scan] };
    if (sql.includes('INSERT INTO scan_outbox') && options.outboxError) {
      throw options.outboxError;
    }
    return { rows: [] };
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, query, client };
}

describe('insertQueuedScan outbox transaction', () => {
  const input = {
    id: scan.id,
    sha256: scan.sha256,
    storedPath: scan.stored_path,
    originalFilename: scan.original_filename,
  };

  it('commits the scan and its message in the same transaction', async () => {
    const { pool, query } = fakePool();

    await expect(insertQueuedScan(pool, input)).resolves.toEqual({ scan, inserted: true });

    const sql = query.mock.calls.map(([statement]) => statement.trim().split(/\s+/)[0]);
    expect(sql).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
    expect(query.mock.calls[2]?.[0]).toContain('INSERT INTO scan_outbox');
    expect(JSON.parse(query.mock.calls[2]?.[1]?.[2] as string)).toEqual({
      scanId: scan.id,
      sha256: scan.sha256,
      filePath: scan.stored_path,
    });
  });

  it('reuses a duplicate hash without creating another outbox event', async () => {
    const { pool, query } = fakePool({ inserted: false });

    await expect(insertQueuedScan(pool, input)).resolves.toEqual({ scan, inserted: false });

    expect(query.mock.calls.map(([statement]) => statement.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'INSERT',
      'SELECT',
      'COMMIT',
    ]);
  });

  it('rolls the scan insert back if writing the outbox event fails', async () => {
    const { pool, query } = fakePool({ outboxError: new Error('outbox insert failed') });

    await expect(insertQueuedScan(pool, input)).rejects.toThrow('outbox insert failed');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
