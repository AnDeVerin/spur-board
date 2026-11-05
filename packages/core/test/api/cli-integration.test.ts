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
        .select(['id', 'line_outbox_id', 'cleared_at'])
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
      expect(JSON.parse(edits[0]?.payload ?? '{}')).toMatchObject({ text: '✓ cleared' });
    } finally {
      try {
        await app?.close();
      } finally {
        await store.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
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
