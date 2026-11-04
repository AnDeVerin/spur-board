import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  renderHttpProblem,
  type ActorId,
  type ServerErrorCode,
} from '@spur-board/contracts';
import type { FastifyInstance } from 'fastify';
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
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function expectProblem(response: InjectResponse, code: ServerErrorCode, hint?: string): void {
  const requestId = response.headers['x-request-id'];
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  const expected = renderHttpProblem({ code, requestId: String(requestId) });
  expect(response.statusCode).toBe(expected.status);
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(response.json()).toEqual(hint === undefined ? expected.body : { ...expected.body, hint });
}

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
    port?: number;
    ready?: () => boolean;
    registry?: OperationRegistry;
    logRequest?: ApiOptions['logRequest'];
  } = {},
) {
  return createApiServer({
    store,
    config,
    port: options.port ?? 4311,
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
        expectProblem(response, 'starting', 'Wait until the daemon is ready.');
      }
    } finally {
      await app.close();
    }
  });

  it('checks readiness and identity before parsing malformed POST JSON', async () => {
    const store = newStore();
    const logRequest = vi.fn();
    const startingApp = await server(store, { ready: () => false, logRequest });
    const malformed = {
      method: 'POST' as const,
      url: '/v1/ops/task.get',
      headers: { host, 'content-type': 'application/json' },
      payload: '{bad',
    };
    try {
      const response = await startingApp.inject(malformed);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: 'starting',
        requestId: response.headers['x-request-id'],
      });
      expect(logRequest).toHaveBeenCalledWith({
        requestId: response.headers['x-request-id'],
        method: 'POST',
        url: '/v1/ops/task.get',
        status: 503,
      });
      for (const headers of [
        { ...malformed.headers, origin: 'https://outside.example' },
        { ...malformed.headers, host: 'outside.example:4311' },
        { ...malformed.headers, 'content-type': 'text/plain' },
      ]) {
        const guarded = await startingApp.inject({ ...malformed, headers });
        expect(guarded.statusCode).toBe(403);
        expect(guarded.json()).toMatchObject({ code: 'forbidden' });
      }
    } finally {
      await startingApp.close();
    }

    const readyLog = vi.fn();
    const readyApp = await server(store, { logRequest: readyLog });
    try {
      const response = await readyApp.inject(malformed);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'forbidden',
        requestId: response.headers['x-request-id'],
      });
      expect(readyLog).toHaveBeenCalledWith({
        requestId: response.headers['x-request-id'],
        method: 'POST',
        url: '/v1/ops/task.get',
        status: 403,
      });
    } finally {
      await readyApp.close();
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

  it('returns a catalog problem for unknown routes after the request guard', async () => {
    const logRequest = vi.fn();
    const app = await server(newStore(), { logRequest });
    try {
      const response = await app.inject({ method: 'GET', url: '/missing', headers: { host } });
      expectProblem(response, 'not_found', 'This API route is not available.');
      expect(logRequest).toHaveBeenCalledWith({
        requestId: response.headers['x-request-id'],
        method: 'GET',
        url: '/missing',
        status: 404,
      });
      const guarded = await app.inject({
        method: 'GET',
        url: '/missing',
        headers: { host, origin: 'https://outside.example' },
      });
      expectProblem(guarded, 'forbidden', 'Browser origins are not accepted.');
    } finally {
      await app.close();
    }
  });

  it('rejects oversized JSON as usage before dispatch with no side effects', async () => {
    const resolveTargets = vi.fn();
    const app = await server(newStore(), {
      registry: {
        'task.get': {
          id: 'task.get',
          resolveTargets,
          run: vi.fn(),
        },
      },
    });
    try {
      const response = await app.inject({
        ...post({ task: 'PROJ-123' }),
        payload: JSON.stringify({ input: { task: 'PROJ-123', padding: 'x'.repeat(1_048_576) } }),
      });
      expectProblem(response, 'usage', 'Send a smaller JSON body.');
      expect(resolveTargets).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('renders malformed JSON and wrong content type as catalog problems', async () => {
    const app = await server(newStore());
    try {
      const malformed = await app.inject({
        ...post({ task: 'PROJ-123' }),
        payload: '{bad',
      });
      expectProblem(malformed, 'usage');

      const wrongType = await app.inject({
        ...post({ task: 'PROJ-123' }),
        headers: { host, 'x-board-session': 'session-1', 'content-type': 'text/plain' },
      });
      expectProblem(wrongType, 'forbidden', 'Use application/json.');
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
      expectProblem(
        response,
        'not_implemented',
        'Operation task.get is not available in this daemon build. Ask the operator to update the daemon.',
      );
      expect(response.json()).toMatchObject({ recovery: { sideEffects: 'none', maxRetries: 0 } });
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
        ok: true,
        requestId: response.headers['x-request-id'],
        value: {
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
        return Promise.resolve({
          tasks: [],
          items: [],
          unlinkedPrs: [],
          unlinkedSessions: [],
          sources: [],
          warmingUp: true,
          spurUnavailable: null,
          hostLoad: null,
        });
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
    const app = await server(newStore(), { port: 0 });
    try {
      await listenApiServer(app, 0);
      const address = app.server.address();
      expect(address).not.toBeNull();
      expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
      const url = `http://127.0.0.1:${String(address.port)}/v1/schema`;
      expect((await fetch(url)).status).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/schema',
            headers: { host: 'outside.example' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/schema',
            headers: {
              host: `127.0.0.1:${String(address.port)}`,
              origin: 'https://outside.example',
            },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
