import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import amqp from 'amqplib';
import { loadConfig, QUEUE_NAMES } from '@mini-scan/shared';
import { Pool } from 'pg';
import { buildApp } from '../../services/api/src/app';
import { runMigrations } from '../../services/api/src/migrate';
import { connectRabbitMq } from '../../services/api/src/rabbitmq';
import { startOutboxDispatcher } from '../../services/api/src/outbox';
import { prunePublishedOutboxEvents } from '../../services/api/src/outbox-retention';

jest.setTimeout(30_000);

describe('scan upload integration', () => {
  let tempDir: string;
  let pool: Pool;
  let rabbit: Awaited<ReturnType<typeof connectRabbitMq>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let worker: ChildProcessWithoutNullStreams;
  let apiUrl: string;
  let cookie = '';
  let accountEmail = '';
  let rabbitUrl: string;
  let outbox: ReturnType<typeof startOutboxDispatcher>;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mini-scan-integration-'));
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://scans:scans@localhost:5432/scans',
      RABBITMQ_URL: process.env.RABBITMQ_URL ?? 'amqp://miniscan:miniscan@localhost:5672',
      LOG_LEVEL: 'fatal',
      FILE_STORAGE_PATH: tempDir,
      SCAN_RETRY_BASE_DELAY_MS: '1000',
    });
    rabbitUrl = config.RABBITMQ_URL;
    pool = new Pool({ connectionString: config.DATABASE_URL });
    await runMigrations(pool);
    rabbit = await connectRabbitMq(config.RABBITMQ_URL);
    app = await buildApp({ config, pool, rabbit });
    outbox = startOutboxDispatcher({
      pool,
      rabbit,
      pollIntervalMs: 20,
      retentionDays: config.OUTBOX_RETENTION_DAYS,
      cleanupIntervalMs: config.OUTBOX_CLEANUP_INTERVAL_MS,
      onPublished: () => undefined,
      onPruned: () => undefined,
      onError: (_scanId, error) => console.error('integration outbox error', error),
    });
    apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    accountEmail = `integration-${randomUUID()}@example.test`;
    const registered = await fetch(`${apiUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: accountEmail,
        password: 'integration-password-123',
      }),
    });
    expect(registered.status).toBe(201);
    cookie = registered.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    expect(cookie).toContain('mini_scan_session=');

    worker = spawn(process.execPath, [path.resolve('services/worker/dist/index.js')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: config.DATABASE_URL,
        RABBITMQ_URL: config.RABBITMQ_URL,
        LOG_LEVEL: 'info',
        FILE_STORAGE_PATH: tempDir,
        SCAN_RETRY_BASE_DELAY_MS: '1000',
      },
      stdio: 'pipe',
    });
    await waitForWorkerReady(worker);
  });

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      worker.kill('SIGTERM');
      await exited;
    }
    if (outbox) await outbox.stop();
    if (app) await app.close();
    if (rabbit) await rabbit.close();
    if (pool) await pool.end();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('uploads, scans, deduplicates identical uploads, and ignores a duplicate message', async () => {
    const content = `integration fixture ${randomUUID()}`;
    const first = await upload(content);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { scanId: string };
    const completed = await waitForScan(firstBody.scanId);
    expect(completed.status).toBe('Clean');
    expect(completed.result.sha256).toBeTruthy();
    let outboxPublishedAt: Date | null | undefined;
    await waitFor(async () => {
      const outboxState = await pool.query<{ published_at: Date | null }>(
        'SELECT published_at FROM scan_outbox WHERE scan_id = $1 AND event_type = $2',
        [firstBody.scanId, 'scan.queued'],
      );
      outboxPublishedAt = outboxState.rows[0]?.published_at;
      return outboxPublishedAt instanceof Date;
    });
    expect(outboxPublishedAt).toBeInstanceOf(Date);

    const second = await upload(content);
    expect(second.status).toBe(202);
    expect(((await second.json()) as { scanId: string }).scanId).toBe(firstBody.scanId);

    const beforeDuplicateMessage = await pool.query<{
      count: string;
      updated_at: Date;
    }>(
      `SELECT COUNT(*)::text AS count, MAX(updated_at) AS updated_at
       FROM scans WHERE sha256 = $1`,
      [completed.sha256],
    );
    expect(beforeDuplicateMessage.rows[0]?.count).toBe('1');

    const connection = await amqp.connect(rabbitUrl);
    const channel = await connection.createChannel();
    await channel.sendToQueue(
      QUEUE_NAMES.SCAN_JOBS,
      Buffer.from(
        JSON.stringify({ scanId: firstBody.scanId, sha256: completed.sha256, filePath: 'ignored' }),
      ),
      { persistent: true, contentType: 'application/json', headers: { 'x-scan-attempt': 1 } },
    );
    await waitFor(async () => (await channel.checkQueue(QUEUE_NAMES.SCAN_JOBS)).messageCount === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await channel.close();
    await connection.close();

    const afterDuplicateMessage = await pool.query<{
      status: string;
      result_details: Record<string, unknown>;
      updated_at: Date;
    }>('SELECT status, result_details, updated_at FROM scans WHERE id = $1', [firstBody.scanId]);
    expect(afterDuplicateMessage.rows[0]?.status).toBe('Clean');
    expect(afterDuplicateMessage.rows[0]?.result_details.sha256).toBe(completed.sha256);
    expect(afterDuplicateMessage.rows[0]?.updated_at).toEqual(
      beforeDuplicateMessage.rows[0]?.updated_at,
    );
  });

  it('removes published outbox events older than the retention period', async () => {
    const scanId = randomUUID();
    const sha256 = createHash('sha256').update(scanId).digest('hex');
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO scans (id, sha256, stored_path, original_filename, status)
       VALUES ($1, $2, '/data/uploads/expired.bin', 'expired.bin', 'Clean')`,
      [scanId, sha256],
    );
    await pool.query(
      `INSERT INTO scan_outbox (id, scan_id, event_type, payload, created_at, published_at)
       VALUES ($1, $2, 'scan.queued', $3::jsonb, NOW() - INTERVAL '31 days', NOW() - INTERVAL '31 days')`,
      [eventId, scanId, JSON.stringify({ scanId, sha256, filePath: '/data/uploads/expired.bin' })],
    );

    const deleted = await prunePublishedOutboxEvents(pool, 30);
    const remaining = await pool.query('SELECT id FROM scan_outbox WHERE id = $1', [eventId]);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(remaining.rowCount).toBe(0);
  });

  it("requires authentication and hides another user's scans", async () => {
    const anonymous = await fetch(`${apiUrl}/scans/${randomUUID()}`);
    expect(anonymous.status).toBe(401);
    expect((await fetch(`${apiUrl}/scans`)).status).toBe(401);

    const firstUpload = await upload(`private fixture ${randomUUID()}`);
    const firstBody = (await firstUpload.json()) as { scanId: string };
    await waitForScan(firstBody.scanId);

    const secondAccount = await fetch(`${apiUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `other-${randomUUID()}@example.test`,
        password: 'integration-password-456',
      }),
    });
    const otherCookie = secondAccount.headers.get('set-cookie')?.split(';', 1)[0];
    const hiddenScan = await fetch(`${apiUrl}/scans/${firstBody.scanId}`, {
      headers: { cookie: otherCookie ?? '' },
    });
    expect(hiddenScan.status).toBe(404);

    const otherHistory = await fetch(`${apiUrl}/scans`, { headers: { cookie: otherCookie ?? '' } });
    expect(otherHistory.status).toBe(200);
    expect(await otherHistory.json()).toEqual([]);
  });

  it('logs in, returns the session user, and revokes a session on logout', async () => {
    const login = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: accountEmail, password: 'integration-password-123' }),
    });
    expect(login.status).toBe(200);
    const loginCookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';

    const me = await fetch(`${apiUrl}/auth/me`, { headers: { cookie: loginCookie } });
    expect(me.status).toBe(200);

    const logout = await fetch(`${apiUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: loginCookie },
    });
    expect(logout.status).toBe(204);

    const revoked = await fetch(`${apiUrl}/auth/me`, { headers: { cookie: loginCookie } });
    expect(revoked.status).toBe(401);
  });

  async function upload(content: string) {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/plain' }), 'sample.txt');
    return fetch(`${apiUrl}/scans`, { method: 'POST', body: form, headers: { cookie } });
  }

  async function waitForScan(scanId: string): Promise<{
    status: string;
    sha256: string;
    result: Record<string, unknown>;
  }> {
    let result: { status: string; sha256: string; result: Record<string, unknown> } | undefined;
    await waitFor(async () => {
      const response = await fetch(`${apiUrl}/scans/${scanId}`, { headers: { cookie } });
      if (!response.ok) return false;
      const scan = (await response.json()) as {
        status: string;
        sha256: string;
        result: Record<string, unknown>;
      };
      result = scan;
      return scan.status === 'Clean' || scan.status === 'Malicious' || scan.status === 'Failed';
    });
    if (!result) throw new Error('Scan completed without a response body');
    return result;
  }
});

function waitForWorkerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`Worker did not become ready: ${output}`)),
      10_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('worker ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited before readiness (code ${code}): ${output}`));
    });
  });
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for scan pipeline');
}
