import { nextScanRetry } from '@mini-scan/shared';

describe('nextScanRetry', () => {
  it('returns the first retry and its base delay after attempt one', () => {
    expect(nextScanRetry(1, 3, 1000)).toEqual({ attempt: 2, delayMs: 1000 });
  });

  it('doubles the delay for each later retry', () => {
    expect(nextScanRetry(2, 3, 1000)).toEqual({ attempt: 3, delayMs: 2000 });
  });

  it('returns no retry after the attempt limit', () => {
    expect(nextScanRetry(3, 3, 1000)).toBeNull();
  });
});
