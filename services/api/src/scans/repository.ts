import type { Pool } from 'pg';
import type { ScanStatus } from '@mini-scan/shared';

export type ScanRow = {
  id: string;
  sha256: string;
  stored_path: string;
  original_filename: string;
  status: ScanStatus;
  result_details: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

export async function insertQueuedScan(
  pool: Pool,
  input: {
    id: string;
    sha256: string;
    storedPath: string;
    originalFilename: string;
  },
): Promise<ScanRow> {
  const result = await pool.query<ScanRow>(
    `
      INSERT INTO scans (id, sha256, stored_path, original_filename, status)
      VALUES ($1, $2, $3, $4, 'Queued')
      RETURNING *
    `,
    [input.id, input.sha256, input.storedPath, input.originalFilename],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Insert returned no scan row');
  }
  return row;
}

export async function getScanById(pool: Pool, id: string): Promise<ScanRow | null> {
  const result = await pool.query<ScanRow>('SELECT * FROM scans WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}
