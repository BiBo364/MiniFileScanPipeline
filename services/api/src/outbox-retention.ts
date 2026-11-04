import type { Pool } from 'pg';

export const OUTBOX_CLEANUP_BATCH_SIZE = 500;

export async function prunePublishedOutboxEvents(
  pool: Pool,
  retentionDays: number,
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `
      DELETE FROM scan_outbox
      WHERE id IN (
        SELECT id
        FROM scan_outbox
        WHERE published_at IS NOT NULL
          AND published_at < NOW() - ($1 * INTERVAL '1 day')
        ORDER BY published_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `,
    [retentionDays, OUTBOX_CLEANUP_BATCH_SIZE],
  );

  return result.rowCount ?? result.rows.length;
}
