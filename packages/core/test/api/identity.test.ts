import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '@spur-board/contracts';
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
    await scanTransaction(store, config, async (trx) => {
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
      verifyToken: (token) => verifyOperatorToken(store, token, new Date(now), () => {}),
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
      expect(await verifyOperatorToken(store, 'private', new Date(now), () => {})).toBeNull();

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

  describe('token request bounds', () => {
    const valid = {
      name: 'desk',
      folder: 'workspace/desk',
      host: 'local',
      hash: createHash('sha256').update('bounds').digest('hex'),
    };
    async function post(body: unknown) {
      const store = await storeWithSession();
      const app = await createApiServer({
        store,
        config,
        port: 4311,
        ready: () => true,
        clock: { now: () => Date.parse('2026-11-04T10:00:00.000Z') },
        lookupSession: vi.fn(),
        verifyToken: (token) =>
          verifyOperatorToken(store, token, new Date('2026-11-04T10:00:00.000Z'), () => {}),
        registry: {},
        logRequest: vi.fn(),
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/tokens/requests',
          headers: { host: '127.0.0.1:4311', 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
        const rows = {
          tokens: await store.db.selectFrom('operator_token').select('id').execute(),
          items: await store.db.selectFrom('operator_item').select('id').execute(),
        };
        return { response, rows };
      } finally {
        await app.close();
      }
    }

    it.each([
      ['name', 'over 64 characters', 'n'.repeat(65), '64'],
      ['name', 'with a space', 'my desk', '64'],
      ['folder', 'over 1024 characters', 'f'.repeat(1025), '1024'],
      ['folder', 'with a line feed', 'workspace\ndesk', '1024'],
      ['folder', 'of only spaces', '   ', '1024'],
      ['host', 'over 253 characters', 'h'.repeat(254), '253'],
      ['host', 'with a right-to-left override', 'local\u202Ehost', '253'],
    ])(
      'refuses a %s %s with a usage hint naming the field and its limit',
      async (field, _label, value, limit) => {
        const { response, rows } = await post({ ...valid, [field]: value });
        expect(response.statusCode).toBe(400);
        const body = response.json<{ code: string; hint: string }>();
        expect(body.code).toBe('usage');
        expect(body.hint).toContain(`\`${field}\``);
        expect(body.hint).toContain(limit);
        expect(response.body).not.toContain(value);
        expect(rows).toEqual({ tokens: [], items: [] });
      },
    );

    it('refuses an unknown key without naming it', async () => {
      const { response, rows } = await post({ ...valid, zzsecret: 1 });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'usage',
        hint: 'Send a JSON object with only name, folder, host and hash.',
      });
      expect(response.body).not.toContain('zzsecret');
      expect(rows).toEqual({ tokens: [], items: [] });
    });

    it('accepts every field at its limit', async () => {
      const { response, rows } = await post({
        ...valid,
        name: 'n'.repeat(64),
        folder: 'f'.repeat(1024),
        host: 'h'.repeat(253),
      });
      expect(response.statusCode).toBe(200);
      expect(rows.tokens).toHaveLength(1);
    });
  });

  it('reports a token state by hash without a credential and writes nothing', async () => {
    const store = await storeWithSession();
    let now = Date.parse('2026-11-04T10:00:00.000Z');
    const logRequest = vi.fn();
    const app = await createApiServer({
      store,
      config,
      port: 4311,
      ready: () => true,
      clock: { now: () => now },
      lookupSession: vi.fn(),
      verifyToken: (token) => verifyOperatorToken(store, token, new Date(now), () => {}),
      registry: {},
      logRequest,
    });
    const headers = { host: '127.0.0.1:4311', 'content-type': 'application/json' };
    const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');
    const enroll = (secret: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/tokens/requests',
        headers,
        payload: JSON.stringify({
          name: 'desk',
          folder: 'workspace/desk',
          host: 'local',
          hash: hashOf(secret),
        }),
      });
    const status = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/tokens/status',
        headers,
        payload: JSON.stringify(body),
      });
    try {
      expect((await enroll('first')).statusCode).toBe(200);
      const pending = await status({ hash: hashOf('first') });
      expect(pending.statusCode).toBe(200);
      expect(pending.json()).toMatchObject({ ok: true, value: { status: 'pending' } });

      now += 15 * 60 * 1000;
      const tokenRow = () =>
        store.db.selectFrom('operator_token').selectAll().where('name', '=', 'desk').execute();
      const eventCount = () =>
        store.db
          .selectFrom('event')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .executeTakeFirstOrThrow();
      const items = () => store.db.selectFrom('operator_item').selectAll().execute();
      const before = { token: await tokenRow(), events: await eventCount(), items: await items() };
      const expired = await status({ hash: hashOf('first') });
      expect(expired.statusCode).toBe(200);
      expect(expired.json()).toMatchObject({ ok: true, value: { status: 'expired' } });
      expect(Object.keys(expired.json<{ value: object }>().value)).toEqual(['status']);
      expect(before.token[0]?.status).toBe('pending');
      expect({ token: await tokenRow(), events: await eventCount(), items: await items() }).toEqual(
        before,
      );
      expect(logRequest.mock.calls.at(-1)?.[0]).toMatchObject({
        method: 'POST',
        url: '/v1/tokens/status',
        status: 200,
      });

      expect((await enroll('second')).statusCode).toBe(200);
      expect((await status({ hash: hashOf('first') })).json()).toMatchObject({
        value: { status: 'unknown' },
      });
      expect((await status({ hash: hashOf('second') })).json()).toMatchObject({
        value: { status: 'pending' },
      });

      const extra = await status({ hash: hashOf('second'), extra: 1 });
      expect(extra.statusCode).toBe(400);
      expect(extra.json()).toMatchObject({ code: 'usage' });
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
      config,
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
    await scanTransaction(store, config, (trx) =>
      decideTokenInTransaction(trx, row.item_id, 'approve', at),
    );
    const logRequest = vi.fn();
    const verifyToken = vi.fn((token: string) => verifyOperatorToken(store, token, at, () => {}));
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
      expect(await verifyOperatorToken(store, secret, at, () => {})).toBeNull();
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

  const notListedHint =
    'Spur project "stray" is not listed in any spurProjects in the Board\'s config.yaml (not Spur\'s spur.yaml), and inside a Spur session a token is not used. Ask the operator to add it under projects[].spurProjects there and restart the Board daemon, or run the command outside a Spur session.';

  it('names an unlisted Spur project from a snapshot without consulting a bearer', async () => {
    const store = await storeWithSession();
    await scanTransaction(store, config, async (trx) => {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'stray-1',
          spur_project: 'stray',
          ended_at: null,
          end_reason: null,
        })
        .execute();
    });
    const lookupSession = vi.fn();
    const verifyToken = vi.fn().mockResolvedValue({ name: 'test' });
    await expect(
      identify(
        { store, config, lookupSession, verifyToken },
        { session: 'stray-1', authorization: 'Bearer valid' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden', hint: notListedHint });
    expect(lookupSession).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('names an unlisted Spur project from a live lookup without consulting a bearer', async () => {
    const store = await storeWithSession();
    const verifyToken = vi.fn().mockResolvedValue({ name: 'test' });
    await expect(
      identify(
        {
          store,
          config,
          lookupSession: vi.fn().mockResolvedValue({ project: 'stray', status: 'running' }),
          verifyToken,
        },
        { session: 'stray-1', authorization: 'Bearer valid' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden', hint: notListedHint });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('names the Board projects of a Spur project listed under several', async () => {
    const store = await storeWithSession();
    const [board] = config.projects;
    if (board === undefined) throw new Error('Missing project');
    // configSchema refuses this shape, so the config is built without parsing.
    const duplicated: Config = { ...config, projects: [board, { ...board, id: 'other' }] };
    const verifyToken = vi.fn();
    await expect(
      identify(
        {
          store,
          config: duplicated,
          lookupSession: vi.fn().mockResolvedValue({ project: 'worker', status: 'running' }),
          verifyToken,
        },
        { session: 'worker-1', authorization: 'Bearer valid' },
      ),
    ).rejects.toMatchObject({
      code: 'forbidden',
      hint: 'Spur project "worker" is listed under several Board projects: board, other. Ask the operator to keep it under one of them in the Board\'s config.yaml (not Spur\'s spur.yaml) and restart the Board daemon.',
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('does not echo a live project name with control characters', async () => {
    const store = await storeWithSession();
    const error: unknown = await identify(
      {
        store,
        config,
        lookupSession: vi.fn().mockResolvedValue({ project: 'stray\u001b[31m', status: 'running' }),
        verifyToken: vi.fn(),
      },
      { session: 'stray-1', authorization: undefined },
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'forbidden', hint: 'Invalid session identity.' });
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
