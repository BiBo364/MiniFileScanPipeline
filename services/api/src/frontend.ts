import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const assets = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
} as const;

export function registerFrontendRoutes(app: Pick<FastifyInstance, 'get'>): void {
  for (const [url, asset] of Object.entries(assets)) {
    app.get(url, async (_request, reply) => {
      const filePath = path.resolve(__dirname, '../public', asset.file);
      const content = await readFile(filePath);
      return sendFrontendAsset(reply, content, asset.type);
    });
  }
}

function sendFrontendAsset(reply: FastifyReply, content: Buffer, contentType: string) {
  return reply
    .type(contentType)
    .header('cache-control', 'no-cache')
    .header('x-content-type-options', 'nosniff')
    .header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    )
    .send(content);
}
