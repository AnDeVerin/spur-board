import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebServer, createOperationRegistry } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

const origin = 'https://web.example.test';
const host = { host: 'web.example.test' };
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

// The files the web build emits beside index.html (packages/web/build/app-icons.ts).
const appFiles = [
  ['/manifest.webmanifest', 'application/manifest+json', '{"name":"Spur Board"}'],
  ['/favicon.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ['/favicon-32.png', 'image/png', 'png-32'],
  ['/apple-touch-icon.png', 'image/png', 'png-180'],
  ['/icons/icon-192.png', 'image/png', 'png-192'],
  ['/icons/icon-512.png', 'image/png', 'png-512'],
  ['/icons/icon-512-maskable.png', 'image/png', 'png-512-maskable'],
] as const;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'web-app-files-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'icons'));
  writeFileSync(join(root, 'index.html'), '<html><head></head>Board</html>');
  writeFileSync(join(root, 'assets', 'app.abcdef1234.js'), 'export default 42;');
  writeFileSync(join(root, 'icons', 'other.png'), 'not an app file');
  writeFileSync(join(root, 'favicon.ico'), 'not an app file');
  writeFileSync(join(root, 'private.txt'), 'not a route');
  for (const [path, , body] of appFiles) writeFileSync(join(root, path), body);
  const store = openTempStore('web-app-files-').store;
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
  });
  cleanups.push(() => app.close());
  return app;
}

describe('web listener app files', () => {
  it.each(appFiles)(
    'serves %s as %s, uncached, with the Host header only',
    async (url, type, body) => {
      const app = await setup();
      const response = await app.inject({ url, headers: host });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe(type);
      expect(response.body).toBe(body);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    },
  );

  it('keeps hashed assets immutable and other files with an extension unserved', async () => {
    const app = await setup();
    const asset = await app.inject({ url: '/assets/app.abcdef1234.js', headers: host });
    expect(asset.headers['cache-control']).toContain('immutable');
    for (const url of ['/favicon.ico', '/icons/other.png', '/private.txt', '/missing.js'])
      expect((await app.inject({ url, headers: host })).statusCode, url).toBe(404);
  });

  it('refuses a cross-site request for the manifest', async () => {
    const app = await setup();
    const response = await app.inject({
      url: '/manifest.webmanifest',
      headers: { ...host, 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('serves the manifest to a cross-site top-level navigation', async () => {
    const app = await setup();
    const response = await app.inject({
      url: '/manifest.webmanifest',
      headers: {
        ...host,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/manifest+json');
    expect(response.body).toBe('{"name":"Spur Board"}');
  });
});
