import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;
const SESSION_COOKIE = 'mini_scan_session';

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return { salt, hash: derived.toString('hex') };
}

export async function verifyPassword(
  password: string,
  salt: string,
  storedHash: string,
): Promise<boolean> {
  const expected = Buffer.from(storedHash, 'hex');
  if (expected.length !== PASSWORD_KEY_LENGTH) return false;
  const actual = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(pool: Pool, userId: string, ttlDays: number): Promise<string> {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashSessionToken(token), userId, expiresAt],
  );
  return token;
}

export async function getSessionUserId(
  pool: Pool,
  request: FastifyRequest,
): Promise<string | null> {
  const token = getCookieValue(request.headers.cookie, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;

  const result = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM user_sessions WHERE token_hash = $1 AND expires_at > NOW()',
    [hashSessionToken(token)],
  );
  return result.rows[0]?.user_id ?? null;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  ttlDays: number,
  secure: boolean,
): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlDays * 24 * 60 * 60}${secure ? '; Secure' : ''}`,
  );
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`,
  );
}

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
