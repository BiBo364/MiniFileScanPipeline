import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '@mini-scan/shared';
import type { RabbitMqPublisher } from '../rabbitmq';
import { getScanById, insertQueuedScan } from './repository';
import { sanitizeOriginalFilename, saveUploadAndHash, storedFilePath } from './storage';

const scanIdParams = z.object({
  id: z.string().uuid(),
});

export function registerScanRoutes(
  app: Pick<FastifyInstance, 'get' | 'post'>,
  deps: { config: AppConfig; pool: Pool; rabbit: RabbitMqPublisher },
): void {
  app.post('/scans', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'Expected a multipart file field named "file"' });
    }

    const scanId = randomUUID();
    const originalFilename = sanitizeOriginalFilename(file.filename);
    const filePath = storedFilePath(deps.config.FILE_STORAGE_PATH, scanId);
    const log = request.log.child({ scanId });

    const saved = await saveUploadAndHash(file.file, filePath);
    if (saved.bytesWritten > deps.config.MAX_UPLOAD_BYTES) {
      await unlink(filePath).catch(() => undefined);
      return reply.code(413).send({ error: 'File exceeds the 10 MB upload limit' });
    }

    let savedScan: Awaited<ReturnType<typeof insertQueuedScan>>;
    try {
      savedScan = await insertQueuedScan(deps.pool, {
        id: scanId,
        sha256: saved.sha256,
        storedPath: filePath,
        originalFilename,
      });
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }

    if (!savedScan.inserted) {
      await unlink(filePath).catch(() => undefined);
      request.log
        .child({ scanId: savedScan.scan.id })
        .info({ sha256: saved.sha256 }, 'duplicate upload reused existing scan');
      return reply.code(202).send({ scanId: savedScan.scan.id });
    }

    await deps.rabbit.publishScanJob({
      scanId: savedScan.scan.id,
      sha256: saved.sha256,
      filePath,
    });

    log.info({ sha256: saved.sha256 }, 'scan queued');
    return reply.code(202).send({ scanId });
  });

  app.get('/scans/:id', async (request, reply) => {
    const parsed = scanIdParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'id must be a UUID' });
    }

    const scan = await getScanById(deps.pool, parsed.data.id);
    if (!scan) {
      return reply.code(404).send({ error: 'Scan not found' });
    }

    return {
      id: scan.id,
      status: scan.status,
      sha256: scan.sha256,
      result: scan.result_details,
      createdAt: scan.created_at.toISOString(),
      updatedAt: scan.updated_at.toISOString(),
    };
  });
}
