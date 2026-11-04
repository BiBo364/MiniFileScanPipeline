import type { Pool, PoolClient } from 'pg';
import type { RabbitMqPublisher } from '../../services/api/src/rabbitmq';
import { publishNextOutboxEvent } from '../../services/api/src/outbox';

const event = {
  id: '48df7819-f4cc-4588-a91d-1bdc4a09ac9b',
  scan_id: 'd69ba071-b0c9-4dd7-9fb6-269c4a369f03',
  payload: {
    scanId: 'd69ba071-b0c9-4dd7-9fb6-269c4a369f03',
    sha256: 'c'.repeat(64),
    filePath: '/data/uploads/scan.bin',
  },
};

function dependencies() {
  const query = jest.fn(async (sql: string) => ({
    rows: sql.includes('SELECT id') ? [event] : [],
  }));
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  const publishScanJob = jest.fn().mockResolvedValue(undefined);
  const rabbit = { publishScanJob } as unknown as RabbitMqPublisher;
  return { pool, query, client, rabbit, publishScanJob };
}

describe('outbox dispatcher', () => {
  it('publishes with broker confirmation before marking the event published', async () => {
    const { pool, query, rabbit, publishScanJob } = dependencies();

    await expect(publishNextOutboxEvent(pool, rabbit)).resolves.toBe(event.scan_id);

    expect(publishScanJob).toHaveBeenCalledWith(event.payload);
    expect(query.mock.calls.map(([statement]) => statement.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'UPDATE',
      'COMMIT',
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[2]?.[0]).toContain('published_at = NOW()');
  });

  it('leaves the event pending when RabbitMQ does not confirm it', async () => {
    const { pool, query, rabbit, publishScanJob } = dependencies();
    publishScanJob.mockRejectedValue(new Error('broker unavailable'));

    await expect(publishNextOutboxEvent(pool, rabbit)).rejects.toMatchObject({
      name: 'OutboxDispatchError',
      scanId: event.scan_id,
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query.mock.calls.some(([statement]) => statement.includes('published_at = NOW()'))).toBe(
      false,
    );
  });
});
