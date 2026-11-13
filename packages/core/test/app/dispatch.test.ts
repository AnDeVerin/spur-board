import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  eventPayloadSchemas,
  ok,
  type ActorId,
  type EventKind,
  type PrFacts,
  type PrPoller,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';
import { archiveTask } from '../../src/app/archive.ts';
import { scanTransaction } from '../../src/app/secrets.ts';

// The dispatcher end to end through the observation core, the registry and the tick, on an
// sb-like board: review by `rev`, product review by `coord`, ready to merge by the operator.

const BASE = Date.parse('2026-11-04T08:00:00.000Z');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const KEY = 'o/r#9';
const TRACKER = 'github-issues:proj:o/r';
const GITHUB = 'github:proj:o/r';
const WORKER: ActorId = 'agent:worker/worker-1';
const REV: ActorId = 'agent:rev/rev-1';
const COORD: ActorId = 'agent:coord/coord-1';
const EXTERNAL = 'reviewer';
const ROW_TABLES = [
  'turn',
  'notification',
  'outbox',
  'block',
  'operator_item',
  'submission',
] as const;

type Options = {
  mode?: 'on' | 'shadow';
  cycleLimit?: number;
  externalReview?: boolean;
  devOrchestrator?: string;
};

function boardConfig(options: Options = {}) {
  return configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
        repos: ['o/r'],
        operatorGithubLogin: 'agent-bot',
        spurProjects: [
          { name: 'worker', role: 'worker' },
          { name: 'rev', role: 'worker' },
          { name: 'coord', role: 'worker' },
        ],
        columns: [
          { id: 'todo' },
          {
            id: 'dev',
            ...(options.devOrchestrator === undefined
              ? {}
              : { orchestrator: options.devOrchestrator }),
          },
          { id: 'review', orchestrator: 'rev', cycleLimit: options.cycleLimit ?? 10 },
          { id: 'product-review', orchestrator: 'coord' },
          ...(options.externalReview === true ? [{ id: 'external-review' }] : []),
          { id: 'ready-to-merge', orchestrator: 'operator' },
          { id: 'done' },
        ],
        dispatcher: { mode: options.mode ?? 'on' },
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
}

function prFacts(patch: Partial<PrFacts> = {}): PrFacts {
  return {
    repo: 'o/r',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'o/r#9 work',
    author: 'agent-bot',
    headSha: A,
    headBranch: 'o/r#9-work',
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [{ name: 'ci', state: 'success', completedAt: '2026-11-04T08:00:00.000Z' }],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: [KEY],
    updatedAt: '2026-11-04T08:00:00.000Z',
    feedback: [],
    feedbackComplete: true,
    ...patch,
  };
}

function ticketFacts(status = 'open', inFilter = true): TicketFacts {
  return {
    trackerId: TRACKER,
    id: 'node-9',
    key: KEY,
    title: 'A ticket',
    status,
    assignee: null,
    sprint: null,
    labels: ['board'],
    inFilter,
    url: 'https://github.com/o/r/issues/9',
    updatedAt: '2026-11-04T08:00:00.000Z',
  };
}

function sessionFacts(
  id: string,
  spurProject: string,
  ended = false,
  labelled = true,
): SessionFacts {
  return {
    id,
    spurProject,
    branch: null,
    pr: null,
    links:
      spurProject === 'worker' && labelled
        ? { 'board-worker': 'https://github.com/o/r/issues/9' }
        : {},
    lifecycle: ended ? 'completed' : 'running',
    health: 'working',
    healthSince: '2026-11-04T08:00:00.000Z',
    lastActivityAt: null,
    endedAt: ended ? '2026-11-04T08:00:00.000Z' : null,
    endReason: ended ? 'complete' : null,
  };
}

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/** A board with one task, driven step by step; the clock moves a minute per step. */
function board(options: Options = {}) {
  let config = boardConfig(options);
  let now = BASE;
  const clock = { now: () => now };
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-dispatch-')), 'board.db'));
  stores.push(store);
  let core = createObservationCore({ store, config, clock });
  let current: PrFacts | null = null;
  const prs = new Map<number, PrFacts>();
  const pollPr: PrPoller['pollPr'] = () =>
    Promise.resolve(
      current === null
        ? ok({ status: 'not_found' as const, observedAt: new Date(now).toISOString() })
        : ok({ status: 'ok' as const, facts: current, observedAt: new Date(now).toISOString() }),
    );
  const build = () => ({
    registry: createOperationRegistry({
      config,
      clock,
      completeSince: core.completeSince,
      prPoller: () => pollPr,
    }),
    apply: createApply({ store, clock, config }),
    query: createQuery({ store, clock, config }),
  });
  let { registry, apply, query } = build();
  let keys = 0;
  const step = () => {
    now += 60_000;
    return new Date(now).toISOString();
  };
  const observe = async (
    source: string,
    items: Parameters<typeof core.observe>[1]['batch']['items'],
    complete = true,
  ) => {
    const observedAt = step();
    await core.observe(source, {
      batch: { source, observedAt, complete, items, entities: [] },
      effectiveComplete: complete,
      state: { ...(complete ? { lastCompleteAt: observedAt } : {}), gone: [] },
      outcomes: [],
    });
  };
  const ctx = {
    store,
    at: () => new Date(now).toISOString(),
    /** A daemon restart on the same store: a fresh core and registry, perhaps a new config. */
    restart(next: Options = options) {
      config = boardConfig(next);
      core = createObservationCore({ store, config, clock });
      ({ registry, apply, query } = build());
    },
    ticket: (status = 'open', inFilter = true) =>
      observe(TRACKER, [{ kind: 'ticket', facts: ticketFacts(status, inFilter) }]),
    /** A complete GitHub poll with the given PR facts merged over the current ones. */
    async pr(patch: Partial<PrFacts> = {}, complete = true) {
      const number = patch.number ?? current?.number ?? 7;
      current = prFacts({ ...prs.get(number), ...patch });
      prs.set(number, current);
      await observe(
        GITHUB,
        [...prs.values()].map((facts) => ({ kind: 'pr' as const, facts })),
        complete,
      );
    },
    github: (complete = true) =>
      observe(
        GITHUB,
        [...prs.values()].map((facts) => ({ kind: 'pr' as const, facts })),
        complete,
      ),
    /** A complete Spur poll: the reviewers always, the worker while `worker` is not `none`. */
    spur: (worker: 'live' | 'ended' | 'none' | 'unlinked' = 'live', complete = true) =>
      observe(
        'spur',
        [
          ...(worker === 'none'
            ? []
            : [
                {
                  kind: 'session' as const,
                  facts: sessionFacts(
                    'worker-1',
                    'worker',
                    worker === 'ended',
                    worker !== 'unlinked',
                  ),
                },
              ]),
          { kind: 'session' as const, facts: sessionFacts('rev-1', 'rev') },
          { kind: 'session' as const, facts: sessionFacts('coord-1', 'coord') },
        ],
        complete,
      ),
    blind: (source: string, blind: boolean) => {
      step();
      return core.reportSourceState(source, {
        ...(blind ? { blind: { reason: 'auth' as const, message: 'Bad token' } } : {}),
        gone: [],
      });
    },
    tick: () => {
      step();
      return tickBoard({ store, config, clock, completeSince: core.completeSince });
    },
    ack: (actor: ActorId, turn: string) => {
      step();
      return apply(
        registry['inbox.ack'],
        { entries: [{ id: turn }] },
        actor,
        `key-${String(++keys)}`,
      );
    },
    submit: (actor: ActorId, turn: string, sha = current?.headSha ?? A) => {
      step();
      return apply(registry['task.submit'], { turn, sha }, actor, `key-${String(++keys)}`);
    },
    ret: (actor: ActorId, turn: string, reason = 'Handle the empty list.') => {
      step();
      return apply(registry['task.return'], { turn, reason }, actor, `key-${String(++keys)}`);
    },
    linkSession: (session: string) => {
      step();
      return apply(
        registry['link.add'],
        { mode: 'session', task: KEY, session, reason: 'The worker started before the ticket.' },
        'operator',
        `key-${String(++keys)}`,
      );
    },
    linkPr: (number: number) => {
      step();
      return apply(
        registry['link.add'],
        {
          mode: 'pr',
          task: KEY,
          pr: `https://github.com/o/r/pull/${String(number)}`,
          reason: 'This PR replaces the earlier one.',
        },
        'operator',
        `key-${String(++keys)}`,
      );
    },
    archive: () => {
      step();
      return apply(registry['task.archive'], { task: KEY }, 'operator', `key-${String(++keys)}`);
    },
    add: () => {
      step();
      return apply(registry['task.add'], { task: KEY }, 'operator', `key-${String(++keys)}`);
    },
    closeItem: (item: string) => {
      step();
      return apply(registry['item.close'], { item }, 'operator', `key-${String(++keys)}`);
    },
    task: () =>
      store.db.selectFrom('task').selectAll().where('key', '=', KEY).executeTakeFirstOrThrow(),
    turns: () => store.db.selectFrom('turn').selectAll().orderBy('id').execute(),
    /** The task's unclosed turn as (column, role, reason), or null. */
    async openTurn() {
      const turn = await store.db
        .selectFrom('turn')
        .select(['id', 'column', 'role', 'reason', 'handed', 'head_sha'])
        .where('closed_at', 'is', null)
        .executeTakeFirst();
      return turn === undefined ? null : { ...turn, id: `T${String(turn.id)}` };
    },
    async events(kind?: EventKind) {
      const rows = await store.db
        .selectFrom('event')
        .select(['id', 'kind', 'payload', 'at'])
        .orderBy('id')
        .execute();
      return rows
        .filter((row) => kind === undefined || row.kind === kind)
        .map((row) => ({
          kind: row.kind,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        }));
    },
    async moves() {
      return (await ctx.events('task_moved')).map((event) => event.payload);
    },
    async rows() {
      return Promise.all(
        ROW_TABLES.map((table) => store.db.selectFrom(table).selectAll().execute()),
      );
    },
    async count(table: (typeof ROW_TABLES)[number]) {
      return (await store.db.selectFrom(table).selectAll().execute()).length;
    },
    async snapshot() {
      return Promise.all(
        (
          [
            'task',
            'turn',
            'submission',
            'notification',
            'outbox',
            'block',
            'operator_item',
            'event',
          ] as const
        ).map((table) => store.db.selectFrom(table).selectAll().execute()),
      );
    },
    /** The poll context core gives the GitHub adapter. */
    context: () => core.context(GITHUB),
    inbox: (actor: ActorId) => query(registry['inbox.get'], {}, actor),
    history: () => query(registry['task.history'], { task: KEY }, 'operator'),
  };
  return ctx;
}

type Board = ReturnType<typeof board>;

/** The task on the board with no PR: complete polls of the tracker, GitHub and Spur. */
async function started(options: Options = {}, worker: 'live' | 'none' = 'live'): Promise<Board> {
  const ctx = board(options);
  await ctx.ticket();
  await ctx.github();
  await ctx.spur(worker);
  return ctx;
}

/** The worker took the Dev turn and opened PR #7 at head A. */
async function inDev(options: Options = {}): Promise<Board> {
  const ctx = await started(options);
  const turn = await ctx.openTurn();
  await ctx.ack(WORKER, turn?.id ?? '');
  await ctx.pr();
  return ctx;
}

/** The worker submitted head A, so the task sits in Review with the reviewer's turn T2. */
async function inReview(options: Options = {}): Promise<Board> {
  const ctx = await inDev(options);
  await ctx.submit(WORKER, 'T1', A);
  return ctx;
}

const turnOf = (column: string, role: string, reason: string): unknown =>
  expect.objectContaining({ column, role, reason });

describe('flow tables', () => {
  it('the happy path', async () => {
    const ctx = board();
    await ctx.ticket();
    await ctx.github();
    await ctx.spur('none');
    // To Do with no open PR and no live worker: no turn and no event.
    expect((await ctx.task()).column).toBe('todo');
    expect(await ctx.turns()).toEqual([]);
    expect(await ctx.moves()).toEqual([]);

    await ctx.spur('live');
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_pr'));
    await ctx.ack(WORKER, 'T1');

    await ctx.pr();
    expect(await ctx.openTurn()).toMatchObject({ id: 'T1' });

    await expect(ctx.submit(WORKER, 'T1', A)).resolves.toMatchObject({
      task: { column: 'review' },
      turn: 'T1',
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('review', 'orchestrator:review', 'review: no_review_on_head'),
    );
    await ctx.ack(REV, 'T2');
    await expect(ctx.submit(REV, 'T2', A)).resolves.toMatchObject({
      task: { column: 'product-review' },
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('product-review', 'orchestrator:product-review', 'product-review: no_review_on_head'),
    );
    await ctx.ack(COORD, 'T3');
    await ctx.submit(COORD, 'T3', A);
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect(await ctx.openTurn()).toEqual(
      turnOf('ready-to-merge', 'operator', 'ready-to-merge: not_merged'),
    );
    expect(
      await ctx.store.db.selectFrom('operator_item').select(['kind', 'cleared_at']).execute(),
    ).toEqual([{ kind: 'turn', cleared_at: null }]);

    await ctx.pr({ state: 'merged' });
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toEqual(turnOf('done', 'worker', 'done: wrap up'));
    expect(
      await ctx.store.db.selectFrom('operator_item').select(['kind', 'cleared_at']).execute(),
    ).toEqual([{ kind: 'turn', cleared_at: expect.any(String) as unknown }]);
    expect((await ctx.moves()).map(({ from, to, reason }) => [from, to, reason])).toEqual([
      ['todo', 'dev', 'gate_passed'],
      ['dev', 'review', 'gate_passed'],
      ['review', 'product-review', 'gate_passed'],
      ['product-review', 'ready-to-merge', 'gate_passed'],
      ['ready-to-merge', 'done', 'merged'],
    ]);
  });

  it('the review cycle', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await expect(ctx.ret(REV, 'T2')).resolves.toMatchObject({ task: { column: 'dev' } });
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    await ctx.ack(WORKER, 'T3');
    await ctx.pr({ headSha: B });
    await expect(ctx.submit(WORKER, 'T3', B)).resolves.toMatchObject({
      task: { column: 'review' },
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('review', 'orchestrator:review', 'review: no_review_on_head'),
    );
    await ctx.ack(REV, 'T4');
    await ctx.submit(REV, 'T4', B);
    expect((await ctx.task()).column).toBe('product-review');
  });

  it('red CI after an early submit', async () => {
    const ctx = await inDev();
    await ctx.pr({ requiredChecks: [{ name: 'ci', state: 'pending', completedAt: null }] });
    await ctx.submit(WORKER, 'T1', A);
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();

    await ctx.pr({
      requiredChecks: [{ name: 'ci', state: 'failure', completedAt: '2026-11-04T08:00:00.000Z' }],
    });
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: checks_red'));
  });

  it("a conflict in Review waits for the conductor's submit", async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.pr({ mergeable: 'conflicting' });
    expect((await ctx.task()).column).toBe('review');
    expect(await ctx.openTurn()).toMatchObject({ id: 'T2' });

    await ctx.submit(REV, 'T2', A);
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['conflict'],
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: conflict, no_submit_on_head'),
    );
  });

  it('a conflict in Ready to Merge with the operator as executor goes to Dev at once', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    await ctx.ack(COORD, 'T3');
    await ctx.submit(COORD, 'T3', A);
    expect(await ctx.openTurn()).toEqual(
      turnOf('ready-to-merge', 'operator', 'ready-to-merge: not_merged'),
    );

    await ctx.pr({ mergeable: 'conflicting' });
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'ready-to-merge',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['conflict'],
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: conflict, no_submit_on_head'),
    );
    expect(
      await ctx.store.db.selectFrom('operator_item').select(['kind', 'cleared_at']).execute(),
    ).toEqual([{ kind: 'turn', cleared_at: expect.any(String) as unknown }]);
  });

  it('a re-entry with a review mark on head passes Review without a turn', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    await ctx.ack(COORD, 'T3');
    await ctx.ret(COORD, 'T3');
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    await ctx.ack(WORKER, 'T4');

    await expect(ctx.submit(WORKER, 'T4', A)).resolves.toMatchObject({
      task: { column: 'product-review' },
    });
    expect((await ctx.moves()).slice(-2).map(({ from, to }) => [from, to])).toEqual([
      ['dev', 'review'],
      ['review', 'product-review'],
    ]);
    expect((await ctx.turns()).map((turn) => turn.column)).toEqual([
      'dev',
      'review',
      'product-review',
      'dev',
      'product-review',
    ]);
  });

  it('a merge from Dev while a worker turn is open', async () => {
    const ctx = await inDev();
    await ctx.pr({ state: 'merged' });
    expect((await ctx.task()).column).toBe('done');
    const turns = await ctx.turns();
    expect(turns[0]).toMatchObject({ id: 1, column: 'dev', closed_reason: 'moved' });
    expect(await ctx.openTurn()).toEqual(turnOf('done', 'worker', 'done: wrap up'));
  });

  it('a return to Dev with no live worker gives an operator turn item', async () => {
    const ctx = await inReview();
    await ctx.spur('ended');
    await ctx.ack(REV, 'T2');
    await ctx.ret(REV, 'T2');
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'operator', 'dev: no_submit_on_head'));
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select(['kind', 'item_key'])
        .where('kind', '=', 'turn')
        .execute(),
    ).toEqual([{ kind: 'turn', item_key: 'turn:3' }]);
  });

  it('a reopened ticket goes to To Do and stays until a new PR opens above the floor', async () => {
    const ctx = await inDev();
    await ctx.pr({ state: 'merged' });
    expect((await ctx.task()).column).toBe('done');
    await ctx.ticket('closed');
    await ctx.ticket('open');
    const task = await ctx.task();
    expect(task).toMatchObject({ column: 'todo' });
    expect(
      await ctx.store.db
        .selectFrom('link')
        .select('number')
        .where('reopen_hidden_at', 'is not', null)
        .execute(),
    ).toEqual([{ number: 7 }]);
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'done',
      to: 'todo',
      reason: 'ticket_reopened',
    });
    expect(await ctx.openTurn()).toBeNull();

    // The worker is still live; a re-evaluation by a GitHub recovery pass keeps the task.
    await ctx.blind(GITHUB, true);
    await ctx.blind(GITHUB, false);
    await ctx.tick();
    expect((await ctx.task()).column).toBe('todo');
    expect(await ctx.openTurn()).toBeNull();

    await ctx.pr({ number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' });
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(
      expect.objectContaining({ column: 'dev', role: 'worker', head_sha: C }),
    );
  });

  it('a reopen seen before the merge is observed still sends the task to To Do', async () => {
    const ctx = await inDev();
    // GitHub merged #7 before the ticket closed and reopened; the board sees the merge last.
    const merged = ctx.at();
    await ctx.ticket('closed');
    await ctx.ticket('open');
    expect((await ctx.task()).column).toBe('dev');
    await ctx.pr({ state: 'merged', updatedAt: merged });
    expect(await ctx.task()).toMatchObject({ column: 'todo' });
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'dev',
      to: 'todo',
      reason: 'ticket_reopened',
    });
    expect(await ctx.openTurn()).toBeNull();
  });

  it('a merge after the reopen still counts', async () => {
    const ctx = await inDev();
    await ctx.ticket('closed');
    await ctx.ticket('open');
    // Merged 30 s after the reopen was observed.
    await ctx.pr({
      state: 'merged',
      updatedAt: new Date(Date.parse(ctx.at()) + 30_000).toISOString(),
    });
    expect((await ctx.task()).column).toBe('done');
  });
});

/** The reviewers marked head A, so the task sits in the column after Product Review. */
async function pastProductReview(options: Options = {}): Promise<Board> {
  const ctx = await inReview(options);
  await ctx.ack(REV, 'T2');
  await ctx.submit(REV, 'T2', A);
  await ctx.ack(COORD, 'T3');
  await ctx.submit(COORD, 'T3', A);
  return ctx;
}

const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString();

describe('shadow mode', () => {
  it('shadow creates no turn, ring or block and follows the same rules', async () => {
    const ctx = board({ mode: 'shadow' });
    await ctx.ticket();
    await ctx.github();
    await ctx.spur('none');
    // The first evaluation of a task that stays put writes nothing.
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: null });
    expect(await ctx.events('task_shadow_moved')).toEqual([]);
    const counts = async () =>
      Promise.all(ROW_TABLES.filter((table) => table !== 'submission').map((t) => ctx.count(t)));
    const before = await counts();
    const visit = async () => {
      const task = await ctx.task();
      return [task.column, task.column_epoch, task.left_moves];
    };

    await ctx.spur('live');
    expect((await ctx.task()).shadow_column).toBe('dev');
    await ctx.pr();
    const quiet = (await ctx.task()).last_change_at;
    await expect(ctx.submit(WORKER, KEY, A)).resolves.toMatchObject({
      task: { column: 'todo' },
      turn: null,
      sha: A,
    });
    expect((await ctx.task()).shadow_column).toBe('review');
    expect((await ctx.task()).last_change_at).toBe(quiet);
    await ctx.submit(REV, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('product-review');
    await ctx.submit(COORD, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('ready-to-merge');
    await ctx.pr({ state: 'merged' });

    expect(await ctx.task()).toMatchObject({ shadow_column: 'done' });
    expect(await visit()).toEqual(['todo', 0, 0]);
    expect(await counts()).toEqual(before);
    expect(await ctx.events('task_moved')).toEqual([]);
    expect((await ctx.events('task_shadow_moved')).map((event) => event.payload)).toEqual([
      { from: 'todo', to: 'dev', reason: 'gate_passed' },
      { from: 'dev', to: 'review', reason: 'gate_passed' },
      { from: 'review', to: 'product-review', reason: 'gate_passed' },
      { from: 'product-review', to: 'ready-to-merge', reason: 'gate_passed' },
      { from: 'ready-to-merge', to: 'done', reason: 'merged' },
    ]);
    expect(
      await ctx.store.db.selectFrom('submission').select(['column', 'epoch', 'author']).execute(),
    ).toEqual([
      { column: 'dev', epoch: 0, author: WORKER },
      { column: 'review', epoch: 0, author: REV },
      { column: 'product-review', epoch: 0, author: COORD },
    ]);
    expect((await ctx.events('task_submitted'))[0]?.payload).toEqual({ column: 'dev', sha: A });
  });

  it('a shadow left move voids the Dev submit', async () => {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    await ctx.submit(REV, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('product-review');

    await ctx.pr({ mergeable: 'conflicting' });
    expect((await ctx.task()).shadow_column).toBe('dev');
    expect((await ctx.events('task_shadow_moved')).at(-1)?.payload).toEqual({
      from: 'product-review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['conflict'],
    });
    expect(
      await ctx.store.db.selectFrom('submission').select(['column', 'voided_at']).execute(),
    ).toEqual([
      { column: 'dev', voided_at: expect.any(String) as unknown },
      { column: 'review', voided_at: null },
    ]);

    await ctx.pr({ mergeable: 'mergeable' });
    expect((await ctx.task()).shadow_column).toBe('dev');
    expect(await ctx.task()).toMatchObject({ column: 'todo', column_epoch: 0, left_moves: 0 });
  });

  it('counts the Dev orchestrator submit as handling external feedback', async () => {
    const ctx = await started({ mode: 'shadow', devOrchestrator: 'coord' });
    await ctx.pr({
      feedback: [
        {
          kind: 'comment',
          id: 'c-1',
          author: { login: EXTERNAL, type: 'user' },
          postedAt: at(1),
        },
      ],
    });
    expect((await ctx.task()).shadow_column).toBe('dev');

    await ctx.submit(COORD, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('review');
    expect((await ctx.events('task_shadow_moved')).at(-1)?.payload).toEqual({
      from: 'dev',
      to: 'review',
      reason: 'gate_passed',
    });
  });
  it('reads GitHub feedback back only to the newest Dev submit', async () => {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr({
      feedback: [
        {
          kind: 'comment',
          id: 'c-1',
          author: { login: EXTERNAL, type: 'user' },
          postedAt: at(1),
        },
      ],
    });
    expect('feedbackCursors' in (await ctx.context())).toBe(false);

    await ctx.submit(WORKER, KEY, A);
    const submitted = ctx.at();
    await ctx.submit(REV, KEY, A);
    expect((await ctx.context()).feedbackCursors).toEqual([
      { ref: { kind: 'pr', repo: 'o/r', number: 7 }, id: '', postedAt: submitted },
    ]);
    // The shadow submits keep their cutoff after a switch to on: they had no turn.
    ctx.restart({ mode: 'on' });
    expect((await ctx.context()).feedbackCursors).toEqual([
      { ref: { kind: 'pr', repo: 'o/r', number: 7 }, id: '', postedAt: submitted },
    ]);
  });

  it('counts a shadow submit as handling feedback only on the PR it was made on', async () => {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr();
    const comment = {
      kind: 'comment' as const,
      id: 'c-8',
      author: { login: EXTERNAL, type: 'user' as const },
      postedAt: at(1),
    };
    // A conflict PR #8 with a comment posted before the submit on #7.
    await ctx.pr({
      number: 8,
      url: 'https://github.com/o/r/pull/8',
      headSha: C,
      feedback: [comment],
    });
    expect(
      await ctx.store.db
        .selectFrom('link')
        .select(['number', 'pr_state'])
        .where('entity', '=', 'pr')
        .orderBy('id')
        .execute(),
    ).toEqual([
      { number: 7, pr_state: 'active' },
      { number: 8, pr_state: 'conflict' },
    ]);
    await ctx.submit(WORKER, KEY, A);
    const submitted = ctx.at();
    expect((await ctx.context()).feedbackCursors).toEqual([
      { ref: { kind: 'pr', repo: 'o/r', number: 7 }, id: '', postedAt: submitted },
    ]);

    // #7 closes and the operator makes #8 the task's PR: the submit on #7 did not handle #8's
    // comment.
    await ctx.pr({ number: 7, state: 'closed' });
    await ctx.linkPr(8);
    expect(
      await ctx.store.db
        .selectFrom('link')
        .select(['number', 'pr_state'])
        .where('entity', '=', 'pr')
        .orderBy('id')
        .execute(),
    ).toEqual([
      { number: 7, pr_state: 'active' },
      { number: 8, pr_state: 'active' },
    ]);
    expect((await ctx.task()).shadow_column).toBe('dev');
    ctx.restart({ mode: 'on' });
    await ctx.github();
    await ctx.spur();
    await ctx.tick();
    const turn = await ctx.openTurn();
    expect(turn).toMatchObject({ column: 'dev', head_sha: C });
    expect(JSON.parse(turn?.handed ?? '[]')).toEqual([
      { repo: 'o/r', number: 8, kind: 'comment', id: 'c-8', postedAt: at(1) },
    ]);
  });
});

describe('re-evaluation and the journal', () => {
  it('re-evaluates from current facts without repeating moves or journal entries', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    const before = await ctx.snapshot();

    ctx.restart();
    await ctx.tick();
    await ctx.tick();
    await ctx.ticket();
    await ctx.github();
    await ctx.spur();

    expect(await ctx.snapshot()).toEqual(before);
  });

  it('journals each move with its reason, readable by task.history', async () => {
    const ctx = await inReview();
    expect((await ctx.task()).last_change_at).toBe(ctx.at());
    await ctx.ack(REV, 'T2');
    await ctx.ret(REV, 'T2');
    await ctx.pr({ headSha: B });
    await ctx.ack(WORKER, 'T3');
    await ctx.submit(WORKER, 'T3', B);
    expect((await ctx.task()).last_change_at).toBe(ctx.at());
    await ctx.pr({ mergeable: 'conflicting' });
    expect((await ctx.task()).last_change_at).toBe(ctx.at());

    const moves = await ctx.store.db
      .selectFrom('event')
      .select('payload')
      .where('kind', '=', 'task_moved')
      .orderBy('id')
      .execute();
    const payloads = moves.map((row) =>
      eventPayloadSchemas.task_moved.parse(JSON.parse(row.payload)),
    );
    expect(payloads.map(({ from, to, reason, gate }) => [from, to, reason, gate])).toEqual([
      ['todo', 'dev', 'gate_passed', undefined],
      ['dev', 'review', 'gate_passed', undefined],
      ['review', 'dev', undefined, undefined],
      ['dev', 'review', 'gate_passed', undefined],
      ['review', 'dev', 'gate_broken', ['conflict']],
    ]);
    const history = await ctx.history();
    expect(history.events.filter((event) => event.kind === 'task_moved')).toHaveLength(5);
    expect(
      history.events.filter((event) => event.kind === 'task_moved').map((event) => event.summary),
    ).toEqual(Array(5).fill('Task moved'));

    const shadow = await started({ mode: 'shadow' });
    expect((await shadow.history()).events).toContainEqual(
      expect.objectContaining({ kind: 'task_shadow_moved', summary: 'Shadow move' }),
    );
  });

  it('records the head a turn was opened on', async () => {
    const ctx = await inReview();
    const turns = await ctx.turns();
    expect(turns.map((turn) => turn.head_sha)).toEqual([null, A]);
    expect((await ctx.inbox(REV)).turns).toEqual([
      expect.objectContaining({ id: 'T2', head: A, column: 'review' }),
    ]);
  });
});

describe('turns', () => {
  it('hands the turn back with the failing reasons after a submit', async () => {
    const ctx = await inDev();
    await ctx.pr({
      draft: true,
      requiredChecks: [{ name: 'ci', state: 'failure', completedAt: at(0) }],
    });
    expect(await ctx.openTurn()).toMatchObject({ id: 'T1' });
    await ctx.submit(WORKER, 'T1', A);
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: pr_draft, checks_red'));
    expect((await ctx.turns())[0]).toMatchObject({ closed_reason: 'submitted' });
  });

  it('gives no wrap-up turn without a live agent executor', async () => {
    const ctx = await inReview();
    await ctx.spur('ended');
    await ctx.pr({ state: 'merged' });
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toBeNull();
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('cleared_at', 'is', null)
        .execute(),
    ).toEqual([]);
  });

  it('opens an entry turn for a reactivated task whose turn was archived', async () => {
    const ctx = await inReview();
    const epoch = (await ctx.task()).column_epoch;
    await scanTransaction(ctx.store, boardConfig(), async (trx) => {
      const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
      await archiveTask(trx, { task, reason: 'out_of_filter', actor: 'system', at: ctx.at() });
    });
    expect((await ctx.turns())[1]).toMatchObject({ id: 2, closed_reason: 'archived' });

    await ctx.ticket();
    expect((await ctx.task()).membership).toBe('active');
    expect(await ctx.openTurn()).toMatchObject({ id: 'T3', column: 'review' });
    expect((await ctx.turns())[2]).toMatchObject({ column: 'review', epoch, seq: 2 });
  });

  it('opens an entry turn on the next tick for a task re-added after its archive was consumed', async () => {
    const ctx = await inReview();
    const epoch = (await ctx.task()).column_epoch;
    await ctx.archive();
    await ctx.tick();
    expect((await ctx.turns())[1]).toMatchObject({ id: 2, closed_reason: 'archived' });
    await ctx.github();
    await ctx.tick();

    await ctx.add();
    expect((await ctx.task()).membership).toBe('active');
    await ctx.tick();
    expect(await ctx.openTurn()).toMatchObject({ id: 'T3', column: 'review' });
    expect((await ctx.turns())[2]).toMatchObject({ column: 'review', epoch, seq: 2 });
  });

  it('reroutes an untaken operator turn to a worker that links', async () => {
    const comment = (id: string, minute: number) => ({
      kind: 'comment' as const,
      id,
      author: { login: EXTERNAL, type: 'user' as const },
      postedAt: at(minute),
    });
    const handed = (id: string, minute: number) => ({
      repo: 'o/r',
      number: 7,
      kind: 'comment',
      id,
      postedAt: at(minute),
    });
    const ctx = await started({}, 'none');
    await ctx.pr({ feedback: [comment('c-1', 1)] });
    expect((await ctx.task()).column).toBe('dev');
    const operatorTurn = await ctx.openTurn();
    expect(operatorTurn).toEqual(
      turnOf('dev', 'operator', 'dev: external_comments, no_submit_on_head'),
    );
    expect(JSON.parse(operatorTurn?.handed ?? '[]')).toEqual([handed('c-1', 1)]);
    await ctx.pr({ feedback: [comment('c-1', 1), comment('c-2', 2)] });

    await ctx.spur('live');
    expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'rerouted' });
    const workerTurn = await ctx.openTurn();
    expect(workerTurn).toEqual(
      turnOf('dev', 'worker', 'dev: external_comments, no_submit_on_head'),
    );
    expect(JSON.parse(workerTurn?.handed ?? '[]')).toEqual([handed('c-1', 1), handed('c-2', 2)]);
    expect(
      await ctx.store.db.selectFrom('operator_item').select(['item_key', 'cleared_at']).execute(),
    ).toEqual([{ item_key: 'turn:1', cleared_at: expect.any(String) as unknown }]);
  });
});

describe('blindness', () => {
  it('draws no conclusion while GitHub is blind', async () => {
    const ctx = await inDev();
    await ctx.blind(GITHUB, true);
    await ctx.submit(WORKER, 'T1', A);
    await ctx.tick();
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();

    await ctx.blind(GITHUB, false);
    expect((await ctx.task()).column).toBe('review');
    expect(await ctx.openTurn()).toMatchObject({ column: 'review' });
  });

  it('holds a task before the first complete poll since start', async () => {
    const ctx = await inDev();
    ctx.restart();
    await ctx.spur();
    await ctx.submit(WORKER, 'T1', A);
    expect((await ctx.task()).column).toBe('dev');
    await ctx.github(false);
    expect((await ctx.task()).column).toBe('dev');

    await ctx.github();
    expect((await ctx.task()).column).toBe('review');
  });

  it('defers a worker turn while Spur is blind', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.blind('spur', true);
    await ctx.ret(REV, 'T2');
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();

    await ctx.blind('spur', false);
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
  });
});

describe('cycle limit', () => {
  const cycleItems = (ctx: Board) =>
    ctx.store.db
      .selectFrom('operator_item')
      .select(['id', 'item_key', 'cleared_at', 'block_id'])
      .where('kind', '=', 'cycle_limit')
      .orderBy('id')
      .execute();

  /** The reviewer takes its turn and returns the task. */
  async function cycle(ctx: Board) {
    const review = await ctx.openTurn();
    await ctx.ack(REV, review?.id ?? '');
    await ctx.ret(REV, review?.id ?? '');
  }

  /** The worker takes its Dev turn, pushes `head` and submits it. */
  async function resubmit(ctx: Board, head: string) {
    const dev = await ctx.openTurn();
    await ctx.ack(WORKER, dev?.id ?? '');
    await ctx.pr({ headSha: head });
    await ctx.submit(WORKER, dev?.id ?? '', head);
  }

  it('raises one operator block per limit, holds the task and resets on its close', async () => {
    const ctx = await inReview({ cycleLimit: 2 });
    await cycle(ctx);
    expect(await cycleItems(ctx)).toEqual([]);
    await resubmit(ctx, B);
    await cycle(ctx);

    const [item] = await cycleItems(ctx);
    expect(await cycleItems(ctx)).toEqual([
      {
        id: expect.any(Number) as unknown,
        item_key: 'cycle-limit:1:review',
        cleared_at: null,
        block_id: expect.any(Number) as unknown,
      },
    ]);
    expect(
      await ctx.store.db
        .selectFrom('block')
        .select('type')
        .where('id', '=', item?.block_id ?? 0)
        .execute(),
    ).toHaveLength(1);
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();

    await ctx.pr({ headSha: C });
    await ctx.tick();
    expect(await ctx.openTurn()).toBeNull();

    await ctx.closeItem(`I${String(item?.id)}`);
    expect(await ctx.openTurn()).toBeNull();
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));

    await resubmit(ctx, C);
    await cycle(ctx);
    expect(await cycleItems(ctx)).toHaveLength(1);
    await resubmit(ctx, A);
    await cycle(ctx);
    expect(await cycleItems(ctx)).toEqual([
      expect.objectContaining({ cleared_at: expect.any(String) as unknown }),
      expect.objectContaining({ cleared_at: null }),
    ]);
  });

  it('does not count conflict, red CI or draft returns', async () => {
    const ctx = await inReview({ cycleLimit: 1 });
    await ctx.pr({ mergeable: 'conflicting' });
    expect((await ctx.task()).column).toBe('dev');
    await ctx.pr({ mergeable: 'mergeable', headSha: B });
    await resubmit(ctx, B);
    expect((await ctx.task()).column).toBe('review');

    await ctx.pr({ requiredChecks: [{ name: 'ci', state: 'failure', completedAt: at(0) }] });
    expect((await ctx.task()).column).toBe('dev');
    await ctx.pr({ requiredChecks: [{ name: 'ci', state: 'success', completedAt: at(0) }] });
    await resubmit(ctx, C);
    expect((await ctx.task()).column).toBe('review');

    await ctx.pr({ draft: true });
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).filter((move) => move.reason === 'gate_broken')).toHaveLength(3);
    expect(await cycleItems(ctx)).toEqual([]);
    expect(await ctx.openTurn()).toMatchObject({ column: 'dev' });
  });
});

describe('mode switch', () => {
  it('copies the shadow column on a switch to on and records the mode', async () => {
    const ctx = await started({ mode: 'shadow' });
    const mode = () =>
      ctx.store.db
        .selectFrom('meta')
        .select('value')
        .where('key', '=', 'dispatcher_mode:proj')
        .executeTakeFirst();
    expect(await mode()).toEqual({ value: '"shadow"' });
    expect(await ctx.events('dispatcher_mode_changed')).toEqual([]);
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    expect(await ctx.task()).toMatchObject({
      column: 'todo',
      shadow_column: 'review',
      column_epoch: 0,
    });

    ctx.restart({ mode: 'on' });
    await ctx.tick();
    expect(await ctx.task()).toMatchObject({
      column: 'review',
      shadow_column: null,
      column_epoch: 1,
    });
    expect(await ctx.moves()).toEqual([{ from: 'todo', to: 'review', reason: 'mode_changed' }]);
    expect((await ctx.events('dispatcher_mode_changed')).map((event) => event.payload)).toEqual([
      { from: 'shadow', to: 'on' },
    ]);
    expect(await mode()).toEqual({ value: '"on"' });
    expect(await ctx.store.db.selectFrom('submission').select('voided_at').execute()).toEqual([
      { voided_at: null },
    ]);

    await ctx.github();
    expect(await ctx.openTurn()).toEqual(
      turnOf('review', 'orchestrator:review', 'review: no_review_on_head'),
    );
  });

  it('keeps feedback a shadow submit handled after a switch to on', async () => {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr({
      feedback: [
        {
          kind: 'comment',
          id: 'c-1',
          author: { login: EXTERNAL, type: 'user' },
          postedAt: at(1),
        },
      ],
    });
    await ctx.submit(WORKER, KEY, A);
    const submitted = ctx.at();
    expect((await ctx.task()).shadow_column).toBe('review');

    ctx.restart({ mode: 'on' });
    await ctx.tick();
    await ctx.github();
    await ctx.tick();
    expect(await ctx.task()).toMatchObject({ column: 'review', column_epoch: 1, left_moves: 0 });
    expect(await ctx.moves()).toEqual([{ from: 'todo', to: 'review', reason: 'mode_changed' }]);
    expect(await ctx.store.db.selectFrom('submission').select('voided_at').execute()).toEqual([
      { voided_at: null },
    ]);
    expect(await ctx.openTurn()).toMatchObject({ column: 'review', handed: '[]' });
    expect((await ctx.context()).feedbackCursors).toEqual([
      { ref: { kind: 'pr', repo: 'o/r', number: 7 }, id: '', postedAt: submitted },
    ]);
  });

  it('clears the shadow column on a switch back to shadow', async () => {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    ctx.restart({ mode: 'on' });
    await ctx.tick();
    await ctx.github();
    expect((await ctx.task()).column).toBe('review');
    const turn = await ctx.openTurn();
    expect(turn).not.toBeNull();
    const unackedTurnBells = () =>
      ctx.store.db
        .selectFrom('notification')
        .select('id')
        .where('kind', 'in', ['turn', 'turn_reminder'])
        .where('acked_at', 'is', null)
        .execute();
    expect(await unackedTurnBells()).not.toEqual([]);

    ctx.restart({ mode: 'shadow' });
    await ctx.tick();
    expect(await ctx.task()).toMatchObject({ column: 'review', shadow_column: null });
    // The turn left from `on` is closed with its ring, so it cannot move the real column.
    expect(await ctx.openTurn()).toBeNull();
    expect(
      (await ctx.turns()).find((row) => `T${String(row.id)}` === turn?.id)?.closed_reason,
    ).toBe('moved');
    expect(await unackedTurnBells()).toEqual([]);
    expect((await ctx.events('dispatcher_mode_changed')).map((event) => event.payload)).toEqual([
      { from: 'shadow', to: 'on' },
      { from: 'on', to: 'shadow' },
    ]);
    // The shadow continues from the column.
    await ctx.github();
    await ctx.submit(REV, KEY, A);
    expect(await ctx.task()).toMatchObject({ column: 'review', shadow_column: 'product-review' });
  });
});

describe('design flows 2.5 and 2.10', () => {
  const review = (reviewer: string, state: 'approved' | 'changes_requested', minute: number) => ({
    reviews: [{ reviewer, state, commitSha: A, submittedAt: at(minute) }],
    feedback: [
      {
        kind: 'review' as const,
        id: `r-${reviewer}`,
        author: { login: reviewer, type: 'user' as const },
        postedAt: at(minute),
      },
    ],
  });

  it('External Review holds with no turn until an external approval', async () => {
    const ctx = await pastProductReview({ externalReview: true });
    expect((await ctx.task()).column).toBe('external-review');
    expect(await ctx.openTurn()).toBeNull();
    await ctx.tick();
    expect(await ctx.openTurn()).toBeNull();

    await ctx.pr(review(EXTERNAL, 'approved', 30));
    expect((await ctx.task()).column).toBe('ready-to-merge');
  });

  it('an external changes-requested review returns the task to Dev and the Dev turn hands it over', async () => {
    const ctx = await pastProductReview({ externalReview: true });
    await ctx.pr(review(EXTERNAL, 'changes_requested', 30));
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['external_comments'] });
    const turn = await ctx.openTurn();
    expect(turn).toEqual(turnOf('dev', 'worker', 'dev: external_comments, no_submit_on_head'));
    expect(JSON.parse(turn?.handed ?? '[]')).toEqual([
      { repo: 'o/r', number: 7, kind: 'review', id: `r-${EXTERNAL}`, postedAt: at(30) },
    ]);
  });

  it('a second approval by the same reviewer in Ready to Merge returns nothing', async () => {
    const ctx = await pastProductReview();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    const before = await ctx.task();
    const moves = await ctx.moves();
    const approval = (id: string, minute: number) => ({
      kind: 'review' as const,
      id,
      author: { login: EXTERNAL, type: 'user' as const },
      postedAt: at(minute),
      state: 'approved' as const,
    });
    await ctx.pr({
      reviews: [{ reviewer: EXTERNAL, state: 'approved', commitSha: A, submittedAt: at(31) }],
      feedback: [approval('r-1', 30), approval('r-2', 31)],
    });

    expect(await ctx.task()).toMatchObject({
      column: 'ready-to-merge',
      column_epoch: before.column_epoch,
      left_moves: before.left_moves,
    });
    expect(await ctx.moves()).toEqual(moves);
    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select('column')
        .where('voided_at', 'is not', null)
        .execute(),
    ).toEqual([]);
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select('item_key')
        .where('kind', '=', 'cycle_limit')
        .execute(),
    ).toEqual([]);
  });

  it('a conflict in External Review returns it at once', async () => {
    const ctx = await pastProductReview({ externalReview: true });
    await ctx.pr({ mergeable: 'conflicting' });
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: conflict, no_submit_on_head'),
    );
  });

  it('a PR set back to draft during Review waits for the acked conductor turn', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.pr({ draft: true });
    expect((await ctx.task()).column).toBe('review');
    await ctx.submit(REV, 'T2', A);
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['pr_draft'] });
  });

  it('a force-push in Review with the conductor turn open waits, then goes to Dev', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.pr({ headSha: B });
    expect((await ctx.task()).column).toBe('review');
    await ctx.submit(REV, 'T2', B);
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['no_submit_on_head'] });
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
  });

  it('a PR closed without merge sends the task to Dev with no turn', async () => {
    const ctx = await inReview();
    await ctx.pr({ state: 'closed' });
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['pr_closed'] });
    expect(
      await ctx.store.db
        .selectFrom('turn')
        .select('id')
        .where('closed_at', 'is', null)
        .where('column', '=', 'dev')
        .execute(),
    ).toEqual([]);
  });

  it('an external comment during an open Dev turn is handed over on the after-submit turn', async () => {
    const ctx = await inDev();
    const comment = {
      kind: 'comment' as const,
      id: 'c-1',
      author: { login: EXTERNAL, type: 'user' as const },
      postedAt: at(20),
    };
    await ctx.pr({ feedback: [comment] });
    expect(await ctx.openTurn()).toMatchObject({ id: 'T1', handed: '[]' });
    expect(await ctx.turns()).toHaveLength(1);

    await ctx.submit(WORKER, 'T1', A);
    const turn = await ctx.openTurn();
    expect(turn).toEqual(turnOf('dev', 'worker', 'dev: external_comments'));
    expect(JSON.parse(turn?.handed ?? '[]')).toEqual([
      { repo: 'o/r', number: 7, kind: 'comment', id: 'c-1', postedAt: at(20) },
    ]);
  });

  it('hands over no comment from an incomplete history, then all of them once it is complete', async () => {
    const ctx = await inDev();
    const comment = (id: string, minute: number) => ({
      kind: 'comment' as const,
      id,
      author: { login: EXTERNAL, type: 'user' as const },
      postedAt: at(minute),
    });
    // The comment pages broke off: only the newest comment was read.
    await ctx.pr({ feedback: [comment('c-2', 21)], feedbackComplete: false });
    await ctx.submit(WORKER, 'T1', A);
    const gap = await ctx.openTurn();
    expect(gap).toEqual(
      turnOf('dev', 'worker', 'dev: external_comments, comment_history_incomplete'),
    );
    expect(gap?.handed).toBe('[]');
    expect('feedbackCursors' in (await ctx.context())).toBe(false);

    await ctx.pr({ feedback: [comment('c-1', 20), comment('c-2', 21)], feedbackComplete: true });
    await ctx.ack(WORKER, gap?.id ?? '');
    await ctx.submit(WORKER, gap?.id ?? '', A);
    const turn = await ctx.openTurn();
    expect(turn).toEqual(turnOf('dev', 'worker', 'dev: external_comments'));
    expect(JSON.parse(turn?.handed ?? '[]')).toEqual([
      { repo: 'o/r', number: 7, kind: 'comment', id: 'c-1', postedAt: at(20) },
      { repo: 'o/r', number: 7, kind: 'comment', id: 'c-2', postedAt: at(21) },
    ]);
  });

  it('a turned Dev submit does not handle a comment posted before it', async () => {
    const ctx = await inDev();
    const posted = ctx.at();
    await ctx.pr({
      feedback: [
        {
          kind: 'comment' as const,
          id: 'c-1',
          author: { login: EXTERNAL, type: 'user' as const },
          postedAt: posted,
        },
      ],
    });
    await ctx.submit(WORKER, 'T1', A);
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: external_comments'));
    // The cursor is the handed comment, not a time-only cutoff at the turned submit.
    expect((await ctx.context()).feedbackCursors).toEqual([
      { ref: { kind: 'pr', repo: 'o/r', number: 7 }, id: 'c-1', postedAt: posted },
    ]);
  });

  it('an after-submit turn that hands over an external comment needs its own submit', async () => {
    const ctx = await inDev();
    await ctx.pr({
      feedback: [
        {
          kind: 'comment' as const,
          id: 'c-1',
          author: { login: EXTERNAL, type: 'user' as const },
          postedAt: at(20),
        },
      ],
    });
    await ctx.submit(WORKER, 'T1', A);
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: external_comments'));

    await ctx.tick();
    await ctx.github();
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toMatchObject({ id: 'T2' });

    await ctx.ack(WORKER, 'T2');
    await expect(ctx.submit(WORKER, 'T2', A)).resolves.toMatchObject({
      task: { column: 'review' },
    });
  });

  it('an operator approval review is not an external comment', async () => {
    const ctx = await pastProductReview();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    await ctx.pr(review('operator-human', 'approved', 30));
    expect((await ctx.task()).column).toBe('ready-to-merge');
  });
});

describe('triggers', () => {
  it('evaluates a task journaled by a command on the next tick', async () => {
    const ctx = board();
    await ctx.ticket();
    await ctx.github();
    await ctx.spur('unlinked');
    expect((await ctx.task()).column).toBe('todo');

    await ctx.linkSession('worker-1');
    expect((await ctx.task()).column).toBe('todo');
    await ctx.tick();
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_pr'));
  });

  it('evaluates no task without a new journal entry', async () => {
    const ctx = await started({}, 'none');
    await ctx.tick();
    await ctx.store.transaction(async (trx) => {
      await trx
        .insertInto('link')
        .values({
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'rev-1',
          role: 'worker',
          source: 'manual',
          created_at: ctx.at(),
          ticket_key: null,
          pr_open: null,
        })
        .execute();
    });
    await ctx.tick();
    await ctx.tick();
    expect((await ctx.task()).column).toBe('todo');
    expect(await ctx.moves()).toEqual([]);

    // The stored facts would move it: a source pass does.
    await ctx.blind(GITHUB, true);
    await ctx.blind(GITHUB, false);
    expect((await ctx.task()).column).toBe('dev');
  });
});
