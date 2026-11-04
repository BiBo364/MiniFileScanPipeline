import { loadConfig } from '@mini-scan/shared';
import { buildApp } from './app';
import { runMigrations } from './migrate';
import { createPool } from './postgres';
import { connectRabbitMq } from './rabbitmq';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  await runMigrations(pool);

  const rabbit = await connectRabbitMq(config.RABBITMQ_URL);
  const app = await buildApp({ config, pool, rabbit });

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info({ port: config.API_PORT }, 'API listening');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
