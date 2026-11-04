import type { Pool } from 'pg';
import type { ScanResult } from './scanner';

export type ClaimedScan = {
  id: string;
  sha256: string;
  stored_path: string;
  original_filename: string;
};

export async function claimQueuedScan(
  pool: Pool,
  scanId: string,
  messageSha256: string,
): Promise<ClaimedScan | null> {
  const result = await pool.query<ClaimedScan>(
    `
      UPDATE scans
      SET status = 'Scanning', updated_at = NOW()
      WHERE id = $1 AND sha256 = $2 AND status = 'Queued'
      RETURNING id, sha256, stored_path, original_filename
    `,
    [scanId, messageSha256],
  );

  return result.rows[0] ?? null;
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
