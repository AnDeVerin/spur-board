import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ActorId } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandError,
  createApiServer,
  listenApiServer,
  openStore,
  type Mutation,
  type ApiOptions,
  type OperationRegistry,
  type Query,
  type Store,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'worker', role: 'worker' }],
    },
    {
      id: 'other',
      tracker: { type: 'github-issues', repo: 'x/y', milestone: 'M1' },
      repos: ['x/y'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'foreign', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});

const stores: Store[] = [];
function newStore(): Store {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-api-ops-')), 'board.db'));
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const host = '127.0.0.1:4311';
function post(input: unknown, operation = 'task.get', headers: Record<string, string> = {}) {
  return {
    method: 'POST' as const,
    url: `/v1/ops/${operation}`,
    headers: {
      host,
      'content-type': 'application/json',
      'x-board-session': 'session-1',
      ...headers,
    },
    payload: JSON.stringify({ input }),
  };
}

async function server(
  store: Store,
  options: {
    ready?: () => boolean;
    registry?: OperationRegistry;
    logRequest?: ApiOptions['logRequest'];
  } = {},
) {
  return createApiServer({
    store,
    config,
    port: 4311,
    ready: options.ready ?? (() => true),
    clock: { now: () => Date.parse('2026-11-04T08:00:00.000Z') },
    lookupSession: () => Promise.resolve({ project: 'worker', status: 'running' }),
    verifyToken: () => Promise.resolve(true),
    registry: options.registry ?? {},
    logRequest: options.logRequest ?? vi.fn(),
  });
}

const boardTarget = {
  kind: 'found' as const,
  value: {
    project: 'board',
    task: null,
    block: null,
    workers: [],
  },
};

describe('catalog HTTP API', () => {
  it('serves the generated catalog snapshot without identity', async () => {
    const app = await server(newStore());
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/schema', headers: { host } });
      const committed = JSON.parse(
        readFileSync(new URL('../../../contracts/ops.snapshot.json', import.meta.url), 'utf8'),
      ) as unknown;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(committed);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.close();
    }
  });

  it('returns starting before readiness on both routes with a matching request ID', async () => {
    const app = await server(newStore(), { ready: () => false });
    try {
      for (const request of [
        { method: 'GET' as const, url: '/v1/schema', headers: { host } },
        post({ task: 'PROJ-123' }),
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(503);
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.json()).toMatchObject({ code: 'starting', status: 503 });
        expect(response.json()).toMatchObject({ requestId: response.headers['x-request-id'] });
      }
    } finally {
      await app.close();
    }
  });

  it('maps catalog errors to problem JSON with the catalog status and handler hint', async () => {
    const denied: Query<'status.get'> = {
      id: 'status.get',
      resolveTargets() {
        return Promise.resolve([boardTarget]);
      },
      run() {
        return Promise.reject(new CommandError('not_found', 'The requested board was not found.'));
      },
    };
    const app = await server(newStore(), { registry: { 'status.get': denied } });
    try {
      const response = await app.inject(post({}, 'status.get'));
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({
        code: 'not_found',
        hint: 'The requested board was not found.',
        status: 404,
      });
      expect(response.json()).toMatchObject({ requestId: response.headers['x-request-id'] });
    } finally {
      await app.close();
    }
  });

  it.each([
    { input: { task: 'not-an-id' }, code: 'usage' },
    { input: { task: 'B12' }, code: 'wrong_id_kind' },
  ])('validates input as $code before dispatch', async ({ input, code }) => {
    const app = await server(newStore());
    try {
      const response = await app.inject(post(input));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code, status: 400 });
    } finally {
      await app.close();
    }
  });

  it('reports an unregistered catalog operation as unavailable in this build', async () => {
    const app = await server(newStore());
    try {
      const response = await app.inject(post({ task: 'PROJ-123' }));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 'unexpected' });
      expect(response.body).toContain('task.get is not available in this build');
    } finally {
      await app.close();
    }
  });

  it('passes parsed input, actor and key through a registered app mutation', async () => {
    const seen = vi.fn();
    const add: Mutation<'task.add'> = {
      id: 'task.add',
      resolveTargets() {
        return Promise.resolve([]);
      },
      run(_trx, input, ctx) {
        seen(input, ctx.actor);
        return Promise.resolve({
          task: { key: input.task, project: 'board', column: 'todo', membership: 'active' },
        });
      },
    };
    const store = newStore();
    const app = await server(store, { registry: { 'task.add': add } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/task.add',
        headers: { host, 'content-type': 'application/json', authorization: 'Bearer accepted' },
        payload: JSON.stringify({ input: { task: 'PROJ-123' }, key: 'add-1' }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        result: {
          task: { key: 'PROJ-123', project: 'board', column: 'todo', membership: 'active' },
        },
      });
      expect(seen).toHaveBeenCalledExactlyOnceWith(
        { task: 'PROJ-123' },
        'operator' satisfies ActorId,
      );
      expect(await store.db.selectFrom('command').select(['key', 'actor']).execute()).toEqual([
        { key: 'add-1', actor: 'operator' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('denies a foreign project task.get before its test handler reads and journals the refusal', async () => {
    const store = newStore();
    await store.transaction(async (trx) => {
      await trx
        .insertInto('task')
        .values({
          ...sampleRows.task,
          project: 'other',
          key: 'x/y#202',
          tracker_id: '202',
        })
        .execute();
    });
    const read = vi.fn();
    const taskGet: Query<'task.get'> = {
      id: 'task.get',
      async resolveTargets(trx, input) {
        const row = await trx
          .selectFrom('task')
          .select(['id', 'project', 'column'])
          .where('key', '=', input.task)
          .executeTakeFirst();
        return row === undefined
          ? [{ kind: 'missing' as const }]
          : [
              {
                kind: 'found' as const,
                value: {
                  project: row.project,
                  task: { id: row.id, column: row.column },
                  block: null,
                  workers: [],
                },
              },
            ];
      },
      run() {
        read();
        return Promise.reject(new Error('The foreign task must not be read'));
      },
    };
    const app = await server(store, { registry: { 'task.get': taskGet } });
    try {
      const response = await app.inject(post({ task: 'x/y#202' }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'forbidden' });
      expect(read).not.toHaveBeenCalled();
      expect(
        await store.db.selectFrom('event').select(['kind', 'project', 'task_id']).execute(),
      ).toEqual([{ kind: 'operation_denied', project: 'other', task_id: 1 }]);
    } finally {
      await app.close();
    }
  });

  it('does not run a scoped query when its handler resolves no authorization target', async () => {
    const read = vi.fn();
    const statusGet: Query<'status.get'> = {
      id: 'status.get',
      resolveTargets() {
        return Promise.resolve([]);
      },
      run() {
        read();
        return Promise.resolve({ tasks: [] });
      },
    };
    const app = await server(newStore(), { registry: { 'status.get': statusGet } });
    try {
      const response = await app.inject(post({}, 'status.get'));
      expect(response.statusCode).toBe(404);
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('propagates one request ID through response headers and request logs', async () => {
    const logRequest = vi.fn();
    const app = await server(newStore(), { logRequest });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/schema', headers: { host } });
      expect(logRequest).toHaveBeenCalledExactlyOnceWith({
        requestId: response.headers['x-request-id'],
        method: 'GET',
        url: '/v1/schema',
        status: 200,
      });
      const notFound = await app.inject({ method: 'GET', url: '/missing', headers: { host } });
      expect(notFound.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.close();
    }
  });

  it('listens only through the loopback helper', async () => {
    const app = await server(newStore());
    try {
      await listenApiServer(app, 0);
      const address = app.server.address();
      expect(address).not.toBeNull();
      expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
    } finally {
      await app.close();
    }
  });
});
