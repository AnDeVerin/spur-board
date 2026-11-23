import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer, createOperationRegistry, type WebOptions } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

const origin = 'https://web.example.test';
// What a browser sends when a home-screen app or a Slack link opens the page.
const navigation = {
  host: 'web.example.test',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};
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

async function setup(overrides: Partial<WebOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'web-cross-site-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<html>Board</html>');
  writeFileSync(join(root, 'assets', 'app.abcdef1234.js'), 'export default 42;');
  const store = openTempStore('web-cross-site-').store;
  cleanups.push(() => store.close());
  const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
  const app = await createWebServer({
    store,
    config,
    clock,
    registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
    ready: () => true,
    firstPollDone: () => Promise.resolve(true),
    webRoot: root,
    logRequest: () => undefined,
    ...overrides,
  });
  cleanups.push(() => app.close());
  return app;
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

describe('web listener cross-site requests', () => {
  it.each([
    { method: 'GET', url: '/', body: '<html>Board</html>' },
    { method: 'GET', url: '/?open=proj-42', body: '<html>Board</html>' },
    { method: 'GET', url: '/tasks/42', body: '<html>Board</html>' },
    { method: 'GET', url: '/assets/app.abcdef1234.js', body: 'export default 42;' },
    { method: 'HEAD', url: '/', body: '' },
  ] as const)(
    'accepts a cross-site top-level navigation to the page: $method $url',
    async ({ method, url, body }) => {
      const app = await setup();
      const response = await app.inject({ method, url, headers: navigation });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(body);
      secure(response);
    },
  );

  it.each([
    { name: 'navigate GET /v1/health', method: 'GET', url: '/v1/health', changes: {} },
    { name: 'navigate GET /%76%31/health', method: 'GET', url: '/%76%31/health', changes: {} },
    { name: 'cors GET /', method: 'GET', url: '/', changes: { 'sec-fetch-mode': 'cors' } },
    {
      name: 'no-cors image GET /',
      method: 'GET',
      url: '/',
      changes: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    },
    { name: 'iframe GET /', method: 'GET', url: '/', changes: { 'sec-fetch-dest': 'iframe' } },
    { name: 'no dest GET /', method: 'GET', url: '/', changes: { 'sec-fetch-dest': undefined } },
    {
      name: 'navigate POST /v1/ops/status.get',
      method: 'POST',
      url: '/v1/ops/status.get',
      changes: { origin, 'content-type': 'application/json' },
    },
    { name: 'navigate POST /', method: 'POST', url: '/', changes: { origin } },
    {
      name: 'navigate GET / with a foreign host',
      method: 'GET',
      url: '/',
      changes: { host: 'foreign.example.test' },
      hint: 'Use the configured web host.',
    },
  ] as const)(
    'refuses a cross-site request that is not a page navigation: $name',
    async ({ method, url, changes, ...rest }) => {
      const runOperation = vi.fn();
      const app = await setup({
        runOperation: (id, input, run) => {
          runOperation(id, input);
          return run();
        },
      });
      const response = await app.inject({
        method,
        url,
        headers: Object.fromEntries(
          Object.entries({ ...navigation, ...changes }).filter(([, value]) => value !== undefined),
        ),
        ...(method === 'POST' ? { payload: JSON.stringify({ input: {} }) } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'forbidden',
        hint: 'hint' in rest ? rest.hint : 'Cross-site requests are not accepted.',
      });
      expect(runOperation).not.toHaveBeenCalled();
      secure(response);
    },
  );

  // `app.inject` normalises the target, so only a real socket puts an absolute form on the wire.
  // Router failures (`web-server.test.ts`, `guards and audits router failures`) skip the hooks.
  it.each([
    { name: 'absolute-form target', path: 'http://web.example.test/v1/health' },
    { name: 'router failure /assets/%zz', path: '/assets/%zz' },
    { name: 'router failure /v1/ops/%E0%A4%A', path: '/v1/ops/%E0%A4%A' },
    { name: 'router failure over-long id', path: `/v1/ops/${'x'.repeat(101)}` },
    { name: 'router failure over-long encoded id', path: `/v1/ops/${'%61'.repeat(101)}` },
  ])('refuses a cross-site request that is not a page navigation: $name', async ({ path }) => {
    const app = await setup();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await new Promise<{ statusCode: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(`${address}/`, { path, headers: navigation }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            resolve({ statusCode: response.statusCode, body });
          });
        });
        request.on('error', reject);
        request.end();
      },
    );
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'forbidden',
      hint: 'Cross-site requests are not accepted.',
    });
  });
});
