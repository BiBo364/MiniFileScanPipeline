import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

export function createSha256Tap(): { stream: Transform; digest: () => string } {
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  return {
    stream,
    digest: () => hash.digest('hex'),
  };
}
