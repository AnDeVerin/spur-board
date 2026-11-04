import { join } from 'node:path';
import { createOperationRegistry, openStore, type Store } from '@spur-board/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolvePaths } from '../src/config.ts';
import { createHttpModule, lookupLiveSession } from '../src/http-module.ts';
import type { DaemonState, ModuleContext } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

const wire = {
  id: 'worker-1',
  project: 'worker',
  branch: 'work-1',
  status: 'running',
  state: 'waiting',
  lastActivityAt: '2026-11-04T08:00:00.000Z',
};

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('live session lookup', () => {
  it('reads a recorded session detail and encodes the requested ID', async () => {
    const requested: URL[] = [];
    const fetcher = vi.fn((url: RequestInfo | URL) => {
      requested.push(url instanceof URL ? url : new URL(url instanceof Request ? url.url : url));
      return Promise.resolve(Response.json({ ...wire, id: 'worker-1' }));
    });
    const result = await lookupLiveSession('http://127.0.0.1:4310', 'worker-1', fetcher);
    expect(result).toEqual({ project: 'worker', status: 'running' });
    expect(requested.map((url) => url.pathname)).toEqual(['/sessions/worker-1']);
  });

  it.each([
    { name: 'completed', status: 'completed' },
    { name: 'killed', status: 'killed' },
  ])('retains the $name terminal state for the identity boundary', async ({ status }) => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ ...wire, status })));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, fetcher)).resolves.toEqual({
      project: 'worker',
      status,
    });
  });

  it('treats 404 as unknown and failures or invalid responses as unavailable', async () => {
    const missing = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, missing)).resolves.toBeNull();
    const down = vi.fn(() => Promise.reject(new Error('connection refused')));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, down)).rejects.toThrow(
      'connection refused',
    );
    const invalid = vi.fn(() => Promise.resolve(Response.json({ ...wire, id: 'another-session' })));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, invalid)).rejects.toThrow(
      'Invalid session detail response',
    );
  });
});

describe('HTTP module', () => {
  it('serves schema.get through the real operation route on an assigned port', async () => {
    const config = VALID_CONFIG_YAML.replace(
      'operatorGithubLogin: octocat',
      'operatorGithubLogin: octocat\n    spurProjects:\n      - name: worker\n        role: worker',
    );
    const home = makeHome({ config, httpPort: 0 });
    const store = openStore(join(home, 'board.sqlite'));
    stores.push(store);
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      { write: (line) => records.push(JSON.parse(line) as Record<string, unknown>) },
      {},
    ).child({ module: 'http' });
    const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    };
    const module = createHttpModule(ctx, {
      fetcher: () => Promise.resolve(Response.json(wire)),
      registry: createOperationRegistry({
        config: loaded.config,
        clock,
        completeSince: new Map(),
      }),
    });
    try {
      await module.start(new AbortController().signal);
      const listening = records.find((record) => record['msg'] === 'http listening');
      expect(listening?.['port']).toEqual(expect.any(Number));
      const response = await fetch(
        `http://127.0.0.1:${String(listening?.['port'])}/v1/ops/schema.get`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board-session': 'worker-1' },
          body: JSON.stringify({ input: {} }),
        },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        ok: boolean;
        value: { version: string; operations: unknown[] };
      };
      expect(result.ok).toBe(true);
      expect(result.value.version).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(result.value.operations)).toBe(true);
      const filtered = await fetch(
        `http://127.0.0.1:${String(listening?.['port'])}/v1/ops/schema.get`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board-session': 'worker-1' },
          body: JSON.stringify({ input: { role: 'worker' } }),
        },
      );
      expect(filtered.status).toBe(200);
      const body = (await filtered.json()) as { value: { operations: { id: string }[] } };
      expect(body.value.operations.map((entry) => entry.id)).toContain('schema.get');
      expect(body.value.operations.map((entry) => entry.id)).not.toContain('task.add');
    } finally {
      await module.stop();
    }
  });

  it('serves starting until ready, logs request IDs, and closes its listener', async () => {
    const home = makeHome();
    const store = openStore(join(home, 'board.sqlite'));
    stores.push(store);
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      {
        write(line) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
      {},
    ).child({ module: 'http' });
    const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
    let state: DaemonState = 'starting';
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => state,
    };
    const module = createHttpModule(ctx);
    const url = `http://127.0.0.1:${String(loaded.config.http.port)}/v1/schema`;
    try {
      await module.start(new AbortController().signal);
      const starting = await fetch(url);
      expect(starting.status).toBe(503);
      expect(await starting.json()).toMatchObject({ code: 'starting' });
      state = 'ready';
      const ready = await fetch(url);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toHaveProperty('version');
      const requestId = ready.headers.get('x-request-id');
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(records).toContainEqual(
        expect.objectContaining({ requestId, module: 'http', msg: 'http request', status: 200 }),
      );
    } finally {
      await module.stop();
    }
    await expect(fetch(url)).rejects.toThrow();
  });
});
