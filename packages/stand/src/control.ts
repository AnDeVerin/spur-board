import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const MAX_BODY = 64 * 1024;

export interface RouteResult {
  status: number;
  body: unknown;
}

export interface ControlRoutes {
  /** Re-reads state until the condition holds or the timeout passes; never queued. */
  wait(body: { condition: string; timeoutMs: number }, signal: AbortSignal): Promise<RouteResult>;
  poll(body: { source?: string }): Promise<RouteResult>;
  reset(): Promise<RouteResult>;
}

export interface Control {
  readonly url: string;
  /** Answers 503 to new requests, awaits queued mutations, then closes the server. */
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY) throw new HttpError(413, 'The body is over 64 KiB.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The body is not JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new HttpError(400, 'The body must be a JSON object.');
  return parsed as Record<string, unknown>;
}

const ROUTES = new Set(['/wait', '/poll', '/reset']);

/**
 * The stand's control endpoint on 127.0.0.1. Checks, in order: no `Origin` (403), Host exactly
 * `127.0.0.1:<port>` (403), the Bearer token (401), a known route (404), the body size (413).
 * `poll` and `reset` run one at a time through one queue; `wait` runs outside it.
 */
export async function startControl(options: {
  token: string;
  routes: ControlRoutes;
}): Promise<Control> {
  const expected = digest(`Bearer ${options.token}`);
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  const waits = new AbortController();
  const queued = (run: () => Promise<RouteResult>): Promise<RouteResult> => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port;
    if (closing) throw new HttpError(503, 'The stand is stopping.');
    if (request.headers.origin !== undefined)
      throw new HttpError(403, 'Browser origins are not accepted.');
    if (request.headers.host !== `127.0.0.1:${String(port)}`)
      throw new HttpError(403, 'Use the host 127.0.0.1 and the control port.');
    const auth = request.headers.authorization;
    if (auth === undefined || !timingSafeEqual(digest(auth), expected))
      throw new HttpError(401, 'A valid Bearer token is required.');
    const path = request.url ?? '';
    if (request.method !== 'POST' || !ROUTES.has(path)) throw new HttpError(404, 'Unknown route.');
    const body = await readJson(request);
    let result: RouteResult;
    if (path === '/wait') {
      const { condition, timeoutMs } = body;
      if (typeof condition !== 'string' || typeof timeoutMs !== 'number' || timeoutMs < 0)
        throw new HttpError(400, 'Send { condition, timeoutMs }.');
      const aborted = new AbortController();
      const abort = () => {
        aborted.abort();
      };
      response.on('close', abort);
      waits.signal.addEventListener('abort', abort);
      try {
        result = await options.routes.wait(
          { condition, timeoutMs },
          AbortSignal.any([aborted.signal, waits.signal]),
        );
      } finally {
        response.off('close', abort);
        waits.signal.removeEventListener('abort', abort);
      }
    } else if (path === '/poll') {
      const { source } = body;
      if (source !== undefined && typeof source !== 'string')
        throw new HttpError(400, 'source must be a string.');
      result = await queued(() => options.routes.poll(source === undefined ? {} : { source }));
    } else {
      result = await queued(() => options.routes.reset());
    }
    send(response, result.status, result.body);
  }

  // Each request's response, until it is flushed or aborted; close awaits them.
  const open = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const done = new Promise<void>((resolve) => {
      response.on('close', resolve);
    });
    open.add(done);
    void done.then(() => open.delete(done));
    handle(request, response).catch((err: unknown) => {
      if (err instanceof HttpError) send(response, err.status, { error: err.message });
      else send(response, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close() {
      closed ??= (async () => {
        closing = true;
        await tail;
        waits.abort();
        await Promise.all([...open]);
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        });
      })();
      return closed;
    },
  };
}
