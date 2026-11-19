import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createWebServer, createOperationRegistry } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

const origin = 'https://web.example.test';
const headers = { host: 'web.example.test', origin, 'content-type': 'application/json' };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(runOperation: (id: string, input: unknown) => void) {
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
  const root = mkdtempSync(join(tmpdir(), 'web-turn-assets-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'index.html'), '<html>Board</html>');
  const store = openTempStore('web-turn-').store;
  cleanups.push(() => store.close());
  const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
  const app = await createWebServer({
    store,
    config,
    clock,
    webRoot: root,
    logRequest: () => {},
    registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
    ready: () => true,
    firstPollDone: () => Promise.resolve(true),
    runOperation: (id, input, run) => {
      runOperation(id, input);
      return run();
    },
  });
  cleanups.push(() => app.close());
  return app;
}

it.each([
  { id: 'inbox.ack', input: { entries: [{ id: 'T9' }] } },
  { id: 'task.submit', input: { turn: 'T9', sha: 'a'.repeat(40) } },
  { id: 'task.return', input: { turn: 'T9', reason: 'Fix the parser.' } },
])('lets the Turn section reach the $id handler as operator', async ({ id, input }) => {
  const runOperation = vi.fn();
  const app = await setup(runOperation);
  const response = await app.inject({
    method: 'POST',
    url: `/v1/ops/${id}`,
    headers,
    payload: JSON.stringify({ input, key: `web-${id}` }),
  });
  // 403 would mean the web listener refused the op before its handler; not_found is the handler's.
  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ code: 'not_found' });
  expect(runOperation).toHaveBeenCalledWith(id, input);
});
