import { loadConfig } from '@mini-scan/shared';
import { buildApp } from './app';
import { createPool } from './postgres';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const app = buildApp({ config, pool });

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info({ port: config.API_PORT }, 'API listening');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
