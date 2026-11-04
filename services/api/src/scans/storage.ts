import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { createSha256Tap } from './hash';

export function sanitizeOriginalFilename(raw: string): string {
  const base = path.basename(raw).trim();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'upload.bin';
  }
  return cleaned.slice(0, 255);
}

export function storedFilePath(storageDir: string, scanId: string): string {
  return path.join(storageDir, `${scanId}.bin`);
}

export async function saveUploadAndHash(
  source: Readable,
  destPath: string,
): Promise<{ sha256: string; bytesWritten: number }> {
  await mkdir(path.dirname(destPath), { recursive: true });

  const tap = createSha256Tap();
  let bytesWritten = 0;
  tap.stream.on('data', (chunk: Buffer) => {
    bytesWritten += chunk.length;
  });

  try {
    await pipeline(source, tap.stream, createWriteStream(destPath));
  } catch (error) {
    await unlink(destPath).catch(() => undefined);
    throw error;
  }

  return { sha256: tap.digest(), bytesWritten };
}
