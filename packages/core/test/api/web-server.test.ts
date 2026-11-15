import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, OPERATIONS } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer, createOperationRegistry, type WebOptions } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';
import { sampleRows } from '../store/sample-rows.ts';

const origin = 'https://web.example.test';
const headers = { host: 'web.example.test', origin, 'content-type': 'application/json' };
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

async function setup(overrides: Partial<WebOptions> = {}, built = true) {
  const root = mkdtempSync(join(tmpdir(), 'web-server-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  if (built) {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<html>Board</html>');
    writeFileSync(join(root, 'assets', 'app.abcdef1234.js'), 'export default 42;');
    writeFileSync(join(root, 'assets', 'app.abcdef1234.css'), 'body{}');
    writeFileSync(join(root, 'assets', 'index-App_Z-9x.js'), 'export default 7;');
    writeFileSync(join(root, 'private.txt'), 'not a route');
  }
  const store = openTempStore('web-api-').store;
  cleanups.push(() => store.close());
  const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
  const logRequest = vi.fn<WebOptions['logRequest']>();
  const options: WebOptions = {
    store,
    config,
    clock,
    registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
    ready: () => true,
    firstPollDone: () => Promise.resolve(true),
    webRoot: root,
    logRequest,
    ...overrides,
  };
  const app = await createWebServer(options);
  cleanups.push(() => app.close());
  return { app, store, logRequest, root };
}
function post(id = 'status.get', input: unknown = {}) {
  return {
    method: 'POST' as const,
    url: `/v1/ops/${id}`,
    headers,
    payload: JSON.stringify({ input }),
  };
}
function secure(response: { headers: Record<string, unknown> }) {
  expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
}

describe('web listener', () => {
  it.each([
    { host: 'foreign.example.test' },
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://foreign.example.test' },
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/x-www-form-urlencoded' },
    { 'content-type': undefined },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects browser guards before dispatch: %j', async (changes) => {
    const runOperation = vi.fn();
    const { app } = await setup({
      runOperation: (id, input, run) => {
        runOperation(id, input);
        return run();
      },
    });
    const response = await app.inject({
      ...post(),
      headers: Object.fromEntries(
        Object.entries({ ...headers, ...changes }).filter(([, value]) => value !== undefined),
      ),
    });
    expect(response.statusCode).toBe(403);
    expect(runOperation).not.toHaveBeenCalled();
    secure(response);
  });

  it('accepts exact origin with JSON parameters and runs bound reads as operator', async () => {
    const { app } = await setup();
    for (const id of ['status.get', 'inbox.get']) {
      const response = await app.inject({
        ...post(id),
        headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
      });
      expect(response.statusCode).toBe(200);
      secure(response);
    }
  });

  it('denies unbound operations before their handlers and supports common readiness/errors', async () => {
    const runOperation = vi.fn();
    const { app } = await setup({
      runOperation: (id, input, run) => {
        runOperation(id, input);
        return run();
      },
    });
    for (const operation of OPERATIONS.filter((entry) => entry.web === null)) {
      expect((await app.inject(post(operation.id))).statusCode).toBe(403);
    }
    expect(runOperation).not.toHaveBeenCalled();
    expect((await app.inject(post('unknown'))).statusCode).toBe(409);
    expect((await app.inject(post('task.get', {}))).statusCode).toBe(400);
    const starting = await setup({ ready: () => false });
    expect((await starting.app.inject(post())).statusCode).toBe(503);
  });

  it('runs both anonymous operator writes with shared hooks and idempotency', async () => {
    const order: string[] = [];
    const { app, store } = await setup({
      runOperation: async (id, _input, run) => {
        order.push(id);
        return run();
      },
      afterOperation: () => {
        order.push('after');
      },
    });
    await store.db
      .insertInto('task')
      .values({ ...sampleRows.task, membership: 'active', archive_reason: null })
      .execute();
    await store.db
      .insertInto('block')
      .values({
        ...sampleRows.block,
        type: 'needs_input',
        state: 'open',
        outcome: null,
        outcome_reason: null,
        unblocked_at: null,
        unblocked_by: null,
        addressee_role: 'operator',
      })
      .execute();
    const comment = {
      ...post('comment.add', { task: 'o/r#101', text: 'From browser' }),
      payload: JSON.stringify({
        input: { task: 'o/r#101', text: 'From browser' },
        key: 'web-comment',
      }),
    };
    expect((await app.inject(comment)).statusCode).toBe(200);
    expect((await app.inject(comment)).statusCode).toBe(200);
    const answer = await app.inject(
      post('block.answer', { block: 'B1', text: 'Answer from browser' }),
    );
    expect(answer.statusCode).toBe(200);
    const comments = await store.db.selectFrom('comment').selectAll().execute();
    expect(comments).toHaveLength(2);
    expect(comments.every((entry) => entry.author === 'operator')).toBe(true);
    expect(order).toEqual([
      'comment.add',
      'after',
      'comment.add',
      'after',
      'block.answer',
      'after',
    ]);
    expect((await app.inject(post('task.get', { task: 'o/r#101' }))).statusCode).toBe(200);
    expect((await app.inject(post('task.history', { task: 'o/r#101' }))).statusCode).toBe(200);
  });

  it.each([
    '/v1/tokens/requests',
    '/v1/tokens/status',
    '/v1/skills/reload',
    '/v1/skills/reloads',
    '/v1/schema',
    '/v1/doctor',
    '/v1/events',
    '/v1/x',
    '/v1',
  ])('keeps privileged and future routes absent: %s', async (url) => {
    const { app } = await setup();
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method,
        url,
        headers,
        ...(method === 'POST' ? { payload: '{}' } : {}),
      });
      expect(response.statusCode).toBe(404);
      secure(response);
    }
  });

  it('serves memory assets, MIME, caching, SPA fallback and HEAD without requiring Origin', async () => {
    const { app, root } = await setup();
    rmSync(root, { recursive: true, force: true });
    for (const url of ['/', '/index.html', '/tasks/42']) {
      const response = await app.inject({ url, headers: { host: headers.host } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('<html>Board</html>');
      expect(response.headers['cache-control']).toBe('no-cache');
      secure(response);
    }
    for (const [url, type, bytes] of [
      ['/assets/app.abcdef1234.js', 'text/javascript', 'export default 42;'],
      ['/assets/app.abcdef1234.css', 'text/css', 'body{}'],
      ['/assets/index-App_Z-9x.js', 'text/javascript', 'export default 7;'],
    ] as const) {
      const response = await app.inject({ url, headers: { host: headers.host } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(type);
      expect(response.body).toBe(bytes);
      expect(response.headers['cache-control']).toContain('immutable');
    }
    expect((await app.inject({ method: 'HEAD', url: '/', headers })).body).toBe('');
    expect((await app.inject({ url: '/missing.js', headers })).statusCode).toBe(404);
    expect((await app.inject({ url: '/private.txt', headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/', headers: { ...headers, 'sec-fetch-site': 'cross-site' } }))
        .statusCode,
    ).toBe(403);
    const options = await app.inject({
      method: 'OPTIONS',
      url: '/',
      headers: { host: headers.host, origin },
    });
    expect(options.statusCode).toBe(404);
    secure(options);
  });

  it.each([
    '/../secret',
    '/%2e%2e/secret',
    '/assets/%2e%2e/index.html',
    '/assets/%2E%2E%2Findex.html',
    '/assets/..%5cindex.html',
  ])('rejects raw traversal before fallback: %s', async (url) => {
    const { app } = await setup();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await new Promise<{
      statusCode: number | undefined;
      headers: Record<string, unknown>;
    }>((resolve, reject) => {
      const request = httpRequest(`${address}/`, { path: url, headers }, (response) => {
        response.resume();
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, headers: response.headers });
        });
      });
      request.on('error', reject);
      request.end();
    });
    expect(response.statusCode).toBe(404);
    secure(response);
  });

  it.each(
    [
      { path: '/assets/%zz', status: 404 },
      { path: '/v1/ops/%E0%A4%A', status: 404 },
      { path: `/v1/ops/${'x'.repeat(101)}`, status: 400 },
      { path: `/v1/ops/${'%61'.repeat(101)}`, status: 400 },
    ].flatMap((pathCase) =>
      [
        { method: 'GET', changes: {}, status: pathCase.status === 400 ? 404 : pathCase.status },
        { method: 'GET', changes: { host: 'foreign.example.test' }, status: 403 },
        { method: 'GET', changes: { 'sec-fetch-site': 'cross-site' }, status: 403 },
        { method: 'POST', changes: { origin: undefined }, status: 403 },
        { method: 'POST', changes: { origin: 'null' }, status: 403 },
        { method: 'POST', changes: { origin: 'https://foreign.example.test' }, status: 403 },
        { method: 'POST', changes: { 'content-type': 'text/plain' }, status: 403 },
        { method: 'POST', changes: {}, status: pathCase.status },
      ].map((requestCase) => ({ ...pathCase, ...requestCase })),
    ),
  )(
    'guards and audits router failures: $method $path $changes',
    async ({ path, method, changes, status }) => {
      const runOperation = vi.fn();
      const { app, logRequest } = await setup({
        runOperation: (id, input, run) => {
          runOperation(id, input);
          return run();
        },
      });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const requestHeaders = Object.fromEntries(
        Object.entries({
          ...headers,
          'x-forwarded-for': '192.0.2.1',
          'user-agent': 'Router test',
          ...changes,
        }).filter(([, value]) => value !== undefined),
      );
      const response = await new Promise<{
        statusCode: number | undefined;
        headers: Record<string, unknown>;
        body: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          `${address}/`,
          { path: `${path}?secret=hidden`, method, headers: requestHeaders },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () => {
              resolve({ statusCode: response.statusCode, headers: response.headers, body });
            });
          },
        );
        request.on('error', reject);
        request.end(method === 'POST' ? '{}' : undefined);
      });
      expect(response.statusCode).toBe(status);
      secure(response);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
      expect(response.body).not.toContain('secret=hidden');
      expect(runOperation).not.toHaveBeenCalled();
      expect(logRequest).toHaveBeenCalledExactlyOnceWith({
        requestId: response.headers['x-request-id'],
        method,
        path,
        status,
        via: 'web',
        forwardedFor: '192.0.2.1',
        userAgent: 'Router test',
      });
    },
  );

  it('keeps health and operations available without a UI build', async () => {
    const { app } = await setup({}, false);
    const response = await app.inject({ url: '/', headers });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('UI is not built: run `pnpm --filter @spur-board/web build`');
    secure(response);
    expect((await app.inject(post())).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/health', headers })).json()).toEqual({
      firstPollDone: true,
    });
  });

  it('logs untrusted audit metadata on rejected requests without query or body', async () => {
    const { app, logRequest } = await setup();
    const response = await app.inject({
      ...post(),
      url: '/v1/ops/status.get?secret=hidden',
      headers: {
        ...headers,
        origin: 'null',
        'x-forwarded-for': '192.0.2.1',
        'user-agent': 'Browser test',
      },
    });
    expect(logRequest).toHaveBeenCalledWith({
      requestId: response.headers['x-request-id'],
      method: 'POST',
      path: '/v1/ops/status.get',
      status: 403,
      via: 'web',
      forwardedFor: '192.0.2.1',
      userAgent: 'Browser test',
    });
  });
});
