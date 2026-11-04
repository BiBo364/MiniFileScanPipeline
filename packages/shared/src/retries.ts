export type ScanRetryPlan = { attempt: number; delayMs: number } | null;

export function nextScanRetry(
  currentAttempt: number,
  maxAttempts: number,
  baseDelayMs: number,
): ScanRetryPlan {
  if (currentAttempt >= maxAttempts) return null;

  const attempt = currentAttempt + 1;
  return { attempt, delayMs: baseDelayMs * 2 ** (attempt - 2) };
}
