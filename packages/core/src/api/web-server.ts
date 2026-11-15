import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { resolveWebOrigin } from '@spur-board/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { CommandError } from '../app/commands.ts';
import { createOpsRoute, installOperationErrors } from './ops-route.ts';
import type { ApiOptions } from './server.ts';

export interface WebOptions extends Pick<
  ApiOptions,
  | 'store'
  | 'config'
  | 'clock'
  | 'registry'
  | 'ready'
  | 'stopping'
  | 'runOperation'
  | 'afterOperation'
  | 'firstPollDone'
  | 'logError'
> {
  readonly webRoot: string | URL;
  readonly logRequest: (entry: {
    requestId: string;
    method: string;
    path: string;
    status: number;
    via: 'web';
    forwardedFor?: string;
    userAgent?: string;
  }) => void;
}

// #529 replaces this authorized compatibility stub with context propagation.
function withChannel<T>(_via: 'web' | 'slack', fn: () => Promise<T>): Promise<T> {
  return fn();
}

const mime: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

async function loadFiles(root: string | URL): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(dir: string | URL, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path =
        typeof dir === 'string'
          ? join(dir, entry.name)
          : new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      const key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, key);
      else if (entry.isFile()) files.set(key, await readFile(path));
    }
  }
  try {
    await walk(root, '');
  } catch (err) {
    if (!(
      err instanceof Error &&
      'code' in err &&
      (err.code === 'ENOENT' || err.code === 'ENOTDIR')
    ))
      throw err;
    files.clear();
  }
  return files;
}

/** Independent browser transport; the caller owns listening and shutdown. */
export async function createWebServer(options: WebOptions): Promise<FastifyInstance> {
  const files = await loadFiles(options.webRoot);
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), trustProxy: false });
  installOperationErrors(app, options);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    const address = app.server.address();
    const origin = resolveWebOrigin(
      options.config.web,
      address !== null && typeof address === 'object' ? address.port : undefined,
    );
    if (origin === undefined || request.headers.host !== new URL(origin).host)
      throw new CommandError('forbidden', 'Use the configured web host.');
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new CommandError('forbidden', 'Cross-site requests are not accepted.');
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin !== origin)
      throw new CommandError('forbidden', 'Use the configured web origin.');
    if (
      request.method === 'POST' &&
      request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    )
      throw new CommandError('forbidden', 'Use application/json.');
    const rawPath = request.raw.url?.split('?', 1)[0] ?? '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      throw new CommandError('not_found', 'Invalid web path.');
    }
    if (decoded.split(/[\\/]/).some((part) => part === '..' || part === '.'))
      throw new CommandError('not_found', 'Invalid web path.');
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });
  app.addHook('onResponse', (request, reply, done) => {
    const forwardedFor = request.headers['x-forwarded-for'];
    const userAgent = request.headers['user-agent'];
    options.logRequest({
      requestId: request.id,
      method: request.method,
      path: request.url.split('?', 1)[0] ?? '/',
      status: reply.statusCode,
      via: 'web',
      ...(typeof forwardedFor === 'string' ? { forwardedFor } : {}),
      ...(userAgent === undefined ? {} : { userAgent }),
    });
    done();
  });
  createOpsRoute(app, {
    ...options,
    identify: () => Promise.resolve({ actor: 'operator' }),
    allow: (operation) => operation.web !== null,
    runOperation: (id, input, run) =>
      withChannel('web', () =>
        options.runOperation === undefined ? run() : options.runOperation(id, input, run),
      ),
  });
  app.get('/v1/health', async () => {
    if (!options.ready())
      throw new CommandError(
        options.stopping?.() === true ? 'stopping' : 'starting',
        'Wait until the daemon is ready.',
      );
    if (options.firstPollDone === undefined)
      throw new CommandError('not_found', 'Health is unavailable.');
    return { firstPollDone: await options.firstPollDone() };
  });
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '/';
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      path === '/v1' ||
      path.startsWith('/v1/')
    )
      throw new CommandError('not_found', 'This web route is not available.');
    const key = path === '/' ? '/index.html' : path;
    const file = key === '/index.html' || path.startsWith('/assets/') ? files.get(key) : undefined;
    const fallback = extname(path) === '' ? files.get('/index.html') : undefined;
    if (file === undefined && fallback === undefined) {
      if (!files.has('/index.html'))
        return reply
          .code(503)
          .type('text/html')
          .send('UI is not built: run `pnpm --filter @spur-board/web build`');
      throw new CommandError('not_found', 'This web asset is not available.');
    }
    const index = key === '/index.html' || file === undefined;
    reply.header(
      'cache-control',
      index
        ? 'no-cache'
        : /[.-][a-z0-9_-]{8,}\.[^.]+$/i.test(key)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
    );
    return reply
      .type(index ? 'text/html; charset=utf-8' : (mime[extname(key)] ?? 'application/octet-stream'))
      .send(request.method === 'HEAD' ? undefined : (file ?? fallback));
  });
  return app;
}
