import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorize,
  createApiServer,
  identify,
  openStore,
  requestToken,
  tokenListQuery,
  tokenRevokeMutation,
  verifyOperatorToken,
  type Store,
} from '../../src/index.ts';
import { decideTokenInTransaction } from '../../src/app/tokens.ts';
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
    await scanTransaction(store, async (trx) => {
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
  it('enrolls without a credential, keeps approval pending and reuses an expired name', async () => {
    const store = await storeWithSession();
    let now = Date.parse('2026-11-04T10:00:00.000Z');
    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock: { now: () => now },
      lookupSession: vi.fn(),
      verifyToken: (token) => verifyOperatorToken(store, token),
      registry: {},
      logRequest: vi.fn(),
    });
    const enroll = (secret: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/tokens/requests',
        headers: { host: '127.0.0.1:4311', 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'desk',
          folder: 'workspace/desk',
          host: 'local',
          hash: createHash('sha256').update(secret).digest('hex'),
        }),
      });
    try {
      const response = await enroll('private');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ value: { name: 'desk', status: 'pending' } });
      expect(await verifyOperatorToken(store, 'private')).toBeNull();

      now += 15 * 60 * 1000;
      const again = await enroll('private-again');
      expect(again.body).not.toContain('does not match the operation schema');
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        value: { name: 'desk', status: 'pending', expiresAt: '2026-11-04T10:30:00.000Z' },
      });
    } finally {
      await app.close();
    }
  });

  it('keeps a session as agent while an approved token alone is operator and logs its name', async () => {
    const store = await storeWithSession('active');
    const at = new Date('2026-11-04T10:00:00.000Z');
    const secret = 'private';
    await requestToken(
      store,
      {
        name: 'desk',
        folder: 'workspace/desk',
        host: 'local',
        hash: createHash('sha256').update(secret).digest('hex'),
      },
      at,
    );
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    await scanTransaction(store, (trx) =>
      decideTokenInTransaction(trx, row.item_id, 'approve', at),
    );
    const logRequest = vi.fn();
    const verifyToken = vi.fn((token: string) => verifyOperatorToken(store, token));
    const clock = { now: () => at.getTime() };
    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock,
      lookupSession: vi.fn(),
      verifyToken,
      registry: { 'token.list': tokenListQuery(clock), 'token.revoke': tokenRevokeMutation },
      logRequest,
    });
    try {
      const input = {
        method: 'POST' as const,
        url: '/v1/ops/token.list',
        headers: {
          host: '127.0.0.1:4311',
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
        },
        payload: JSON.stringify({ input: {} }),
      };
      const operator = await app.inject(input);
      expect(operator.statusCode).toBe(200);
      expect(operator.json()).toMatchObject({
        value: { tokens: [{ name: 'desk', status: 'approved' }] },
      });
      expect(logRequest).toHaveBeenCalledWith(
        expect.objectContaining({ tokenName: 'desk', status: 200 }),
      );
      const agent = await app.inject({
        ...input,
        headers: { ...input.headers, 'x-board-session': 'session-1' },
      });
      expect(agent.statusCode).toBe(403);
      expect(verifyToken).toHaveBeenCalledTimes(1);
      expect(logRequest.mock.calls[1]?.[0]).toMatchObject({ status: 403 });
      expect(logRequest.mock.calls[1]?.[0]).not.toHaveProperty('tokenName');
      const revoked = await app.inject({
        ...input,
        url: '/v1/ops/token.revoke',
        payload: JSON.stringify({ input: { name: 'desk' } }),
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ value: { name: 'desk', status: 'revoked' } });
      expect(await verifyOperatorToken(store, secret)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('allows a configured operator-project session to list tokens without a bearer', async () => {
    const store = await storeWithSession();
    const clock = { now: () => Date.parse('2026-11-04T10:00:00.000Z') };
    const verifyToken = vi.fn();
    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock,
      lookupSession: vi.fn().mockResolvedValue({ project: 'ops', status: 'running' }),
      verifyToken,
      registry: { 'token.list': tokenListQuery(clock) },
      logRequest: vi.fn(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/token.list',
        headers: {
          host: '127.0.0.1:4311',
          'content-type': 'application/json',
          'x-board-session': 'ops-1',
        },
        payload: JSON.stringify({ input: {} }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ value: { tokens: [] } });
      expect(verifyToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

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
    const verifyToken = vi.fn().mockResolvedValue({ name: 'test' });
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
    const verifyToken = vi.fn().mockResolvedValue({ name: 'test' });
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
import { createHash } from 'node:crypto';
