import type { Pool } from 'pg';
import { scanJobMessageSchema } from '@mini-scan/shared';
import type { RabbitMqPublisher } from './rabbitmq';

type OutboxRow = {
  id: string;
  scan_id: string;
  payload: unknown;
};

export class OutboxDispatchError extends Error {
  constructor(
    public readonly scanId: string,
    options: ErrorOptions,
  ) {
    super('Failed to publish outbox event', options);
    this.name = 'OutboxDispatchError';
  }
}

export async function publishNextOutboxEvent(
  pool: Pool,
  rabbit: RabbitMqPublisher,
): Promise<string | null> {
  const client = await pool.connect();
  let scanId = 'outbox';
  try {
    await client.query('BEGIN');
    const result = await client.query<OutboxRow>(
      `
        SELECT id, scan_id, payload
        FROM scan_outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `,
    );
    const event = result.rows[0];
    if (!event) {
      await client.query('COMMIT');
      return null;
    }

    scanId = event.scan_id;
    const message = scanJobMessageSchema.parse(event.payload);
    await rabbit.publishScanJob(message);
    await client.query(
      'UPDATE scan_outbox SET published_at = NOW() WHERE id = $1 AND published_at IS NULL',
      [event.id],
    );
    await client.query('COMMIT');
    return scanId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw new OutboxDispatchError(scanId, { cause: error });
  } finally {
    client.release();
  }
}

export function startOutboxDispatcher(deps: {
  pool: Pool;
  rabbit: RabbitMqPublisher;
  pollIntervalMs: number;
  onPublished: (scanId: string) => void;
  onError: (scanId: string, error: unknown) => void;
}): { stop: () => Promise<void> } {
  let stopping = false;
  let wakeDelay: (() => void) | undefined;

  const run = async (): Promise<void> => {
    while (!stopping) {
      try {
        const scanId = await publishNextOutboxEvent(deps.pool, deps.rabbit);
        if (scanId) {
          deps.onPublished(scanId);
          continue;
        }
      } catch (error) {
        const scanId = error instanceof OutboxDispatchError ? error.scanId : 'outbox';
        deps.onError(scanId, error);
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deps.pollIntervalMs);
        wakeDelay = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeDelay = undefined;
    }
  };

  const loop = run();
  return {
    async stop(): Promise<void> {
      stopping = true;
      wakeDelay?.();
      await loop;
    },
  };
}
