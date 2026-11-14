import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  eventPayloadSchemas,
  ok,
  type ActorId,
  type ColumnId,
  type EventKind,
  type PrFacts,
  type PrPoller,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { sql } from 'kysely';
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
import { editInboundComment, recordInboundBlockMessage } from '../../src/app/blocks.ts';
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
const CUR: ActorId = 'agent:cur/cur-1';
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
  /** Review's course check; the default applies when unset. */
  courseCheck?: number;
  /** Adds the curator project `cur` with a live session `cur-1`. */
  curator?: boolean;
  externalReview?: boolean;
  devOrchestrator?: string;
  /** The task's project left the config: the only project tracks another repo. */
  projectRemoved?: boolean;
};

function boardConfig(options: Options = {}) {
  return configSchema.parse({
    projects: [
      {
        id: options.projectRemoved === true ? 'other' : 'proj',
        tracker: {
          type: 'github-issues',
          repo: options.projectRemoved === true ? 'o/other' : 'o/r',
          label: 'board',
        },
        repos: [options.projectRemoved === true ? 'o/other' : 'o/r'],
        operatorGithubLogin: 'agent-bot',
        spurProjects: [
          { name: 'worker', role: 'worker' },
          { name: 'rev', role: 'worker' },
          { name: 'coord', role: 'worker' },
          ...(options.curator === true ? [{ name: 'cur', role: 'curator' }] : []),
        ],
        columns: [
          { id: 'todo' },
          {
            id: 'dev',
            ...(options.devOrchestrator === undefined
              ? {}
              : { orchestrator: options.devOrchestrator }),
          },
          {
            id: 'review',
            orchestrator: 'rev',
            cycleLimit: options.cycleLimit ?? 10,
            ...(options.courseCheck === undefined ? {} : { courseCheck: options.courseCheck }),
          },
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
          ...(options.curator === true
            ? [{ kind: 'session' as const, facts: sessionFacts('cur-1', 'cur') }]
            : []),
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
    /** The operator corrects the task's column. */
    move: (column: Exclude<ColumnId, 'done'>, reason = 'The board put it in the wrong column.') => {
      step();
      return apply(
        registry['task.move'],
        { mode: 'correct', task: KEY, column, reason },
        'operator',
        `key-${String(++keys)}`,
      );
    },
    unlinkPr: (number = 7) => {
      step();
      return apply(
        registry['link.remove'],
        {
          mode: 'pr',
          task: KEY,
          pr: `https://github.com/o/r/pull/${String(number)}`,
          reason: 'Merged for another ticket.',
        },
        'operator',
        `key-${String(++keys)}`,
      );
    },
    why: async () => {
      const result = await query(registry['task.get'], { task: KEY, why: true }, 'operator');
      if (result.why === undefined) throw new Error('task.get returned no why');
      return result.why;
    },
    add: () => {
      step();
      return apply(registry['task.add'], { task: KEY }, 'operator', `key-${String(++keys)}`);
    },
    answer: (actor: ActorId, block: string, text: string) => {
      step();
      return apply(registry['block.answer'], { block, text }, actor, `key-${String(++keys)}`);
    },
    unblock: (actor: ActorId, block: string, reason: string) => {
      step();
      return apply(
        registry['block.unblock'],
        { mode: 'reason', block, reason },
        actor,
        `key-${String(++keys)}`,
      );
    },
    escalate: (actor: ActorId, block: string) => {
      step();
      return apply(registry['block.escalate'], { block }, actor, `key-${String(++keys)}`);
    },
    /** The operator's message in the block's Slack thread, as the inbound applier records it. */
    reply: (block: string, text: string) => {
      const at = step();
      return scanTransaction(store, config, (trx) =>
        recordInboundBlockMessage(trx, {
          blockId: Number(block.slice(1)),
          text,
          conversationRef: 'C-thread',
          messageRef: `m-${String(++keys)}`,
          at,
          config,
        }),
      );
    },
    /** The operator's edit of a Slack message, as the inbound applier records it. */
    editReply: (comment: number, text: string) => {
      const at = step();
      return scanTransaction(store, config, async (trx) =>
        editInboundComment(trx, {
          comment: await trx
            .selectFrom('comment')
            .selectAll()
            .where('id', '=', comment)
            .executeTakeFirstOrThrow(),
          text,
          at,
          actor: 'operator',
          config,
        }),
      );
    },
    editComment: (actor: ActorId, comment: string, text: string) => {
      step();
      return apply(registry['comment.edit'], { comment, text }, actor, `key-${String(++keys)}`);
    },
    ackComment: (actor: ActorId, comment: string, revision: number) => {
      step();
      return apply(
        registry['inbox.ack'],
        { entries: [{ id: comment, revision }] },
        actor,
        `key-${String(++keys)}`,
      );
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
    /** The task's `status.get` row. */
    async status() {
      const { tasks } = await query(registry['status.get'], {}, 'operator');
      const [row] = tasks;
      if (row === undefined || tasks.length !== 1) throw new Error('status.get returned no row');
      return row;
    },
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

  it('a PR first seen merged after a reopen it predates sends the task to To Do', async () => {
    const ctx = await started();
    const turn = await ctx.openTurn();
    await ctx.ack(WORKER, turn?.id ?? '');
    // GitHub merged #7, then the ticket closed and reopened, all before a poll saw #7.
    const merged = ctx.at();
    await ctx.ticket('closed');
    await ctx.ticket('open');
    await ctx.pr({ state: 'merged', mergedAt: merged });
    expect(await ctx.task()).toMatchObject({ column: 'todo' });
    expect(
      await ctx.store.db
        .selectFrom('link')
        .select('number')
        .where('reopen_hidden_at', 'is not', null)
        .execute(),
    ).toEqual([{ number: 7 }]);
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'dev',
      to: 'todo',
      reason: 'ticket_reopened',
    });
  });

  it('a PR first seen merged after the reopen it follows counts', async () => {
    const ctx = await started();
    const turn = await ctx.openTurn();
    await ctx.ack(WORKER, turn?.id ?? '');
    await ctx.ticket('closed');
    await ctx.ticket('open');
    await ctx.pr({
      state: 'merged',
      mergedAt: new Date(Date.parse(ctx.at()) + 30_000).toISOString(),
    });
    expect((await ctx.task()).column).toBe('done');
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

  it('a merge made before the reopen is hidden though the PR changed after it', async () => {
    const ctx = await inDev();
    // GitHub merged #7 before the ticket closed and reopened; its title is edited after the reopen.
    const merged = ctx.at();
    await ctx.ticket('closed');
    await ctx.ticket('open');
    const edited = new Date(Date.parse(ctx.at()) + 30_000).toISOString();
    await ctx.pr({ state: 'merged', mergedAt: merged, updatedAt: edited, title: 'Renamed' });
    expect(await ctx.task()).toMatchObject({ column: 'todo' });
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'dev',
      to: 'todo',
      reason: 'ticket_reopened',
    });
  });

  it('a late pre-reopen merge hides only its own PR, not a follow-up merged after the reopen', async () => {
    const ctx = await inDev();
    // GitHub merged #7 before the ticket closed and reopened; the board sees that merge last.
    const merged = ctx.at();
    await ctx.ticket('closed');
    await ctx.ticket('open');
    const after = new Date(Date.parse(ctx.at()) + 30_000).toISOString();
    // Follow-up #8 is first seen merged after the reopen, so it links active and counts.
    await ctx.pr({
      number: 8,
      url: 'https://github.com/o/r/pull/8',
      headSha: C,
      state: 'merged',
      updatedAt: after,
    });
    await ctx.pr({ number: 7, state: 'merged', updatedAt: merged });
    expect(
      await ctx.store.db
        .selectFrom('link')
        .select('number')
        .where('reopen_hidden_at', 'is not', null)
        .execute(),
    ).toEqual([{ number: 7 }]);
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

  it('status shows the shadow column next to the column on every row', async () => {
    const ctx = board({ mode: 'shadow' });
    await ctx.ticket();
    await ctx.github();
    await ctx.spur('none');
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: null });
    expect(await ctx.status()).toEqual({
      key: KEY,
      project: 'proj',
      column: 'todo',
      membership: 'active',
      shadowColumn: 'todo',
      shadowDiffers: false,
      state: 'ticket open',
      prCount: 0,
      sessionCount: 0,
      openBlocks: 0,
    });

    await ctx.spur('live');
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: 'review' });
    expect(await ctx.status()).toEqual({
      key: KEY,
      project: 'proj',
      column: 'todo',
      membership: 'active',
      shadowColumn: 'review',
      shadowDiffers: true,
      state: 'ticket open; PRs 1 open; sessions 1 working',
      prCount: 1,
      sessionCount: 1,
      openBlocks: 0,
    });
  });

  it('records a course check on the counted shadow return without a block', async () => {
    const ctx = await started({ mode: 'shadow', courseCheck: 2 });
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    // A conflict return does not count.
    await ctx.pr({ mergeable: 'conflicting' });
    await ctx.pr({ mergeable: 'mergeable' });
    await ctx.submit(WORKER, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('review');
    const comment = (id: string) => ({
      kind: 'comment' as const,
      id,
      author: { login: EXTERNAL, type: 'user' as const },
      postedAt: new Date(Date.parse(ctx.at()) + 30_000).toISOString(),
    });
    const first = comment('c-1');
    await ctx.pr({ feedback: [first] });
    expect((await ctx.task()).shadow_column).toBe('dev');
    await ctx.submit(WORKER, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('review');
    await ctx.pr({ feedback: [first, comment('c-2')] });
    expect((await ctx.task()).shadow_column).toBe('dev');

    const returns = (await ctx.events('task_shadow_moved'))
      .map((event) => event.payload)
      .filter((payload) => payload.to === 'dev' && payload.from === 'review');
    expect(returns).toEqual([
      expect.objectContaining({ gate: ['conflict'] }),
      expect.not.objectContaining({ courseCheck: true }),
      expect.objectContaining({ gate: ['external_comments'], courseCheck: true }),
    ]);
    expect(returns[0]).not.toHaveProperty('courseCheck');
    expect(returns[1]).toMatchObject({ gate: ['external_comments'] });
    expect(await ctx.count('block')).toBe(0);
    expect(await ctx.count('operator_item')).toBe(0);
    const { events } = await ctx.history();
    expect(
      events.filter((event) => event.summary === 'Shadow move with a course check'),
    ).toHaveLength(1);
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

const itemsOf = (ctx: Board, kind: 'cycle_limit' | 'course_check') =>
  ctx.store.db
    .selectFrom('operator_item')
    .select(['id', 'item_key', 'cleared_at', 'block_id'])
    .where('kind', '=', kind)
    .orderBy('id')
    .execute();

describe('cycle limit', () => {
  it('raises one operator block per limit, holds the task and resets on its close', async () => {
    // Four counted returns: the course check is off so only the cycle limit stops the task.
    const ctx = await inReview({ cycleLimit: 2, courseCheck: 0 });
    await cycle(ctx);
    expect(await itemsOf(ctx, 'cycle_limit')).toEqual([]);
    await resubmit(ctx, B);
    await cycle(ctx);

    const [item] = await itemsOf(ctx, 'cycle_limit');
    expect(await itemsOf(ctx, 'cycle_limit')).toEqual([
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
    expect(await itemsOf(ctx, 'cycle_limit')).toHaveLength(1);
    await resubmit(ctx, A);
    await cycle(ctx);
    expect(await itemsOf(ctx, 'cycle_limit')).toEqual([
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
    expect(await itemsOf(ctx, 'cycle_limit')).toEqual([]);
    expect(await ctx.openTurn()).toMatchObject({ column: 'dev' });
  });
});

describe('course check', () => {
  const NOTE = 'Split the parser change out and finish the empty-list case first.';

  /** Three counted returns from Review, the worker resubmitting B and then `third`. */
  async function threeReturns(ctx: Board, third = C) {
    await cycle(ctx);
    await resubmit(ctx, B);
    await cycle(ctx);
    await resubmit(ctx, third);
    await cycle(ctx);
  }

  /** The block of the task's one active course-check item. */
  async function courseBlock(ctx: Board) {
    const items = (await itemsOf(ctx, 'course_check')).filter((item) => item.cleared_at === null);
    expect(items).toHaveLength(1);
    return ctx.store.db
      .selectFrom('block')
      .selectAll()
      .where('id', '=', items[0]?.block_id ?? 0)
      .executeTakeFirstOrThrow();
  }

  it('asks the curator on the third counted return instead of a Dev turn', async () => {
    const ctx = await inReview({ curator: true });
    await cycle(ctx);
    await resubmit(ctx, B);
    await cycle(ctx);
    await resubmit(ctx, C);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    await cycle(ctx);

    expect(await itemsOf(ctx, 'course_check')).toEqual([
      {
        id: expect.any(Number) as unknown,
        item_key: 'course-check:1:review',
        cleared_at: null,
        block_id: expect.any(Number) as unknown,
      },
    ]);
    expect(await itemsOf(ctx, 'cycle_limit')).toEqual([]);
    const block = await courseBlock(ctx);
    expect(block).toMatchObject({
      type: 'needs_input',
      author: 'system',
      addressee_role: 'curator',
      state: 'open',
    });
    expect(block.reason).toContain('course check: 3 returns to Dev from review');
    expect(block.reason).toContain('by rev/rev-1 on');
    expect(block.reason).toContain('on aaaaaaa: Handle the empty list.');
    expect(block.reason).toContain('PR: https://github.com/o/r/pull/7');
    expect(block.reason).toContain('Issue: https://github.com/o/r/issues/9');
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();
    expect((await ctx.why()).holds).toContain('cycle_limit');

    // The hold lasts across ticks and new heads; a repeated return opens no second block.
    await ctx.pr({ headSha: A });
    await ctx.tick();
    expect(await ctx.openTurn()).toBeNull();
    expect(await itemsOf(ctx, 'course_check')).toHaveLength(1);
  });

  it('lists a changes-requested reviewer with the short commit', async () => {
    const ctx = await inReview({ curator: true });
    await cycle(ctx);
    await resubmit(ctx, C);
    await cycle(ctx);
    await resubmit(ctx, B);
    await ctx.pr({
      reviews: [
        { reviewer: EXTERNAL, state: 'changes_requested', commitSha: B, submittedAt: at(0) },
        { reviewer: 'someone', state: 'approved', commitSha: B, submittedAt: at(0) },
      ],
      reviewThreads: [{ resolved: false }, { resolved: true }],
    });
    await cycle(ctx);

    const { reason } = await courseBlock(ctx);
    expect(reason).toContain('- reviewer requested changes on bbbbbbb (current head)');
    expect(reason).not.toContain('someone');
    expect(reason).toContain('Unresolved review threads: 1');
  });

  it('the curator answer resumes Dev with the note and resets only the course count', async () => {
    const ctx = await inReview({ curator: true });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);

    await ctx.answer(CUR, `B${String(block.id)}`, NOTE);
    expect(await ctx.openTurn()).toBeNull();
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    const { comments } = await ctx.inbox(WORKER);
    expect(comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ block: null, text: NOTE, author: CUR })]),
    );
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));

    const active = async () =>
      (await itemsOf(ctx, 'course_check')).map((item) => item.cleared_at === null);
    await resubmit(ctx, A);
    await cycle(ctx);
    expect(await active()).toEqual([false]);
    await resubmit(ctx, B);
    await cycle(ctx);
    expect(await active()).toEqual([false]);
    await resubmit(ctx, C);
    await cycle(ctx);
    expect(await active()).toEqual([false, true]);
    expect(await itemsOf(ctx, 'cycle_limit')).toEqual([]);
  });

  it('cycleLimit keeps counting after a curator answer', async () => {
    const ctx = await inReview({ curator: true, cycleLimit: 4, courseCheck: 3 });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    await ctx.answer(CUR, `B${String(block.id)}`, NOTE);
    await ctx.tick();
    await resubmit(ctx, A);
    await cycle(ctx);

    const [limit] = await itemsOf(ctx, 'cycle_limit');
    expect(limit).toMatchObject({ item_key: 'cycle-limit:1:review', cleared_at: null });
    expect(
      await ctx.store.db
        .selectFrom('block')
        .select(['addressee_role', 'author'])
        .where('id', '=', limit?.block_id ?? 0)
        .executeTakeFirst(),
    ).toEqual({ addressee_role: 'operator', author: 'system' });
    expect((await itemsOf(ctx, 'course_check')).map((item) => item.cleared_at === null)).toEqual([
      false,
    ]);
    expect(await ctx.openTurn()).toBeNull();
  });

  it('cycleLimit wins when both are reached', async () => {
    const ctx = await inReview({ curator: true, cycleLimit: 3, courseCheck: 3 });
    await threeReturns(ctx);
    expect(await itemsOf(ctx, 'cycle_limit')).toHaveLength(1);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    expect(await ctx.openTurn()).toBeNull();
  });

  it('a cycle-limit clear does not reset the course count', async () => {
    const ctx = await inReview({ curator: true, cycleLimit: 2, courseCheck: 3 });
    await cycle(ctx);
    await resubmit(ctx, B);
    await cycle(ctx);
    const [limit] = await itemsOf(ctx, 'cycle_limit');
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    await ctx.closeItem(`I${String(limit?.id)}`);
    await ctx.tick();
    await resubmit(ctx, C);
    await cycle(ctx);

    expect((await itemsOf(ctx, 'cycle_limit')).map((item) => item.cleared_at === null)).toEqual([
      false,
    ]);
    expect(await itemsOf(ctx, 'course_check')).toEqual([
      expect.objectContaining({ item_key: 'course-check:1:review', cleared_at: null }),
    ]);
    expect(await ctx.openTurn()).toBeNull();
  });

  it('courseCheck 0 turns the check off', async () => {
    const ctx = await inReview({ curator: true, courseCheck: 0 });
    for (const head of [B, C, A, B]) {
      await cycle(ctx);
      expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
      await resubmit(ctx, head);
    }
    expect((await ctx.moves()).filter((move) => move.to === 'dev' && move.block)).toHaveLength(4);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
  });

  it('without a curator the operator gets the block and its thread reply resumes Dev', async () => {
    const ctx = await inReview();
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    expect(block.addressee_role).toBe('operator');
    expect(await opens(ctx, block.id)).toBe(1);

    await ctx.reply(`B${String(block.id)}`, NOTE);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    expect((await ctx.inbox(WORKER)).comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ block: null, text: NOTE, author: 'operator' }),
      ]),
    );
  });

  it('the curator closing the course block with a reason resumes Dev with the reason', async () => {
    const ctx = await inReview({ curator: true });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    const reason = 'The course is fine: the reviewer asks for the same fix each time.';

    await ctx.unblock(CUR, `B${String(block.id)}`, reason);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    const notes = (await ctx.inbox(WORKER)).comments.filter((comment) => comment.block === null);
    expect(notes).toEqual([expect.objectContaining({ text: reason, author: CUR })]);
  });

  it('the curator escalates the course block to the operator, whose reply resumes Dev', async () => {
    const ctx = await inReview({ curator: true });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    expect(await opens(ctx, block.id)).toBe(0);

    await ctx.escalate(CUR, `B${String(block.id)}`);
    expect(await courseBlock(ctx)).toMatchObject({ addressee_role: 'operator', state: 'open' });
    expect(await opens(ctx, block.id)).toBe(1);
    await ctx.tick();
    expect(await ctx.openTurn()).toBeNull();
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toBeNull();

    await ctx.reply(`B${String(block.id)}`, NOTE);
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    const notes = (await ctx.inbox(WORKER)).comments.filter((comment) => comment.block === null);
    expect(notes).toEqual([expect.objectContaining({ text: NOTE, author: 'operator' })]);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));
  });

  it('an edit of the operator Slack answer reaches the forwarded note', async () => {
    const ctx = await inReview();
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    await ctx.reply(`B${String(block.id)}`, NOTE);
    const answer = await ctx.store.db
      .selectFrom('comment')
      .select('id')
      .where('block_id', '=', block.id)
      .where('author', '=', 'operator')
      .executeTakeFirstOrThrow();
    const corrected = `${NOTE} Accept the slow path as a known limit.`;

    await ctx.editReply(answer.id, corrected);
    await ctx.tick();
    const notes = (await ctx.inbox(WORKER)).comments.filter((comment) => comment.block === null);
    expect(notes).toEqual([expect.objectContaining({ text: corrected, author: 'operator' })]);
  });

  it('a curator comment.edit of its answer reaches the forwarded note, even once acked', async () => {
    const ctx = await inReview({ curator: true });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    const { comment } = await ctx.answer(CUR, `B${String(block.id)}`, NOTE);
    await ctx.tick();
    const [note] = (await ctx.inbox(WORKER)).comments.filter((entry) => entry.block === null);
    expect(note).toEqual(expect.objectContaining({ text: NOTE, author: CUR }));
    await ctx.ackComment(WORKER, note?.id ?? '', note?.revision ?? 1);
    expect((await ctx.inbox(WORKER)).comments.filter((entry) => entry.block === null)).toEqual([]);

    const corrected = `${NOTE} Accept the slow path as a known limit.`;
    await ctx.editComment(CUR, comment.id, corrected);
    const notes = (await ctx.inbox(WORKER)).comments.filter((entry) => entry.block === null);
    expect(notes).toEqual([
      expect.objectContaining({ id: note?.id, text: corrected, author: CUR }),
    ]);
  });
});

/** The `conversation.open` outbox rows of block `blockId`. */
async function opens(ctx: Board, blockId: number): Promise<number> {
  const rows = await ctx.store.db
    .selectFrom('outbox')
    .select('id')
    .where('kind', '=', 'conversation.open')
    .where(sql<boolean>`json_extract(payload, '$.blockId') = ${blockId}`)
    .execute();
  return rows.length;
}

describe('mode switch', () => {
  it('status rows of an on project carry no shadow fields, a pending switch included', async () => {
    const on = await started({ mode: 'on' });
    const row = await on.status();
    expect(Object.keys(row)).toEqual([
      'key',
      'project',
      'column',
      'membership',
      'state',
      'prCount',
      'sessionCount',
      'openBlocks',
    ]);
    expect(row).toEqual({
      key: KEY,
      project: 'proj',
      column: 'dev',
      membership: 'active',
      state: 'ticket open; sessions 1 working',
      prCount: 0,
      sessionCount: 1,
      openBlocks: 0,
    });

    const ctx = await started({ mode: 'shadow' });
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: 'review' });
    ctx.restart({ mode: 'on' });
    const pending = await ctx.status();
    expect(pending).not.toHaveProperty('shadowColumn');
    expect(pending).not.toHaveProperty('shadowDiffers');
    expect(pending).toMatchObject({ column: 'todo' });
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: 'review' });
  });

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

  it('an entry turn that hands over a comment after a shadow submit needs its own submit', async () => {
    const ctx = await started({ mode: 'shadow' });
    const pending = [{ name: 'ci', state: 'pending' as const, completedAt: null }];
    await ctx.pr({ requiredChecks: pending });
    await ctx.submit(WORKER, KEY, A);
    expect((await ctx.task()).shadow_column).toBe('dev');
    // The comment comes a step after the submit, so that submit did not handle it.
    await ctx.github();
    await ctx.pr({
      feedback: [
        {
          kind: 'comment',
          id: 'c-1',
          author: { login: EXTERNAL, type: 'user' },
          postedAt: ctx.at(),
        },
      ],
    });

    ctx.restart({ mode: 'on' });
    await ctx.spur();
    await ctx.pr({ requiredChecks: prFacts().requiredChecks });
    expect(await ctx.task()).toMatchObject({ column: 'dev', column_epoch: 1 });
    const turn = await ctx.openTurn();
    expect(turn).toEqual(turnOf('dev', 'worker', 'dev: external_comments'));
    expect(JSON.parse(turn?.handed ?? '[]')).toMatchObject([{ kind: 'comment', id: 'c-1' }]);
    expect(
      await ctx.store.db.selectFrom('submission').select(['column', 'voided_at']).execute(),
    ).toEqual([{ column: 'dev', voided_at: expect.any(String) as unknown }]);

    await ctx.tick();
    await ctx.github();
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toMatchObject({ id: turn?.id });

    await ctx.ack(WORKER, turn?.id ?? '');
    await expect(ctx.submit(WORKER, turn?.id ?? '', A)).resolves.toMatchObject({
      task: { column: 'review' },
    });
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

describe('task.move', () => {
  const cycleItems = (ctx: Board) =>
    ctx.store.db
      .selectFrom('operator_item')
      .select(['item_key', 'cleared_at'])
      .where('kind', '=', 'cycle_limit')
      .execute();
  const mode = (ctx: Board) =>
    ctx.store.db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', 'dispatcher_mode:proj')
      .executeTakeFirst();
  /** The kinds journaled from `task_corrected` on. */
  const fromCorrection = async (ctx: Board) => {
    const events = await ctx.events();
    return events.slice(events.findIndex((event) => event.kind === 'task_corrected'));
  };
  /** In shadow mode, the task in To Do with its shadow column in Review after a shadow submit. */
  async function shadowInReview(): Promise<Board> {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: 'review' });
    return ctx;
  }

  it('explains from the shadow column a pending switch to on will copy, and writes nothing', async () => {
    const ctx = await shadowInReview();
    ctx.restart({ mode: 'on' });
    const before = await ctx.snapshot();

    const why = await ctx.why();

    expect(why).toMatchObject({ column: 'review', dispatcher: 'on' });
    expect(await ctx.snapshot()).toEqual(before);
    expect(await mode(ctx)).toEqual({ value: '"shadow"' });
  });

  it("settles a correction past a broken Dev back in Dev and counts it toward Review's limit", async () => {
    const ctx = await inDev({ cycleLimit: 1 });
    await ctx.pr({
      feedback: [
        { kind: 'comment', id: 'c-1', author: { login: EXTERNAL, type: 'user' }, postedAt: at(5) },
      ],
      feedbackComplete: true,
    });

    const result = await ctx.move('review');

    expect(result.column).toBe('dev');
    expect(result.settled).toEqual([
      expect.objectContaining({
        kind: 'task_moved',
        from: 'review',
        to: 'dev',
        reason: 'gate_broken',
        gate: expect.arrayContaining(['external_comments']) as unknown,
      }),
    ]);
    const [corrected, bounced] = await fromCorrection(ctx);
    expect(corrected).toEqual({
      kind: 'task_corrected',
      payload: {
        from: 'dev',
        to: 'review',
        reason: 'The board put it in the wrong column.',
        shadow: false,
      },
    });
    expect(bounced).toMatchObject({
      kind: 'task_moved',
      payload: { from: 'review', to: 'dev', reason: 'gate_broken' },
    });
    expect(await cycleItems(ctx)).toEqual([{ item_key: 'cycle-limit:1:review', cleared_at: null }]);
    expect(await ctx.openTurn()).toBeNull();
    expect((await ctx.task()).left_moves).toBe(1);
  });

  it('carries the feedback an untaken Dev turn handed over into the turn after a correction to Dev', async () => {
    const handed = { repo: 'o/r', number: 7, kind: 'comment', id: 'c-1', postedAt: at(1) };
    const ctx = await started({}, 'none');
    await ctx.pr({
      feedback: [
        { kind: 'comment', id: 'c-1', author: { login: EXTERNAL, type: 'user' }, postedAt: at(1) },
      ],
    });
    const untaken = await ctx.openTurn();
    expect(untaken).toEqual(turnOf('dev', 'operator', 'dev: external_comments, no_submit_on_head'));
    expect(JSON.parse(untaken?.handed ?? '[]')).toEqual([handed]);

    const result = await ctx.move('dev');

    expect(result.column).toBe('dev');
    expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'corrected' });
    const turn = await ctx.openTurn();
    expect(turn).toMatchObject({ id: 'T2', column: 'dev' });
    expect(JSON.parse(turn?.handed ?? '[]')).toEqual([handed]);
  });

  describe('feedback of the untaken turns a correction closes', () => {
    const handed = { repo: 'o/r', number: 7, kind: 'comment', id: 'c-1', postedAt: at(1) };
    /** No live worker: the operator's untaken Dev turn T1 hands over comment c-1. */
    async function untakenWithComment(): Promise<Board> {
      const ctx = await started({}, 'none');
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
      expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handed]);
      return ctx;
    }

    it('hands it over in the Dev turn opened once GitHub sees again', async () => {
      const ctx = await untakenWithComment();
      await ctx.blind(GITHUB, true);

      await ctx.move('dev');
      expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'corrected' });
      expect(await ctx.openTurn()).toBeNull();
      // The poll cursor still counts the closed turn: the snapshot keeps c-1 either way.
      expect((await ctx.context()).feedbackCursors).toEqual([
        { ref: { kind: 'pr', repo: 'o/r', number: 7 }, id: 'c-1', postedAt: at(1) },
      ]);

      await ctx.blind(GITHUB, false);
      const turn = await ctx.openTurn();
      expect(turn).toMatchObject({ id: 'T2', column: 'dev' });
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([handed]);
    });

    it('hands it over in the Dev turn after a correction to Review bounces left', async () => {
      const ctx = await untakenWithComment();

      const result = await ctx.move('review');

      expect(result).toMatchObject({ column: 'dev', settled: [{ from: 'review', to: 'dev' }] });
      const turn = await ctx.openTurn();
      expect(turn).toMatchObject({ id: 'T2', column: 'dev' });
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([handed]);
    });

    it('hands it over in the worker turn deferred while Spur is blind, past a reroute', async () => {
      const ctx = await untakenWithComment();
      await ctx.spur('live');
      expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'rerouted' });
      expect(await ctx.openTurn()).toMatchObject({ id: 'T2', role: 'worker' });
      await ctx.blind('spur', true);

      await ctx.move('dev');
      expect((await ctx.turns())[1]).toMatchObject({ id: 2, closed_reason: 'corrected' });
      expect(await ctx.openTurn()).toBeNull();

      await ctx.blind('spur', false);
      const turn = await ctx.openTurn();
      expect(turn).toMatchObject({ id: 'T3', column: 'dev', role: 'worker' });
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([handed]);
    });

    it('hands it over from the closed turn after a poll dropped it from the snapshot', async () => {
      const ctx = await untakenWithComment();
      // A poll past more than 100 newer comments stops at the turn's c-1 and keeps only the
      // newest 100: c-1 is gone from the snapshot, and the poll cursor never pages back to it.
      await ctx.pr({ feedback: [] });
      expect(await ctx.openTurn()).toMatchObject({ id: 'T1' });

      await ctx.move('dev');

      expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'corrected' });
      const turn = await ctx.openTurn();
      expect(turn).toEqual(turnOf('dev', 'operator', 'dev: external_comments, no_submit_on_head'));
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([handed]);
    });

    it('drops it from a closed untaken turn once a later taken turn handed it over', async () => {
      const ctx = await untakenWithComment();
      await ctx.spur('live');
      await ctx.ack(WORKER, 'T2');
      await ctx.pr({ feedback: [] });

      await ctx.move('dev');

      expect((await ctx.turns()).map((turn) => turn.closed_reason)).toEqual([
        'rerouted',
        'corrected',
        null,
      ]);
      const turn = await ctx.openTurn();
      expect(turn).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([]);
    });

    it('counts it handled when the closed turn was taken', async () => {
      const ctx = await untakenWithComment();
      await ctx.spur('live');
      await ctx.ack(WORKER, 'T2');

      await ctx.move('dev');

      expect((await ctx.turns())[1]).toMatchObject({ id: 2, closed_reason: 'corrected' });
      const turn = await ctx.openTurn();
      expect(turn).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([]);
    });
  });

  it('settles a correction out of an unlinked Done to Review back in Dev with no_pr, uncounted', async () => {
    const ctx = await inDev({ cycleLimit: 1 });
    await ctx.pr({ state: 'merged' });
    expect((await ctx.task()).column).toBe('done');
    await ctx.unlinkPr();
    expect((await ctx.task()).column).toBe('done');

    const result = await ctx.move('review');

    expect(result).toMatchObject({ from: 'done', to: 'review', column: 'dev' });
    expect(
      result.settled.map(({ from, to, reason, gate }) => ({ from, to, reason, gate })),
    ).toEqual([{ from: 'review', to: 'dev', reason: 'gate_broken', gate: ['no_pr'] }]);
    expect(await cycleItems(ctx)).toEqual([]);
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_pr'));
  });

  it('settles a shadow correction with task_shadow_moved and no count', async () => {
    const ctx = await started({ mode: 'shadow', cycleLimit: 1 });

    const result = await ctx.move('review');

    expect(result).toMatchObject({ to: 'review', column: 'dev', task: { column: 'todo' } });
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: 'dev' });
    expect((await fromCorrection(ctx)).slice(0, 2)).toEqual([
      {
        kind: 'task_corrected',
        payload: {
          from: 'dev',
          to: 'review',
          reason: 'The board put it in the wrong column.',
          shadow: true,
        },
      },
      {
        kind: 'task_shadow_moved',
        payload: { from: 'review', to: 'dev', reason: 'gate_broken', gate: ['no_pr'] },
      },
    ]);
    expect(await cycleItems(ctx)).toEqual([]);
  });

  it('refuses a correction for a task whose project left the config, and writes nothing', async () => {
    const ctx = await inReview();
    ctx.restart({ projectRemoved: true });
    const before = await ctx.snapshot();

    await expect(ctx.move('dev')).rejects.toMatchObject({ code: 'move_not_allowed' });

    expect(await ctx.snapshot()).toEqual(before);
  });

  it('explains a task whose project left the config with no dispatcher, holds or gates', async () => {
    const ctx = await inReview();
    ctx.restart({ projectRemoved: true });

    expect(await ctx.why()).toMatchObject({
      column: 'review',
      dispatcher: null,
      holds: [],
      gates: [],
      checksWaivedBy: null,
    });
  });

  it('keeps a correction made before the first pass after a switch to on', async () => {
    const ctx = await shadowInReview();
    ctx.restart({ mode: 'on' });

    await ctx.move('dev');

    expect(await ctx.task()).toMatchObject({ column: 'dev', shadow_column: null });
    const events = (await ctx.events()).filter((event) =>
      ['task_moved', 'dispatcher_mode_changed', 'task_corrected'].includes(event.kind),
    );
    expect(events).toEqual([
      { kind: 'task_moved', payload: { from: 'todo', to: 'review', reason: 'mode_changed' } },
      { kind: 'dispatcher_mode_changed', payload: { from: 'shadow', to: 'on' } },
      {
        kind: 'task_corrected',
        payload: {
          from: 'review',
          to: 'dev',
          reason: 'The board put it in the wrong column.',
          shadow: false,
        },
      },
    ]);
  });

  it('keeps a correction made before the first pass after a switch to shadow', async () => {
    const ctx = await inReview();
    ctx.restart({ mode: 'shadow' });

    await ctx.move('dev');

    expect(await ctx.task()).toMatchObject({ column: 'review', shadow_column: 'dev' });
    const kinds = (await ctx.events()).map((event) => event.kind);
    expect(kinds.indexOf('task_corrected')).toBeGreaterThan(
      kinds.indexOf('dispatcher_mode_changed'),
    );
    expect((await ctx.events('task_corrected')).map((event) => event.payload)).toEqual([
      { from: 'review', to: 'dev', reason: 'The board put it in the wrong column.', shadow: true },
    ]);
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
