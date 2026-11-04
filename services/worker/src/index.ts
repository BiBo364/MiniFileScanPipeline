import { loadConfig } from '@mini-scan/shared';
import { createLogger } from './logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info('Worker skeleton started; the scan consumer arrives in a later stage');

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      logger.info('Worker received shutdown signal');
      resolve();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
