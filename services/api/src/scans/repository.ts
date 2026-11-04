import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ScanJobMessage, ScanStatus } from '@mini-scan/shared';

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
): Promise<{ scan: ScanRow; inserted: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<ScanRow>(
      `
        INSERT INTO scans (id, sha256, stored_path, original_filename, status)
        VALUES ($1, $2, $3, $4, 'Queued')
        ON CONFLICT (sha256) DO NOTHING
        RETURNING *
      `,
      [input.id, input.sha256, input.storedPath, input.originalFilename],
    );

    const insertedRow = result.rows[0];
    if (insertedRow) {
      const message: ScanJobMessage = {
        scanId: insertedRow.id,
        sha256: insertedRow.sha256,
        filePath: insertedRow.stored_path,
      };
      await client.query(
        `
          INSERT INTO scan_outbox (id, scan_id, event_type, payload)
          VALUES ($1, $2, 'scan.queued', $3::jsonb)
        `,
        [randomUUID(), insertedRow.id, JSON.stringify(message)],
      );
      await client.query('COMMIT');
      return { scan: insertedRow, inserted: true };
    }

    const existing = await client.query<ScanRow>('SELECT * FROM scans WHERE sha256 = $1', [
      input.sha256,
    ]);
    const row = existing.rows[0];
    if (!row) {
      throw new Error('Conflicting scan hash was not found after insert');
    }
    await client.query('COMMIT');
    return { scan: row, inserted: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getScanById(pool: Pool, id: string): Promise<ScanRow | null> {
  const result = await pool.query<ScanRow>('SELECT * FROM scans WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}
