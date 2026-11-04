import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '@mini-scan/shared';
import { registerHealthRoute } from './health';

export function buildApp(deps: { config: AppConfig; pool: Pool }) {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      base: { service: 'api' },
      timestamp: true,
    },
  });

  registerHealthRoute(app, {
    pool: deps.pool,
    rabbitMqUrl: deps.config.RABBITMQ_URL,
  });

  return app;
}
