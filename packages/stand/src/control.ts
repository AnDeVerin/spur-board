import { createHash, timingSafeEqual } from 'node:crypto';
import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const MAX_BODY = 64 * 1024;
/** A body still arriving after this is dropped, so a slow client cannot hold a route or close. */
const BODY_TIMEOUT_MS = 10_000;
/** How long close waits for answers to flush before it drops their connections. */
const FLUSH_TIMEOUT_MS = 2_000;
/** The longest `wait` the server runs, whatever the request asks. */
export const MAX_WAIT_MS = 600_000;

export interface RouteResult {
  status: number;
  body: unknown;
}

export interface ControlRoutes {
  /** Re-reads state until the condition holds or the timeout passes; never queued. */
  wait(body: { condition: string; timeoutMs: number }, signal: AbortSignal): Promise<RouteResult>;
  poll(body: { source?: string; timeoutMs?: number }): Promise<RouteResult>;
  reset(): Promise<RouteResult>;
  /** Lists what the fake Slack API holds; never queued. */
  slackOutbox(): Promise<RouteResult>;
  slackClick(body: { message: number; button: string; text?: string }): Promise<RouteResult>;
  /** One verb on one fake system; only `spur` is queued with `poll` and `reset`. */
  fake(body: { system: string; verb: string; args: unknown }): Promise<RouteResult>;
  /** 200 with an empty log, 409 otherwise; never queued. */
  violations(): Promise<RouteResult>;
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
  const timer = setTimeout(() => {
    request.destroy(new HttpError(408, 'The body took too long.'));
  }, BODY_TIMEOUT_MS);
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_BODY) throw new HttpError(413, 'The body is over 64 KiB.');
      chunks.push(buffer);
    }
  } finally {
    clearTimeout(timer);
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

const ROUTES = new Set([
  '/wait',
  '/poll',
  '/reset',
  '/fake',
  '/violations',
  '/fake/slack/outbox',
  '/fake/slack/click',
]);

/**
 * The stand's control endpoint on 127.0.0.1. Checks, in order: no `Origin` (403), Host exactly
 * `127.0.0.1:<port>` (403), the Bearer token (401), a known route (404), the body size (413) and
 * its arrival time (10 s). `wait` runs at most `MAX_WAIT_MS`.
 * `poll`, `reset`, `fake spur` and the Slack click run one at a time through one queue; `wait`,
 * `violations`, the Slack outbox and the other fakes run outside it.
 */
export async function startControl(options: {
  token: string;
  routes: ControlRoutes;
  /** Called when the server starts reading a request body; a test seam. */
  onBodyRead?: (path: string) => void;
}): Promise<Control> {
  const expected = digest(`Bearer ${options.token}`);
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  // A function, so a check after an await reads the flag anew.
  const isClosing = (): boolean => closing;
  const waits = new AbortController();
  // Requests whose body is still arriving; close drops them.
  const reading = new Set<IncomingMessage>();
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
    reading.add(request);
    options.onBodyRead?.(path);
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } finally {
      reading.delete(request);
    }
    // Shutdown may have begun while the body arrived; nothing new runs after it.
    if (isClosing()) throw new HttpError(503, 'The stand is stopping.');
    let result: RouteResult;
    if (path === '/wait') {
      const { condition, timeoutMs: asked } = body;
      if (
        typeof condition !== 'string' ||
        typeof asked !== 'number' ||
        !Number.isFinite(asked) ||
        asked < 0
      )
        throw new HttpError(400, 'Send { condition, timeoutMs } with a finite timeoutMs.');
      const timeoutMs = Math.min(asked, MAX_WAIT_MS);
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
      const { source, timeoutMs: asked } = body;
      if (source !== undefined && typeof source !== 'string')
        throw new HttpError(400, 'source must be a string.');
      if (
        asked !== undefined &&
        (typeof asked !== 'number' || !Number.isFinite(asked) || asked < 0)
      )
        throw new HttpError(400, 'timeoutMs must be a finite number of milliseconds.');
      result = await queued(() =>
        options.routes.poll({
          ...(source === undefined ? {} : { source }),
          ...(asked === undefined ? {} : { timeoutMs: Math.min(asked, MAX_WAIT_MS) }),
        }),
      );
    } else if (path === '/fake') {
      const { system, verb, args = {} } = body;
      if (typeof system !== 'string' || typeof verb !== 'string')
        throw new HttpError(400, 'Send { system, verb, args }.');
      const run = () => options.routes.fake({ system, verb, args });
      // A reset replaces the fake Spur, so it waits its turn. The other fakes outlive a reset and
      // must answer beside a poll they hold. `fail clear` affects later requests only: a request
      // already held waits for its abort, the poll bound or shutdown.
      result = await (system === 'spur' ? queued(run) : run());
    } else if (path === '/violations') {
      result = await options.routes.violations();
    } else if (path === '/fake/slack/outbox') {
      result = await options.routes.slackOutbox();
    } else if (path === '/fake/slack/click') {
      const { message, button, text } = body;
      if (
        typeof message !== 'number' ||
        !Number.isSafeInteger(message) ||
        message < 1 ||
        typeof button !== 'string' ||
        button === '' ||
        (text !== undefined && typeof text !== 'string')
      )
        throw new HttpError(
          400,
          'Send { message, button, text? } with a positive integer message.',
        );
      result = await queued(() =>
        options.routes.slackClick({
          message,
          button,
          ...(typeof text === 'string' ? { text } : {}),
        }),
      );
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
        for (const request of reading)
          request.destroy(new HttpError(503, 'The stand is stopping.'));
        await tail;
        waits.abort();
        // A client that stops reading its answer cannot hold shutdown past the flush bound.
        let bound: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all([...open]),
          new Promise<void>((resolve) => {
            bound = setTimeout(resolve, FLUSH_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(bound);
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

/**
 * One HTTP call to a stand on 127.0.0.1, straight to the socket: a fresh agent never takes an env
 * proxy, so a bearer token cannot reach one. Any other host is refused before connecting.
 */
export function callLocal(
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
    return Promise.reject(
      new Error(`Refusing a stand call to ${target.host}; it must be 127.0.0.1.`),
    );
  return new Promise((resolve, reject) => {
    const req = request(
      {
        agent: new Agent({ keepAlive: false }),
        host: '127.0.0.1',
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: {
          host: target.host,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        timeout: options.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`No answer from ${target.host} in ${String(options.timeoutMs)} ms.`));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
