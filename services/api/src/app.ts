import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type { Pool } from 'pg';
import type { AppConfig } from '@mini-scan/shared';
import { registerHealthRoute } from './health';
import type { RabbitMqPublisher } from './rabbitmq';
import { registerScanRoutes } from './scans/routes';

function getErrorStatusCode(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return 500;
}

export async function buildApp(deps: {
  config: AppConfig;
  pool: Pool;
  rabbit: RabbitMqPublisher;
}) {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      base: { service: 'api' },
      timestamp: true,
    },
    bodyLimit: deps.config.MAX_UPLOAD_BYTES,
  });

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: deps.config.MAX_UPLOAD_BYTES,
    },
  });

  registerHealthRoute(app, { pool: deps.pool, rabbit: deps.rabbit });
  registerScanRoutes(app, deps);

  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = getErrorStatusCode(error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (statusCode === 413) {
      return reply.code(413).send({ error: 'File exceeds the 10 MB upload limit' });
    }
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : message,
    });
  });

  return app;
}
