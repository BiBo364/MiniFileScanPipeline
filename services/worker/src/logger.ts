import pino from 'pino';
import type { AppConfig } from '@mini-scan/shared';

export function createLogger(config: AppConfig): pino.Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'worker' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
