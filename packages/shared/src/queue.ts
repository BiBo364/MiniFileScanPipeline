import { z } from 'zod';

export const QUEUE_NAMES = {
  SCAN_JOBS: 'scan.jobs',
  SCAN_DEAD: 'scan.jobs.dead',
  SCAN_RETRY_PREFIX: 'scan.jobs.retry',
} as const;

export function scanRetryQueueName(attempt: number): string {
  return `${QUEUE_NAMES.SCAN_RETRY_PREFIX}.${attempt}`;
}

export type ScanJobMessage = {
  scanId: string;
  sha256: string;
  filePath: string;
};

export const scanJobMessageSchema = z.object({
  scanId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  filePath: z.string().min(1),
});
