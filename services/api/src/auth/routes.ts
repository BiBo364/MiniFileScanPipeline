import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '@mini-scan/shared';
import {
  clearSessionCookie,
  createSession,
  getCookieValue,
  getSessionUserId,
  hashPassword,
  hashSessionToken,
  setSessionCookie,
  verifyPassword,
} from './sessions';

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
});
const SESSION_COOKIE = 'mini_scan_session';

export function registerAuthRoutes(
  app: Pick<FastifyInstance, 'get' | 'post'>,
  deps: { config: AppConfig; pool: Pool },
): void {
  app.post('/auth/register', async (request, reply) => {
    if (!isSameOrigin(request))
      return reply.code(403).send({ error: 'Cross-origin request rejected' });
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Provide a valid email and a 12 to 128 character password' });
    }

    const userId = randomUUID();
    const password = await hashPassword(parsed.data.password);
    try {
      await deps.pool.query(
        'INSERT INTO users (id, email, password_salt, password_hash) VALUES ($1, $2, $3, $4)',
        [userId, parsed.data.email, password.salt, password.hash],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'An account with that email already exists' });
      }
      throw error;
    }

    const token = await createSession(deps.pool, userId, deps.config.AUTH_SESSION_TTL_DAYS);
    setSessionCookie(
      reply,
      token,
      deps.config.AUTH_SESSION_TTL_DAYS,
      deps.config.NODE_ENV === 'production',
    );
    return reply.code(201).send({ id: userId, email: parsed.data.email });
  });

  app.post('/auth/login', async (request, reply) => {
    if (!isSameOrigin(request))
      return reply.code(403).send({ error: 'Cross-origin request rejected' });
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid email or password' });

    const result = await deps.pool.query<{
      id: string;
      email: string;
      password_salt: string;
      password_hash: string;
    }>('SELECT id, email, password_salt, password_hash FROM users WHERE email = $1', [
      parsed.data.email,
    ]);
    const user = result.rows[0];
    if (
      !user ||
      !(await verifyPassword(parsed.data.password, user.password_salt, user.password_hash))
    ) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const token = await createSession(deps.pool, user.id, deps.config.AUTH_SESSION_TTL_DAYS);
    setSessionCookie(
      reply,
      token,
      deps.config.AUTH_SESSION_TTL_DAYS,
      deps.config.NODE_ENV === 'production',
    );
    return { id: user.id, email: user.email };
  });

  app.post('/auth/logout', async (request, reply) => {
    if (!isSameOrigin(request))
      return reply.code(403).send({ error: 'Cross-origin request rejected' });
    const token = getCookieValue(request.headers.cookie, SESSION_COOKIE);
    if (token) {
      await deps.pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [
        hashSessionToken(token),
      ]);
    }
    clearSessionCookie(reply, deps.config.NODE_ENV === 'production');
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const userId = await getSessionUserId(deps.pool, request);
    if (!userId) return reply.code(401).send({ error: 'Authentication required' });
    const result = await deps.pool.query<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE id = $1',
      [userId],
    );
    const user = result.rows[0];
    if (!user) return reply.code(401).send({ error: 'Authentication required' });
    return user;
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function isSameOrigin(request: Parameters<typeof getSessionUserId>[1]): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
