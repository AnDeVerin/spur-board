import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebServer, createOperationRegistry } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

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

async function setup(index: string, productVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), 'web-version-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), index);
  writeFileSync(join(root, 'assets', 'app.abcdef1234.js'), 'export default 42;');
  const store = openTempStore('web-version-').store;
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
    ...(productVersion === undefined ? {} : { productVersion }),
  });
  cleanups.push(() => app.close());
  return app;
}
const post = (url = '/v1/ops/status.get', extra: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url,
  headers: { ...headers, ...extra },
  payload: JSON.stringify({ input: {} }),
});

describe('web listener version', () => {
  it('stamps the board version into the page and every answer', async () => {
    const app = await setup('<html><head></head>Board</html>', '1.2.3');
    for (const url of ['/', '/index.html', '/tasks/42']) {
      const response = await app.inject({ url, headers: { host: headers.host } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(
        '<html><head><meta name="board-version" content="1.2.3"></head>Board</html>',
      );
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['x-board-version']).toBe('1.2.3');
    }
    const asset = await app.inject({
      url: '/assets/app.abcdef1234.js',
      headers: { host: headers.host },
    });
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.headers['x-board-version']).toBe('1.2.3');
    const op = await app.inject(post());
    expect(op.statusCode).toBe(200);
    expect(op.headers['x-board-version']).toBe('1.2.3');
    const foreign = await app.inject(post(undefined, { host: 'foreign.example.test' }));
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['x-board-version']).toBe('1.2.3');
    const long = await app.inject(post(`/v1/ops/${'x'.repeat(101)}`));
    expect(long.statusCode).toBe(400);
    expect(long.headers['x-board-version']).toBe('1.2.3');
  });

  it('escapes the version and leaves a page with no <head> unchanged', async () => {
    const escaped = await setup('<html><HEAD lang="en">Board</html>', '1"<2>&');
    expect((await escaped.inject({ url: '/', headers: { host: headers.host } })).body).toBe(
      '<html><HEAD lang="en"><meta name="board-version" content="1&quot;&lt;2&gt;&amp;">Board</html>',
    );
    const plain = await setup('<html><header>Board</header></html>', '1.2.3');
    expect((await plain.inject({ url: '/', headers: { host: headers.host } })).body).toBe(
      '<html><header>Board</header></html>',
    );
  });

  it('sends no version header and the page as built without a product version', async () => {
    const app = await setup('<html><head></head>Board</html>');
    for (const url of ['/', '/tasks/42', '/assets/app.abcdef1234.js']) {
      const response = await app.inject({ url, headers: { host: headers.host } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-board-version']).toBeUndefined();
    }
    expect((await app.inject({ url: '/', headers: { host: headers.host } })).body).toBe(
      '<html><head></head>Board</html>',
    );
    expect((await app.inject(post())).headers['x-board-version']).toBeUndefined();
  });
});
