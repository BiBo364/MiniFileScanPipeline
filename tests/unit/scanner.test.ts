import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@mini-scan/shared';
import { EICAR_SHA256, scanFile } from '../../services/worker/src/scanner';

describe('scanFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mini-scan-worker-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function config(overrides: NodeJS.ProcessEnv = {}) {
    return loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgres://scans:scans@localhost/scans',
      RABBITMQ_URL: 'amqp://guest:guest@localhost',
      FILE_STORAGE_PATH: tempDir,
      SCAN_BLOCKLIST_SHA256: '',
      DANGEROUS_FILE_EXTENSIONS: '.exe',
      SCAN_MAX_FILE_BYTES: '100',
      ...overrides,
    });
  }

  async function makeFile(name: string, contents: string) {
    const filePath = path.join(tempDir, name);
    await writeFile(filePath, contents);
    return { filePath, sha256: createHash('sha256').update(contents).digest('hex') };
  }

  it('marks a regular file clean', async () => {
    const file = await makeFile('document.txt', 'ordinary text');

    const result = await scanFile({
      ...file,
      originalFilename: 'document.txt',
      expectedSha256: file.sha256,
      config: config(),
    });

    expect(result.status).toBe('Clean');
    expect(result.details.reasons).toEqual([]);
  });

  it('flags a configured bad hash, dangerous extension, size limit, and hash mismatch', async () => {
    const file = await makeFile('payload', 'malicious payload longer than limit');
    const testConfig = config({
      SCAN_BLOCKLIST_SHA256: file.sha256,
      SCAN_MAX_FILE_BYTES: '5',
    });

    const result = await scanFile({
      ...file,
      originalFilename: 'payload.EXE',
      expectedSha256: '0'.repeat(64),
      config: testConfig,
    });

    expect(result.status).toBe('Malicious');
    expect(result.details.reasons).toEqual([
      'stored_file_hash_mismatch',
      'known_bad_hash',
      'dangerous_file_extension',
      'file_size_limit_exceeded',
    ]);
  });

  it('recognizes the EICAR test signature', async () => {
    const eicar = String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;
    const file = await makeFile('eicar.com', eicar);

    expect(file.sha256).toBe(EICAR_SHA256);
    const result = await scanFile({
      ...file,
      originalFilename: 'eicar.com',
      expectedSha256: EICAR_SHA256,
      config: config(),
    });

    expect(result.status).toBe('Malicious');
    expect(result.details.reasons).toContain('known_bad_hash');
  });
});
