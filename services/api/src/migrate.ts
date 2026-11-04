import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

function migrationsDirectory(): string {
  return path.resolve(__dirname, '../../../db/migrations');
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const directory = migrationsDirectory();
  const files = (await fs.readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const fileName of files) {
    const alreadyApplied = await pool.query<{ id: string }>(
      'SELECT id FROM schema_migrations WHERE id = $1',
      [fileName],
    );
    if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
      continue;
    }

    const sql = await fs.readFile(path.join(directory, fileName), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [fileName]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
