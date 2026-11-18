import { createHash } from 'node:crypto';
import {
  configSchema,
  err,
  ok,
  type ActorId,
  type ColumnId,
  type PollPrError,
  type PrFacts,
  type PrPoller,
  type SubmissionBasis,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  reconcileDueDoorbells,
  type Store,
} from '../../src/index.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { returnCounts } from '../../src/app/course-check.ts';
import { closeTurns, openTurn, takeTurn } from '../../src/app/turns.ts';
import { openTempStore } from '../support/store.ts';

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

function board(
  reviewOrchestrator = 'rev',
  mode: 'shadow' | 'on' = 'shadow',
  qaOrchestrator = 'qa',
) {
  return configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [
          { name: 'worker', role: 'worker' },
          { name: 'rev', role: 'orchestrator' },
          { name: 'qa', role: 'orchestrator' },
        ],
        columns: [
          { id: 'todo', orchestrator: 'none' },
          { id: 'ready-for-dev', orchestrator: 'none' },
          { id: 'dev', orchestrator: 'none' },
          { id: 'review', orchestrator: reviewOrchestrator },
          { id: 'qa', orchestrator: qaOrchestrator },
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
    qaOrchestrator?: string;
    noPoller?: boolean;
    mode?: 'shadow' | 'on';
    /** GitHub and Spur count as polled to the end since start, so the dispatcher decides. */
    complete?: boolean;
    /** When GitHub and Spur last completed a poll, with `complete`; default `AT`. */
    completeAt?: string;
    pr?: Partial<PrFacts>;
  } = {},
) {
  const config = board(options.reviewOrchestrator, options.mode, options.qaOrchestrator);
  const clock = { now: () => Date.parse(AT) };
  const store = openTempStore('board-turn-').store;
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
            [SOURCE, options.completeAt ?? AT],
            ['spur', options.completeAt ?? AT],
          ]
        : [],
    ),
    ...(options.noPoller === true ? {} : { prPoller: () => pollPr }),
  });
  const apply = createApply({ store, clock, config });
  const query = createQuery({ store, clock, config });

  async function tables() {
    return Promise.all(TABLES.map((table) => store.db.selectFrom(table).selectAll().execute()));
  }

  return {
    store,
    config,
    observe,
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
    submit: (
      actor: ActorId,
      sha: string,
      key: string,
      turn = 'T1',
      provenance: { basis?: SubmissionBasis; from?: string; reason?: string } = {},
    ) => apply(registry['task.submit'], { turn, sha, ...provenance }, actor, key),
    get: () => query(registry['task.get'], { task: 'o/r#9' }, 'operator'),
    status: () => query(registry['status.get'], {}, 'operator'),
    /** A submit through its own `createApply`, as each daemon request builds one. */
    submitAlone: (actor: ActorId, sha: string, key: string, turn = 'T1') =>
      createApply({ store, clock, config })(registry['task.submit'], { turn, sha }, actor, key),
    return: (actor: ActorId, key: string, turn = 'T1', findings?: number) =>
      apply(
        registry['task.return'],
        { turn, reason: 'Handle the empty list.', ...(findings === undefined ? {} : { findings }) },
        actor,
        key,
      ),
    move: (column: Exclude<ColumnId, 'done'>, actor: ActorId = 'operator', key = 'move-1') =>
      apply(
        registry['task.move'],
        { mode: 'correct', task: 'o/r#9', column, reason: 'The board moved it wrongly.' },
        actor,
        key,
      ),
    unlinkPr: () =>
      apply(
        registry['link.remove'],
        {
          mode: 'pr',
          task: 'o/r#9',
          pr: 'https://github.com/o/r/pull/7',
          reason: 'Merged for another ticket.',
        },
        'operator',
        'unlink-1',
      ),
    history: async () =>
      (await query(registry['task.history'], { task: 'o/r#9' }, 'operator')).events,
    why: async (actor: ActorId = 'operator') => {
      const result = await query(registry['task.get'], { task: 'o/r#9', why: true }, actor);
      if (result.why === undefined) throw new Error('task.get returned no why');
      return result.why;
    },
    events: async () =>
      (await store.db.selectFrom('event').select(['kind', 'payload']).orderBy('id').execute()).map(
        (row) => ({ kind: row.kind, payload: JSON.parse(row.payload) as unknown }),
      ),
    turn: () => store.db.selectFrom('turn').selectAll().executeTakeFirstOrThrow(),
    task: () => store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow(),
    /** Runs the doorbell job at `at` and returns the dedupe keys of every doorbell row. */
    async ring(at: string) {
      await reconcileDueDoorbells(store, config, new Date(at));
      const rows = await store.db
        .selectFrom('outbox')
        .select('dedupe_key')
        .where('kind', '=', 'doorbell')
        .orderBy('id')
        .execute();
      return rows.map((row) => row.dedupe_key);
    },
    /** The turn notification of turn `turnId`. */
    turnNotice: (turnId: number) =>
      store.db
        .selectFrom('notification')
        .selectAll()
        .where('kind', '=', 'turn')
        .where('turn_id', '=', turnId)
        .executeTakeFirstOrThrow(),
  };
}

/** A review turn taken by rev-1. */
async function taken(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  await ctx.openTurn();
  await ctx.ack(REV_1);
  return ctx;
}

/** `submitConfirmMs` past `AT`: when a pending submit stops waiting for a PR. */
const PENDING_UNTIL = new Date(Date.parse(AT) + 180_000).toISOString();

/** Asserts rev-1's review submit of `sha` was accepted pending: the row, the closed turn, the event. */
async function expectPending(
  ctx: Awaited<ReturnType<typeof setup>>,
  submitted: Promise<unknown>,
  sha: string,
  pr: { pr_repo: string | null; pr_number: number | null } = { pr_repo: 'o/r', pr_number: 7 },
) {
  await expect(submitted).resolves.toMatchObject({ turn: 'T1', sha, status: 'pending' });
  expect(
    await ctx.store.db
      .selectFrom('submission')
      .select(['column', 'commit_sha', 'submitted_at', 'pending_until', 'pr_repo', 'pr_number'])
      .execute(),
  ).toEqual([
    {
      column: 'review',
      commit_sha: sha,
      submitted_at: AT,
      pending_until: PENDING_UNTIL,
      ...pr,
    },
  ]);
  expect(await ctx.turn()).toMatchObject({ closed_reason: 'submitted', closed_at: AT });
  expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([
    {
      kind: 'task_submitted',
      payload: { turn: 'T1', column: 'review', sha, basis: 'tested', pending: true },
    },
  ]);
}

/** Bans the task's PR link, as when the board has linked no PR yet. */
async function unlinkAll(ctx: Awaited<ReturnType<typeof setup>>) {
  await ctx.store.transaction(async (trx) => {
    await trx.updateTable('link').set({ banned: 1 }).where('entity', '=', 'pr').execute();
  });
}

describe('task.submit', () => {
  it.each(['tested', 'carried', 'skipped'] as const)(
    'keeps pending and shadow behavior for %s',
    async (basis) => {
      for (const shadow of [false, true]) {
        const ctx = shadow ? await setup() : await taken({ mode: 'on', complete: true });
        if (!shadow) await unlinkAll(ctx);
        await ctx.submitted('dev', A, WORKER_1);
        ctx.commits(B);
        await ctx.submit(REV_1, B, 'basis-mode', shadow ? 'o/r#9' : 'T1', {
          basis,
          ...(basis === 'carried' ? { from: A } : {}),
          reason: 'Declared basis',
        });
        expect((await ctx.get()).submission).toMatchObject({ basis, pending: !shadow });
        if (!shadow) expect(await ctx.turn()).toMatchObject({ closed_reason: 'submitted' });
        await ctx.store.db.updateTable('submission').set({ voided_at: AT }).execute();
        expect((await ctx.get()).submission).toMatchObject({ basis, pending: false, voided: true });
      }
    },
  );

  it.each(['skipped', 'other-task'] as const)(
    'cannot carry a source that is %s',
    async (source) => {
      const ctx = await taken();
      await ctx.submitted('dev', A, WORKER_1);
      if (source === 'skipped')
        await ctx.store.db.updateTable('submission').set({ basis: 'skipped' }).execute();
      else {
        const task = await ctx.task();
        await ctx.store.db
          .insertInto('task')
          .values({ ...task, id: 2, key: 'o/r#10', tracker_id: '10' })
          .execute();
        await ctx.store.db.updateTable('submission').set({ task_id: 2 }).execute();
      }
      ctx.commits(B);
      await expect(
        ctx.submit(REV_1, B, 'bad-source', 'T1', {
          basis: 'carried',
          from: A,
          reason: 'Try source',
        }),
      ).rejects.toMatchObject({ code: 'submit_source_not_tested' });
      expect((await ctx.turn()).closed_at).toBeNull();
      expect(await ctx.store.db.selectFrom('submission').selectAll().execute()).toHaveLength(1);
    },
  );

  it.each([2000, 2001])('bounds reasons at %i UTF-16 units', async (length) => {
    const ctx = await taken();
    ctx.commits(B);
    const result = ctx.submit(REV_1, B, 'reason-limit', 'T1', {
      basis: 'skipped',
      reason: 'x'.repeat(length),
    });
    if (length === 2000) {
      await result;
      expect((await ctx.get()).submission?.reason).toHaveLength(length);
    } else {
      await expect(result).rejects.toMatchObject({ code: 'usage' });
      expect((await ctx.turn()).closed_at).toBeNull();
      expect((await ctx.get()).submission).toBeNull();
    }
  });

  it.each([undefined, 'tested', 'skipped'] as const)(
    'persists and exposes basis %s after closing the turn',
    async (basis) => {
      const ctx = await taken();
      ctx.commits(B);
      const reason = '<script>test</script> <!here> *literal*';
      await ctx.submit(REV_1, B, 'submit-basis', 'T1', {
        ...(basis === undefined ? {} : { basis }),
        reason,
      });
      const expected = {
        column: 'review',
        sha: B,
        at: AT,
        basis: basis ?? 'tested',
        from: null,
        testedOrigin: null,
        reason,
        pending: false,
        voided: false,
      };
      expect((await ctx.get()).submission).toEqual(expected);
      expect((await ctx.status()).tasks.find((task) => task.key === 'o/r#9')?.submission).toEqual(
        expected,
      );
      expect(
        (await ctx.history()).find((event) => event.kind === 'task_submitted')?.summary,
      ).toContain(`basis ${basis ?? 'tested'} — ${reason}`);
      expect(await ctx.turn()).toMatchObject({ closed_reason: 'submitted' });
    },
  );

  it('resolves carry chains to a legacy tested row', async () => {
    const ctx = await taken();
    await ctx.submitted('dev', A, WORKER_1);
    ctx.commits(B);
    await ctx.submit(REV_1, B, 'carry-b', 'T1', { basis: 'carried', from: A, reason: 'Same work' });
    const turn = `T${String((await ctx.openTurn()).id)}`;
    await ctx.ack(REV_1, turn);
    const c = 'c'.repeat(40);
    ctx.commits(c);
    await ctx.submit(REV_1, c, 'carry-c', turn, {
      basis: 'carried',
      from: B,
      reason: 'Same work again',
    });
    expect((await ctx.get()).submission).toMatchObject({
      sha: c,
      basis: 'carried',
      from: B,
      testedOrigin: A,
    });
    const rows = await ctx.store.db.selectFrom('submission').selectAll().orderBy('id').execute();
    expect(rows.map((row) => row.tested_source_id)).toEqual([null, rows[0]?.id, rows[0]?.id]);
    // Equal timestamps still choose the newest identity. Voiding gate marks does not erase provenance.
    await ctx.store.db.updateTable('submission').set({ voided_at: AT }).execute();
    expect((await ctx.get()).submission).toMatchObject({ sha: c, voided: true });
    const direct = await ctx.store.db
      .insertInto('submission')
      .values({
        task_id: 1,
        column: 'dev',
        epoch: 0,
        commit_sha: B,
        author: WORKER_1,
        submitted_at: AT,
        note: null,
        basis: 'tested',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const next = `T${String((await ctx.openTurn()).id)}`;
    await ctx.ack(REV_1, next);
    await ctx.submit(REV_1, c, 'prefer-direct', next, {
      basis: 'carried',
      from: B,
      reason: 'Prefer direct tested match',
    });
    const newest = await ctx.store.db
      .selectFrom('submission')
      .selectAll()
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(newest.tested_source_id).toBe(direct.id);
    expect((await ctx.get()).submission).toMatchObject({ from: B, testedOrigin: B });
  });

  it.each(['tested', 'carried', 'skipped'] as const)(
    'keeps gate and return counts for %s',
    async (basis) => {
      const green = { name: 'ci', state: 'success' as const, completedAt: AT };
      const ctx = await taken({
        mode: 'on',
        complete: true,
        pr: { requiredChecks: [green], feedback: [], feedbackComplete: true },
      });
      await ctx.submitted('dev', A, WORKER_1);
      ctx.commits(A);
      await ctx.submit(REV_1, A, 'basis-gates', 'T1', {
        basis,
        reason: 'Declared provenance',
        ...(basis === 'carried' ? { from: A } : {}),
      });
      expect((await ctx.task()).column).toBe('qa');
      expect(await returnCounts(ctx.store.db, 1, 'qa')).toEqual({ cycle: 0, course: 0 });
      const turn = await ctx.store.db
        .selectFrom('turn')
        .select('id')
        .where('closed_at', 'is', null)
        .executeTakeFirstOrThrow();
      const id = `T${String(turn.id)}`;
      await ctx.ack(QA_1, id);
      await ctx.return(QA_1, 'return-after-basis', id);
      expect(await returnCounts(ctx.store.db, 1, 'qa')).toEqual({ cycle: 1, course: 1 });
    },
  );

  it.each([
    { basis: 'carried', reason: 'carry', code: 'submit_basis_invalid' },
    { basis: 'carried', from: A, code: 'submit_basis_invalid' },
    { basis: 'skipped', code: 'submit_basis_invalid' },
    { basis: 'skipped', reason: '  \n ', code: 'submit_basis_invalid' },
    { basis: 'tested', reason: ' ', code: 'submit_basis_invalid' },
    { basis: 'tested', from: A, code: 'submit_basis_invalid' },
    { basis: 'skipped', from: A, reason: 'skip', code: 'submit_basis_invalid' },
    { basis: 'carried', from: A, reason: 'unknown', code: 'submit_source_not_tested' },
  ] as const)('refuses invalid provenance atomically: %j', async ({ code, ...provenance }) => {
    const ctx = await taken();
    ctx.commits(B);
    const turn = await ctx.turn();
    await expect(ctx.submit(REV_1, B, 'invalid-basis', 'T1', provenance)).rejects.toMatchObject({
      code,
    });
    expect(await ctx.store.db.selectFrom('submission').selectAll().execute()).toEqual([]);
    expect(await ctx.turn()).toEqual(turn);
    expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([]);
  });

  it('holds the ring of the next turn its submitter executes', async () => {
    const green = { name: 'ci', state: 'success' as const, completedAt: AT };
    const ctx = await taken({
      mode: 'on',
      complete: true,
      pr: { requiredChecks: [green], feedback: [], feedbackComplete: true },
    });
    await ctx.submitted('dev', A, WORKER_1);
    ctx.commits(A);

    await expect(ctx.submit(REV_1, A, 'submit-1')).resolves.toMatchObject({
      status: 'confirmed',
      task: { column: 'qa' },
    });

    const turn = await ctx.store.db
      .selectFrom('turn')
      .select(['id', 'role'])
      .where('closed_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(turn.role).toBe('orchestrator:qa');
    const notice = await ctx.turnNotice(turn.id);
    expect(notice.next_at).toBe(new Date(Date.parse(AT) + 120_000).toISOString());
    expect(await ctx.ring(AT)).toEqual([]);
    expect(await ctx.ring(new Date(Date.parse(AT) + 120_000).toISOString())).toEqual([
      `doorbell:${String(notice.id)}:rev-1:1`,
    ]);
  });

  it('accepts a head the board saw only through the poll', async () => {
    const ctx = await taken();
    ctx.commits(B);

    await expect(ctx.submit(REV_1, B, 'submit-1')).resolves.toEqual({
      task: { key: 'o/r#9', project: 'proj', column: 'review', membership: 'active' },
      turn: 'T1',
      sha: B,
      status: 'confirmed',
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
      {
        kind: 'task_submitted',
        payload: { turn: 'T1', column: 'review', sha: B, basis: 'tested' },
      },
    ]);
    expect(ctx.calls).toEqual([
      [SOURCE, { kind: 'pr', repo: 'o/r', number: 7 }, { timeoutMs: 10_000 }],
    ]);

    await expect(ctx.submit(REV_1, B, 'submit-2')).rejects.toMatchObject({ code: 'turn_closed' });
    ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));
    await expect(ctx.submit(REV_1, B, 'submit-1')).resolves.toMatchObject({ turn: 'T1', sha: B });
    expect(ctx.calls).toHaveLength(1);
  });

  it('replays a result stored before submits had a status as confirmed', async () => {
    const ctx = await taken();
    ctx.commits(B);
    await ctx.submit(REV_1, B, 'submit-1');
    // A result stored before the upgrade has no status: every submit then confirmed its head.
    await ctx.store.db
      .updateTable('command')
      .set({
        result: sql<string>`json_remove(result, '$.status')`,
        // Pre-provenance canonical input: no basis field existed or was defaulted.
        fingerprint: createHash('sha256')
          .update(JSON.stringify(['task.submit', { sha: B, turn: 'T1' }, REV_1]))
          .digest('hex'),
      })
      .where('key', '=', 'submit-1')
      .execute();

    const before = await ctx.tables();
    await expect(ctx.submit(REV_1, B, 'submit-1')).resolves.toMatchObject({
      turn: 'T1',
      sha: B,
      status: 'confirmed',
    });
    expect(ctx.calls).toHaveLength(1);
    expect(await ctx.tables()).toEqual(before);
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

  it('accepts a submit with no linked PR as pending', async () => {
    const ctx = await taken({ mode: 'on', complete: true });
    await unlinkAll(ctx);

    await expectPending(ctx, ctx.submit(REV_1, A, 'submit-1'), A, {
      pr_repo: null,
      pr_number: null,
    });

    expect(ctx.calls).toHaveLength(0);
    // The dispatcher in the same transaction holds the task: no move to Dev, no new turn.
    expect((await ctx.task()).column).toBe('review');
    expect(await ctx.store.db.selectFrom('turn').select('id').execute()).toHaveLength(1);
    expect((await ctx.history()).filter((event) => event.kind === 'task_submitted')).toMatchObject([
      { summary: `Turn submitted, pending confirmation: ${A}, basis tested` },
    ]);
    // The same key replays the pending result; a new key finds the turn closed.
    await expect(ctx.submit(REV_1, A, 'submit-1')).resolves.toMatchObject({ status: 'pending' });
    await expect(ctx.submit(REV_1, A, 'submit-2')).rejects.toMatchObject({ code: 'turn_closed' });
  });

  it('refuses a shadow submit with no linked PR', async () => {
    const ctx = await setup();
    await unlinkAll(ctx);
    const before = await ctx.tables();

    await expect(ctx.submit(REV_1, A, 'submit-1', 'o/r#9')).rejects.toMatchObject({
      code: 'head_mismatch',
      hint: 'The task has no active pull request; ask the operator to link it with `board link`, then submit its head.',
    });

    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.tables()).toEqual(before);
  });

  const waitable: { name: string; result: Awaited<ReturnType<PollPr>> }[] = (
    [
      { kind: 'timeout', message: 'GitHub timed out' },
      {
        kind: 'failed',
        adapterKind: 'throttled',
        retryAt: '2026-11-04T08:05:00.000Z',
        message: 'Throttled',
      },
      { kind: 'stopped', message: 'Stopped' },
    ] satisfies PollPrError[]
  ).map((error) => ({ name: error.kind, result: err(error) }));
  it.each(waitable)('accepts a submit pending for $name', async ({ result }) => {
    const ctx = await taken();
    ctx.answers(result);

    await expectPending(ctx, ctx.submit(REV_1, A, 'submit-1'), A);

    expect(ctx.calls).toHaveLength(1);
  });

  const unavailable: { name: string; result?: Awaited<ReturnType<PollPr>> }[] = [
    ...(
      [
        { kind: 'blind', reason: 'auth', message: 'Bad token' },
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

  it('names the poll timeout it waited for in the timeout hint of a shadow submit', async () => {
    const ctx = await setup();
    ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));

    const refused = ctx.submit(REV_1, A, 'submit-1', 'o/r#9');

    await expect(refused).rejects.toMatchObject({
      code: 'github_unavailable',
      hint: 'GitHub did not answer for o/r#7 within 10 s; wait a minute, then submit again. The board has had no complete GitHub poll since it started.',
    });
    expect(ctx.calls).toEqual([
      [SOURCE, { kind: 'pr', repo: 'o/r', number: 7 }, { timeoutMs: 10_000 }],
    ]);
  });

  describe('head confirmed by the last poll', () => {
    const LATER = '2026-11-04T08:01:00.000Z';
    const noAnswer: PollPrError[] = [
      { kind: 'timeout', message: 'GitHub timed out' },
      { kind: 'failed', adapterKind: 'transient', message: 'HTTP 502' },
      { kind: 'failed', adapterKind: 'unexpected', message: 'The poll step failed' },
      {
        kind: 'failed',
        adapterKind: 'throttled',
        retryAt: '2026-11-04T08:05:00.000Z',
        message: 'Throttled',
      },
    ];
    const label = (error: PollPrError) =>
      error.kind === 'failed' ? `failed ${error.adapterKind}` : error.kind;

    it.each(noAnswer.map((error) => [label(error), error] as const))(
      'accepts the polled head when GitHub gives no answer: %s',
      async (_, error) => {
        const ctx = await taken({ complete: true });
        ctx.answers(err(error));

        await expect(ctx.submit(REV_1, A, 'submit-1')).resolves.toMatchObject({
          turn: 'T1',
          sha: A,
          status: 'confirmed',
        });

        expect(
          await ctx.store.db.selectFrom('submission').select(['column', 'commit_sha']).execute(),
        ).toEqual([{ column: 'review', commit_sha: A }]);
        expect((await ctx.turn()).closed_reason).toBe('submitted');
        expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([
          {
            kind: 'task_submitted',
            payload: {
              turn: 'T1',
              column: 'review',
              sha: A,
              basis: 'tested',
              confirmedByPoll: true,
            },
          },
        ]);
        expect(
          (await ctx.history()).filter((event) => event.kind === 'task_submitted'),
        ).toMatchObject([
          { summary: `Turn submitted on the head of the last poll: ${A}, basis tested` },
        ]);
      },
    );

    it('marks a shadow submit confirmed by the last poll', async () => {
      const ctx = await setup({ complete: true });
      ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));

      await expect(ctx.submit(REV_1, A, 'submit-1', 'o/r#9')).resolves.toMatchObject({
        turn: null,
        sha: A,
        status: 'confirmed',
      });

      expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([
        {
          kind: 'task_submitted',
          payload: { column: 'review', sha: A, basis: 'tested', confirmedByPoll: true },
        },
      ]);
    });

    it('shows a live-confirmed submit as a plain submit in history', async () => {
      const ctx = await taken({ complete: true });
      ctx.commits(B);

      await ctx.submit(REV_1, B, 'submit-1');

      expect(
        (await ctx.history()).filter((event) => event.kind === 'task_submitted'),
      ).toMatchObject([{ summary: `Turn submitted: ${B}, basis tested` }]);
    });

    it('accepts a head the last poll did not see as pending', async () => {
      const ctx = await taken({ complete: true });
      ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));

      await expectPending(ctx, ctx.submit(REV_1, B, 'submit-1'), B);
    });

    it('refuses a shadow submit of a head the last poll did not see', async () => {
      const ctx = await setup({ complete: true });
      ctx.answers(err({ kind: 'timeout', message: 'GitHub timed out' }));
      const before = await ctx.tables();

      await expect(ctx.submit(REV_1, B, 'submit-1', 'o/r#9')).rejects.toMatchObject({
        code: 'github_unavailable',
        hint: `GitHub did not answer for o/r#7 within 10 s; wait a minute, then submit again. Its last poll saw head ${A}.`,
      });

      expect(await ctx.tables()).toEqual(before);
    });

    it('accepts a head seen before the last complete poll as pending', async () => {
      const ctx = await taken({ complete: true, completeAt: LATER });
      ctx.answers(err({ kind: 'failed', adapterKind: 'transient', message: 'HTTP 502' }));

      await expectPending(ctx, ctx.submit(REV_1, A, 'submit-1'), A);
    });

    it('refuses a shadow submit of a head seen before the last complete poll', async () => {
      const ctx = await setup({ complete: true, completeAt: LATER });
      ctx.answers(err({ kind: 'failed', adapterKind: 'transient', message: 'HTTP 502' }));
      const before = await ctx.tables();

      await expect(ctx.submit(REV_1, A, 'submit-1', 'o/r#9')).rejects.toMatchObject({
        code: 'github_unavailable',
        hint: `The GitHub poll of o/r#7 failed (transient); wait a minute, then submit again. The board last saw head ${A} at ${AT}, before its last complete GitHub poll.`,
      });

      expect(await ctx.tables()).toEqual(before);
    });

    it('refuses a live answer with another head even after a complete poll', async () => {
      const ctx = await taken({ complete: true });
      ctx.commits(B);

      await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({
        code: 'head_mismatch',
      });

      expect(await ctx.store.db.selectFrom('submission').selectAll().execute()).toEqual([]);
    });

    const SUBMIT_AGAIN: { name: string; result: Awaited<ReturnType<PollPr>>; hint: string }[] = [
      {
        name: 'timeout',
        result: err({ kind: 'timeout', message: 'GitHub timed out' }),
        hint: 'GitHub did not answer for o/r#7 within 10 s; wait a minute, then submit again. The board has had no complete GitHub poll since it started.',
      },
      {
        name: 'failed transient',
        result: err({ kind: 'failed', adapterKind: 'transient', message: 'HTTP 502' }),
        hint: 'The GitHub poll of o/r#7 failed (transient); wait a minute, then submit again. The board has had no complete GitHub poll since it started.',
      },
      {
        name: 'failed unexpected',
        result: err({ kind: 'failed', adapterKind: 'unexpected', message: 'Boom' }),
        hint: 'The GitHub poll of o/r#7 failed (unexpected); wait a minute, then submit again. The board has had no complete GitHub poll since it started.',
      },
      {
        name: 'failed throttled',
        result: err({
          kind: 'failed',
          adapterKind: 'throttled',
          retryAt: '2026-11-04T08:05:00.000Z',
          message: 'Throttled',
        }),
        hint: 'GitHub is throttled until 2026-11-04T08:05:00.000Z; submit again after that. The board has had no complete GitHub poll since it started.',
      },
      {
        name: 'stopped',
        result: err({ kind: 'stopped', message: 'Stopped' }),
        hint: 'The GitHub poller is not running; submit again once the daemon is up.',
      },
      {
        name: 'blind stale',
        result: err({ kind: 'blind', reason: 'stale', message: 'Stale' }),
        hint: 'The board has no recent complete GitHub poll for o/r#7; submit again in a few minutes, once GitHub answers its polls.',
      },
    ];
    it.each(SUBMIT_AGAIN)('accepts a turn submit pending after $name', async ({ result }) => {
      const ctx = await taken();
      ctx.answers(result);

      await expectPending(ctx, ctx.submit(REV_1, A, 'submit-1'), A);
    });

    it.each(SUBMIT_AGAIN)(
      'tells a shadow caller to submit again after $name',
      async ({ result, hint }) => {
        const ctx = await setup();
        ctx.answers(result);
        const before = await ctx.tables();

        await expect(ctx.submit(REV_1, A, 'submit-1', 'o/r#9')).rejects.toMatchObject({
          code: 'github_unavailable',
          hint,
        });

        expect(await ctx.tables()).toEqual(before);
      },
    );

    it.each(SUBMIT_AGAIN.filter(({ name }) => name === 'stopped' || name === 'blind stale'))(
      'accepts $name after a complete poll as pending',
      async ({ result }) => {
        const ctx = await taken({ complete: true });
        ctx.answers(result);

        await expectPending(ctx, ctx.submit(REV_1, A, 'submit-1'), A);
      },
    );

    it.each(SUBMIT_AGAIN.filter(({ name }) => name === 'stopped' || name === 'blind stale'))(
      'refuses a shadow submit after $name and a complete poll',
      async ({ result, hint }) => {
        const ctx = await setup({ complete: true });
        ctx.answers(result);
        const before = await ctx.tables();

        await expect(ctx.submit(REV_1, A, 'submit-1', 'o/r#9')).rejects.toMatchObject({
          code: 'github_unavailable',
          hint,
        });

        expect(await ctx.tables()).toEqual(before);
      },
    );

    const NO_REPEAT: {
      name: string;
      result?: Awaited<ReturnType<PollPr>>;
      hint: string;
    }[] = [
      {
        name: 'no poller',
        hint: 'This daemon runs no GitHub poller; repeating will not help; ask the operator to check the daemon.',
      },
      {
        name: 'blind auth',
        result: err({ kind: 'blind', reason: 'auth', message: 'Bad token' }),
        hint: 'The board cannot read o/r#7 (auth); repeating will not help; ask the operator to fix the GitHub access.',
      },
      {
        name: 'blind config',
        result: err({ kind: 'blind', reason: 'config', message: 'No token' }),
        hint: 'The board cannot read o/r#7 (config); repeating will not help; ask the operator to fix the GitHub access.',
      },
      {
        name: 'failed auth',
        result: err({ kind: 'failed', adapterKind: 'auth', message: 'Bad token' }),
        hint: 'The board cannot read o/r#7 (auth); repeating will not help; ask the operator to fix the GitHub access.',
      },
      {
        name: 'failed config',
        result: err({ kind: 'failed', adapterKind: 'config', message: 'Bad config' }),
        hint: 'The board cannot read o/r#7 (config); repeating will not help; ask the operator to fix the GitHub access.',
      },
      {
        name: 'unknown_source',
        result: err({ kind: 'unknown_source', message: 'Unknown source' }),
        hint: "The repo of o/r#7 is not in the project's repos; repeating will not help; ask the operator to add it to the config.",
      },
      {
        name: 'unsupported',
        result: err({ kind: 'unsupported', message: 'Unsupported' }),
        hint: 'This daemon cannot poll a pull request on demand; repeating will not help; ask the operator to update the daemon.',
      },
      {
        name: 'not_found',
        result: ok({ status: 'not_found' as const, observedAt: AT }),
        hint: "GitHub answered not_found for o/r#7; repeating will not help; ask the operator to check the board's GitHub access.",
      },
      {
        name: 'no_access',
        result: ok({ status: 'no_access' as const, observedAt: AT }),
        hint: "GitHub answered no_access for o/r#7; repeating will not help; ask the operator to check the board's GitHub access.",
      },
    ];
    it.each(NO_REPEAT)(
      'refuses $name after a complete poll and says repeating will not help',
      async ({ name, result, hint }) => {
        const ctx = await taken({ complete: true, noPoller: name === 'no poller' });
        if (result !== undefined) ctx.answers(result);
        const before = await ctx.tables();

        await expect(ctx.submit(REV_1, A, 'submit-1')).rejects.toMatchObject({
          code: 'github_unavailable',
          hint,
        });

        expect(await ctx.tables()).toEqual(before);
      },
    );
  });
  describe('shadow submit', () => {
    it('submits a shadow task by its key', async () => {
      const ctx = await setup();
      ctx.commits(B);

      await expect(ctx.submit(REV_1, B, 'submit-1', 'o/r#9')).resolves.toEqual({
        task: { key: 'o/r#9', project: 'proj', column: 'review', membership: 'active' },
        turn: null,
        sha: B,
        status: 'confirmed',
      });

      expect(
        await ctx.store.db
          .selectFrom('submission')
          .select(['column', 'epoch', 'commit_sha', 'author'])
          .execute(),
      ).toEqual([{ column: 'review', epoch: 0, commit_sha: B, author: REV_1 }]);
      expect((await ctx.events()).filter((event) => event.kind === 'task_submitted')).toEqual([
        { kind: 'task_submitted', payload: { column: 'review', sha: B, basis: 'tested' } },
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
        status: 'confirmed',
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
      { kind: 'turn_closed', payload: { turn: 'T1', outcome: 'returned' } },
      { kind: 'task_moved', payload: { from: 'review', to: 'dev', turn: 'T1', block: 'B1' } },
    ]);
    expect(await ctx.turn()).toMatchObject({ closed_reason: 'returned', closed_at: AT });
    expect(ctx.calls).toHaveLength(0);
  });

  it('voids visit submits and keeps review marks and QA on return to Dev', async () => {
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
      { column: 'qa', voided_at: null },
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
    const notice = await ctx.turnNotice(2);
    expect(notice.next_at).toBe(AT);
    expect(await ctx.ring(AT)).toContain(`doorbell:${String(notice.id)}:worker-1:1`);
  });

  it('the next Dev turn carries the return in inbox, task.get and why', async () => {
    const green = { name: 'ci', state: 'success' as const, completedAt: AT };
    const ctx = await taken({
      mode: 'on',
      complete: true,
      pr: { requiredChecks: [green], feedback: [], feedbackComplete: true },
    });
    const query = createQuery({
      store: ctx.store,
      clock: { now: () => Date.parse(AT) },
      config: ctx.config,
    });
    const registry = createOperationRegistry({
      config: ctx.config,
      clock: { now: () => Date.parse(AT) },
      completeSince: new Map([
        [SOURCE, AT],
        ['spur', AT],
      ]),
    });
    const task = (detail = false) =>
      query(registry['task.get'], { task: 'o/r#9', ...(detail ? { detail } : {}) }, 'operator');
    expect((await task()).turn).not.toHaveProperty('returned');

    await ctx.return(REV_1, 'return-1');

    const returned = {
      by: REV_1,
      from: 'review',
      turn: 'T1',
      block: 'B1',
      reason: 'Handle the empty list.',
    };
    const inbox = await query(registry['inbox.get'], {}, WORKER_1);
    expect(inbox.turns).toEqual([expect.objectContaining({ id: 'T2', column: 'dev', returned })]);
    expect((await task()).turn).toEqual(expect.objectContaining({ id: 'T2', returned }));
    expect((await ctx.why()).turn).toEqual(expect.objectContaining({ id: 'T2', returned }));

    // A correction at the same frozen instant opens a new visit: the returned turn keeps it.
    await ctx.move('dev');

    const { turn, turns } = await task(true);
    expect(turns).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'T2', returned })]),
    );
    expect(turns?.find((entry) => entry.id === 'T1')).not.toHaveProperty('returned');
    expect(turn).not.toBeNull();
    expect(turn?.id).not.toBe('T2');
    expect(turn).not.toHaveProperty('returned');
  });

  it('status.get marks a returned Dev task until it leaves Dev or the next submit', async () => {
    const green = { name: 'ci', state: 'success' as const, completedAt: AT };
    const returned = async () => {
      const ctx = await taken({
        mode: 'on',
        complete: true,
        pr: { requiredChecks: [green], feedback: [], feedbackComplete: true },
      });
      const registry = createOperationRegistry({
        config: ctx.config,
        clock: { now: () => Date.parse(AT) },
        completeSince: new Map([
          [SOURCE, AT],
          ['spur', AT],
        ]),
      });
      const query = createQuery({
        store: ctx.store,
        clock: { now: () => Date.parse(AT) },
        config: ctx.config,
      });
      const row = async () =>
        (await query(registry['status.get'], {}, 'operator')).tasks.find(
          (task) => task.key === 'o/r#9',
        );
      return { ctx, row };
    };

    const counted = await returned();
    await counted.ctx.return(REV_1, 'return-1', 'T1', 3);
    expect((await counted.row())?.returned).toEqual({
      from: 'review',
      at: AT,
      by: REV_1,
      block: 'B1',
      findings: 3,
    });
    expect(
      (await counted.ctx.events()).filter((event) => event.kind === 'task_moved').at(-1)?.payload,
    ).toEqual({ from: 'review', to: 'dev', turn: 'T1', block: 'B1', findings: 3 });

    // Without findings the marker says null; a submit that leaves the task in Dev clears it.
    const submitted = await returned();
    await submitted.ctx.return(REV_1, 'return-1');
    expect((await submitted.row())?.returned).toMatchObject({ block: 'B1', findings: null });
    await unlinkAll(submitted.ctx);
    await submitted.ctx.ack(WORKER_1, 'T2');
    await expect(submitted.ctx.submit(WORKER_1, A, 'submit-1', 'T2')).resolves.toMatchObject({
      status: 'pending',
    });
    const pending = await submitted.row();
    expect(pending?.column).toBe('dev');
    expect(pending).not.toHaveProperty('returned');

    // Leaving Dev clears it, and a correction back into Dev does not bring it back.
    const moved = await returned();
    await moved.ctx.return(REV_1, 'return-1');
    await moved.ctx.move('review');
    expect(await moved.row()).not.toHaveProperty('returned');
    await moved.ctx.move('dev', 'operator', 'move-2');
    const corrected = await moved.row();
    expect(corrected?.column).toBe('dev');
    expect(corrected).not.toHaveProperty('returned');
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

describe('turn journal', () => {
  const TURN_KINDS = ['turn_opened', 'turn_taken', 'turn_closed'] as const;
  const LATER = new Date(Date.parse(AT) + 60_000);

  /** The journal rows of turn opens, takes and closes, oldest first. */
  const turnEvents = async (ctx: Awaited<ReturnType<typeof setup>>) =>
    (
      await ctx.store.db
        .selectFrom('event')
        .select(['kind', 'project', 'task_id', 'at', 'actor', 'actor_ref', 'payload'])
        .where('kind', 'in', TURN_KINDS)
        .orderBy('id')
        .execute()
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));

  it('journals one event per turn open, take and close', async () => {
    const ctx = await taken();
    ctx.commits(A);

    await expect(ctx.submit(REV_1, A, 'submit-1')).resolves.toMatchObject({ turn: 'T1' });

    const turn = await ctx.turn();
    const rev1 = {
      actor: 'agent',
      actor_ref: JSON.stringify({ project: 'rev', session: 'rev-1' }),
    };
    const row = { project: 'proj', task_id: 1, at: AT };
    expect(await turnEvents(ctx)).toEqual([
      {
        ...row,
        kind: 'turn_opened',
        actor: 'system',
        actor_ref: null,
        payload: { turn: 'T1', column: turn.column, addressee: turn.role, reason: turn.reason },
      },
      { ...row, ...rev1, kind: 'turn_taken', payload: { turn: 'T1', taker: turn.acked_by } },
      {
        ...row,
        kind: 'turn_closed',
        actor: 'system',
        actor_ref: null,
        payload: { turn: 'T1', outcome: turn.closed_reason },
      },
    ]);
    expect(turn).toMatchObject({
      column: 'review',
      role: 'orchestrator:review',
      reason: 'Review',
      acked_by: REV_1,
      closed_reason: 'submitted',
    });
    expect(
      (await ctx.history())
        .filter((event) => (TURN_KINDS as readonly string[]).includes(event.kind))
        .map((event) => [event.actor, event.summary]),
    ).toEqual([
      ['system', 'Turn T1 opened in review for orchestrator:review: Review'],
      [REV_1, 'Turn T1 taken by agent:rev/rev-1'],
      ['system', 'Turn T1 closed: submitted'],
    ]);
  });

  it('writes no turn event when nothing changes', async () => {
    const ctx = await setup();
    await ctx.openTurn();
    await ctx.openTurn();
    expect((await turnEvents(ctx)).map((event) => event.kind)).toEqual(['turn_opened']);

    await ctx.ack(REV_1);
    const seen = (await turnEvents(ctx)).length;
    const turn = await ctx.turn();
    await expect(ctx.ack(QA_1)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await turnEvents(ctx)).toHaveLength(seen);
    expect(await ctx.turn()).toEqual(turn);

    ctx.commits(A);
    await ctx.submit(REV_1, A, 'submit-1');
    const closed = (await turnEvents(ctx)).length;
    await ctx.store.transaction((trx) =>
      closeTurns(trx, { taskId: 1, reason: 'moved', at: LATER }),
    );
    expect(await turnEvents(ctx)).toHaveLength(closed);
  });

  it('journals every successful take', async () => {
    const ctx = await taken();
    const takers = async () =>
      (await turnEvents(ctx))
        .filter((event) => event.kind === 'turn_taken')
        .map((event) => event.payload);
    expect(await takers()).toEqual([{ turn: 'T1', taker: REV_1 }]);

    await expect(ctx.ack(REV_2)).resolves.toBeDefined();
    expect(await takers()).toEqual([
      { turn: 'T1', taker: REV_1 },
      { turn: 'T1', taker: REV_2 },
    ]);

    await expect(
      ctx.store.transaction((trx) =>
        takeTurn(trx, { turnId: 1, actor: REV_2, at: LATER, config: ctx.config }),
      ),
    ).resolves.toBe(true);
    expect((await ctx.turn()).acked_at).toBe(LATER.toISOString());
    expect(await takers()).toEqual([
      { turn: 'T1', taker: REV_1 },
      { turn: 'T1', taker: REV_2 },
      { turn: 'T1', taker: REV_2 },
    ]);
  });

  it('rolls back the event with the turn write', async () => {
    const fresh = await setup();
    await expect(
      fresh.store.transaction(async (trx) => {
        const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
        await openTurn(trx, {
          task,
          reason: 'Review',
          handed: [],
          at: new Date(AT),
          config: fresh.config,
        });
        await closeTurns(trx, { taskId: 1, reason: 'moved', at: new Date(AT) });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await fresh.store.db.selectFrom('turn').selectAll().execute()).toEqual([]);
    expect(await turnEvents(fresh)).toEqual([]);

    const ctx = await taken();
    const turn = await ctx.turn();
    const seen = await turnEvents(ctx);
    await expect(
      ctx.store.transaction(async (trx) => {
        await takeTurn(trx, { turnId: 1, actor: REV_2, at: LATER, config: ctx.config });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await ctx.turn()).toEqual(turn);
    expect(await turnEvents(ctx)).toEqual(seen);
  });
});

describe('task.get why', () => {
  const green = { name: 'ci', state: 'success' as const, completedAt: AT };
  const ready = { requiredChecks: [green], feedback: [], feedbackComplete: true };

  it('shows a pending submit as a hold with its text', async () => {
    const ctx = await taken({ mode: 'on', complete: true, pr: ready });
    await unlinkAll(ctx);
    await ctx.submit(REV_1, A, 'submit-1');

    const waiting = await ctx.why();
    expect(waiting.holds).toEqual(['submit_pending']);
    expect(waiting.pendingSubmit).toEqual({
      sha: A,
      until: PENDING_UNTIL,
      text: 'submit pending confirmation of aaaaaaa',
    });

    // The PR linked again, observed at the submit's time on its head, confirms it.
    await ctx.store.transaction(async (trx) => {
      await trx.updateTable('link').set({ banned: 0 }).where('entity', '=', 'pr').execute();
    });
    const settled = await ctx.why();
    expect(settled.holds).toEqual([]);
    expect(settled).not.toHaveProperty('pendingSubmit');
  });

  it('explains a Review task with an open turn and the last moves', async () => {
    const ctx = await taken({ mode: 'on', complete: true, pr: ready });
    await ctx.submitted('dev', A, WORKER_1);

    const before = await ctx.why();
    expect(before).toMatchObject({
      column: 'review',
      dispatcher: 'on',
      holds: [],
      checksWaivedBy: null,
      turn: { id: 'T1', column: 'review', taken: { by: REV_1 } },
      moves: [],
    });
    expect(before.gates.find((gate) => gate.column === 'review')).toEqual({
      column: 'review',
      enabled: true,
      ok: false,
      blockedIn: 'review',
      conditions: [{ condition: 'review_on_head', state: 'failed', reason: 'no_review_on_head' }],
    });
    expect(before.gates.find((gate) => gate.column === 'product-review')).toMatchObject({
      enabled: false,
    });
    expect(before).not.toHaveProperty('waiting');

    await ctx.return(REV_1, 'return-1');
    const after = await ctx.why();
    expect(after.column).toBe('dev');
    expect(after.moves.at(-1)).toEqual({
      at: AT,
      kind: 'task_moved',
      actor: REV_1,
      from: 'review',
      to: 'dev',
      reason: 'returned',
      gate: [],
      text: 'B1',
    });
    expect(after.turn).toMatchObject({ column: 'dev', addressee: 'worker', taken: null });
  });

  it('shows an incomplete comment history as a waiting Dev condition', async () => {
    const ctx = await setup({
      column: 'dev',
      mode: 'on',
      complete: true,
      pr: { ...ready, feedbackComplete: false },
    });

    const why = await ctx.why();

    expect(why.column).toBe('dev');
    expect(why.gates.find((gate) => gate.column === 'dev')?.conditions).toContainEqual({
      condition: 'comment_history_read',
      state: 'waiting',
      reason: 'comment_history_incomplete',
    });
    expect(why.waiting).toEqual([
      {
        reason: 'comment_history_incomplete',
        head: A,
        text: `waiting for the board to read the full PR comment history on ${A}`,
      },
    ]);
  });

  it('names the CI run the task waits for while Dev checks are pending', async () => {
    const pending = { name: 'ci', state: 'pending' as const, completedAt: null };
    const ctx = await setup({
      column: 'dev',
      mode: 'on',
      complete: true,
      pr: { ...ready, requiredChecks: [pending] },
    });
    const before = await ctx.tables();

    const why = await ctx.why();

    expect(why.waiting).toEqual([
      { reason: 'checks_pending', head: A, text: `waiting for CI on ${A}` },
    ]);
    expect(await ctx.tables()).toEqual(before);
  });

  it('uses the shadow column in shadow mode', async () => {
    const ctx = await setup({ mode: 'shadow', complete: true, pr: ready });
    await ctx.store.db.updateTable('task').set({ shadow_column: 'qa' }).execute();

    const why = await ctx.why();

    expect(why).toMatchObject({ column: 'qa', dispatcher: 'shadow', turn: null });
    expect((await ctx.task()).column).toBe('review');
  });

  it('reports a missing PR snapshot as a hold', async () => {
    const ctx = await setup({ mode: 'on', complete: true });
    await ctx.store.db.deleteFrom('pr_snapshot').execute();
    const before = await ctx.tables();

    const why = await ctx.why();

    expect(why.holds).toContain('pr_snapshot_missing');
    expect(why.gates).toEqual([]);
    expect(why.checksWaivedBy).toBeNull();
    expect(await ctx.tables()).toEqual(before);
  });

  it('leaves why out without the flag', async () => {
    const ctx = await setup();
    const query = createQuery({
      store: ctx.store,
      clock: { now: () => Date.parse(AT) },
      config: ctx.config,
    });
    const registry = createOperationRegistry({
      config: ctx.config,
      clock: { now: () => Date.parse(AT) },
      completeSince: new Map(),
    });
    expect(await query(registry['task.get'], { task: 'o/r#9' }, 'operator')).not.toHaveProperty(
      'why',
    );
  });
});

describe('task.move', () => {
  it.each(['qa', 'operator', 'none'] as const)(
    'correction into QA clears confirmed and pending QA with executor %s',
    async (qaOrchestrator) => {
      const ctx = await setup({
        column: 'qa',
        qaOrchestrator,
        mode: 'on',
        complete: true,
        pr: {
          requiredChecks: [{ name: 'ci', state: 'success', completedAt: AT }],
          feedback: [],
          feedbackComplete: true,
        },
      });
      await ctx.openTurn();
      await ctx.submitted('dev', A, WORKER_1);
      await ctx.submitted('review', A, REV_1);
      await ctx.submitted('qa', A, QA_1);
      await ctx.submitted('qa', B, QA_1);
      await ctx.store.db
        .updateTable('submission')
        .set({ pending_until: '2026-11-04T08:03:00.000Z' })
        .where('commit_sha', '=', B)
        .execute();
      const before = await ctx.task();
      await ctx.move('qa');
      expect(
        await ctx.store.db
          .selectFrom('submission')
          .select(['column', 'voided_at'])
          .orderBy('id')
          .execute(),
      ).toEqual([
        { column: 'dev', voided_at: null },
        { column: 'review', voided_at: null },
        { column: 'qa', voided_at: AT },
        { column: 'qa', voided_at: AT },
      ]);
      expect(await ctx.turn()).toMatchObject({ closed_reason: 'corrected' });
      expect((await ctx.task()).left_moves).toBe(before.left_moves);
      expect(await returnCounts(ctx.store.db, 1, 'qa')).toEqual({ cycle: 0, course: 0 });
      const turns = await ctx.store.db
        .selectFrom('turn')
        .select(['column', 'closed_reason'])
        .orderBy('id')
        .execute();
      expect(turns.filter((turn) => turn.column === 'qa')).toHaveLength(
        qaOrchestrator === 'none' ? 1 : 2,
      );
      expect((await ctx.task()).column).toBe(qaOrchestrator === 'none' ? 'ready-to-merge' : 'qa');
      const actor =
        qaOrchestrator === 'qa' ? QA_1 : qaOrchestrator === 'operator' ? 'operator' : WORKER_1;
      await expect(ctx.submit(actor, A, 'late-after-correction')).rejects.toMatchObject({
        code: 'turn_closed',
      });
      await ctx.observe(B);
      expect(
        await ctx.store.db
          .selectFrom('submission')
          .select(['pending_until', 'voided_at'])
          .where('column', '=', 'qa')
          .where('commit_sha', '=', B)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        pending_until: '2026-11-04T08:03:00.000Z',
        voided_at: AT,
      });
    },
  );

  it('corrects a wrong Done after the merged PR is unlinked', async () => {
    const ctx = await setup({
      column: 'done',
      mode: 'on',
      complete: true,
      pr: { state: 'merged' },
    });
    await ctx.openTurn();
    await ctx.submitted('dev', A, WORKER_1);
    await ctx.submitted('review', A, REV_1);
    await ctx.submitted('qa', A, QA_1);
    await ctx.unlinkPr();
    const epoch = (await ctx.task()).column_epoch;
    const seen = (await ctx.events()).length;

    const result = await ctx.move('dev');

    expect(result).toEqual({
      task: { key: 'o/r#9', project: 'proj', column: 'dev', membership: 'active' },
      from: 'done',
      to: 'dev',
      column: 'dev',
      settled: [],
    });
    expect(await ctx.task()).toMatchObject({
      column: 'dev',
      column_epoch: epoch + 1,
      left_moves: 0,
      last_change_at: AT,
    });
    expect(
      await ctx.store.db
        .selectFrom('turn')
        .select(['column', 'closed_reason'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { column: 'done', closed_reason: 'corrected' },
      { column: 'dev', closed_reason: null },
    ]);
    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select(['column', 'voided_at'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { column: 'dev', voided_at: AT },
      { column: 'review', voided_at: null },
      { column: 'qa', voided_at: null },
    ]);
    const events = (await ctx.events()).slice(seen);
    expect(events[0]).toEqual({
      kind: 'turn_closed',
      payload: { turn: 'T1', outcome: 'corrected' },
    });
    expect(events[1]).toEqual({
      kind: 'task_corrected',
      payload: { from: 'done', to: 'dev', reason: 'The board moved it wrongly.', shadow: false },
    });
    expect(events.map((event) => event.kind)).not.toContain('task_moved');
  });

  it('writes only the shadow column in shadow mode', async () => {
    const ctx = await setup({ mode: 'shadow', complete: true });
    const before = await ctx.task();

    const result = await ctx.move('dev');

    expect(result).toMatchObject({ from: 'review', to: 'dev', column: 'dev', settled: [] });
    expect(await ctx.task()).toMatchObject({
      column: 'review',
      shadow_column: 'dev',
      column_epoch: before.column_epoch,
    });
    expect((await ctx.events()).at(-2)).toEqual({
      kind: 'task_corrected',
      payload: { from: 'review', to: 'dev', reason: 'The board moved it wrongly.', shadow: true },
    });
    expect((await ctx.events()).at(-1)).toMatchObject({
      kind: 'dev_repair',
      payload: { action: 'reset', reason: 'corrected', throughTurn: 0, throughSubmission: 0 },
    });
  });

  it('refuses while a merged PR is the active PR', async () => {
    const ctx = await setup({
      column: 'done',
      mode: 'on',
      complete: true,
      pr: { state: 'merged' },
    });
    const before = await ctx.tables();

    const refused = ctx.move('dev');

    await expect(refused).rejects.toMatchObject({ code: 'move_not_allowed' });
    await expect(refused).rejects.toHaveProperty('hint', expect.stringContaining('board unlink'));
    expect(await ctx.tables()).toEqual(before);
  });

  it('refuses a column the project does not enable', async () => {
    const ctx = await setup({ mode: 'on', complete: true });
    const before = await ctx.tables();

    await expect(ctx.move('product-review')).rejects.toMatchObject({
      code: 'move_not_allowed',
      hint: expect.stringContaining('review, qa') as unknown,
    });
    expect(await ctx.tables()).toEqual(before);
  });

  it('denies a worker with the operator-only hint and no change', async () => {
    const ctx = await setup({ mode: 'on', complete: true });
    const seen = (await ctx.events()).length;
    const unchanged = await ctx.tables();

    await expect(ctx.move('dev', WORKER_1)).rejects.toMatchObject({
      code: 'forbidden',
      hint: 'Allowed role: operator.',
    });

    expect((await ctx.events()).slice(seen).map((event) => event.kind)).toEqual([
      'operation_denied',
    ]);
    expect(withoutEvents(await ctx.tables())).toEqual(withoutEvents(unchanged));
  });
});

describe('board-wide column orchestrator', () => {
  const BR_1: ActorId = 'agent:br/br-1';
  const PROJECTS = ['alpha', 'beta'] as const;
  type Project = (typeof PROJECTS)[number];
  const sourceOf = (project: Project) => `github:${project}:${project}/r`;
  const prOf = (project: Project, headSha: string) =>
    prFact(headSha, { repo: `${project}/r`, url: `https://github.com/${project}/r/pull/7` });

  /** Review turns T1 (alpha) and T2 (beta); `br` reviews board-wide, alpha may bind its own. */
  async function wide(alphaReview: 'none' | 'rev' = 'none') {
    const config = configSchema.parse({
      projects: PROJECTS.map((id) => ({
        id,
        tracker: { type: 'github-issues', repo: `${id}/r`, label: 'board' },
        repos: [`${id}/r`],
        operatorGithubLogin: 'operator',
        spurProjects:
          id === 'alpha' && alphaReview === 'rev' ? [{ name: 'rev', role: 'orchestrator' }] : [],
        columns: [
          { id: 'todo' },
          { id: 'dev' },
          { id: 'review', orchestrator: id === 'alpha' ? alphaReview : 'none' },
          { id: 'done' },
        ],
      })),
      spurProjects: [{ name: 'br', role: 'orchestrator', columns: ['review'] }],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    const clock = { now: () => Date.parse(AT) };
    const store = openTempStore('board-turn-wide-').store;
    stores.push(store);
    await store.transaction(async (trx) => {
      for (const [index, project] of PROJECTS.entries()) {
        await trx
          .insertInto('task')
          .values({
            project,
            tracker_kind: 'github-issues',
            tracker_id: `${project}/r#9`,
            key: `${project}/r#9`,
            membership: 'active',
            archive_reason: null,
            column: 'review',
            shadow_column: null,
            created_at: AT,
            last_change_at: null,
            terminal_at: null,
            archive_slot_at: null,
          })
          .execute();
        await trx
          .insertInto('link')
          .values({
            task_id: index + 1,
            entity: 'pr',
            repo: `${project}/r`,
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
      }
      for (const [id, project] of [
        ['br-1', 'br'],
        ['rev-1', 'rev'],
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
    });
    const core = createObservationCore({ store, config, clock });
    const observe = (project: Project, headSha: string) =>
      core.observe(sourceOf(project), {
        batch: {
          source: sourceOf(project),
          observedAt: AT,
          complete: false,
          items: [{ kind: 'pr', facts: prOf(project, headSha) }],
          entities: [],
        },
        effectiveComplete: false,
        state: { gone: [] },
        outcomes: [],
      });
    for (const project of PROJECTS) await observe(project, A);
    const pollPr: PollPr = async (source) => {
      const project = PROJECTS.find((id) => sourceOf(id) === source);
      if (project === undefined) throw new Error(`Unexpected poll of ${source}`);
      await observe(project, B);
      return ok({ status: 'ok' as const, facts: prOf(project, B), observedAt: AT });
    };
    const registry = createOperationRegistry({
      config,
      clock,
      completeSince: new Map(),
      prPoller: () => pollPr,
    });
    const apply = createApply({ store, clock, config });
    const query = createQuery({ store, clock, config });
    await scanTransaction(store, config, async (trx) => {
      for (const task of await trx.selectFrom('task').selectAll().orderBy('id').execute()) {
        await openTurn(trx, { task, reason: 'Review', handed: [], at: new Date(AT), config });
      }
    });
    return {
      config,
      inbox: async (actor: ActorId) =>
        (await query(registry['inbox.get'], {}, actor)).turns.map((turn) => turn.id),
      ack: (actor: ActorId, turn: string) =>
        apply(registry['inbox.ack'], { entries: [{ id: turn }] }, actor, `ack-${actor}-${turn}`),
      submit: (actor: ActorId, turn: string) =>
        apply(registry['task.submit'], { turn, sha: B }, actor, `submit-${turn}`),
      return: (actor: ActorId, turn: string) =>
        apply(
          registry['task.return'],
          { turn, reason: 'Handle the empty list.' },
          actor,
          `return-${turn}`,
        ),
    };
  }

  it.each(PROJECTS)(
    'lets one br session take both review turns, submit on %s and return the other',
    async (submitted) => {
      const ctx = await wide();
      const turnOf = { alpha: 'T1', beta: 'T2' } as const;
      const returned = submitted === 'alpha' ? 'beta' : 'alpha';
      expect(ctx.config.projects.map((project) => project.columns[2]?.orchestrator)).toEqual([
        'br',
        'br',
      ]);
      expect(await ctx.inbox(BR_1)).toEqual(['T1', 'T2']);
      await expect(ctx.ack(BR_1, 'T1')).resolves.toBeDefined();
      await expect(ctx.ack(BR_1, 'T2')).resolves.toBeDefined();

      await expect(ctx.submit(BR_1, turnOf[submitted])).resolves.toMatchObject({
        task: { key: `${submitted}/r#9`, project: submitted },
        turn: turnOf[submitted],
        sha: B,
        status: 'confirmed',
      });
      await expect(ctx.return(BR_1, turnOf[returned])).resolves.toMatchObject({
        task: { key: `${returned}/r#9`, column: 'dev' },
        block: { author: BR_1, addressee: 'worker' },
      });
    },
  );

  it("leaves a project's own review binding to it and keeps br out of that project", async () => {
    const ctx = await wide('rev');
    expect(ctx.config.projects.map((project) => project.columns[2]?.orchestrator)).toEqual([
      'rev',
      'br',
    ]);
    expect(await ctx.inbox(BR_1)).toEqual(['T2']);
    await expect(ctx.ack(BR_1, 'T1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(ctx.ack(REV_1, 'T1')).resolves.toBeDefined();
    await expect(ctx.ack(BR_1, 'T2')).resolves.toBeDefined();
  });
});
