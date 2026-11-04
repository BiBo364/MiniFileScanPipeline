import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { QUEUE_NAMES } from '@mini-scan/shared';
import type { ScanJobMessage } from '@mini-scan/shared';

export type RabbitMqPublisher = {
  ping: () => Promise<void>;
  publishScanJob: (message: ScanJobMessage) => Promise<void>;
  close: () => Promise<void>;
};

type ActiveChannel = { connection: ChannelModel; channel: ConfirmChannel };

export async function connectRabbitMq(url: string): Promise<RabbitMqPublisher> {
  let active: ActiveChannel | undefined;
  let opening: Promise<void> | undefined;
  let closed = false;

  const invalidate = (connection: ChannelModel): void => {
    if (active?.connection !== connection) return;
    active = undefined;
    void connection.close().catch(() => undefined);
  };

  const ensureChannel = async (): Promise<ActiveChannel> => {
    if (closed) throw new Error('RabbitMQ publisher is closed');
    if (active) return active;

    if (!opening) {
      opening = (async () => {
        const connection = await amqp.connect(url);
        connection.on('error', () => undefined);
        const channel = await connection.createConfirmChannel();
        channel.on('error', () => undefined);
        await channel.assertQueue(QUEUE_NAMES.SCAN_JOBS, { durable: true });
        if (closed) {
          await channel.close().catch(() => undefined);
          await connection.close().catch(() => undefined);
          throw new Error('RabbitMQ publisher is closed');
        }

        active = { connection, channel };
        connection.once('close', () => invalidate(connection));
        channel.once('close', () => invalidate(connection));
      })().finally(() => {
        opening = undefined;
      });
    }

    await opening;
    if (!active) throw new Error('RabbitMQ connection could not be established');
    return active;
  };

  return {
    async ping(): Promise<void> {
      const current = await ensureChannel();
      try {
        await current.channel.checkQueue(QUEUE_NAMES.SCAN_JOBS);
      } catch (error) {
        invalidate(current.connection);
        throw error;
      }
    },
    async publishScanJob(message: ScanJobMessage): Promise<void> {
      const current = await ensureChannel();
      try {
        await new Promise<void>((resolve, reject) => {
          current.channel.sendToQueue(
            QUEUE_NAMES.SCAN_JOBS,
            Buffer.from(JSON.stringify(message)),
            {
              persistent: true,
              contentType: 'application/json',
              headers: { 'x-scan-attempt': 1 },
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
      } catch (error) {
        invalidate(current.connection);
        throw error;
      }
    },
    async close(): Promise<void> {
      closed = true;
      const current = active;
      active = undefined;
      await current?.channel.close().catch(() => undefined);
      await current?.connection.close().catch(() => undefined);
    },
  };
}
