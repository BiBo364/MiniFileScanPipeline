import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerFrontendRoutes } from '../../services/api/src/frontend';

describe('frontend static routes', () => {
  let routes: Map<string, (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>>;

  beforeAll(() => {
    routes = new Map();
    const fakeApp = {
      get: (
        url: string,
        handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
      ) => routes.set(url, handler),
    };
    registerFrontendRoutes(fakeApp as unknown as Pick<FastifyInstance, 'get'>);
  });

  it.each([
    ['/', 'text/html', 'Mini File Scan Pipeline'],
    ['/app.js', 'text/javascript', 'initialize()'],
    ['/styles.css', 'text/css', '--green'],
  ])('serves %s with a same-origin content policy', async (url, contentType, expectedText) => {
    const responseHeaders = new Map<string, string>();
    let body: Buffer | undefined;
    const reply = {
      type: jest.fn((value: string) => {
        responseHeaders.set('content-type', value);
        return reply;
      }),
      header: jest.fn((name: string, value: string) => {
        responseHeaders.set(name, value);
        return reply;
      }),
      send: jest.fn((value: Buffer) => {
        body = value;
        return reply;
      }),
    } as unknown as FastifyReply;
    const handler = routes.get(url);
    if (!handler) throw new Error(`No route registered for ${url}`);

    await handler({} as FastifyRequest, reply);

    expect(responseHeaders.get('content-type')).toContain(contentType);
    expect(responseHeaders.get('content-security-policy')).toContain("default-src 'self'");
    expect(body?.toString()).toContain(expectedText);
  });
});
