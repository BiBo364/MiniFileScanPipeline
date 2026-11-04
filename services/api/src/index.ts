import { loadConfig } from '@mini-scan/shared';
import { buildApp } from './app';
import { runMigrations } from './migrate';
import { createPool } from './postgres';
import { connectRabbitMq } from './rabbitmq';
import { startOutboxDispatcher } from './outbox';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  await runMigrations(pool);

  const rabbit = await connectRabbitMq(config.RABBITMQ_URL);
  const app = await buildApp({ config, pool, rabbit });
  const outbox = startOutboxDispatcher({
    pool,
    rabbit,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    retentionDays: config.OUTBOX_RETENTION_DAYS,
    cleanupIntervalMs: config.OUTBOX_CLEANUP_INTERVAL_MS,
    onPublished: (scanId) => app.log.child({ scanId }).info('scan job published from outbox'),
    onPruned: (count) =>
      app.log
        .child({ scanId: 'outbox' })
        .info({ count }, 'expired published outbox events removed'),
    onError: (scanId, error) =>
      app.log.child({ scanId }).error({ err: error }, 'outbox publish failed; will retry'),
  });

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info({ port: config.API_PORT }, 'API listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'API shutting down');
    await app.close();
    await outbox.stop();
    await rabbit.close();
    await pool.end();
    app.log.info('API stopped');
  };

  process.once(
    'SIGINT',
    () =>
      void shutdown('SIGINT').catch((error: unknown) => {
        app.log.fatal({ err: error }, 'API shutdown failed');
        process.exit(1);
      }),
  );
  process.once(
    'SIGTERM',
    () =>
      void shutdown('SIGTERM').catch((error: unknown) => {
        app.log.fatal({ err: error }, 'API shutdown failed');
        process.exit(1);
      }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
