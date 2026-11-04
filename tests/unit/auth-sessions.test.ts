import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  clearSessionCookie,
  createSession,
  getCookieValue,
  getSessionUserId,
  hashPassword,
  hashSessionToken,
  setSessionCookie,
  verifyPassword,
} from '../../services/api/src/auth/sessions';

describe('authentication credential helpers', () => {
  it('stores passwords as salted scrypt hashes and verifies them', async () => {
    const credentials = await hashPassword('a long passphrase');

    expect(credentials.salt).not.toBe('');
    expect(credentials.hash).not.toContain('a long passphrase');
    await expect(
      verifyPassword('a long passphrase', credentials.salt, credentials.hash),
    ).resolves.toBe(true);
    await expect(
      verifyPassword('wrong passphrase', credentials.salt, credentials.hash),
    ).resolves.toBe(false);
    await expect(verifyPassword('wrong', credentials.salt, 'bad-hash')).resolves.toBe(false);
  });

  it('hashes session tokens before they are stored', () => {
    expect(hashSessionToken('opaque-session')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken('opaque-session')).not.toBe('opaque-session');
  });

  it('creates random opaque sessions and stores only their token hash', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    const token = await createSession(pool, 'user-id', 7);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(hashSessionToken(token));
    expect(query.mock.calls[0]?.[1]?.[0]).not.toBe(token);
  });

  it('accepts only a well-formed active session token from its cookie', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ user_id: 'user-id' }] });
    const pool = { query } as unknown as Pool;
    const invalidRequest = {
      headers: { cookie: 'other=ignored; mini_scan_session=abc' },
    } as unknown as FastifyRequest;

    await expect(getSessionUserId(pool, invalidRequest)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();

    const validRequest = {
      headers: { cookie: 'mini_scan_session=1234567890123456789012345678901234567890123' },
    } as unknown as FastifyRequest;
    await expect(getSessionUserId(pool, validRequest)).resolves.toBe('user-id');
    expect(query.mock.calls[0]?.[0]).toContain('expires_at > NOW()');
  });

  it('sets and clears HTTP-only same-site cookies with production security', () => {
    const header = jest.fn();
    const reply = { header } as unknown as FastifyReply;

    setSessionCookie(reply, 'opaque-token', 3, true);
    expect(header.mock.calls[0]?.[1]).toContain(
      'HttpOnly; SameSite=Strict; Max-Age=259200; Secure',
    );

    clearSessionCookie(reply, true);
    expect(header.mock.calls[1]?.[1]).toContain('Max-Age=0; Secure');
  });

  it('parses a named cookie and rejects malformed encoding', () => {
    expect(getCookieValue('first=1; mini_scan_session=hello%20there', 'mini_scan_session')).toBe(
      'hello there',
    );
    expect(getCookieValue('mini_scan_session=%E0%A4%A', 'mini_scan_session')).toBeNull();
    expect(getCookieValue(undefined, 'mini_scan_session')).toBeNull();
  });
});
