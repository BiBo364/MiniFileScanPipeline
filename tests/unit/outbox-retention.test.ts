import type { Pool } from 'pg';
import {
  OUTBOX_CLEANUP_BATCH_SIZE,
  prunePublishedOutboxEvents,
} from '../../services/api/src/outbox-retention';

describe('prunePublishedOutboxEvents', () => {
  it('deletes only published events older than the configured retention, in bounded batches', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 17, rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(prunePublishedOutboxEvents(pool, 30)).resolves.toBe(17);

    expect(query.mock.calls[0]?.[0]).toContain('published_at IS NOT NULL');
    expect(query.mock.calls[0]?.[0]).toContain("published_at < NOW() - ($1 * INTERVAL '1 day')");
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT $2');
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[0]?.[1]).toEqual([30, OUTBOX_CLEANUP_BATCH_SIZE]);
  });

  it('uses returned rows when the database driver omits rowCount', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: null, rows: [{ id: 'a' }, { id: 'b' }] });
    const pool = { query } as unknown as Pool;

    await expect(prunePublishedOutboxEvents(pool, 7)).resolves.toBe(2);
  });
});
