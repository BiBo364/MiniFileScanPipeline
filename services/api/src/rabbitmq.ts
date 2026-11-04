import amqp from 'amqplib';
import { QUEUE_NAMES } from '@mini-scan/shared';
import type { ScanJobMessage } from '@mini-scan/shared';

export type RabbitMqPublisher = {
  ping: () => Promise<void>;
  publishScanJob: (message: ScanJobMessage) => Promise<void>;
  close: () => Promise<void>;
};

export async function connectRabbitMq(url: string): Promise<RabbitMqPublisher> {
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAMES.SCAN_JOBS, { durable: true });

  return {
    async ping(): Promise<void> {
      await channel.checkQueue(QUEUE_NAMES.SCAN_JOBS);
    },
    async publishScanJob(message: ScanJobMessage): Promise<void> {
      const sent = channel.sendToQueue(QUEUE_NAMES.SCAN_JOBS, Buffer.from(JSON.stringify(message)), {
        persistent: true,
        contentType: 'application/json',
      });

      if (!sent) {
        throw new Error('RabbitMQ sendToQueue returned false (write buffer full)');
      }
    },
    async close(): Promise<void> {
      await channel.close();
      await connection.close();
    },
  };
}
