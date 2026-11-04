import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorize, createApiServer, identify, openStore, type Store } from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'worker', role: 'worker' },
        { name: 'ops', role: 'operator' },
      ],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});

const stores: Store[] = [];
async function storeWithSession(status?: 'active' | 'ended' | 'completed' | 'killed') {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-api-identity-')), 'board.db'));
  stores.push(store);
  if (status !== undefined) {
    await store.transaction(async (trx) => {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'session-1',
          spur_project: 'worker',
          raw_state: status === 'completed' || status === 'killed' ? status : 'running',
          ended_at: status === 'ended' ? sampleRows.session_snapshot.ended_at : null,
          end_reason: status === 'ended' ? sampleRows.session_snapshot.end_reason : null,
        })
        .execute();
    });
  }
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('API identity', () => {
  it('uses an active snapshot without a live request', async () => {
    const store = await storeWithSession('active');
    const lookupSession = vi.fn();
    const verifyToken = vi.fn();
    await expect(
      identify(
        { store, config, lookupSession, verifyToken },
        { session: 'session-1', authorization: 'Bearer valid' },
      ),
    ).resolves.toBe('agent:worker/session-1');
    expect(lookupSession).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it.each(['ended', 'completed', 'killed'] as const)(
    'refuses a %s snapshot without falling back to live lookup',
    async (status) => {
      const store = await storeWithSession(status);
      const lookupSession = vi.fn();
      await expect(
        identify(
          { store, config, lookupSession, verifyToken: vi.fn() },
          { session: 'session-1', authorization: undefined },
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(lookupSession).not.toHaveBeenCalled();
    },
  );

  it('looks up a snapshot miss and keeps an operator project tied to its session', async () => {
    const store = await storeWithSession();
    const lookupSession = vi.fn().mockResolvedValue({ project: 'ops', status: 'running' });
    const actor = await identify(
      { store, config, lookupSession, verifyToken: vi.fn() },
      { session: 'ops-1', authorization: undefined },
    );
    expect(lookupSession).toHaveBeenCalledExactlyOnceWith('ops-1');
    expect(actor).toBe('agent:ops/ops-1');
    expect(
      authorize([{ grant: 'operator' }], actor, {
        config,
        target: { kind: 'missing' },
      }).status,
    ).toBe('allowed');
  });

  it.each([
    { name: 'unknown', response: null, code: 'forbidden' },
    { name: 'completed', response: { project: 'worker', status: 'completed' }, code: 'forbidden' },
    { name: 'killed', response: { project: 'worker', status: 'killed' }, code: 'forbidden' },
  ])('refuses a $name live session', async ({ response, code }) => {
    const store = await storeWithSession();
    await expect(
      identify(
        { store, config, lookupSession: vi.fn().mockResolvedValue(response), verifyToken: vi.fn() },
        { session: 'missing-1', authorization: undefined },
      ),
    ).rejects.toMatchObject({ code });
  });

  it('reports unavailable identity on a failed live lookup', async () => {
    const store = await storeWithSession();
    await expect(
      identify(
        {
          store,
          config,
          lookupSession: vi.fn().mockRejectedValue(new Error('offline')),
          verifyToken: vi.fn(),
        },
        { session: 'missing-1', authorization: undefined },
      ),
    ).rejects.toMatchObject({ code: 'identity_unavailable' });

    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock: { now: () => Date.now() },
      lookupSession: vi.fn().mockRejectedValue(new Error('offline')),
      verifyToken: vi.fn(),
      registry: {},
      logRequest: vi.fn(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/task.get',
        headers: {
          host: '127.0.0.1:4311',
          'content-type': 'application/json',
          'x-board-session': 'missing-1',
        },
        payload: JSON.stringify({ input: { task: 'PROJ-123' } }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'identity_unavailable', status: 503 });
    } finally {
      await app.close();
    }
  });

  it('rejects an unrecognized live state as unavailable identity', async () => {
    const store = await storeWithSession();
    await expect(
      identify(
        {
          store,
          config,
          lookupSession: vi.fn().mockResolvedValue({ project: 'worker', status: 'unknown-state' }),
          verifyToken: vi.fn(),
        },
        { session: 'missing-1', authorization: undefined },
      ),
    ).rejects.toMatchObject({ code: 'identity_unavailable' });
  });

  it('rejects an empty session header even with a valid bearer token', async () => {
    const store = await storeWithSession();
    const verifyToken = vi.fn().mockResolvedValue(true);
    await expect(
      identify(
        { store, config, lookupSession: vi.fn(), verifyToken },
        { session: '', authorization: 'Bearer valid' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('rejects multiple session headers instead of falling back to a bearer token', async () => {
    const store = await storeWithSession();
    const verifyToken = vi.fn().mockResolvedValue(true);
    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock: { now: () => Date.now() },
      lookupSession: vi.fn(),
      verifyToken,
      registry: {},
      logRequest: vi.fn(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/task.get',
        headers: {
          host: '127.0.0.1:4311',
          'content-type': 'application/json',
          'x-board-session': ['session-1', 'session-2'],
          authorization: 'Bearer valid',
        },
        payload: JSON.stringify({ input: { task: 'PROJ-123' } }),
      });
      expect(response.statusCode).toBe(403);
      expect(verifyToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: 'Origin', headers: { origin: 'https://elsewhere.example' }, method: 'GET' },
    { name: 'foreign Host', headers: { host: 'elsewhere.example:4311' }, method: 'GET' },
    { name: 'non-JSON body', headers: { 'content-type': 'text/plain' }, method: 'POST' },
  ])('rejects $name before identity', async ({ headers, method }) => {
    const store = await storeWithSession();
    const lookupSession = vi.fn();
    const verifyToken = vi.fn();
    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock: { now: () => Date.now() },
      lookupSession,
      verifyToken,
      registry: {},
      logRequest: vi.fn(),
    });
    try {
      const response = await app.inject({
        method: method as 'GET' | 'POST',
        url: method === 'GET' ? '/v1/schema' : '/v1/ops/task.get',
        headers: { host: '127.0.0.1:4311', ...headers, 'x-board-session': 'missing-1' },
        ...(method === 'POST' ? { payload: '{}' } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'forbidden' });
      expect(lookupSession).not.toHaveBeenCalled();
      expect(verifyToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
