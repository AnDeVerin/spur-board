import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPERATIONS,
  configSchema,
  errorEnvelopeSchema,
  roleCanUseOperation,
} from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../../cli/src/cli.ts';
import {
  createApiServer,
  createApply,
  createBlockMutations,
  createOperationRegistry,
  listenApiServer,
  openStore,
  type Query,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

function capture() {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return {
    io,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe('CLI against the real HTTP API', () => {
  it('answers a question whose gateway post was blocked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'board-api-secret-answer-'));
    const store = openStore(join(home, 'board.db'));
    let app: Awaited<ReturnType<typeof createApiServer>> | undefined;
    try {
      const config = configSchema.parse({
        projects: [
          {
            id: 'proj',
            tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
            repos: ['o/r'],
            operatorGithubLogin: 'operator',
            spurProjects: [{ name: 'web', role: 'worker' }],
            columns: [
              { id: 'todo', orchestrator: 'none' },
              { id: 'ready-for-dev', orchestrator: 'none' },
              { id: 'dev', orchestrator: 'none' },
              { id: 'review', orchestrator: 'none' },
              { id: 'qa', orchestrator: 'none' },
              { id: 'ready-to-merge', orchestrator: 'none' },
              { id: 'done', orchestrator: 'none' },
            ],
          },
        ],
        operator: { slack: 'operator' },
        digest: { tz: 'UTC' },
      });
      const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
      await store.transaction((trx) =>
        trx
          .insertInto('task')
          .values({
            ...sampleRows.task,
            key: 'o/r#101',
            project: 'proj',
            column: 'qa',
            membership: 'active',
            archive_reason: null,
          })
          .execute()
          .then(() => undefined),
      );
      const apply = createApply({ store, clock, config });
      const blocked = await apply(
        createBlockMutations(config).ask,
        { task: 'o/r#101', text: ['xoxb', '123', 'abc'].join('-') },
        'agent:web/worker-1',
        'blocked-question',
      );
      expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([
        { kind: 'feed.line' },
      ]);
      const blockedItem = await store.db
        .selectFrom('operator_item')
        .select(['id', 'line_outbox_id', 'cleared_at', 'text'])
        .where('kind', '=', 'post_blocked')
        .executeTakeFirstOrThrow();
      expect(blockedItem.cleared_at).toBeNull();
      app = await createApiServer({
        store,
        config,
        port: 0,
        ready: () => true,
        clock,
        lookupSession: () => Promise.resolve(null),
        verifyToken: (token) =>
          Promise.resolve(token === 'local-test-token' ? { name: 'local' } : null),
        registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
        logRequest: () => {},
      });
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP port.');
      const io = capture();
      expect(
        await runCli(['answer', blocked.block.id, 'Handled locally.', '--json'], {
          clientConfig: {
            address: new URL(`http://127.0.0.1:${String(address.port)}`),
            session: undefined,
            token: 'local-test-token',
            connectTimeoutMs: 2_000,
            responseTimeoutMs: 2_000,
          },
          io: io.io,
        }),
      ).toBe(0);
      expect(JSON.parse(io.stdout)).toMatchObject({ block: { state: 'unblocked' } });
      expect(
        await store.db.selectFrom('block').select('state').where('id', '=', 1).executeTakeFirst(),
      ).toEqual({ state: 'unblocked' });
      expect(
        await store.db
          .selectFrom('operator_item')
          .select('cleared_at')
          .where('id', '=', blockedItem.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ cleared_at: new Date(clock.now()).toISOString() });
      const edits = await store.db
        .selectFrom('outbox')
        .select(['parent_outbox_id', 'payload'])
        .where('kind', '=', 'feed.line.edit')
        .execute();
      expect(edits).toHaveLength(1);
      expect(edits[0]?.parent_outbox_id).toBe(blockedItem.line_outbox_id);
      expect(JSON.parse(edits[0]?.payload ?? '{}')).toMatchObject({
        text: blockedItem.text,
        resolved: { by: 'system', at: new Date(clock.now()).toISOString() },
      });
    } finally {
      try {
        await app?.close();
      } finally {
        await store.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('routes a worker question to a curator session that reads and answers it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'board-api-curator-'));
    const store = openStore(join(home, 'board.db'));
    let app: Awaited<ReturnType<typeof createApiServer>> | undefined;
    try {
      const config = configSchema.parse({
        projects: [
          {
            id: 'proj',
            tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
            repos: ['o/r'],
            operatorGithubLogin: 'operator',
            spurProjects: [
              { name: 'web', role: 'worker' },
              { name: 'cur', role: 'curator' },
            ],
          },
        ],
        operator: { slack: 'operator' },
        digest: { tz: 'UTC' },
      });
      const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
      await store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            ...sampleRows.task,
            key: 'o/r#101',
            project: 'proj',
            column: 'dev',
            membership: 'active',
            archive_reason: null,
          })
          .execute();
      });
      app = await createApiServer({
        store,
        config,
        port: 0,
        ready: () => true,
        clock,
        lookupSession: (id) =>
          Promise.resolve({
            project: id.startsWith('cur-') ? 'cur' : 'web',
            status: 'running',
          }),
        verifyToken: () => Promise.resolve(null),
        registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
        logRequest: () => {},
      });
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP port.');
      const clientConfig = (session: string) => ({
        address: new URL(`http://127.0.0.1:${String(address.port)}`),
        session,
        token: undefined,
        connectTimeoutMs: 2_000,
        responseTimeoutMs: 2_000,
      });

      const asked = capture();
      expect(
        await runCli(['ask', 'o/r#101', 'Which version?', '--json'], {
          clientConfig: clientConfig('worker-1'),
          io: asked.io,
        }),
      ).toBe(0);
      expect(JSON.parse(asked.stdout)).toMatchObject({
        block: { id: 'B1', addressee: 'curator', state: 'open' },
      });

      const inbox = capture();
      expect(
        await runCli(['inbox', '--json'], { clientConfig: clientConfig('cur-1'), io: inbox.io }),
      ).toBe(0);
      expect(JSON.parse(inbox.stdout)).toMatchObject({
        blocks: [{ id: 'B1', addressee: 'curator' }],
      });

      const acked = capture();
      expect(
        await runCli(['inbox', 'ack', 'B1', '--json'], {
          clientConfig: clientConfig('cur-1'),
          io: acked.io,
        }),
      ).toBe(0);
      expect(
        await store.db.selectFrom('notification').select(['kind', 'role', 'acked_at']).execute(),
      ).toEqual([
        { kind: 'block', role: 'curator', acked_at: new Date(clock.now()).toISOString() },
      ]);

      const answered = capture();
      expect(
        await runCli(['answer', 'B1', 'Use v2.', '--json'], {
          clientConfig: clientConfig('cur-1'),
          io: answered.io,
        }),
      ).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({
        block: { state: 'unblocked', unblockedBy: 'agent:cur/cur-1' },
      });
      expect(await store.db.selectFrom('notification').select(['kind', 'role']).execute()).toEqual([
        { kind: 'block', role: 'curator' },
        { kind: 'answer', role: 'worker' },
      ]);
    } finally {
      try {
        await app?.close();
      } finally {
        await store.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('a linked worker neither lists nor acks a held curator answer and cannot ack a curator block before the first ring', async () => {
    const home = mkdtempSync(join(tmpdir(), 'board-api-curator-ack-'));
    const store = openStore(join(home, 'board.db'));
    let app: Awaited<ReturnType<typeof createApiServer>> | undefined;
    try {
      const config = configSchema.parse({
        projects: [
          {
            id: 'proj',
            tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
            repos: ['o/r'],
            operatorGithubLogin: 'operator',
            spurProjects: [
              { name: 'web', role: 'worker' },
              { name: 'cur', role: 'curator' },
            ],
          },
        ],
        operator: { slack: 'operator' },
        digest: { tz: 'UTC' },
      });
      const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
      await store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            ...sampleRows.task,
            key: 'o/r#101',
            project: 'proj',
            column: 'qa',
            membership: 'active',
            archive_reason: null,
          })
          .execute();
        await trx
          .insertInto('link')
          .values({
            ...sampleRows.link,
            entity: 'session',
            repo: null,
            number: null,
            pr_state: null,
            session_id: 'worker-1',
            role: 'worker',
          })
          .execute();
      });
      const apply = createApply({ store, clock, config });
      const ops = createBlockMutations(config);
      const own = await apply(ops.ask, { task: 'o/r#101', text: 'Q?' }, 'agent:cur/cur-1', 'own');
      const answered = await apply(
        ops.answer,
        { block: own.block.id, text: 'A.' },
        'operator',
        'answer',
      );
      const held = await apply(
        ops.ask,
        { task: 'o/r#101', text: 'Q2?' },
        'agent:web/worker-2',
        'q2',
      );
      expect(held.block.addressee).toBe('curator');
      expect(
        await store.db
          .selectFrom('notification')
          .select(['kind', 'role', 'recipient_session'])
          .orderBy('id')
          .execute(),
      ).toEqual([
        { kind: 'answer', role: 'curator', recipient_session: null },
        { kind: 'block', role: 'curator', recipient_session: null },
      ]);
      app = await createApiServer({
        store,
        config,
        port: 0,
        ready: () => true,
        clock,
        lookupSession: (id) =>
          Promise.resolve({ project: id.startsWith('cur-') ? 'cur' : 'web', status: 'running' }),
        verifyToken: () => Promise.resolve(null),
        registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
        logRequest: () => {},
      });
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP port.');
      const asWorker = {
        address: new URL(`http://127.0.0.1:${String(address.port)}`),
        session: 'worker-1',
        token: undefined,
        connectTimeoutMs: 2_000,
        responseTimeoutMs: 2_000,
      };
      const inbox = capture();
      expect(await runCli(['inbox', '--json'], { clientConfig: asWorker, io: inbox.io })).toBe(0);
      expect(JSON.parse(inbox.stdout)).toMatchObject({ comments: [] });
      for (const id of [`${answered.comment.id}@1`, held.block.id]) {
        const acked = capture();
        expect(
          await runCli(['inbox', 'ack', id, '--json'], { clientConfig: asWorker, io: acked.io }),
          id,
        ).not.toBe(0);
        expect(acked.stdout + acked.stderr, id).toContain('forbidden');
      }
      expect(await store.db.selectFrom('notification').select('acked_at').execute()).toEqual([
        { acked_at: null },
        { acked_at: null },
      ]);
    } finally {
      try {
        await app?.close();
      } finally {
        await store.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  describe('with a curator', () => {
    async function curatorApi() {
      const home = mkdtempSync(join(tmpdir(), 'board-api-note-'));
      const store = openStore(join(home, 'board.db'));
      const config = configSchema.parse({
        projects: [
          {
            id: 'proj',
            tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
            repos: ['o/r'],
            operatorGithubLogin: 'operator',
            spurProjects: [
              { name: 'web', role: 'worker' },
              { name: 'cur', role: 'curator' },
            ],
          },
        ],
        operator: { slack: 'operator' },
        digest: { tz: 'UTC' },
      });
      const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
      await store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            ...sampleRows.task,
            key: 'o/r#101',
            project: 'proj',
            column: 'dev',
            membership: 'active',
            archive_reason: null,
          })
          .execute();
      });
      const app = await createApiServer({
        store,
        config,
        port: 0,
        ready: () => true,
        clock,
        lookupSession: (id) =>
          Promise.resolve({ project: id.startsWith('cur-') ? 'cur' : 'web', status: 'running' }),
        verifyToken: () => Promise.resolve(null),
        registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
        logRequest: () => {},
      });
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP port.');
      const board = async (session: string, args: string[]) => {
        const io = capture();
        const code = await runCli([...args, '--json'], {
          clientConfig: {
            address: new URL(`http://127.0.0.1:${String(address.port)}`),
            session,
            token: undefined,
            connectTimeoutMs: 2_000,
            responseTimeoutMs: 2_000,
          },
          io: io.io,
        });
        return { code, stdout: io.stdout };
      };
      const close = async () => {
        try {
          await app.close();
        } finally {
          await store.close();
          rmSync(home, { recursive: true, force: true });
        }
      };
      return { store, board, close };
    }

    it('escalates with a note', async () => {
      const { store, board, close } = await curatorApi();
      try {
        expect((await board('worker-1', ['ask', 'o/r#101', 'Which version?'])).code).toBe(0);
        const escalated = await board('cur-1', ['escalate', 'B1', '--note', 'Owner is away.']);
        expect(escalated.code).toBe(0);
        expect(JSON.parse(escalated.stdout)).toMatchObject({ block: { addressee: 'operator' } });
        const rows = await store.db.selectFrom('outbox').selectAll().orderBy('id').execute();
        expect(rows.map((row) => row.kind)).toEqual(['conversation.open', 'conversation.reply']);
        expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ text: 'Which version?' });
        expect(JSON.parse(rows[1]?.payload ?? '{}')).toMatchObject({ text: 'Owner is away.' });
        expect(rows[1]?.parent_outbox_id).toBe(rows[0]?.id);
      } finally {
        await close();
      }
    });

    it('withdraws from a new curator session', async () => {
      const { board, close } = await curatorApi();
      try {
        expect((await board('cur-1', ['ask', 'o/r#101', 'Which version?'])).code).toBe(0);
        const withdrawn = await board('cur-2', ['unblock', 'B1', '--withdraw', 'Settled.']);
        expect(withdrawn.code).toBe(0);
        expect(JSON.parse(withdrawn.stdout)).toMatchObject({
          block: {
            outcome: 'withdrawn',
            outcomeReason: 'Settled.',
            unblockedBy: 'agent:cur/cur-2',
          },
        });
      } finally {
        await close();
      }
    });
  });

  it('parses task queries and startup without an unknown outcome', async () => {
    const home = mkdtempSync(join(tmpdir(), 'board-api-cli-'));
    let store: ReturnType<typeof openStore> | undefined;
    let app: Awaited<ReturnType<typeof createApiServer>> | undefined;
    try {
      store = openStore(join(home, 'board.db'));
      await store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            id: 1,
            project: 'board',
            tracker_kind: 'github-issues',
            tracker_id: '101',
            key: 'o/r#101',
            membership: 'active',
            archive_reason: null,
            column: 'todo',
            shadow_column: null,
            created_at: '2026-11-04T08:00:00.000Z',
            last_change_at: null,
            terminal_at: null,
            archive_slot_at: null,
          })
          .execute();
        await trx
          .insertInto('link')
          .values({
            task_id: 1,
            entity: 'session',
            repo: null,
            number: null,
            pr_state: null,
            session_id: 'session-1',
            role: 'worker',
            source: 'manual',
            created_at: '2026-11-04T08:00:00.000Z',
          })
          .execute();
        await trx
          .insertInto('block')
          .values({
            id: 1,
            task_id: 1,
            type: 'code',
            reason: 'Inspect checks',
            author: 'operator',
            addressee_role: 'worker',
            target_column: null,
            state: 'open',
            outcome: null,
            outcome_reason: null,
            repeat_of: null,
            unblocked_by: null,
            unblocked_at: null,
            created_at: '2026-11-04T08:00:00.000Z',
          })
          .execute();
        await trx
          .insertInto('event')
          .values({
            at: '2026-11-04T08:00:00.000Z',
            project: 'board',
            task_id: 1,
            kind: 'task_added',
            actor: 'system',
            actor_ref: null,
            payload: '{}',
            v: 1,
            request_id: null,
          })
          .execute();
      });
      let ready = true;
      const statuses: number[] = [];
      const statusGet: Query<'status.get'> = {
        id: 'status.get',
        resolveTargets() {
          return Promise.resolve([
            {
              kind: 'found' as const,
              value: { project: 'board', task: null, block: null, workers: [] },
            },
          ]);
        },
        run() {
          return Promise.resolve({
            tasks: [],
            items: [],
            unlinkedPrs: [],
            unlinkedSessions: [],
            hiddenUnlinkedPrs: 0,
            hiddenUnlinkedSessions: 0,
            sources: [],
            warmingUp: true,
            spurUnavailable: null,
            hostLoad: null,
            transport: [],
          });
        },
      };
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
      const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
      const options = {
        store,
        config,
        port: 0,
        ready: () => ready,
        clock,
        lookupSession: () => Promise.resolve({ project: 'worker', status: 'running' as const }),
        verifyToken: () => Promise.resolve(null),
        registry: {
          ...createOperationRegistry({ config, clock, completeSince: new Map() }),
          'status.get': statusGet,
        },
        logRequest: ({ status }: { status: number }) => {
          statuses.push(status);
        },
      };
      app = await createApiServer(options);
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP port.');
      options.port = address.port;
      const clientConfig = {
        address: new URL(`http://127.0.0.1:${String(address.port)}`),
        session: 'session-1',
        token: undefined,
        connectTimeoutMs: 2_000,
        responseTimeoutMs: 2_000,
      };

      const success = capture();
      expect(await runCli(['status', '--json'], { clientConfig, io: success.io })).toBe(0);
      expect(JSON.parse(success.stdout)).toEqual({
        tasks: [],
        items: [],
        unlinkedPrs: [],
        unlinkedSessions: [],
        hiddenUnlinkedPrs: 0,
        hiddenUnlinkedSessions: 0,
        sources: [],
        warmingUp: true,
        spurUnavailable: null,
        hostLoad: null,
        transport: [],
      });
      expect(success.stderr).toBe('');

      const schema = capture();
      expect(await runCli(['schema', '--json'], { clientConfig, io: schema.io })).toBe(0);
      const schemaValue = JSON.parse(schema.stdout) as { version: string; operations: unknown[] };
      expect(schemaValue.version).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(schemaValue.operations)).toBe(true);
      expect(schema.stderr).toBe('');

      const workerSchema = capture();
      expect(
        await runCli(['schema', '--role', 'worker', '--json'], {
          clientConfig,
          io: workerSchema.io,
        }),
      ).toBe(0);
      const workerOperations = JSON.parse(workerSchema.stdout) as {
        operations: { id: string; cli: { command: string } }[];
      };
      expect(workerOperations.operations.map(({ id, cli }) => [id, cli.command])).toEqual(
        OPERATIONS.filter((operation) => roleCanUseOperation(operation, 'worker')).map(
          (operation) => [operation.id, operation.cli.command],
        ),
      );
      expect(workerOperations.operations.map(({ id }) => id)).not.toContain('token.list');
      expect(workerSchema.stderr).toBe('');

      const task = capture();
      expect(await runCli(['task', 'o/r#101', '--json'], { clientConfig, io: task.io })).toBe(0);
      expect(JSON.parse(task.stdout)).toMatchObject({
        task: { key: 'o/r#101' },
        blocks: [{ id: 'B1' }],
        comments: [],
      });
      const history = capture();
      expect(
        await runCli(['task', 'history', 'o/r#101', '--json'], { clientConfig, io: history.io }),
      ).toBe(0);
      expect(JSON.parse(history.stdout)).toMatchObject({
        task: { key: 'o/r#101' },
        events: [{ kind: 'task_added', actor: 'system' }],
      });
      const inbox = capture();
      expect(await runCli(['inbox', '--json'], { clientConfig, io: inbox.io })).toBe(0);
      expect(JSON.parse(inbox.stdout)).toMatchObject({ comments: [], blocks: [{ id: 'B1' }] });

      ready = false;
      const starting = capture();
      expect(await runCli(['status', '--json'], { clientConfig, io: starting.io })).toBe(3);
      expect(starting.stdout).toBe('');
      expect(errorEnvelopeSchema.parse(JSON.parse(starting.stderr))).toMatchObject({
        ok: false,
        error: { code: 'daemon_unavailable', recovery: { sideEffects: 'none' } },
      });
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 503]);
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          await store?.close();
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    }
  });
});
