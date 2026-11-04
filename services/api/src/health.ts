import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { pingPostgres } from './postgres';
import { pingRabbitMq } from './rabbitmq';

type HealthStatus = 'ok' | 'error';

async function asCheck(operation: Promise<void>): Promise<HealthStatus> {
  try {
    await operation;
    return 'ok';
  } catch {
    return 'error';
  }
}

export function registerHealthRoute(
  app: Pick<FastifyInstance, 'get'>,
  deps: { pool: Pool; rabbitMqUrl: string },
): void {
  app.get('/health', async (_request, reply) => {
    const [postgres, rabbitmq] = await Promise.all([
      asCheck(pingPostgres(deps.pool)),
      asCheck(pingRabbitMq(deps.rabbitMqUrl)),
    ]);

    const healthy = postgres === 'ok' && rabbitmq === 'ok';

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      checks: { postgres, rabbitmq },
    });
  });
}
