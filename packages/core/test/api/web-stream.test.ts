import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer, createOperationRegistry, type WebOptions } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

const origin = 'https://web.example.test';
const host = 'web.example.test';
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  web: { port: 4312, publicOrigin: origin },
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A web listener on a real loopback port with no UI build; streams need no assets. */
async function setup(overrides: Partial<WebOptions> = {}) {
  const store = openTempStore('web-stream-').store;
  cleanups.push(() => store.close());
  const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
  const logRequest = vi.fn<WebOptions['logRequest']>();
  const app = await createWebServer({
    store,
    config,
    clock,
    registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
    ready: () => true,
    webRoot: '/nonexistent-web-root',
    logRequest,
    ...overrides,
  });
  cleanups.push(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, logRequest };
}
function secure(response: { headers: Record<string, unknown> }) {
  expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(
    Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
  ).toEqual([]);
}

interface Opened {
  request: ClientRequest;
  response: IncomingMessage;
  /** The first chunk of a 200 GET stream, else the whole body. */
  body: string;
}
/** Opens `/v1/events` on a real port; a 200 GET resolves on its first chunk. */
function stream(
  address: string,
  changes: Record<string, string | undefined> = {},
  method: 'GET' | 'HEAD' | 'POST' = 'GET',
): Promise<Opened> {
  const requestHeaders: Record<string, string | undefined> = {
    host,
    accept: 'text/event-stream',
    ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : undefined),
    ...changes,
  };
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${address}/v1/events`,
      {
        method,
        agent: false,
        headers: Object.fromEntries(
          Object.entries(requestHeaders).filter(([, value]) => value !== undefined),
        ),
      },
      (response) => {
        response.setEncoding('utf8');
        if (method === 'GET' && response.statusCode === 200) {
          response.once('data', (chunk: string) => {
            resolve({ request, response, body: chunk });
          });
          return;
        }
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ request, response, body });
        });
      },
    );
    request.on('error', reject);
    request.end(method === 'POST' ? '{}' : undefined);
  });
}
function within(promise: Promise<unknown>, ms = 2_000): Promise<string> {
  return Promise.race([
    promise.then(() => 'done'),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, ms);
    }),
  ]);
}
const ended = (opened: Opened) =>
  new Promise<void>((resolve) => {
    opened.response.on('end', resolve);
    opened.response.on('close', resolve);
    opened.response.resume();
  });

describe('web event stream', () => {
  it('streams hello with SSE and browser headers', async () => {
    const instance = '0b7e5d1c-0000-4000-8000-000000000533';
    const { address } = await setup({ instance, productVersion: '1.2.3' });
    const opened = await stream(address, { origin });
    expect(opened.response.statusCode).toBe(200);
    expect(opened.response.headers['x-board-version']).toBe('1.2.3');
    expect(opened.response.headers['content-type']).toBe('text/event-stream');
    expect(opened.response.headers['cache-control']).toBe('no-cache');
    expect(opened.response.headers['x-accel-buffering']).toBe('no');
    secure(opened.response);
    expect(opened.body).toBe(`event: hello\nid: 0\ndata: {"head":0,"instance":"${instance}"}\n\n`);
    opened.request.destroy();
  });

  it.each([
    { changes: { host: 'foreign.example.test' }, status: 403 },
    { changes: { 'sec-fetch-site': 'cross-site' }, status: 403 },
    {
      changes: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      status: 403,
    },
    { changes: { origin: 'https://foreign.example.test' }, status: 403 },
    { changes: { origin: 'null' }, status: 403 },
  ])('guards the stream: $changes', async ({ changes, status }) => {
    const { address } = await setup();
    const opened = await stream(address, changes);
    expect(opened.response.statusCode).toBe(status);
    expect(opened.response.headers['content-type']).toContain('application/problem+json');
    secure(opened.response);
  });

  it('answers HEAD and POST with not_found and a starting daemon with 503', async () => {
    const { address } = await setup();
    for (const method of ['HEAD', 'POST'] as const) {
      const opened = await stream(address, {}, method);
      expect(opened.response.statusCode).toBe(404);
      secure(opened.response);
    }
    for (const [stopping, code] of [
      [false, 'starting'],
      [true, 'stopping'],
    ] as const) {
      const idle = await setup({ ready: () => false, stopping: () => stopping });
      const opened = await stream(idle.address);
      expect(opened.response.statusCode).toBe(503);
      expect(JSON.parse(opened.body)).toMatchObject({ code });
    }
  });

  it('audits an aborted stream once, frees its slot and refuses the 33rd stream as plain text', async () => {
    const { address, logRequest } = await setup();
    const aborted = await stream(address, { 'user-agent': 'Stream test' });
    const requestId = aborted.response.headers['x-request-id'];
    aborted.request.destroy();
    await vi.waitFor(() => {
      expect(logRequest).toHaveBeenCalled();
    });
    expect(logRequest).toHaveBeenCalledExactlyOnceWith({
      requestId,
      method: 'GET',
      path: '/v1/events',
      status: 200,
      via: 'web',
      userAgent: 'Stream test',
    });
    const open: Opened[] = [];
    for (let index = 0; index < 32; index += 1) {
      const opened = await stream(address);
      expect(opened.response.statusCode).toBe(200);
      open.push(opened);
    }
    const refused = await stream(address);
    expect(refused.response.statusCode).toBe(503);
    expect(refused.response.headers['content-type']).toContain('text/plain');
    expect(refused.response.headers['retry-after']).toBe('5');
    expect(() => JSON.parse(refused.body) as unknown).toThrow();
    secure(refused.response);
    for (const opened of open) opened.request.destroy();
  });

  it('ends open streams on close without waiting and audits each once', async () => {
    const { app, address, logRequest } = await setup();
    const streams = [await stream(address), await stream(address)];
    const ends = streams.map(ended);
    expect(await within(app.close())).toBe('done');
    for (const end of ends) expect(await within(end)).toBe('done');
    const audits = logRequest.mock.calls.filter(([entry]) => entry.path === '/v1/events');
    expect(audits).toHaveLength(2);
    expect(audits.map(([entry]) => entry.status)).toEqual([200, 200]);
    expect(new Set(audits.map(([entry]) => entry.requestId)).size).toBe(2);
  });
});
