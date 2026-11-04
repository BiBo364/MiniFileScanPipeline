import amqp, { type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import {
  QUEUE_NAMES,
  loadConfig,
  nextScanRetry,
  scanJobMessageSchema,
  scanRetryQueueName,
} from '@mini-scan/shared';
import { createLogger } from './logger';
import { claimQueuedScan, markScanFailed, releaseScanClaim, saveScanResult } from './repository';
import { scanFile } from './scanner';

async function publishConfirmed(
  channel: ConfirmChannel,
  queue: string,
  message: ConsumeMessage,
  attempt: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    channel.sendToQueue(
      queue,
      message.content,
      {
        persistent: true,
        contentType: 'application/json',
        headers: { ...message.properties.headers, 'x-scan-attempt': attempt },
        messageId: message.properties.messageId,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function parseMessage(
  message: ConsumeMessage,
): ReturnType<typeof scanJobMessageSchema.parse> | null {
  try {
    return scanJobMessageSchema.parse(JSON.parse(message.content.toString()));
  } catch {
    return null;
  }
}

function messageAttempt(message: ConsumeMessage, maxAttempts: number): number {
  const value = Number(message.properties.headers?.['x-scan-attempt'] ?? 1);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, maxAttempts)) : 1;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const connection = await amqp.connect(config.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();
  await channel.assertQueue(QUEUE_NAMES.SCAN_JOBS, { durable: true });
  await channel.assertQueue(QUEUE_NAMES.SCAN_DEAD, { durable: true });
  for (let attempt = 2; attempt <= config.SCAN_MAX_ATTEMPTS; attempt += 1) {
    await channel.assertQueue(scanRetryQueueName(attempt), {
      durable: true,
      arguments: {
        'x-message-ttl': nextScanRetry(
          attempt - 1,
          config.SCAN_MAX_ATTEMPTS,
          config.SCAN_RETRY_BASE_DELAY_MS,
        )?.delayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': QUEUE_NAMES.SCAN_JOBS,
      },
    });
  }
  await channel.prefetch(1);

  let stopping = false;
  const activeJobs = new Set<Promise<void>>();
  const track = (job: Promise<void>): void => {
    activeJobs.add(job);
    void job.finally(() => activeJobs.delete(job));
  };

  const processScan = async (message: ConsumeMessage | null): Promise<void> => {
    if (!message) return;
    const payload = parseMessage(message);
    if (!payload) {
      logger.child({ scanId: 'unknown' }).error('invalid scan message; discarding');
      channel.nack(message, false, false);
      return;
    }

    const { scanId, sha256 } = payload;
    const log = logger.child({ scanId });
    const attempt = messageAttempt(message, config.SCAN_MAX_ATTEMPTS);
    try {
      const scan = await claimQueuedScan(pool, scanId, sha256, message.fields.redelivered);
      if (!scan) {
        log.info('scan is already claimed or complete; acknowledging duplicate');
        channel.ack(message);
        return;
      }

      log.info({ attempt }, 'scan started');
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
      let claimReleased = true;
      await releaseScanClaim(pool, scanId).catch((releaseError: unknown) => {
        claimReleased = false;
        log.error({ err: releaseError }, 'could not release scan claim');
      });
      if (!claimReleased) {
        channel.nack(message, false, true);
        return;
      }

      try {
        const retry = nextScanRetry(
          attempt,
          config.SCAN_MAX_ATTEMPTS,
          config.SCAN_RETRY_BASE_DELAY_MS,
        );
        if (!retry) {
          await publishConfirmed(channel, QUEUE_NAMES.SCAN_DEAD, message, attempt);
          log.error({ attempt, err: error }, 'retry limit reached; sent to dead-letter queue');
        } else {
          await publishConfirmed(
            channel,
            scanRetryQueueName(retry.attempt),
            message,
            retry.attempt,
          );
          log.warn(
            { attempt, nextAttempt: retry.attempt, delayMs: retry.delayMs, err: error },
            'scan failed; scheduled retry',
          );
        }
        channel.ack(message);
      } catch (publishError) {
        log.error(
          { err: publishError },
          'could not route failed scan; requeueing original message',
        );
        channel.nack(message, false, true);
      }
    }
  };

  const processDeadLetter = async (message: ConsumeMessage | null): Promise<void> => {
    if (!message) return;
    const payload = parseMessage(message);
    if (!payload) {
      logger.child({ scanId: 'unknown' }).error('invalid dead-letter message; discarding');
      channel.nack(message, false, false);
      return;
    }

    const log = logger.child({ scanId: payload.scanId });
    try {
      await markScanFailed(pool, payload.scanId, 'retry_limit_exceeded');
      log.error(
        { attempt: messageAttempt(message, config.SCAN_MAX_ATTEMPTS) },
        'scan marked Failed after retry exhaustion',
      );
      channel.ack(message);
    } catch (error) {
      log.error({ err: error }, 'could not persist dead-letter failure; requeueing');
      channel.nack(message, false, true);
    }
  };

  const workConsumer = await channel.consume(
    QUEUE_NAMES.SCAN_JOBS,
    (message) => {
      track(processScan(message));
    },
    { noAck: false },
  );
  const deadConsumer = await channel.consume(
    QUEUE_NAMES.SCAN_DEAD,
    (message) => {
      track(processDeadLetter(message));
    },
    { noAck: false },
  );
  logger.info(
    { queue: QUEUE_NAMES.SCAN_JOBS, deadLetterQueue: QUEUE_NAMES.SCAN_DEAD },
    'worker ready',
  );

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down');
    await channel.cancel(workConsumer.consumerTag);
    await channel.cancel(deadConsumer.consumerTag);
    await Promise.all([...activeJobs]);
    await channel.close();
    await connection.close();
    await pool.end();
    logger.info('worker stopped');
  };

  process.once(
    'SIGINT',
    () =>
      void shutdown('SIGINT').catch((error: unknown) => {
        logger.fatal({ err: error }, 'worker shutdown failed');
        process.exit(1);
      }),
  );
  process.once(
    'SIGTERM',
    () =>
      void shutdown('SIGTERM').catch((error: unknown) => {
        logger.fatal({ err: error }, 'worker shutdown failed');
        process.exit(1);
      }),
  );
  await new Promise<void>((resolve) => {
    connection.once('close', resolve);
    process.once('beforeExit', resolve);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
