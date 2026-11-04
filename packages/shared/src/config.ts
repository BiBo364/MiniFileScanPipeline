import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

function findDotEnvFile(startDir: string): string | undefined {
  let directory = startDir;

  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(directory, '.env');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return undefined;
}

function applyDotEnvFile(): void {
  const filePath = findDotEnvFile(process.cwd());
  if (!filePath) {
    return;
  }

  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  FILE_STORAGE_PATH: z.string().min(1, 'FILE_STORAGE_PATH is required'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SCAN_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SCAN_BLOCKLIST_SHA256: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((hash) => hash.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-f0-9]{64}$/))),
  DANGEROUS_FILE_EXTENSIONS: z
    .string()
    .default('.exe,.dll,.bat,.cmd,.com,.scr,.js,.vbs,.ps1')
    .transform((value) => value.split(',').map((extension) => extension.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^\.[a-z0-9]+$/))),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    applyDotEnvFile();
  }

  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}
