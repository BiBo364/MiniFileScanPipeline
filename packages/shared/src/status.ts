export const SCAN_STATUSES = [
  'Queued',
  'Scanning',
  'Clean',
  'Malicious',
  'Failed',
] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];
