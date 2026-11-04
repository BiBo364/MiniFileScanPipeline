import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveUploadAndHash } from '../../services/api/src/scans/storage';

describe('saveUploadAndHash', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mini-scan-hash-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('streams the file to storage and returns its SHA-256 and byte count', async () => {
    const content = Buffer.from('small file content');
    const destination = path.join(tempDir, 'upload.bin');

    const result = await saveUploadAndHash(Readable.from([content]), destination);

    expect(result).toEqual({
      sha256: createHash('sha256').update(content).digest('hex'),
      bytesWritten: content.length,
    });
    await expect(readFile(destination)).resolves.toEqual(content);
  });
});
