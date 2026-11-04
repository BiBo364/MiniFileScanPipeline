export const QUEUE_NAMES = {
  SCAN_JOBS: 'scan.jobs',
} as const;

export type ScanJobMessage = {
  scanId: string;
  sha256: string;
  filePath: string;
};
