import { randomUUID } from 'node:crypto';
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

jest.setTimeout(30_000);

describe('scan upload integration', () => {
  let tempDir: string;
  let pool: Pool;
  let rabbit: Awaited<ReturnType<typeof connectRabbitMq>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let worker: ChildProcessWithoutNullStreams;
  let apiUrl: string;

  beforeAll(async () => {
    loadConfig();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mini-scan-integration-'));
    const config = loadConfig({
      ...process.env,
      LOG_LEVEL: 'fatal',
      FILE_STORAGE_PATH: tempDir,
      SCAN_RETRY_BASE_DELAY_MS: '100',
    });
    pool = new Pool({ connectionString: config.DATABASE_URL });
    await runMigrations(pool);
    rabbit = await connectRabbitMq(config.RABBITMQ_URL);
    app = await buildApp({ config, pool, rabbit });
    apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    worker = spawn(process.execPath, [path.resolve('services/worker/dist/index.js')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOG_LEVEL: 'info',
        FILE_STORAGE_PATH: tempDir,
        SCAN_RETRY_BASE_DELAY_MS: '100',
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

    const connection = await amqp.connect(loadConfig().RABBITMQ_URL);
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

  async function upload(content: string) {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/plain' }), 'sample.txt');
    return fetch(`${apiUrl}/scans`, { method: 'POST', body: form });
  }

  async function waitForScan(scanId: string): Promise<{
    status: string;
    sha256: string;
    result: Record<string, unknown>;
  }> {
    let result: { status: string; sha256: string; result: Record<string, unknown> } | undefined;
    await waitFor(async () => {
      const response = await fetch(`${apiUrl}/scans/${scanId}`);
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
