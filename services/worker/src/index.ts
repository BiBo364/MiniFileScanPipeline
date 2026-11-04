import amqp, { type ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import { QUEUE_NAMES, loadConfig, scanJobMessageSchema } from '@mini-scan/shared';
import { createLogger } from './logger';
import { claimQueuedScan, releaseScanClaim, saveScanResult } from './repository';
import { scanFile } from './scanner';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const connection = await amqp.connect(config.RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAMES.SCAN_JOBS, { durable: true });
  await channel.prefetch(1);

  let stopping = false;
  let activeJob: Promise<void> | undefined;
  let consumerTag: string | undefined;

  const handleMessage = async (message: ConsumeMessage | null): Promise<void> => {
    if (!message) return;
    let payload: unknown;
    try {
      payload = JSON.parse(message.content.toString());
    } catch {
      logger.child({ scanId: 'unknown' }).error('invalid JSON scan message');
      channel.nack(message, false, false);
      return;
    }

    const parsed = scanJobMessageSchema.safeParse(payload);
    if (!parsed.success) {
      logger.child({ scanId: 'unknown' }).error({ issues: parsed.error.issues }, 'invalid scan message');
      channel.nack(message, false, false);
      return;
    }

    const { scanId, sha256 } = parsed.data;
    const log = logger.child({ scanId });
    try {
      const scan = await claimQueuedScan(pool, scanId, sha256);
      if (!scan) {
        log.info('scan is no longer queued; ignoring duplicate message');
        channel.ack(message);
        return;
      }

      log.info('scan started');
      const result = await scanFile({
        filePath: scan.stored_path,
        originalFilename: scan.original_filename,
        expectedSha256: scan.sha256,
        config,
      });
      await saveScanResult(pool, scanId, result);
      log.info({ status: result.status, reasons: result.details.reasons }, 'scan completed');
      channel.ack(message);
    } catch (error) {
      await releaseScanClaim(pool, scanId).catch((releaseError: unknown) => {
        log.error({ err: releaseError }, 'could not release scan claim');
      });
      log.error({ err: error }, 'scan failed; requeueing message');
      channel.nack(message, false, true);
    }
  };

  const consumer = await channel.consume(QUEUE_NAMES.SCAN_JOBS, (message) => {
    activeJob = handleMessage(message).finally(() => {
      activeJob = undefined;
    });
  }, { noAck: false });
  consumerTag = consumer.consumerTag;
  logger.info({ queue: QUEUE_NAMES.SCAN_JOBS }, 'worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down');
    if (consumerTag) await channel.cancel(consumerTag);
    await activeJob;
    await channel.close();
    await connection.close();
    await pool.end();
    logger.info('worker stopped');
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>((resolve) => {
    connection.once('close', resolve);
    process.once('beforeExit', resolve);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
