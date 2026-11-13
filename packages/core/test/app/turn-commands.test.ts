import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  err,
  ok,
  type ActorId,
  type ColumnId,
  type PollPrError,
  type PrFacts,
  type PrPoller,
} from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  openStore,
  type Store,
} from '../../src/index.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { closeTurns, openTurn } from '../../src/app/turns.ts';

const AT = '2026-11-04T08:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const REV_1: ActorId = 'agent:rev/rev-1';
const REV_2: ActorId = 'agent:rev/rev-2';
const QA_1: ActorId = 'agent:qa/qa-1';
const WORKER_1: ActorId = 'agent:worker/worker-1';
const SOURCE = 'github:proj:o/r';
const TABLES = [
  'task',
  'turn',
  'submission',
  'block',
  'notification',
  'outbox',
  'command',
  'event',
  'link',
  'pr_snapshot',
] as const;

type PollPr = PrPoller['pollPr'];

/** Every table but the journal, for a denial that may add only `operation_denied`. */
const withoutEvents = (snapshot: readonly unknown[]) =>
  snapshot.filter((_rows, index) => TABLES[index] !== 'event');

function board(reviewOrchestrator = 'rev', mode: 'shadow' | 'on' = 'shadow') {
  return configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [
          { name: 'worker', role: 'worker' },
          { name: 'rev', role: 'worker' },
          { name: 'qa', role: 'worker' },
        ],
        columns: [
          { id: 'todo', orchestrator: 'none' },
          { id: 'ready-for-dev', orchestrator: 'none' },
          { id: 'dev', orchestrator: 'none' },
          { id: 'review', orchestrator: reviewOrchestrator },
          { id: 'qa', orchestrator: 'qa' },
          { id: 'ready-to-merge', orchestrator: 'none' },
          { id: 'done', orchestrator: 'none' },
        ],
        dispatcher: { mode },
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
}

function prFact(headSha: string, patch: Partial<PrFacts> = {}): PrFacts {
  return {
    repo: 'o/r',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'Work',
    author: 'worker',
    headSha,
    headBranch: 'work',
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: [],
    updatedAt: AT,
    ...patch,
  };
}

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup(
  options: {
    column?: ColumnId;
    reviewOrchestrator?: string;
    noPoller?: boolean;
    mode?: 'shadow' | 'on';
    /** GitHub and Spur count as polled to the end since start, so the dispatcher decides. */
    complete?: boolean;
    pr?: Partial<PrFacts>;
  } = {},
) {
  const config = board(options.reviewOrchestrator, options.mode);
  const clock = { now: () => Date.parse(AT) };
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-turn-')), 'board.db'));
  stores.push(store);
  await store.transaction(async (trx) => {
    await trx
      .insertInto('task')
      .values({
        project: 'proj',
        tracker_kind: 'github-issues',
        tracker_id: 'o/r#9',
        key: 'o/r#9',
        membership: 'active',
        archive_reason: null,
        column: options.column ?? 'review',
        shadow_column: null,
        created_at: AT,
        last_change_at: null,
        terminal_at: null,
        archive_slot_at: null,
      })
      .execute();
    for (const [id, project] of [
      ['worker-1', 'worker'],
      ['rev-1', 'rev'],
      ['rev-2', 'rev'],
      ['qa-1', 'qa'],
    ] as const) {
      await trx
        .insertInto('session_snapshot')
        .values({
          id,
          spur_project: project,
          branch: null,
          pr: null,
          raw_state: 'running',
          state: 'waiting',
          first_seen: AT,
          last_seen: AT,
          ended_at: null,
          end_reason: null,
          detail: JSON.stringify({
            id,
            spurProject: project,
            branch: null,
            pr: null,
            links: {},
            lifecycle: 'running',
            health: 'waiting',
            healthSince: AT,
            lastActivityAt: null,
            endedAt: null,
            endReason: null,
          }),
          source: 'spur',
          observed_at: AT,
          absent_since: null,
        })
        .execute();
    }
    for (const [session, role] of [
      ['worker-1', 'worker'],
      ['rev-1', 'orchestrator'],
    ] as const) {
      await trx
        .insertInto('link')
        .values({
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: session,
          role,
          source: 'manual',
          created_at: AT,
          ticket_key: null,
          pr_open: null,
        })
        .execute();
    }
    await trx
      .insertInto('link')
      .values({
        task_id: 1,
        entity: 'pr',
        repo: 'o/r',
        number: 7,
        pr_state: 'active',
        session_id: null,
        role: null,
        source: 'manual',
        created_at: AT,
        ticket_key: null,
        pr_open: 1,
      })
      .execute();
  });
  const core = createObservationCore({ store, config, clock });
  const observe = (headSha: string) =>
    core.observe(SOURCE, {
      batch: {
        source: SOURCE,
        observedAt: AT,
        complete: false,
        items: [{ kind: 'pr', facts: prFact(headSha, options.pr) }],
        entities: [],
      },
      effectiveComplete: false,
      state: { gone: [] },
      outcomes: [],
    });
  await observe(A);

  const calls: Parameters<PollPr>[] = [];
  let afterPoll: Awaited<ReturnType<typeof tables>> | undefined;
  let answer: () => ReturnType<PollPr> = () => Promise.reject(new Error('No poll expected'));
  const pollPr: PollPr = async (...args) => {
    calls.push(args);
    const result = await answer();
    afterPoll = await tables();
    return result;
  };
  const registry = createOperationRegistry({
    config,
    clock,
    completeSince: new Map(
      options.complete === true
        ? [
            [SOURCE, AT],
            ['spur', AT],
          ]
        : [],
    ),
    ...(options.noPoller === true ? {} : { prPoller: () => pollPr }),
  });
  const apply = createApply({ store, clock, config });

  async function tables() {
    return Promise.all(TABLES.map((table) => store.db.selectFrom(table).selectAll().execute()));
  }

  return {
    store,
    config,
    calls,
    tables,
    afterPoll: () => afterPoll,
    /** The poll commits `headSha` through the real core, then answers ok. */
    commits(headSha: string) {
      answer = async () => {
        await observe(headSha);
        return ok({ status: 'ok' as const, facts: prFact(headSha, options.pr), observedAt: AT });
      };
    },
    answers(result: Awaited<ReturnType<PollPr>>) {
      answer = () => Promise.resolve(result);
    },
    async openTurn() {
      return scanTransaction(store, config, async (trx) => {
        const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
        return openTurn(trx, { task, reason: 'Review', handed: [], at: new Date(AT), config });
      });
    },
    ack: (actor: ActorId, turn = 'T1') =>
      apply(registry['inbox.ack'], { entries: [{ id: turn }] }, actor, `ack-${actor}-${turn}`),
    /** A raw submission row, as an earlier visit's submit or mark left it. */
    submitted: (column: ColumnId, sha: string, author: ActorId) =>
      store.transaction(async (trx) => {
        await trx
          .insertInto('submission')
          .values({
            task_id: 1,
            column,
            epoch: 0,
            commit_sha: sha,
            author,
            submitted_at: AT,
            note: null,
          })
          .execute();
      }),
    submit: (actor: ActorId, sha: string, key: string, turn = 'T1') =>
      apply(registry['task.submit'], { turn, sha }, actor, key),
    /** A submit through its own `createApply`, as each daemon request builds one. */
    submitAlone: (actor: ActorId, sha: string, key: string, turn = 'T1') =>
      createApply({ store, clock, config })(registry['task.submit'], { turn, sha }, actor, key),
    return: (actor: ActorId, key: string, turn = 'T1') =>
      apply(registry['task.return'], { turn, reason: 'Handle the empty list.' }, actor, key),
    events: async () =>
      (await store.db.selectFrom('event').select(['kind', 'payload']).orderBy('id').execute()).map(
        (row) => ({ kind: row.kind, payload: JSON.parse(row.payload) as unknown }),
      ),
    turn: () => store.db.selectFrom('turn').selectAll().executeTakeFirstOrThrow(),
    task: () => store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow(),
  };
}

/** A review turn taken by rev-1. */
async function taken(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  await ctx.openTurn();
  await ctx.ack(REV_1);
  return ctx;
}

describe('task.submit', () => {
  it('accepts a head the board saw only through the poll', async () => {
    const ctx = await taken();
    ctx.commits(B);

    await expect(ctx.submit(REV_1, B, 'submit-1')).resolves.toEqual({
      task: { key: 'o/r#9', project: 'proj', column: 'review', membership: 'active' },
      turn: 'T1',
      sha: B,
    });

    const task = await ctx.task();
    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select(['column', 'epoch', 'commit_sha', 'author'])
        .execute(),
    ).toEqual([{ column: 'review', epoch: task.column_epoch, commit_sha: B, author: REV_1 }]);
    expect(await ctx.turn()).toMatchObject({ closed_reason: 'submitted', closed_at: AT });
    expect(task.column).toBe('review');
    expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([
      { kind: 'task_submitted', payload: { turn: 'T1', column: 'review', sha: B } },
    ]);
    expect(ctx.calls).toEqual([
      [SOURCE, { kind: 'pr', repo: 'o/r', number: 7 }, { timeoutMs: 10_000 }],
    ]);

    await expect(ctx.submit(REV_1, B, 'submit-2')).rejects.toMatchObject({ code: 'turn_closed' });
    ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));
    await expect(ctx.submit(REV_1, B, 'submit-1')).resolves.toMatchObject({ turn: 'T1', sha: B });
    expect(ctx.calls).toHaveLength(1);
  });

  it('refuses a stored key reused for a new turn without polling', async () => {
    const ctx = await taken();
    ctx.commits(B);
    await ctx.submit(REV_1, B, 'submit-1');
    const turn = `T${String((await ctx.openTurn()).id)}`;
    await ctx.ack(REV_1, turn);
    const before = await ctx.tables();

    await expect(ctx.submit(REV_1, B, 'submit-1', turn)).rejects.toMatchObject({
      code: 'idempotency_key_mismatch',
    });

    expect(ctx.calls).toHaveLength(1);
    expect(await ctx.tables()).toEqual(before);
  });

  it('polls once for concurrent submits with one key', async () => {
    const ctx = await taken();
    ctx.commits(B);

    const [first, second] = await Promise.all([
      ctx.submit(REV_1, B, 'submit-1'),
      ctx.submit(REV_1, B, 'submit-1'),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ turn: 'T1', sha: B });
    expect(ctx.calls).toHaveLength(1);
  });

  it('polls once for concurrent same-key submits through separate applies', async () => {
    const ctx = await taken();
    ctx.commits(B);

    const [first, second] = await Promise.all([
      ctx.submitAlone(REV_1, B, 'submit-1'),
      ctx.submitAlone(REV_1, B, 'submit-1'),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ turn: 'T1', sha: B });
    expect(ctx.calls).toHaveLength(1);
  });

  it('refuses a stale sha', async () => {
    const ctx = await taken();
    ctx.commits(B);

    await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({
      code: 'head_mismatch',
    });

    expect(ctx.calls).toHaveLength(1);
    expect(await ctx.tables()).toEqual(ctx.afterPoll());
    expect(await ctx.store.db.selectFrom('submission').selectAll().execute()).toEqual([]);
    expect((await ctx.turn()).closed_at).toBeNull();
    expect(
      (await ctx.store.db.selectFrom('pr_snapshot').select('head_sha').executeTakeFirstOrThrow())
        .head_sha,
    ).toBe(B);
  });

  it('refuses a task with no active pull request without polling', async () => {
    const ctx = await taken();
    await ctx.store.transaction(async (trx) => {
      await trx.updateTable('link').set({ banned: 1 }).where('entity', '=', 'pr').execute();
    });
    const before = await ctx.tables();

    await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({
      code: 'head_mismatch',
      hint: 'The task has no active pull request; ask the operator to link it with `board link`, then submit its head.',
    });

    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(before);
  });

  const unavailable: { name: string; result?: Awaited<ReturnType<PollPr>> }[] = [
    ...(
      [
        { kind: 'timeout', message: 'GitHub timed out' },
        { kind: 'blind', reason: 'auth', message: 'Bad token' },
        {
          kind: 'failed',
          adapterKind: 'throttled',
          retryAt: '2026-11-04T08:05:00.000Z',
          message: 'Throttled',
        },
        { kind: 'stopped', message: 'Stopped' },
        { kind: 'unknown_source', message: 'Unknown source' },
        { kind: 'unsupported', message: 'Unsupported' },
      ] satisfies PollPrError[]
    ).map((error) => ({ name: error.kind, result: err(error) })),
    { name: 'not_found', result: ok({ status: 'not_found' as const, observedAt: AT }) },
    { name: 'no poller' },
  ];
  it.each(unavailable)('answers github_unavailable for $name', async ({ name, result }) => {
    const ctx = await taken({ noPoller: name === 'no poller' });
    if (result !== undefined) ctx.answers(result);
    const before = await ctx.tables();

    const refused = ctx.submit(REV_1, A, 'submit-1');

    await expect(refused).rejects.toMatchObject({ code: 'github_unavailable' });
    expect(ctx.calls).toHaveLength(name === 'no poller' ? 0 : 1);
    expect(await ctx.tables()).toEqual(before);
  });

  it('names the poll timeout it waited for in the timeout hint', async () => {
    const ctx = await taken();
    ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));

    const refused = ctx.submit(REV_1, A, 'submit-1');

    await expect(refused).rejects.toMatchObject({
      code: 'github_unavailable',
      hint: 'GitHub did not answer for o/r#7 within 10 s; wait, then submit again.',
    });
    expect(ctx.calls).toEqual([
      [SOURCE, { kind: 'pr', repo: 'o/r', number: 7 }, { timeoutMs: 10_000 }],
    ]);
  });
  describe('shadow submit', () => {
    it('submits a shadow task by its key', async () => {
      const ctx = await setup();
      ctx.commits(B);

      await expect(ctx.submit(REV_1, B, 'submit-1', 'o/r#9')).resolves.toEqual({
        task: { key: 'o/r#9', project: 'proj', column: 'review', membership: 'active' },
        turn: null,
        sha: B,
      });

      expect(
        await ctx.store.db
          .selectFrom('submission')
          .select(['column', 'epoch', 'commit_sha', 'author'])
          .execute(),
      ).toEqual([{ column: 'review', epoch: 0, commit_sha: B, author: REV_1 }]);
      expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([
        { kind: 'task_submitted', payload: { column: 'review', sha: B } },
      ]);
      expect(await ctx.store.db.selectFrom('turn').selectAll().execute()).toEqual([]);
      expect(ctx.calls).toEqual([
        [SOURCE, { kind: 'pr', repo: 'o/r', number: 7 }, { timeoutMs: 10_000 }],
      ]);
    });

    it('submits a shadow task by its short repo#N key', async () => {
      const ctx = await setup();
      ctx.commits(B);

      await expect(ctx.submit(REV_1, B, 'submit-1', 'r#9')).resolves.toMatchObject({
        task: { key: 'o/r#9', column: 'review' },
        turn: null,
        sha: B,
      });

      expect(
        await ctx.store.db.selectFrom('submission').select(['column', 'commit_sha']).execute(),
      ).toEqual([{ column: 'review', commit_sha: B }]);
      expect(ctx.calls).toHaveLength(1);
    });

    it('refuses a session that does not execute the column', async () => {
      const ctx = await setup();
      ctx.commits(B);
      const before = await ctx.tables();

      for (const actor of [QA_1, WORKER_1]) {
        await expect(ctx.submit(actor, B, `submit-${actor}`, 'o/r#9')).rejects.toMatchObject({
          code: 'forbidden',
        });
      }

      expect(ctx.calls).toHaveLength(0);
      expect(withoutEvents(await ctx.tables())).toEqual(withoutEvents(before));
    });

    it('refuses a stale sha', async () => {
      const ctx = await setup();
      ctx.commits(B);

      await expect(ctx.submit(REV_1, A, 'submit-1', 'o/r#9')).rejects.toMatchObject({
        code: 'head_mismatch',
      });

      expect(ctx.calls).toHaveLength(1);
      expect(await ctx.store.db.selectFrom('submission').selectAll().execute()).toEqual([]);
    });

    it('refuses a task key while the dispatcher is on', async () => {
      const ctx = await setup({ mode: 'on' });
      ctx.commits(B);
      const before = await ctx.tables();

      await expect(ctx.submit(REV_1, B, 'submit-1', 'o/r#9')).rejects.toMatchObject({
        code: 'wrong_id_kind',
      });

      expect(ctx.calls).toHaveLength(0);
      expect(await ctx.tables()).toEqual(before);
    });
  });
});

describe('turn refusals', () => {
  it('refuses a closed turn', async () => {
    const ctx = await taken();
    await scanTransaction(ctx.store, ctx.config, (trx) =>
      closeTurns(trx, { taskId: 1, reason: 'moved', at: new Date(AT) }),
    );
    const before = await ctx.tables();

    await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({ code: 'turn_closed' });
    await expect(ctx.return(REV_1, 'return-1')).rejects.toMatchObject({ code: 'turn_closed' });

    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(before);
  });

  it('refuses a turn of an earlier visit', async () => {
    const ctx = await taken();
    await ctx.store.transaction(async (trx) => {
      await trx.updateTable('task').set({ column_epoch: 1 }).execute();
    });
    const before = await ctx.tables();

    await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({ code: 'turn_closed' });
    await expect(ctx.return(REV_1, 'return-1')).rejects.toMatchObject({ code: 'turn_closed' });

    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(before);
  });

  it('refuses a late call after a return', async () => {
    const ctx = await taken();
    await ctx.return(REV_1, 'return-1');
    const before = await ctx.tables();

    await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({ code: 'turn_closed' });
    await expect(ctx.return(REV_1, 'return-2')).rejects.toMatchObject({ code: 'turn_closed' });

    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(before);
  });

  it('refuses another session and an untaken turn', async () => {
    const untaken = await setup();
    await untaken.openTurn();
    const fresh = await untaken.tables();
    await expect(untaken.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({
      code: 'not_turn_taker',
    });
    await expect(untaken.return(REV_1, 'return-1')).rejects.toMatchObject({
      code: 'not_turn_taker',
    });
    expect(untaken.calls).toHaveLength(0);
    expect(await untaken.tables()).toEqual(fresh);

    const ctx = await taken();
    const before = await ctx.tables();
    await expect(ctx.submit(REV_2, A, 'submit-1')).rejects.toMatchObject({
      code: 'not_turn_taker',
    });
    await expect(ctx.return(REV_2, 'return-1')).rejects.toMatchObject({
      code: 'not_turn_taker',
    });
    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(before);

    await ctx.ack(REV_2);
    const takenOver = await ctx.tables();
    await expect(ctx.submit(REV_1, A, 'submit-2')).rejects.toMatchObject({
      code: 'not_turn_taker',
    });
    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(takenOver);
  });

  it('polls nothing for a caller the grants deny', async () => {
    const ctx = await setup({ reviewOrchestrator: 'none' });
    expect((await ctx.openTurn()).role).toBe('worker');
    await ctx.ack(WORKER_1);
    await ctx.store.transaction(async (trx) => {
      await trx
        .updateTable('link')
        .set({ banned: 1 })
        .where('session_id', '=', 'worker-1')
        .execute();
    });
    const before = await ctx.events();
    const unchanged = await ctx.tables();

    await expect(ctx.submit(WORKER_1, A, 'submit-1')).rejects.toMatchObject({
      code: 'forbidden',
    });

    expect(ctx.calls).toHaveLength(0);
    expect((await ctx.events()).slice(before.length).map((event) => event.kind)).toEqual([
      'operation_denied',
    ]);
    expect(withoutEvents(await ctx.tables())).toEqual(withoutEvents(unchanged));
  });
});

describe('task.return', () => {
  it('returns the task to Dev with a code block on the worker', async () => {
    const ctx = await taken();
    const epoch = (await ctx.task()).column_epoch;
    const seen = (await ctx.events()).length;

    const result = await ctx.return(REV_1, 'return-1');

    expect(result).toMatchObject({
      task: { key: 'o/r#9', column: 'dev' },
      block: {
        id: 'B1',
        type: 'code',
        state: 'open',
        author: REV_1,
        addressee: 'worker',
        reason: 'Handle the empty list.',
      },
    });
    expect(await ctx.task()).toMatchObject({
      column: 'dev',
      column_epoch: epoch + 1,
      left_moves: 1,
      last_change_at: AT,
    });
    expect(await ctx.store.db.selectFrom('block').selectAll().execute()).toEqual([
      expect.objectContaining({
        type: 'code',
        state: 'open',
        addressee_role: 'worker',
        reason: 'Handle the empty list.',
      }),
    ]);
    expect(
      await ctx.store.db
        .selectFrom('notification')
        .select(['kind', 'role', 'block_id'])
        .where('kind', '=', 'block')
        .execute(),
    ).toEqual([{ kind: 'block', role: 'worker', block_id: 1 }]);
    expect(await ctx.store.db.selectFrom('outbox').selectAll().execute()).toEqual([]);
    expect((await ctx.events()).slice(seen)).toEqual([
      { kind: 'block_opened', payload: { block: 'B1', type: 'code', addressee: 'worker' } },
      { kind: 'task_moved', payload: { from: 'review', to: 'dev', turn: 'T1', block: 'B1' } },
    ]);
    expect(await ctx.turn()).toMatchObject({ closed_reason: 'moved', closed_at: AT });
    expect(ctx.calls).toHaveLength(0);
  });

  it('voids the submits of Dev and right of it and keeps review marks', async () => {
    const green = { name: 'ci', state: 'success' as const, completedAt: AT };
    const ctx = await taken({
      mode: 'on',
      complete: true,
      pr: { requiredChecks: [green], feedback: [], feedbackComplete: true },
    });
    await ctx.submitted('dev', A, WORKER_1);
    await ctx.submitted('review', A, REV_1);
    await ctx.submitted('qa', A, QA_1);

    await expect(ctx.return(REV_1, 'return-1')).resolves.toMatchObject({
      task: { column: 'dev' },
    });

    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select(['column', 'voided_at'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { column: 'dev', voided_at: AT },
      { column: 'review', voided_at: null },
      { column: 'qa', voided_at: AT },
    ]);
    expect(await ctx.task()).toMatchObject({ column: 'dev', column_epoch: 1 });
    expect(
      await ctx.store.db
        .selectFrom('turn')
        .select(['id', 'column', 'role', 'reason'])
        .where('closed_at', 'is', null)
        .execute(),
    ).toEqual([{ id: 2, column: 'dev', role: 'worker', reason: 'dev: no_submit_on_head' }]);
    expect(
      await ctx.store.db
        .selectFrom('notification')
        .select(['kind', 'block_id', 'turn_id'])
        .where('role', '=', 'worker')
        .orderBy('id')
        .execute(),
    ).toEqual([
      { kind: 'block', block_id: 1, turn_id: null },
      { kind: 'turn', block_id: null, turn_id: 2 },
    ]);
  });

  it.each(['dev', 'done'] as const)('refuses a return from %s', async (column) => {
    const ctx = await setup({ column });
    expect((await ctx.openTurn()).role).toBe('worker');
    await ctx.ack(WORKER_1);
    const before = await ctx.tables();

    await expect(ctx.return(WORKER_1, 'return-1')).rejects.toMatchObject({
      code: 'return_not_allowed',
    });

    expect(await ctx.tables()).toEqual(before);
  });

  it("refuses another column's orchestrator", async () => {
    const ctx = await taken();
    const before = await ctx.events();
    const unchanged = await ctx.tables();

    await expect(ctx.return(QA_1, 'return-1')).rejects.toMatchObject({ code: 'forbidden' });

    expect((await ctx.events()).slice(before.length).map((event) => event.kind)).toEqual([
      'operation_denied',
    ]);
    expect(withoutEvents(await ctx.tables())).toEqual(withoutEvents(unchanged));
  });
});
