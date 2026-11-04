import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, ScanStatus } from '@mini-scan/shared';

export const EICAR_SHA256 = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f';

export type ScanResult = {
  status: Extract<ScanStatus, 'Clean' | 'Malicious'>;
  details: { reasons: string[]; sizeBytes: number; sha256: string };
};

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export async function scanFile(input: {
  filePath: string;
  originalFilename: string;
  expectedSha256: string;
  config: AppConfig;
}): Promise<ScanResult> {
  const fileStats = await stat(input.filePath);
  const actualSha256 = await hashFile(input.filePath);
  const extension = path.extname(input.originalFilename).toLowerCase();
  const blockedHashes = new Set([EICAR_SHA256, ...input.config.SCAN_BLOCKLIST_SHA256]);
  const reasons: string[] = [];

  if (actualSha256 !== input.expectedSha256.toLowerCase()) {
    reasons.push('stored_file_hash_mismatch');
  }
  if (blockedHashes.has(actualSha256)) {
    reasons.push('known_bad_hash');
  }
  if (input.config.DANGEROUS_FILE_EXTENSIONS.includes(extension)) {
    reasons.push('dangerous_file_extension');
  }
  if (fileStats.size > input.config.SCAN_MAX_FILE_BYTES) {
    reasons.push('file_size_limit_exceeded');
  }

  return {
    status: reasons.length > 0 ? 'Malicious' : 'Clean',
    details: { reasons, sizeBytes: fileStats.size, sha256: actualSha256 },
  };
}
