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
  owner_id: string | null;
};

export async function insertQueuedScan(
  pool: Pool,
  input: {
    id: string;
    sha256: string;
    storedPath: string;
    originalFilename: string;
    ownerId: string;
  },
): Promise<{ scan: ScanRow; inserted: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<ScanRow>(
      `
        INSERT INTO scans (id, sha256, stored_path, original_filename, status, owner_id)
        VALUES ($1, $2, $3, $4, 'Queued', $5)
        ON CONFLICT (owner_id, sha256) DO NOTHING
        RETURNING *
      `,
      [input.id, input.sha256, input.storedPath, input.originalFilename, input.ownerId],
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

    const existing = await client.query<ScanRow>(
      'SELECT * FROM scans WHERE owner_id = $1 AND sha256 = $2',
      [input.ownerId, input.sha256],
    );
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

export async function getScanById(
  pool: Pool,
  id: string,
  ownerId: string,
): Promise<ScanRow | null> {
  const result = await pool.query<ScanRow>('SELECT * FROM scans WHERE id = $1 AND owner_id = $2', [
    id,
    ownerId,
  ]);
  return result.rows[0] ?? null;
}

export async function getRecentScans(pool: Pool, ownerId: string): Promise<ScanRow[]> {
  const result = await pool.query<ScanRow>(
    `SELECT * FROM scans
     WHERE owner_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [ownerId],
  );
  return result.rows;
}
