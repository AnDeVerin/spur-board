import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, renderHttpProblem, type ServerErrorCode } from '@spur-board/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer, openStore, type ApiOptions, type Store } from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

const NOW = Date.parse('2026-11-04T09:00:01.000Z');
const host = '127.0.0.1:4311';
const json = { host, 'content-type': 'application/json' };
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function expectProblem(response: InjectResponse, code: ServerErrorCode, hint: string): void {
  const requestId = String(response.headers['x-request-id']);
  const expected = renderHttpProblem({ code, requestId });
  expect(response.statusCode).toBe(expected.status);
  expect(response.json()).toEqual({ ...expected.body, hint });
}

async function server(
  options: { productVersion?: string; logRequest?: ApiOptions['logRequest'] } = {},
) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-api-reload-')), 'board.db'));
  stores.push(store);
  await store.transaction(async (trx) => {
    for (const id of ['alpha', 'beta', 'gamma']) {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id,
          spur_project: 'worker',
          state: 'waiting',
          ended_at: null,
          end_reason: null,
          absent_since: null,
        })
        .execute();
    }
  });
  const app = await createApiServer({
    store,
    config,
    port: 4311,
    ready: () => true,
    clock: { now: () => NOW },
    lookupSession: () => Promise.resolve(null),
    verifyToken: () => Promise.resolve(null),
    registry: {},
    ...(options.productVersion === undefined ? {} : { productVersion: options.productVersion }),
    logRequest: options.logRequest ?? vi.fn(),
  });
  return { app, store };
}

function reload(body: unknown) {
  return {
    method: 'POST' as const,
    url: '/v1/skills/reload',
    headers: json,
    payload: JSON.stringify(body),
  };
}

function reloads(body: unknown) {
  return {
    method: 'POST' as const,
    url: '/v1/skills/reloads',
    headers: json,
    payload: JSON.stringify(body),
  };
}

const RELOAD_USAGE = 'Send {"version": "<x.y.z>"} with the installed spur-board version.';
const RELOADS_USAGE =
  'Send {"version": "<x.y.z>", "sessions": ["<session id>", ...]} with 1 to 200 session ids.';

describe('POST /v1/skills/reload', () => {
  it('answers not_found when the daemon has no product version', async () => {
    const { app, store } = await server();
    try {
      expectProblem(
        await app.inject(reload({ version: '1.2.3' })),
        'not_found',
        'Skill reload is unavailable.',
      );
      expect(await store.db.selectFrom('outbox').selectAll().execute()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['a short version', { version: '1.2' }],
    ['a v prefix', { version: 'v1.2.3' }],
    ['a leading zero', { version: '01.2.3' }],
    ['a long version', { version: `1.2.3-${'a'.repeat(60)}` }],
    ['an extra field', { version: '1.2.3', force: true }],
    ['no version', {}],
    ['a non-object body', ['1.2.3']],
  ])('answers usage for %s', async (_name, body) => {
    const { app } = await server({ productVersion: '1.2.3' });
    try {
      expectProblem(await app.inject(reload(body)), 'usage', RELOAD_USAGE);
    } finally {
      await app.close();
    }
  });

  it('answers version_mismatch for a version the daemon does not run', async () => {
    const { app, store } = await server({ productVersion: '1.2.3' });
    try {
      expectProblem(
        await app.inject(reload({ version: '1.2.4' })),
        'version_mismatch',
        'The daemon runs 1.2.3. Run `board service restart` to start the installed version.',
      );
      expect(await store.db.selectFrom('outbox').selectAll().execute()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('queues the message once per live session for the running version without identity', async () => {
    const { app, store } = await server({ productVersion: '1.2.3-rc.1' });
    try {
      const first = await app.inject(reload({ version: '1.2.3-rc.1' }));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        ok: true,
        requestId: first.headers['x-request-id'],
        value: { version: '1.2.3-rc.1', queued: 3 },
      });
      const rows = await store.db.selectFrom('outbox').select('payload').execute();
      expect(rows.map((row) => JSON.parse(row.payload) as unknown)).toContainEqual(
        expect.objectContaining({ session: 'alpha', queuedAt: new Date(NOW).toISOString() }),
      );
      const again = await app.inject(reload({ version: '1.2.3-rc.1' }));
      expect(again.json()).toMatchObject({ value: { version: '1.2.3-rc.1', queued: 0 } });
    } finally {
      await app.close();
    }
  });
});

describe('POST /v1/skills/reloads', () => {
  it.each([
    ['no sessions', { version: '1.2.3', sessions: [] }],
    [
      '201 sessions',
      { version: '1.2.3', sessions: Array.from({ length: 201 }, (_, i) => `s-${String(i)}`) },
    ],
    ['a session id with a slash', { version: '1.2.3', sessions: ['alpha/beta'] }],
    ['a session id over 128 characters', { version: '1.2.3', sessions: ['a'.repeat(129)] }],
    ['a missing version', { sessions: ['alpha'] }],
    ['a bad version', { version: 'latest', sessions: ['alpha'] }],
    ['an extra field', { version: '1.2.3', sessions: ['alpha'], all: true }],
  ])('answers usage for %s', async (_name, body) => {
    const { app } = await server({ productVersion: '1.2.3' });
    try {
      expectProblem(await app.inject(reloads(body)), 'usage', RELOADS_USAGE);
    } finally {
      await app.close();
    }
  });

  it('answers only for named sessions with a record and keeps ids out of the logged URL', async () => {
    const logRequest = vi.fn<ApiOptions['logRequest']>();
    const { app } = await server({ productVersion: '1.2.3', logRequest });
    try {
      await app.inject(reload({ version: '1.2.3' }));
      const response = await app.inject(
        reloads({ version: '1.2.3', sessions: ['gamma', 'alpha', 'never'] }),
      );
      expect(response.statusCode).toBe(200);
      const queuedAt = new Date(NOW).toISOString();
      expect(response.json()).toEqual({
        ok: true,
        requestId: response.headers['x-request-id'],
        value: {
          version: '1.2.3',
          sessions: [
            { id: 'alpha', state: 'pending', queuedAt },
            { id: 'gamma', state: 'pending', queuedAt },
          ],
        },
      });
      expect(logRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: '/v1/skills/reloads', status: 200 }),
      );
    } finally {
      await app.close();
    }
  });

  it('answers without a product version and returns nothing for another version', async () => {
    const { app } = await server();
    try {
      const response = await app.inject(reloads({ version: '1.2.3', sessions: ['alpha'] }));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ value: { version: '1.2.3', sessions: [] } });
    } finally {
      await app.close();
    }
  });
});
