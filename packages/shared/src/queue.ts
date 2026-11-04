import { z } from 'zod';

export const QUEUE_NAMES = {
  SCAN_JOBS: 'scan.jobs',
} as const;

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
