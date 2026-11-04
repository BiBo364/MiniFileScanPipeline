import { Pool } from 'pg';
import type { AppConfig } from '@mini-scan/shared';

export function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
  });
}

export async function pingPostgres(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}
