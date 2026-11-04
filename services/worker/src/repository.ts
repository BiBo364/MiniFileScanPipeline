import type { Pool } from 'pg';
import type { ScanResult } from './scanner';

export type ClaimedScan = {
  id: string;
  sha256: string;
  stored_path: string;
  original_filename: string;
};

type ScanState = ClaimedScan & { status: string };

export async function claimQueuedScan(
  pool: Pool,
  scanId: string,
  messageSha256: string,
  redelivered: boolean,
): Promise<ClaimedScan | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<ScanState>(
      `
        SELECT id, sha256, stored_path, original_filename, status
        FROM scans
        WHERE id = $1 AND sha256 = $2
        FOR UPDATE
      `,
      [scanId, messageSha256],
    );
    const scan = result.rows[0];
    if (!scan || (scan.status !== 'Queued' && !(redelivered && scan.status === 'Scanning'))) {
      await client.query('COMMIT');
      return null;
    }

    await client.query("UPDATE scans SET status = 'Scanning', updated_at = NOW() WHERE id = $1", [scanId]);
    await client.query('COMMIT');
    return scan;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveScanResult(
  pool: Pool,
  scanId: string,
  result: ScanResult,
): Promise<void> {
  await pool.query(
    `
      UPDATE scans
      SET status = $2, result_details = $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND status = 'Scanning'
    `,
    [scanId, result.status, JSON.stringify(result.details)],
  );
}

export async function releaseScanClaim(pool: Pool, scanId: string): Promise<void> {
  await pool.query(
    `
      UPDATE scans
      SET status = 'Queued', updated_at = NOW()
      WHERE id = $1 AND status = 'Scanning'
    `,
    [scanId],
  );
}

export async function markScanFailed(pool: Pool, scanId: string, reason: string): Promise<void> {
  await pool.query(
    `
      UPDATE scans
      SET status = 'Failed', result_details = $2::jsonb, updated_at = NOW()
      WHERE id = $1 AND status IN ('Queued', 'Scanning')
    `,
    [scanId, JSON.stringify({ reason })],
  );
}
