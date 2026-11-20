import {
  CHECKS_GATE_COLUMNS,
  configSchema,
  err,
  eventPayloadSchemas,
  ok,
  type ActorId,
  type CheckGateColumn,
  type ColumnId,
  type EventKind,
  type PrFacts,
  type PrPoller,
  type PrReviewRule,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { Kysely, sql, SqliteDialect, type CompiledQuery } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  reconcileDueDoorbells,
  tickBoard,
  type Store,
  type Tables,
} from '../../src/index.ts';
import { registerTurnReminder, ringStillCurrent } from '../../src/app/doorbells.ts';
import { archiveTask } from '../../src/app/archive.ts';
import { returnCounts } from '../../src/app/course-check.ts';
import { dispatchTasks } from '../../src/app/dispatch.ts';
import { mayCount } from '../../src/app/external-rounds.ts';
import { editInboundComment, recordInboundBlockMessage } from '../../src/app/blocks.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { markTaskChanged } from '../../src/app/board-utils.ts';
import { openTempStore, rawDatabase } from '../support/store.ts';

// The dispatcher end to end through the observation core, the registry and the tick, on an
// sb-like board: review by `rev`, product review by `coord`, ready to merge by the operator.

const BASE = Date.parse('2026-11-04T08:00:00.000Z');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const KEY = 'o/r#9';
const TRACKER = 'github-issues:proj:o/r';
const GITHUB = 'github:proj:o/r';
const WORKER: ActorId = 'agent:worker/worker-1';
const REV: ActorId = 'agent:rev/rev-1';
const COORD: ActorId = 'agent:coord/coord-1';
const CUR: ActorId = 'agent:cur/cur-1';
const EXTERNAL = 'reviewer';
/** How long a taken turn's holder may sit quiet before a reminder, then a stall block. */
const IDLE = boardConfig().health.idleInDevAfterMs;
const ROW_TABLES = [
  'turn',
  'notification',
  'outbox',
  'block',
  'operator_item',
  'submission',
] as const;

type Options = {
  compatibility?: 'effective' | 'default' | 'simple';
  workerRole?: 'worker' | 'orchestrator';
  mode?: 'on' | 'shadow';
  cycleLimit?: number;
  /** Review's course check; the default applies when unset. */
  courseCheck?: number;
  /** Review's `courseCheckTo`; unset by default. */
  courseCheckTo?: string;
  /** Adds the curator project `cur` with a live session `cur-1`. */
  curator?: boolean;
  externalReview?: boolean;
  /** External Review's course check; the default applies when unset. */
  externalCourseCheck?: number;
  devOrchestrator?: string;
  doneOrchestrator?: string;
  /** External Review's orchestrator, so it has an executor that can return the task. */
  externalOrchestrator?: string;
  /** External Review's `requireResolvedThreads`; unset by default. */
  externalThreads?: boolean;
  /** External Review's cycle limit; the default applies when unset. */
  externalCycleLimit?: number;
  /** The task's project left the config: the only project tracks another repo. */
  projectRemoved?: boolean;
  /** The project also tracks the repo `o/b`. */
  secondRepo?: boolean;
  unrelatedProject?: boolean;
  movingClock?: boolean;
  frozenClock?: boolean;
  /** Enables QA, run by `coord`, and hands Ready to Merge to `coord` instead of the operator. */
  qa?: boolean;
  qaOrchestrator?: string;
  /** Ready to Merge's `requireResolvedThreads`; unset by default. */
  rtmThreads?: boolean;
  /**
   * `omitted`: the project has no `columns` key, so it gets the default board. `todo-group`:
   * Triage and Ready for Dev follow To Do.
   */
  columns?: 'omitted' | 'todo-group';
  /** The project's `checksGate`; unset by default. */
  checksGate?: CheckGateColumn;
  /** External Review's `approvalRule`; unset by default. */
  approvalRule?: 'any-approval' | 'github-rules';
  /**
   * Adds the project `web` that also polls `o/r`, without `approvalRule`; `github-rules` gives its
   * External Review that rule too.
   */
  sharedRepo?: boolean | 'github-rules';
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
        repos: [
          options.projectRemoved === true ? 'o/other' : 'o/r',
          ...(options.secondRepo === true ? ['o/b'] : []),
        ],
        operatorGithubLogin: 'agent-bot',
        spurProjects: [
          { name: 'worker', role: options.workerRole ?? 'worker' },
          ...(options.workerRole === undefined ? [] : [{ name: 'replacement', role: 'worker' }]),
          { name: 'rev', role: 'orchestrator' },
          {
            name: 'coord',
            role: options.compatibility === 'effective' ? 'curator' : 'orchestrator',
          },
          ...(options.compatibility === 'effective' ? [{ name: 'ops', role: 'operator' }] : []),
          ...(options.curator === true ? [{ name: 'cur', role: 'curator' }] : []),
        ],
        ...(options.columns === 'omitted' || options.compatibility === 'default'
          ? {}
          : options.compatibility === 'effective'
            ? {
                columns: [
                  { id: 'todo' },
                  { id: 'dev' },
                  { id: 'review', orchestrator: 'rev' },
                  { id: 'product-review', orchestrator: 'coord' },
                  { id: 'external-review' },
                  { id: 'ready-to-merge', orchestrator: 'coord' },
                  { id: 'done' },
                ],
              }
            : options.compatibility === 'simple'
              ? {
                  columns: [
                    { id: 'todo' },
                    { id: 'dev' },
                    { id: 'review' },
                    { id: 'product-review' },
                    { id: 'ready-to-merge' },
                    { id: 'done' },
                  ],
                }
              : { columns: columnsOf(options) }),
        ...(options.checksGate === undefined ? {} : { checksGate: options.checksGate }),
        dispatcher: { mode: options.mode ?? 'on' },
      },
      ...(options.unrelatedProject === true
        ? [
            {
              id: 'unrelated',
              tracker: { type: 'github-issues', repo: 'o/unrelated', label: 'board' },
              repos: ['o/unrelated'],
              operatorGithubLogin: 'agent-bot',
              spurProjects: [{ name: 'unrelated', role: 'worker' }],
              dispatcher: { mode: options.mode ?? 'on' },
            },
          ]
        : []),
      ...(options.sharedRepo !== undefined && options.sharedRepo !== false
        ? [
            {
              id: 'web',
              tracker: { type: 'github-issues', repo: 'o/web', label: 'board' },
              repos: ['o/r'],
              operatorGithubLogin: 'agent-bot',
              spurProjects: [{ name: 'web-worker', role: 'worker' }],
              ...(options.sharedRepo === 'github-rules'
                ? {
                    columns: [
                      { id: 'todo' },
                      { id: 'dev' },
                      { id: 'external-review', approvalRule: 'github-rules' },
                      { id: 'ready-to-merge' },
                      { id: 'done' },
                    ],
                  }
                : {}),
              dispatcher: { mode: options.mode ?? 'on' },
            },
          ]
        : []),
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
}

/** The `columns` of the task's project. */
function columnsOf(options: Options) {
  return [
    { id: 'todo' },
    ...(options.columns === 'todo-group' ? [{ id: 'triage' }, { id: 'ready-for-dev' }] : []),
    {
      id: 'dev',
      ...(options.devOrchestrator === undefined ? {} : { orchestrator: options.devOrchestrator }),
    },
    {
      id: 'review',
      orchestrator: 'rev',
      cycleLimit: options.cycleLimit ?? 10,
      ...(options.courseCheck === undefined ? {} : { courseCheck: options.courseCheck }),
      ...(options.courseCheckTo === undefined ? {} : { courseCheckTo: options.courseCheckTo }),
    },
    { id: 'product-review', orchestrator: 'coord' },
    ...(options.externalReview === true
      ? [
          {
            id: 'external-review',
            ...(options.externalOrchestrator === undefined
              ? {}
              : { orchestrator: options.externalOrchestrator }),
            ...(options.externalThreads === undefined
              ? {}
              : { requireResolvedThreads: options.externalThreads }),
            ...(options.externalCycleLimit === undefined
              ? {}
              : { cycleLimit: options.externalCycleLimit }),
            ...(options.externalCourseCheck === undefined
              ? {}
              : { courseCheck: options.externalCourseCheck }),
            ...(options.approvalRule === undefined ? {} : { approvalRule: options.approvalRule }),
          },
        ]
      : []),
    ...(options.qa === true ? [{ id: 'qa', orchestrator: options.qaOrchestrator ?? 'coord' }] : []),
    {
      id: 'ready-to-merge',
      orchestrator: options.qa === true ? 'coord' : 'operator',
      ...(options.rtmThreads === undefined ? {} : { requireResolvedThreads: options.rtmThreads }),
    },
    {
      id: 'done',
      ...(options.doneOrchestrator === undefined ? {} : { orchestrator: options.doneOrchestrator }),
    },
  ];
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
  const clock = { now: () => (options.movingClock === true ? ++now : now) };
  const { store, file } = openTempStore('board-dispatch-');
  stores.push(store);
  let core = createObservationCore({ store, config, clock });
  let current: PrFacts | null = null;
  const prs = new Map<number, PrFacts>();
  /** Set by `pollAnswers`: the on-demand poll's fixed answer instead of the current PR. */
  let pollAnswer: Awaited<ReturnType<PrPoller['pollPr']>> | undefined;
  const pollPr: PrPoller['pollPr'] = () =>
    Promise.resolve(
      pollAnswer ??
        (current === null
          ? ok({ status: 'not_found' as const, observedAt: new Date(now).toISOString() })
          : ok({ status: 'ok' as const, facts: current, observedAt: new Date(now).toISOString() })),
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
    if (options.frozenClock !== true) now += 60_000;
    return new Date(now).toISOString();
  };
  const observe = async (
    source: string,
    items: Parameters<typeof core.observe>[1]['batch']['items'],
    complete = true,
    startedAt?: string,
    blind = false,
    entities: Parameters<typeof core.observe>[1]['batch']['entities'] = [],
  ) => {
    const stepped = step();
    const observedAt = startedAt ?? stepped;
    await core.observe(source, {
      batch: { source, observedAt, complete, items, entities },
      effectiveComplete: complete,
      state: {
        ...(complete ? { lastCompleteAt: observedAt } : {}),
        ...(blind ? { blind: { reason: 'auth' as const, message: 'Bad token' } } : {}),
        gone: [],
      },
      outcomes: [],
    });
  };
  const ctx = {
    store,
    /** The store's database file, for a second connection. */
    file,
    /** The sources' last complete polls, as the tick passes them to the dispatcher. */
    complete: () => core.completeSince,
    config: () => config,
    at: () => new Date(now).toISOString(),
    /** A daemon restart on the same store: a fresh core and registry, perhaps a new config. */
    restart(next: Options = options) {
      config = boardConfig(next);
      core = createObservationCore({ store, config, clock });
      ({ registry, apply, query } = build());
    },
    session: (facts: SessionFacts, startedAt?: string) =>
      observe('spur', [{ kind: 'session', facts }], false, startedAt),
    ticketChange: (patch: Partial<TicketFacts>, startedAt?: string) =>
      observe(
        TRACKER,
        [{ kind: 'ticket', facts: { ...ticketFacts('closed'), ...patch } }],
        true,
        startedAt,
      ),
    vanished: (startedAt?: string) =>
      observe('spur', [], true, startedAt, false, [
        { ref: { kind: 'session', id: 'worker-1' }, status: 'not_found' },
      ]),
    filterMissing: (startedAt?: string) => observe(TRACKER, [], true, startedAt),
    unrelatedRepo: (startedAt: string) =>
      observe('github:unrelated:o/unrelated', [], true, startedAt),
    ticket: (status = 'open', inFilter = true, updatedAt?: string) =>
      observe(TRACKER, [
        {
          kind: 'ticket',
          facts: {
            ...ticketFacts(status, inFilter),
            ...(updatedAt === undefined ? {} : { updatedAt }),
          },
        },
      ]),
    /**
     * A complete GitHub poll with the given PR facts merged over the current ones; `startedAt`
     * backdates the poll's start, as for a poll that began before an earlier step; `blind`
     * reports the source blind with the poll.
     */
    async pr(patch: Partial<PrFacts> = {}, complete = true, startedAt?: string, blind = false) {
      const number = patch.number ?? current?.number ?? 7;
      current = prFacts({ ...prs.get(number), ...patch });
      prs.set(number, current);
      await observe(
        GITHUB,
        [...prs.values()].map((facts) => ({ kind: 'pr' as const, facts })),
        complete,
        startedAt,
        blind,
      );
    },
    /**
     * One complete GitHub poll that merges each patch over its PR's current facts, in order; the
     * first patched PR becomes the current one.
     */
    async prsPoll(...patches: Partial<PrFacts>[]) {
      const changed = patches.map((patch) => {
        const number = patch.number ?? current?.number ?? 7;
        const facts = prFacts({ ...prs.get(number), ...patch });
        prs.set(number, facts);
        return facts;
      });
      current = changed[0] ?? current;
      await observe(
        GITHUB,
        [...prs.values()].map((facts) => ({ kind: 'pr' as const, facts })),
      );
    },
    /**
     * A complete poll of `source` as `pr` makes it, with `reviewRule` beside the current PR's
     * facts, as a github-rules source's full read sends it.
     */
    async rulePr(patch: Partial<PrFacts>, reviewRule?: PrReviewRule, source = GITHUB) {
      const number = patch.number ?? current?.number ?? 7;
      current = prFacts({ ...prs.get(number), ...patch });
      prs.set(number, current);
      await observe(
        source,
        [...prs.values()].map((facts) => ({
          kind: 'pr' as const,
          facts,
          ...(facts.number === number && reviewRule !== undefined ? { reviewRule } : {}),
        })),
      );
    },
    /** The on-demand poll of a submit answers `result` from now on. */
    pollAnswers: (result: Awaited<ReturnType<PrPoller['pollPr']>>) => {
      pollAnswer = result;
    },
    /** The PR facts of the last GitHub poll, or null before the first PR. */
    facts: () => current,
    /** Moves the clock forward by `ms` with no other step. */
    wait: (ms: number) => {
      now += ms;
    },
    github: (complete = true) =>
      observe(
        GITHUB,
        [...prs.values()].map((facts) => ({ kind: 'pr' as const, facts })),
        complete,
      ),
    /** A complete poll of the project repo `repo` that finds no PR. */
    repo: (repo: string, complete = true, startedAt?: string, blind = false) =>
      observe(`github:proj:${repo}`, [], complete, startedAt, blind),
    /**
     * A complete Spur poll: the reviewers always, the worker while `worker` is not `none`; the
     * session ids in `gone` are left out.
     */
    spur: (
      worker: 'live' | 'ended' | 'none' | 'unlinked' = 'live',
      complete = true,
      gone: readonly string[] = [],
      startedAt?: string,
      blind = false,
    ) =>
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
        ].filter((item) => !gone.includes(item.facts.id)),
        complete,
        startedAt,
        blind,
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
    /** The daemon's doorbell reconcile, which the tick does not run. */
    ring: () => {
      step();
      return reconcileDueDoorbells(store, config, new Date(now));
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
    manual: (column: ColumnId, key = `manual-${String(++keys)}`) =>
      apply(
        registry['task.move'],
        { mode: 'manual', task: KEY, column, reason: 'Ready for work.' },
        'operator',
        key,
      ),
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
    get: (detail?: boolean) =>
      query(
        registry['task.get'],
        { task: KEY, ...(detail === undefined ? {} : { detail }) },
        'operator',
      ),
    why: async () => {
      const result = await query(registry['task.get'], { task: KEY, why: true }, 'operator');
      if (result.why === undefined) throw new Error('task.get returned no why');
      return result.why;
    },
    add: (key?: string) => {
      step();
      return apply(registry['task.add'], { task: KEY }, 'operator', key ?? `key-${String(++keys)}`);
    },
    answer: (actor: ActorId, block: string, text: string, note?: string) => {
      step();
      return apply(
        registry['block.answer'],
        { block, text, ...(note === undefined ? {} : { note }) },
        actor,
        `key-${String(++keys)}`,
      );
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
    async status(detail = false) {
      const { tasks } = await query(registry['status.get'], { detail }, 'operator');
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
/** A live hand-added task of the project in `column`, inserted raw without an event. */
async function seedTask(ctx: Board, key: string, column: ColumnId) {
  await ctx.store.db
    .insertInto('task')
    .values({
      project: 'proj',
      tracker_kind: 'github-issues',
      tracker_id: null,
      key,
      membership: 'active',
      archive_reason: null,
      column,
      shadow_column: null,
      created_at: ctx.at(),
      manual_include: 1,
      last_change_at: null,
      terminal_at: null,
      archive_slot_at: null,
    })
    .execute();
}

/** Live tasks as key -> [column, position]. */
async function livePositions(ctx: Board) {
  const rows = await ctx.store.db
    .selectFrom('task')
    .select(['key', 'column', 'position'])
    .where('membership', '!=', 'archived')
    .execute();
  return Object.fromEntries(rows.map((row) => [row.key, [row.column, row.position]]));
}

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

/** Dev and both internal reviews passed; QA has its own executor turn. */
async function inQa(): Promise<Board> {
  const ctx = await inReview({ qa: true });
  await ctx.ack(REV, 'T2');
  await ctx.submit(REV, 'T2');
  await ctx.ack(COORD, 'T3');
  await ctx.submit(COORD, 'T3');
  await ctx.ack(COORD, 'T4');
  return ctx;
}

describe('QA evidence across visits', () => {
  it('keeps confirmed QA through a same-head Dev repair without another QA turn', async () => {
    const ctx = await inQa();
    await ctx.submit(COORD, 'T4');
    await ctx.pr({ requiredChecks: [{ name: 'ci', state: 'failure', completedAt: null }] });
    await ctx.tick();
    expect((await ctx.task()).column).toBe('dev');
    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select('voided_at')
        .where('column', '=', 'qa')
        .executeTakeFirstOrThrow(),
    ).toEqual({ voided_at: null });
    await ctx.pr({ requiredChecks: [{ name: 'ci', state: 'success', completedAt: ctx.at() }] });
    const dev = await ctx.openTurn();
    await ctx.ack(WORKER, dev?.id ?? '');
    await ctx.submit(WORKER, dev?.id ?? '');
    await ctx.tick();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.turns()).filter((turn) => turn.column === 'qa')).toHaveLength(1);
    const row = await ctx.status();
    expect(row.qaSubmission).toMatchObject({ column: 'qa', basis: 'tested', voided: false });
    expect(row.submission?.column).toBe('dev');
  });

  it.each([true, false])('qaSubmission follows an enabled QA column: %s', async (qa) => {
    const ctx = await started({ qa });
    await ctx.store.db
      .insertInto('submission')
      .values({
        task_id: (await ctx.task()).id,
        column: 'qa',
        epoch: 0,
        commit_sha: A,
        author: COORD,
        submitted_at: ctx.at(),
        note: null,
        basis: 'skipped',
        basis_reason: 'Docs only',
      })
      .execute();
    expect((await ctx.status()).qaSubmission).toEqual(
      qa ? expect.objectContaining({ column: 'qa', basis: 'skipped', reason: 'Docs only' }) : null,
    );
  });

  it.each([A, B])(
    'permanently invalidates QA for its PR before completing upstream on %s',
    async (head) => {
      const ctx = await inQa();
      await ctx.submit(COORD, 'T4');
      await ctx.store.db
        .insertInto('submission')
        .values({
          task_id: (await ctx.task()).id,
          column: 'qa',
          epoch: 0,
          commit_sha: C,
          author: COORD,
          submitted_at: ctx.at(),
          note: null,
          pr_repo: 'o/r',
          pr_number: 8,
        })
        .execute();
      await ctx.pr({ headSha: B });
      const qa = () =>
        ctx.store.db
          .selectFrom('submission')
          .select(['pr_number', 'voided_at'])
          .where('column', '=', 'qa')
          .orderBy('id')
          .execute();
      expect(await qa()).toEqual([
        { pr_number: 7, voided_at: ctx.at() },
        { pr_number: 8, voided_at: null },
      ]);
      const invalidated = await qa();
      await ctx.pr({ headSha: head });
      expect(await qa()).toEqual(invalidated);
      for (const actor of [WORKER, REV, COORD]) {
        const turn = await ctx.openTurn();
        await ctx.ack(actor, turn?.id ?? '');
        await ctx.submit(actor, turn?.id ?? '');
      }
      expect(await ctx.openTurn()).toMatchObject({ column: 'qa', head_sha: head });
    },
  );

  it.each(['submit', 'return', 'head', 'correct'] as const)(
    'holds taken QA on same-head upstream failure, then closes on %s',
    async (departure) => {
      const ctx = await inQa();
      await ctx.pr({
        requiredChecks: [{ name: 'ci', state: 'failure', completedAt: null }],
        draft: true,
        mergeable: 'conflicting',
      });
      await ctx.tick();
      expect(await ctx.openTurn()).toMatchObject({ id: 'T4', column: 'qa' });
      if (departure === 'submit') await ctx.submit(COORD, 'T4');
      else if (departure === 'return') await ctx.ret(COORD, 'T4');
      else if (departure === 'head') await ctx.pr({ headSha: B });
      else await ctx.move('dev');
      expect((await ctx.turns()).find((turn) => turn.id === 4)?.closed_at).not.toBeNull();
      await expect(ctx.submit(COORD, 'T4')).rejects.toMatchObject({ code: 'turn_closed' });
    },
  );

  it.each(
    (['return', 'correct'] as const).flatMap((movement) =>
      (['current', 'confirmed', 'mismatch', 'restart'] as const).map((receipt) => ({
        movement,
        receipt,
      })),
    ),
  )(
    'retained worker QA requires the Dev visit submit after $movement ($receipt)',
    async ({ movement, receipt }) => {
      const ctx = await inQa();
      await ctx.submit(COORD, 'T4');
      // Represent an earlier worker QA visit, then return with its evidence still valid.
      await ctx.store.db
        .updateTable('submission')
        .set({ author: WORKER })
        .where('column', '=', 'qa')
        .execute();
      ctx.restart({ qa: true, qaOrchestrator: 'none' });
      await ctx.github();
      await ctx.spur();
      if (movement === 'return') {
        await ctx.ack(COORD, 'T5');
        await ctx.ret(COORD, 'T5');
      } else await ctx.move('dev');
      await ctx.tick();
      const rows = await ctx.store.db
        .selectFrom('submission')
        .select(['column', 'voided_at'])
        .orderBy('id')
        .execute();
      expect(rows.find((row) => row.column === 'dev')?.voided_at).not.toBeNull();
      expect(rows.find((row) => row.column === 'qa')?.voided_at).toBeNull();
      expect((await ctx.task()).column).toBe('dev');
      let dev = await ctx.openTurn();
      expect(dev).toMatchObject({ column: 'dev', reason: 'dev: no_submit_on_head' });
      await ctx.tick();
      expect(await ctx.openTurn()).toEqual(dev);
      await ctx.ack(WORKER, dev?.id ?? '');
      if (receipt === 'current') await ctx.submit(WORKER, dev?.id ?? '', A);
      else {
        ctx.pollAnswers(err({ kind: 'timeout', message: 'GitHub timed out' }));
        await expect(ctx.submit(WORKER, dev?.id ?? '', B)).resolves.toMatchObject({
          status: 'pending',
        });
        expect((await ctx.task()).column).toBe('dev');
        expect(await ctx.openTurn()).toBeNull();
        if (receipt === 'restart') ctx.restart({ qa: true, qaOrchestrator: 'none' });
        if (receipt === 'mismatch') {
          await ctx.github();
          dev = await ctx.openTurn();
          expect(dev).toMatchObject({ column: 'dev' });
          expect(dev?.reason).toContain('head moved to aaaaaaa');
          expect(
            await ctx.store.db
              .selectFrom('submission')
              .select('voided_at')
              .where('column', '=', 'qa')
              .executeTakeFirstOrThrow(),
          ).toEqual({ voided_at: null });
          ctx.pollAnswers(ok({ status: 'ok', facts: prFacts(), observedAt: ctx.at() }));
          await ctx.ack(WORKER, dev?.id ?? '');
          await ctx.submit(WORKER, dev?.id ?? '', A);
        } else {
          await ctx.pr({ headSha: B });
          await ctx.spur();
          for (const actor of [REV, COORD]) {
            const upstream = await ctx.openTurn();
            await ctx.ack(actor, upstream?.id ?? '');
            await ctx.submit(actor, upstream?.id ?? '', B);
          }
        }
      }
      expect((await ctx.task()).column).toBe('ready-to-merge');
      expect((await ctx.turns()).filter((turn) => turn.column === 'dev')).toHaveLength(
        receipt === 'mismatch' ? 3 : 2,
      );
      expect((await ctx.turns()).filter((turn) => turn.column === 'qa')).toHaveLength(1);
    },
  );
});

describe('orchestrator role transitions', () => {
  it.each(
    (['observation', 'manual'] as const).flatMap((mode) =>
      (['taken', 'unread', 'unrung'] as const).flatMap((state) =>
        [false, true].map((alreadyDemoted) => ({ mode, state, alreadyDemoted })),
      ),
    ),
  )(
    'releases a $state worker turn through $mode (already demoted: $alreadyDemoted) and lets its replacement progress',
    async ({ mode, state, alreadyDemoted }) => {
      const ctx =
        state === 'taken'
          ? await inDev({ workerRole: 'worker' })
          : await started({ workerRole: 'worker' });
      if (state !== 'taken') await ctx.pr();
      if (state === 'unread') {
        await ctx.session({ ...sessionFacts('worker-1', 'worker'), health: 'waiting' });
        await ctx.ring();
        expect(
          await ctx.store.db
            .selectFrom('notification')
            .select('recipient_session')
            .where('turn_id', '=', 1)
            .executeTakeFirst(),
        ).toEqual({ recipient_session: 'worker-1' });
      }
      await ctx.linkSession('worker-1');
      const before = await ctx.store.db
        .selectFrom('link')
        .selectAll()
        .where('session_id', '=', 'worker-1')
        .executeTakeFirstOrThrow();
      const handed = [
        {
          repo: 'o/r',
          number: 7,
          kind: 'comment',
          id: 'C-demotion',
          postedAt: new Date(BASE).toISOString(),
        },
      ];
      await scanTransaction(ctx.store, boardConfig({ workerRole: 'worker' }), async (trx) => {
        const turn = await trx
          .updateTable('turn')
          .set({ handed: JSON.stringify(handed) })
          .where('id', '=', 1)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (state === 'taken')
          await registerTurnReminder(trx, turn, 'worker-1', new Date(ctx.at()));
      });
      if (alreadyDemoted)
        await ctx.store.transaction((trx) =>
          trx.updateTable('link').set({ role: 'other' }).where('id', '=', before.id).execute(),
        );
      ctx.restart({ workerRole: 'orchestrator' });
      if (mode === 'observation') await ctx.spur();
      else await ctx.linkSession('worker-1');

      if (state !== 'taken')
        await expect(ctx.ack(WORKER, 'T1')).rejects.toMatchObject({ code: 'not_found' });
      expect(
        await ctx.store.db
          .selectFrom('turn')
          .select(['acked_by', 'closed_reason'])
          .where('id', '=', 1)
          .executeTakeFirst(),
      ).toEqual({ acked_by: state === 'taken' ? WORKER : null, closed_reason: 'rerouted' });
      expect(
        await ctx.store.db
          .selectFrom('link')
          .selectAll()
          .where('id', '=', before.id)
          .executeTakeFirst(),
      ).toEqual({ ...before, role: 'other' });
      const notices = await ctx.store.db
        .selectFrom('notification')
        .select(['kind', 'acked_at'])
        .where('turn_id', '=', 1)
        .execute();
      expect(notices.map((notice) => notice.kind).sort()).toEqual(
        state === 'taken' ? ['turn', 'turn_reminder'] : ['turn'],
      );
      expect(notices.every((notice) => notice.acked_at !== null)).toBe(true);
      expect(await ctx.openTurn()).toMatchObject({
        role: 'operator',
        handed: JSON.stringify(handed),
      });
      if (state === 'taken')
        await expect(ctx.ack(WORKER, (await ctx.openTurn())?.id ?? '')).rejects.toMatchObject({
          code: 'not_found',
        });
      const oldNotice = await ctx.store.db
        .selectFrom('notification')
        .select('id')
        .where('turn_id', '=', 1)
        .where('kind', '=', 'turn')
        .executeTakeFirstOrThrow();
      expect(
        await ringStillCurrent(
          ctx.store.db,
          oldNotice.id,
          'worker-1',
          boardConfig({ workerRole: 'orchestrator' }),
        ),
      ).toBe('dead');
      const stableTurns = await ctx.store.db.selectFrom('turn').selectAll().execute();
      const stableNotices = await ctx.store.db.selectFrom('notification').selectAll().execute();
      if (mode === 'observation') await ctx.spur();
      else await ctx.linkSession('worker-1');
      expect(await ctx.store.db.selectFrom('turn').selectAll().execute()).toEqual(stableTurns);
      expect(await ctx.store.db.selectFrom('notification').selectAll().execute()).toEqual(
        stableNotices,
      );

      await ctx.ticket();
      await ctx.github();
      await ctx.spur();
      await ctx.session({
        ...sessionFacts('replacement-1', 'replacement'),
        links: { 'board-worker': 'https://github.com/o/r/issues/9' },
      });
      await ctx.tick();
      await ctx.ring();
      const replacement = await ctx.openTurn();
      expect(replacement).toMatchObject({
        column: 'dev',
        role: 'worker',
        handed: JSON.stringify(handed),
      });
      const turnId = replacement?.id ?? '';
      await expect(ctx.submit(WORKER, turnId)).rejects.toMatchObject({ code: 'forbidden' });
      const actor: ActorId = 'agent:replacement/replacement-1';
      await ctx.ack(actor, turnId);
      expect(
        await ctx.store.db
          .selectFrom('turn')
          .select('acked_by')
          .where('closed_at', 'is', null)
          .executeTakeFirst(),
      ).toEqual({ acked_by: actor });
      await ctx.submit(actor, turnId);
      expect((await ctx.status()).column).toBe('review');
    },
  );
});

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

    // Merged after the ticket's last change, so the open ticket is only not moved yet.
    await ctx.pr({
      state: 'merged',
      mergedAt: new Date(Date.parse(ctx.at()) + 60_000).toISOString(),
    });
    await ctx.ticket('closed');
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

  it('a gate-passing move puts the task last in its new column', async () => {
    const ctx = board();
    await ctx.ticket();
    await ctx.github();
    await ctx.spur('none');
    await seedTask(ctx, 'o/r#50', 'dev');
    await ctx.spur('live');
    expect((await ctx.moves()).at(-1)).toMatchObject({ from: 'todo', to: 'dev' });
    expect(await livePositions(ctx)).toEqual({ 'o/r#50': ['dev', 1], [KEY]: ['dev', 2] });
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
    await ctx.ticket('closed');
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
    await seedTask(ctx, 'o/r#50', 'todo');
    await ctx.pr({ state: 'merged' });
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    await ctx.ticket('open');
    const task = await ctx.task();
    expect(task).toMatchObject({ column: 'todo' });
    // The reopen is a new visit: after the task already waiting in To Do.
    expect(await livePositions(ctx)).toEqual({ 'o/r#50': ['todo', 1], [KEY]: ['todo', 2] });
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
    await ctx.ticket('closed');
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
    await ctx.ticket('closed');
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
    await ctx.ticket('closed');
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

/** The task's project as configured with `options`. */
const project = (options: Options = {}) => {
  const [entry] = boardConfig(options).projects;
  if (entry === undefined) throw new Error('no project');
  return entry;
};

describe('the Todo group', () => {
  it.each(
    (['todo', 'triage', 'ready-for-dev'] as const).flatMap((column) =>
      (['on', 'shadow'] as const).flatMap((mode) =>
        [false, true].map((frozenClock) => ({ column, mode, frozenClock })),
      ),
    ),
  )(
    'preserves $column after a processed reopen in $mode (frozen=$frozenClock)',
    async ({ column, mode, frozenClock }) => {
      const ctx = await started({ columns: 'todo-group', mode, frozenClock });
      const position = async () => {
        const task = await ctx.task();
        return mode === 'shadow' ? task.shadow_column : task.column;
      };
      await ctx.pr();
      await ctx.pr({ state: 'merged' });
      await ctx.ticket('closed');
      expect(await position()).toBe('done');
      await ctx.ticket('open');
      expect(await position()).toBe('todo');
      await ctx.spur('ended');
      await ctx.manual(column, 'after-reopen');
      const hidden = () =>
        ctx.store.db
          .selectFrom('link')
          .select(['number', 'reopen_hidden_at'])
          .where('reopen_hidden_at', 'is not', null)
          .execute();
      const oldLinks = await hidden();
      expect(oldLinks.map((link) => link.number)).toEqual([7]);
      expect(oldLinks.every((link) => typeof link.reopen_hidden_at === 'string')).toBe(true);
      await ctx.tick();
      expect((await ctx.task()).column).toBe(column);
      expect(await position()).toBe(column);
      await ctx.pr({ state: 'merged' });
      await ctx.tick();
      expect(await position()).toBe(column);
      expect(await hidden()).toEqual(oldLinks);
      expect(await ctx.move(column)).toMatchObject({ column: 'todo' });
      await ctx.manual(column, 'after-correction');
      await ctx.ticket('closed');
      await ctx.ticket('open');
      expect(await position()).toBe('todo');
      await ctx.manual(column, 'after-new-reopen');
      await ctx.pr({ number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' });
      await ctx.tick();
      expect(await position()).toBe('dev');
      await ctx.tick();
      expect(await position()).toBe('dev');
      expect((await hidden()).map((link) => link.number)).toEqual([7]);
    },
  );
  it.each(['on', 'shadow'] as const)(
    'keeps manual placement and replay across idle ticks in %s',
    async (mode) => {
      const ctx = await started({ columns: 'todo-group', mode }, 'none');
      const result = await ctx.manual('triage', 'manual-idle');
      await ctx.tick();
      await ctx.tick();
      expect((await ctx.task()).column).toBe('triage');
      const events = await ctx.store.db.selectFrom('event').selectAll().execute();
      expect(await ctx.manual('triage', 'manual-idle')).toEqual(result);
      expect(await ctx.store.db.selectFrom('event').selectAll().execute()).toEqual(events);
      expect(await ctx.turns()).toEqual([]);
      await ctx.pr();
      await ctx.tick();
      const task = await ctx.task();
      expect(mode === 'on' ? task.column : task.shadow_column).toBe('dev');
      expect(task.column).toBe(mode === 'on' ? 'dev' : 'triage');
    },
  );
  it.each([
    ['shadow', 'on'],
    ['on', 'shadow'],
  ] as const)('synchronizes %s to %s before manual placement', async (from, to) => {
    const ctx = await started({ columns: 'todo-group', mode: from }, 'none');
    await ctx.move('ready-for-dev');
    ctx.restart({ columns: 'todo-group', mode: to });
    expect(await ctx.manual('triage')).toMatchObject({ from: 'ready-for-dev', column: 'triage' });
    await ctx.tick();
    expect((await ctx.task()).column).toBe('triage');
    expect((await ctx.task()).shadow_column).toBe(to === 'shadow' ? 'triage' : null);
  });
  const corrected = (ctx: Board) =>
    ctx.store.db.selectFrom('event').select('id').where('kind', '=', 'task_corrected').execute();

  it('keeps a correction into Triage until work starts, then leaves for Dev in one move', async () => {
    const ctx = await started({ columns: 'todo-group' }, 'none');
    await ctx.move('triage');
    await ctx.tick();
    await ctx.tick();
    expect((await ctx.task()).column).toBe('triage');
    expect(await ctx.moves()).toEqual([]);
    expect(await ctx.turns()).toEqual([]);
    expect(await corrected(ctx)).toHaveLength(1);

    await ctx.spur('live');
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.moves()).toEqual([{ from: 'triage', to: 'dev', reason: 'gate_passed' }]);
  });

  it('moves Ready for Dev to Dev in one move on an open PR with no live worker', async () => {
    const ctx = await started({ columns: 'todo-group' }, 'none');
    await ctx.move('ready-for-dev');
    await ctx.tick();
    expect((await ctx.task()).column).toBe('ready-for-dev');
    expect(await ctx.moves()).toEqual([]);

    await ctx.pr();
    await ctx.tick();
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.moves()).toEqual([
      { from: 'ready-for-dev', to: 'dev', reason: 'gate_passed' },
    ]);
  });

  it('a reopen after Done returns to To Do, and a correction into Triage with the PR hidden settles there too', async () => {
    const ctx = await inDev({ columns: 'todo-group' });
    await ctx.pr({ state: 'merged' });
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    await ctx.ticket('open');
    expect((await ctx.task()).column).toBe('todo');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'done',
      to: 'todo',
      reason: 'ticket_reopened',
    });

    const result = await ctx.move('triage');
    expect(result.column).toBe('todo');
    expect((await ctx.task()).column).toBe('todo');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'triage',
      to: 'todo',
      reason: 'ticket_reopened',
    });
  });

  it('settles a correction into Triage in Dev while a PR is open', async () => {
    const ctx = await inDev({ columns: 'todo-group' });
    const before = (await ctx.moves()).length;
    const result = await ctx.move('triage');
    expect(result.column).toBe('dev');
    expect((await ctx.moves()).slice(before)).toEqual([
      { from: 'triage', to: 'dev', reason: 'gate_passed' },
    ]);
  });

  it('journals one move from To Do to Dev on the live-style board, as before triage', async () => {
    const ctx = await started({ externalReview: true });
    expect(await ctx.moves()).toEqual([{ from: 'todo', to: 'dev', reason: 'gate_passed' }]);
    expect((await ctx.status()).column).toBe('dev');
  });

  it('journals one move from To Do to Dev on a project without columns, past Ready for Dev', async () => {
    const columns = boardConfig({ columns: 'omitted' }).projects[0]?.columns ?? [];
    expect(columns.find((column) => column.id === 'triage')?.enabled).toBe(false);
    expect(columns.find((column) => column.id === 'ready-for-dev')?.enabled).toBe(true);
    const ctx = await started({ columns: 'omitted' });
    expect(await ctx.moves()).toEqual([{ from: 'todo', to: 'dev', reason: 'gate_passed' }]);
    expect((await ctx.status()).column).toBe('dev');
  });
});

describe('unresolved review threads', () => {
  const URL = 'https://github.com/o/r/pull/7#discussion_r1';
  const thread = (patch: Partial<PrFacts['reviewThreads'][number]> = {}) => ({
    resolved: false,
    id: 'PRRT_1',
    url: URL,
    ...patch,
  });
  const RETURNED = {
    from: 'ready-to-merge',
    to: 'dev',
    reason: 'gate_broken',
    gate: ['unresolved_threads'],
  };
  const REASON = 'dev: unresolved_threads, no_submit_on_head';
  const listed = async (ctx: Board) => (await ctx.why()).turn?.threads;
  const counts = async (ctx: Board) =>
    returnCounts(ctx.store.db, (await ctx.task()).id, 'ready-to-merge', project());
  const reviewTurns = async (ctx: Board) =>
    (await ctx.turns()).filter((turn) => turn.column === 'review').length;

  it('returns from Ready to Merge and lists the thread', async () => {
    const ctx = await pastProductReview();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    await ctx.pr({ reviewThreads: [thread()] });

    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual(RETURNED);
    expect((await ctx.openTurn())?.reason).toBe(REASON);
    const threads = [{ id: 'PRRT_1', url: URL, outdated: false }];
    expect(await listed(ctx)).toEqual(threads);
    const [turn] = (await ctx.inbox(WORKER)).turns;
    expect(turn).toMatchObject({ column: 'dev', reason: REASON, threads });
    expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([]);
  });

  it('resolve then submit on the same head reaches Ready to Merge without a Review turn', async () => {
    const ctx = await pastProductReview();
    await ctx.pr({ reviewThreads: [thread()] });
    const turn = await ctx.openTurn();
    await ctx.ack(WORKER, turn?.id ?? '');
    await ctx.pr({ reviewThreads: [thread({ resolved: true })] });
    expect(await listed(ctx)).toBeUndefined();
    const before = await reviewTurns(ctx);

    await expect(ctx.submit(WORKER, turn?.id ?? '', A)).resolves.toMatchObject({
      status: 'confirmed',
    });

    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.moves()).slice(-3)).toEqual([
      { from: 'dev', to: 'review', reason: 'gate_passed' },
      { from: 'review', to: 'product-review', reason: 'gate_passed' },
      { from: 'product-review', to: 'ready-to-merge', reason: 'gate_passed' },
    ]);
    expect(await reviewTurns(ctx)).toBe(before);
    expect(await ctx.openTurn()).toEqual(
      turnOf('ready-to-merge', 'operator', 'ready-to-merge: not_merged'),
    );
  });

  it('a submit with an open thread bounces back counted', async () => {
    const ctx = await pastProductReview();
    await ctx.pr({ reviewThreads: [thread()] });
    expect(await counts(ctx)).toMatchObject({ cycle: 1, course: 1 });
    const turn = await ctx.openTurn();
    await ctx.ack(WORKER, turn?.id ?? '');
    await ctx.submit(WORKER, turn?.id ?? '', A);

    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).filter((move) => move.reason === 'gate_broken')).toEqual([
      RETURNED,
      RETURNED,
    ]);
    expect(await counts(ctx)).toMatchObject({ cycle: 2, course: 2 });
    expect((await ctx.openTurn())?.reason).toBe(REASON);
  });

  it('counts an outdated thread and lists it outdated', async () => {
    const ctx = await pastProductReview();
    await ctx.pr({ reviewThreads: [thread({ outdated: true })] });
    expect((await ctx.moves()).at(-1)).toEqual(RETURNED);
    expect(await listed(ctx)).toEqual([{ id: 'PRRT_1', url: URL, outdated: true }]);
  });

  it('a resolved thread never counts', async () => {
    const ctx = await pastProductReview();
    const moves = (await ctx.moves()).length;
    await ctx.pr({ reviewThreads: [thread({ resolved: true })] });
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect(await ctx.moves()).toHaveLength(moves);
  });

  it('lists only threads stored with an id and a link', async () => {
    const ctx = await pastProductReview();
    await ctx.pr({ reviewThreads: [{ resolved: false }, thread()] });
    expect((await ctx.moves()).at(-1)).toEqual(RETURNED);
    expect(await listed(ctx)).toEqual([{ id: 'PRRT_1', url: URL, outdated: false }]);
  });

  it.each([
    { login: 'agent-bot', type: 'user' as const },
    { login: 'review-bot', type: 'bot' as const },
  ])('a thread from a review by $login still returns', async (author) => {
    const ctx = await pastProductReview();
    await ctx.pr({
      reviewThreads: [thread()],
      feedback: [{ kind: 'review', state: 'commented', id: 'r-1', author, postedAt: at(1) }],
    });
    expect((await ctx.moves()).at(-1)).toEqual(RETURNED);
    expect((await ctx.openTurn())?.reason).toBe(REASON);
  });

  it('does not return when Ready to Merge does not require resolved threads', async () => {
    const ctx = await pastProductReview({ rtmThreads: false });
    const moves = (await ctx.moves()).length;
    await ctx.pr({ reviewThreads: [thread()] });
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect(await ctx.moves()).toHaveLength(moves);
  });

  it('lists no threads once the PR is closed', async () => {
    const ctx = await pastProductReview();
    await ctx.pr({ state: 'closed', reviewThreads: [thread()] });
    expect((await ctx.moves()).at(-1)).toEqual({ ...RETURNED, gate: ['pr_closed'] });
    expect(await ctx.openTurn()).toBeNull();
  });

  it('a hand-back turn on a closed PR lists no threads', async () => {
    const ctx = await inDev();
    ctx.pollAnswers(err({ kind: 'timeout' as const, message: 'GitHub timed out' }));
    await expect(ctx.submit(WORKER, 'T1', B)).resolves.toMatchObject({ status: 'pending' });
    await ctx.pr({ state: 'closed', reviewThreads: [thread()] });

    const turn = await ctx.openTurn();
    expect(turn?.reason).toBe('dev: pr_closed (submit of bbbbbbb: PR o/r#7 closed)');
    expect((await ctx.why()).turn).not.toHaveProperty('threads');
  });

  it('lists no threads after a merge with the ticket open', async () => {
    const ctx = await pastProductReview();
    await ctx.pr({
      state: 'merged',
      mergedAt: new Date(Date.parse(ctx.at()) + 60_000).toISOString(),
      reviewThreads: [thread()],
    });
    await ctx.ticket();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    await ctx.ticket('open', true, ctx.at());
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.openTurn())?.reason).toBe('dev: no_pr (PR o/r#7 merged, ticket still open)');
    expect((await ctx.why()).turn).not.toHaveProperty('threads');
  });
});

describe.each(['on', 'shadow'] as const)('%s delayed change acceptance', (mode) => {
  const effective = (task: Awaited<ReturnType<Board['task']>>) =>
    mode === 'on' ? task.column : (task.shadow_column ?? task.column);

  it.each([
    'vanished',
    'ended',
    'session-change',
    'ticket-change',
    'changed-pr',
    'initial-pr',
    'initial-ticket',
    'initial-link',
  ] as const)(
    '%s invalidates proof accepted between poll start and change acceptance',
    async (kind) => {
      const initialTicket = kind === 'initial-ticket';
      const prSource = kind === 'changed-pr' || kind === 'initial-pr';
      const ctx = initialTicket
        ? board({ mode })
        : await started({ mode }, kind === 'vanished' || kind === 'ended' ? 'live' : 'none');
      if (initialTicket) await ctx.add();
      if (kind === 'changed-pr') await ctx.pr({ state: 'closed' });
      if (kind === 'session-change' || kind === 'initial-link')
        await ctx.session(sessionFacts('worker-1', 'worker', true, kind !== 'initial-link'));
      const pollStartedAt = ctx.at();
      if (!initialTicket) await ctx.ticket('closed');
      if (prSource || initialTicket) await ctx.spur('none');
      if (!prSource) await ctx.github();

      if (kind === 'vanished') await ctx.vanished(pollStartedAt);
      else if (kind === 'ended')
        await ctx.session(sessionFacts('worker-1', 'worker', true), pollStartedAt);
      else if (kind === 'session-change')
        await ctx.session(
          { ...sessionFacts('worker-1', 'worker', true), health: 'waiting' },
          pollStartedAt,
        );
      else if (kind === 'initial-link')
        await ctx.session(sessionFacts('worker-1', 'worker', true), pollStartedAt);
      else if (prSource)
        await ctx.pr({ state: 'closed', title: 'Accepted late' }, true, pollStartedAt);
      else await ctx.ticketChange({ title: 'Accepted late' }, pollStartedAt);
      expect(effective(await ctx.task())).not.toBe('done');

      if (prSource || initialTicket) await ctx.github();
      else if (kind === 'ticket-change') await ctx.spur('none');
      else await ctx.vanished();
      expect(effective(await ctx.task())).not.toBe('done');
      if (prSource || initialTicket) await ctx.spur('none');
      else await ctx.github();
      expect(effective(await ctx.task())).toBe('done');
      expect(
        (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
          ({ payload }) => payload['to'] === 'done',
        ),
      ).toHaveLength(1);
    },
  );

  it.each(['pr', 'worker'] as const)(
    'late disappearance cannot finish before new %s discovery',
    async (discovery) => {
      const ctx = await started({ mode });
      const pollStartedAt = ctx.at();
      await ctx.ticket('closed');
      await ctx.github();
      await ctx.vanished(pollStartedAt);
      await ctx.vanished();
      expect(effective(await ctx.task())).not.toBe('done');
      if (discovery === 'pr') await ctx.pr();
      else await ctx.spur('live');
      expect(
        (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
          ({ payload }) => payload['to'] === 'done',
        ),
      ).toEqual([]);
    },
  );

  it('already-accepted future-dated source proof cannot confirm a later accepted change', async () => {
    const ctx = await started({ mode });
    const pollStartedAt = ctx.at();
    await ctx.ticket('closed');
    const proof = new Date(Date.parse(ctx.at()) + 3_600_000).toISOString();
    await ctx.repo('o/r', true, proof);
    await ctx.vanished(pollStartedAt);
    await ctx.vanished();
    expect(effective(await ctx.task())).not.toBe('done');
    ctx.wait(Date.parse(proof) - Date.parse(ctx.at()) + 60_000);
    await ctx.github();
    expect(effective(await ctx.task())).not.toBe('done');
    await ctx.vanished();
    expect(effective(await ctx.task())).toBe('done');
  });

  it('the proof floor includes every configured repository', async () => {
    const ctx = await started({ mode, secondRepo: true });
    const pollStartedAt = ctx.at();
    await ctx.ticket('closed');
    const future = new Date(Date.parse(ctx.at()) + 3_600_000).toISOString();
    await ctx.repo('o/b', true, future);
    await ctx.vanished(pollStartedAt);
    await ctx.vanished();
    expect(effective(await ctx.task())).not.toBe('done');
    ctx.wait(Date.parse(future) - Date.parse(ctx.at()) + 60_000);
    await ctx.repo('o/r');
    await ctx.repo('o/b');
    expect(effective(await ctx.task())).not.toBe('done');
    await ctx.vanished();
    expect(effective(await ctx.task())).toBe('done');
  });

  it.each([
    ['spur', false],
    ['spur', true],
    ['repository', false],
    ['repository', true],
  ] as const)(
    'incomplete %s changed facts after quiet=%s invalidate the previously accepted own-source proof',
    async (source, quiet) => {
      const ctx = await started({ mode }, source === 'spur' ? 'live' : 'none');
      const pollStartedAt = ctx.at();
      await ctx.ticket('closed');
      const future = new Date(Date.parse(ctx.at()) + 3_600_000).toISOString();
      if (source === 'spur') {
        await ctx.spur('live', true, [], future);
        if (quiet) {
          const boundary = (await ctx.task()).last_change_at;
          await ctx.spur('live', false);
          expect((await ctx.task()).last_change_at).toBe(boundary);
        }
        await ctx.session(sessionFacts('worker-1', 'worker', true), pollStartedAt);
        await ctx.github();
      } else {
        await ctx.repo('o/r', true, future);
        if (quiet) {
          const boundary = (await ctx.task()).last_change_at;
          await ctx.repo('o/r', false);
          expect((await ctx.task()).last_change_at).toBe(boundary);
        }
        await ctx.pr({ state: 'closed' }, false, pollStartedAt);
        await ctx.spur('none');
      }
      expect(effective(await ctx.task())).not.toBe('done');
      ctx.wait(Date.parse(future) - Date.parse(ctx.at()) + 60_000);
      if (source === 'spur') await ctx.github();
      else await ctx.spur('none');
      expect(effective(await ctx.task())).not.toBe('done');
      if (source === 'spur') await ctx.spur('ended');
      else await ctx.github();
      expect(effective(await ctx.task())).toBe('done');
    },
  );

  it('an unrelated project future proof does not delay completion', async () => {
    const ctx = await started({ mode, unrelatedProject: true }, 'none');
    await ctx.unrelatedRepo(new Date(Date.parse(ctx.at()) + 3_600_000).toISOString());
    await ctx.ticket('closed');
    expect((await ctx.task()).last_change_at).toBe(ctx.at());
    await ctx.github();
    await ctx.spur('none');
    expect(effective(await ctx.task())).toBe('done');
  });

  it('idempotent command replay does not advance the acceptance barrier', async () => {
    const ctx = await started({ mode }, 'none');
    await ctx.add('fixed-add-key');
    const boundary = (await ctx.task()).last_change_at;
    const events = await ctx.events();
    await ctx.add('fixed-add-key');
    expect((await ctx.task()).last_change_at).toBe(boundary);
    expect(await ctx.events()).toEqual(events);
  });

  it('a moving acceptance clock leaves gateway scan replay strings stable', async () => {
    const ctx = await started({ mode, movingClock: true });
    if (mode === 'on') await ctx.ack(WORKER, (await ctx.openTurn())?.id ?? '');
    await ctx.spur('ended');
    await ctx.ticket('closed');
    await ctx.github();
    await ctx.spur('ended');
    expect(effective(await ctx.task())).toBe('done');
    const statusEvent = await ctx.store.db
      .selectFrom('event')
      .select('at')
      .where('kind', '=', 'ticket_status_changed')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(statusEvent.at).not.toBe((await ctx.task()).last_change_at);
    expect(await ctx.store.db.selectFrom('outbox').select('id').execute()).not.toEqual([]);
  });

  it('task changes reject a transaction missing its injected acceptance clock', async () => {
    const ctx = await started({ mode });
    const task = await ctx.task();
    await expect(
      scanTransaction(ctx.store, boardConfig({ mode }), (trx) =>
        markTaskChanged(trx, task.id, ctx.at()),
      ),
    ).rejects.toThrow('Task changes require a scan transaction with an acceptance clock');
    expect((await ctx.task()).last_change_at).toBe(task.last_change_at);
  });

  it('queued task changes use acceptance after acquiring the write transaction', async () => {
    const ctx = await started({ mode });
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const holding = ctx.store.transaction(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    const queued = ctx.add();
    ctx.wait(60_000);
    const acquiredAt = ctx.at();
    release.resolve(undefined);
    await holding;
    await queued;
    expect(((await ctx.task()).last_change_at ?? '') >= acquiredAt).toBe(true);
  });
});

describe.each(['on', 'shadow'] as const)('%s temporal task boundary', (mode) => {
  const effective = (task: Awaited<ReturnType<Board['task']>>) =>
    mode === 'on' ? task.column : (task.shadow_column ?? task.column);

  it.each([
    'pr',
    'ticket',
    'filter',
    'session',
    'ended',
    'vanished',
    'unlink',
    'relink',
    'correct',
    'archive',
    'reactivate',
  ] as const)(
    '%s changes preserve a monotonic boundary for stale/equal/fresh callback times',
    async (writer) => {
      for (const offset of [-1, 0, 1]) {
        const ctx = await started({ mode });
        await ctx.pr({ state: 'closed' });
        if (writer === 'filter') await ctx.move('dev');
        else await ctx.ticket('closed');
        if (writer === 'relink') await ctx.unlinkPr();
        const before = (await ctx.task()).last_change_at ?? '';
        const at = new Date(Date.parse(before) + offset).toISOString();
        if (writer === 'pr') await ctx.pr({ title: 'Changed title' }, true, at);
        else if (writer === 'ticket') await ctx.ticketChange({ title: 'Changed title' }, at);
        else if (writer === 'filter') await ctx.filterMissing(at);
        else if (writer === 'session')
          await ctx.session({ ...sessionFacts('worker-1', 'worker'), health: 'waiting' }, at);
        else if (writer === 'ended')
          await ctx.session(sessionFacts('worker-1', 'worker', true), at);
        else if (writer === 'vanished') await ctx.vanished(at);
        else {
          ctx.wait(Date.parse(at) - Date.parse(ctx.at()) - 60_000);
          if (writer === 'unlink') await ctx.unlinkPr();
          else if (writer === 'relink') await ctx.linkPr(7);
          else if (writer === 'correct') await ctx.move('dev');
          else if (writer === 'archive') await ctx.archive();
          else await ctx.add();
        }
        expect((await ctx.task()).last_change_at).toBe([before, at, ctx.at()].sort().at(-1));
      }
    },
  );

  it.each(['pr', 'worker'] as const)(
    'a delayed callback cannot validate stale absence before new %s discovery',
    async (discovery) => {
      const ctx = await started({ mode }, 'none');
      await ctx.pr({ state: 'closed' });
      const old = ctx.at();
      await ctx.spur('none');
      await ctx.ticket('closed');
      await ctx.pr({ title: 'Late old poll' }, true, old);
      expect((await ctx.task()).last_change_at).toBe(ctx.at());
      await ctx.github();
      expect(effective(await ctx.task())).not.toBe('done');
      if (discovery === 'pr') await ctx.pr({ number: 8, state: 'open' });
      else await ctx.spur('live');
      expect(effective(await ctx.task())).not.toBe('done');
      expect(
        (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
          ({ payload }) => payload['to'] === 'done',
        ),
      ).toEqual([]);
    },
  );

  it('actual not_found worker termination invalidates both absence proofs before PR discovery', async () => {
    const ctx = await started({ mode });
    await ctx.ticket('closed');
    await ctx.github();
    const before = (await ctx.task()).last_change_at ?? '';
    await ctx.vanished();
    expect(((await ctx.task()).last_change_at ?? '') > before).toBe(true);
    expect(effective(await ctx.task())).not.toBe('done');
    expect((await ctx.why()).holds).toEqual(expect.arrayContaining(['github_blind', 'spur_blind']));
    await ctx.pr();
    expect(
      (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
        ({ payload }) => payload['to'] === 'done',
      ),
    ).toEqual([]);
    expect(
      await ctx.store.db
        .selectFrom('session_snapshot')
        .select('end_reason')
        .where('id', '=', 'worker-1')
        .executeTakeFirst(),
    ).toEqual({ end_reason: 'vanished' });
  });

  it('unchanged not_found callbacks preserve the boundary and permit renewed confirmation', async () => {
    const ctx = await started({ mode });
    await ctx.ticket('closed');
    await ctx.github();
    await ctx.vanished();
    const boundary = (await ctx.task()).last_change_at;
    const facts = (await ctx.events('session_facts_changed')).length;
    await ctx.vanished();
    expect((await ctx.task()).last_change_at).toBe(boundary);
    expect(await ctx.events('session_facts_changed')).toHaveLength(facts);
    await ctx.github();
    expect(effective(await ctx.task())).toBe('done');
    expect(await ctx.openTurn()).toBeNull();
  });

  it('unchanged ticket, PR and session refreshes preserve the boundary', async () => {
    const ctx = await started({ mode });
    await ctx.pr({ state: 'closed' });
    await ctx.ticket('closed');
    const boundary = (await ctx.task()).last_change_at;
    await ctx.pr({ updatedAt: ctx.at() });
    expect((await ctx.task()).last_change_at).toBe(boundary);
    await ctx.ticket('closed', true, ctx.at());
    expect((await ctx.task()).last_change_at).toBe(boundary);
    await ctx.spur();
    expect((await ctx.task()).last_change_at).toBe(boundary);
  });
});

describe('a done ticket without in-flight work', () => {
  describe.each(['on', 'shadow'] as const)('%s confirming absence', (mode) => {
    const effective = (task: Awaited<ReturnType<Board['task']>>) =>
      mode === 'on' ? task.column : (task.shadow_column ?? task.column);

    describe.each(['repository', 'spur'] as const)('%s source class', (source) => {
      const confirm = (ctx: Board, complete = true, startedAt?: string, blind = false) =>
        source === 'repository'
          ? ctx.repo('o/r', complete, startedAt, blind)
          : ctx.spur('none', complete, [], startedAt, blind);
      const other = (ctx: Board) => (source === 'repository' ? ctx.spur('none') : ctx.repo('o/r'));

      it.each([
        ['none', 'missing'],
        ['none', 'earlier'],
        ['none', 'equal'],
        ['none', 'later'],
        ['closed', 'missing'],
        ['closed', 'earlier'],
        ['closed', 'equal'],
        ['closed', 'later'],
      ] as const)('%s PR with %s complete evidence', async (pr, evidence) => {
        const ctx = await started({ mode }, 'none');
        if (pr === 'closed') await ctx.pr({ state: 'closed' });
        ctx.restart({ mode });
        await ctx.ticket('closed');
        const task = await ctx.task();
        const boundary = Date.parse(task.last_change_at ?? task.created_at);
        await other(ctx);
        if (evidence !== 'missing') {
          const offset = evidence === 'earlier' ? -1 : evidence === 'equal' ? 0 : 1;
          await confirm(ctx, true, new Date(boundary + offset).toISOString());
        }
        const complete = evidence === 'later';
        expect(effective(await ctx.task())).toBe(complete ? 'done' : 'todo');
        const moves = await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved');
        expect(moves).toHaveLength(complete ? 1 : 0);
        if (complete) expect(moves[0]?.payload).toMatchObject({ reason: 'ticket_done_no_pr' });
        else
          expect((await ctx.why()).holds).toContain(
            source === 'repository' ? 'github_blind' : 'spur_blind',
          );
      });

      it('unchanged final confirmation in either source order completes without a fact event', async () => {
        const ctx = await started({ mode }, 'none');
        await ctx.ticket('closed');
        const facts = (await ctx.events()).filter(({ kind }) => kind.endsWith('_facts_changed'));
        await other(ctx);
        expect(effective(await ctx.task())).toBe('todo');
        await confirm(ctx);
        expect(effective(await ctx.task())).toBe('done');
        expect((await ctx.events()).filter(({ kind }) => kind.endsWith('_facts_changed'))).toEqual(
          facts,
        );
        expect(await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).toHaveLength(
          1,
        );
      });

      it('incomplete or blind callbacks cannot prove absence', async () => {
        const ctx = await started({ mode }, 'none');
        await ctx.ticket('closed');
        await other(ctx);
        await confirm(ctx, false);
        expect(effective(await ctx.task())).toBe('todo');
        await confirm(ctx, true, undefined, true);
        expect(effective(await ctx.task())).toBe('todo');
        expect((await ctx.why()).holds).toContain(
          source === 'repository' ? 'github_blind' : 'spur_blind',
        );
        await confirm(ctx);
        expect(effective(await ctx.task())).toBe('done');
      });
    });

    it('discovers a new live worker before trusting its absence', async () => {
      const ctx = await started({ mode }, 'none');
      await ctx.ticket('closed');
      await ctx.repo('o/r');
      expect(effective(await ctx.task())).toBe('todo');
      await ctx.spur('live');
      await ctx.repo('o/r');
      expect(effective(await ctx.task())).toBe('dev');
      expect(
        (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
          ({ payload }) => payload['to'] === 'done',
        ),
      ).toEqual([]);
    });

    it('an unchanged final repo confirmation dispatches without a tick or new fact event', async () => {
      const ctx = await started({ mode, secondRepo: true }, 'none');
      await ctx.repo('o/b');
      await ctx.ticket('closed');
      await ctx.spur('none');
      expect(effective(await ctx.task())).toBe('todo');
      const facts = (await ctx.events()).filter(({ kind }) => kind.endsWith('_facts_changed'));
      await ctx.repo('o/r');
      expect(effective(await ctx.task())).toBe('todo');
      expect((await ctx.why()).holds).toContain('github_blind');
      await ctx.repo('o/b');
      expect(effective(await ctx.task())).toBe('done');
      expect((await ctx.events()).filter(({ kind }) => kind.endsWith('_facts_changed'))).toEqual(
        facts,
      );
      expect(await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).toHaveLength(1);
    });

    it('applies a newly discovered open PR before confirming absence', async () => {
      const ctx = await started({ mode }, 'none');
      await ctx.ticket('closed');
      await ctx.spur('none');
      expect(effective(await ctx.task())).toBe('todo');
      await ctx.pr();
      await ctx.github();
      expect(effective(await ctx.task())).not.toBe('done');
      expect(
        (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
          ({ payload }) => payload['to'] === 'done',
        ),
      ).toEqual([]);
    });

    it('rejects incomplete and blind confirmation callbacks', async () => {
      const ctx = await started({ mode }, 'none');
      await ctx.ticket('closed');
      await ctx.spur('none');
      await ctx.repo('o/r', false);
      expect(effective(await ctx.task())).toBe('todo');
      await ctx.blind(GITHUB, true);
      await ctx.repo('o/r', true, undefined, true);
      expect(effective(await ctx.task())).toBe('todo');
      expect((await ctx.why()).holds).toContain('github_blind');
      await ctx.blind(GITHUB, false);
      await ctx.repo('o/r');
      expect(effective(await ctx.task())).toBe('done');
    });

    it('requires renewed evidence after the worker ends', async () => {
      const ctx = await started({ mode });
      await ctx.ticket('closed');
      await ctx.repo('o/r');
      expect(effective(await ctx.task())).toBe('dev');
      await ctx.spur('ended');
      expect(effective(await ctx.task())).toBe('dev');
      const task = await ctx.task();
      await ctx.repo('o/r', true, task.last_change_at ?? task.created_at);
      expect(effective(await ctx.task())).toBe('dev');
      expect((await ctx.why()).holds).toContain('github_blind');
      await ctx.repo('o/r');
      expect(effective(await ctx.task())).toBe('dev');
      await ctx.spur('ended');
      expect(effective(await ctx.task())).toBe('done');
      expect(
        (await ctx.events(mode === 'on' ? 'task_moved' : 'task_shadow_moved')).filter(
          ({ payload }) => payload['to'] === 'done',
        ),
      ).toHaveLength(1);
    });
  });

  it('preserves the Done orchestrator wrap-up without a worker', async () => {
    const ctx = await started({ doneOrchestrator: 'coord' }, 'none');
    await ctx.ticket('closed');
    await ctx.github();
    await ctx.spur('none');
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toMatchObject({
      column: 'done',
      role: 'orchestrator:done',
      reason: 'done: wrap up',
    });
    const turns = await ctx.turns();
    await ctx.tick();
    expect(await ctx.turns()).toEqual(turns);
  });

  it('leaves archived tasks untouched', async () => {
    const ctx = await started({}, 'none');
    await ctx.archive();
    const moves = await ctx.moves();
    await ctx.ticket('closed');
    await ctx.tick();
    expect(await ctx.moves()).toEqual(moves);
  });

  it.each(['on', 'shadow'] as const)(
    '%s waits for every repo with a selected closed PR',
    async (mode) => {
      for (const state of ['unpolled', 'blind'] as const) {
        const ctx = await started({ mode, secondRepo: true }, 'none');
        await ctx.pr({ state: 'closed' });
        if (state === 'blind') {
          await ctx.repo('o/b');
          await ctx.blind('github:proj:o/b', true);
        }
        await ctx.ticket('closed');
        const task = await ctx.task();
        expect(mode === 'on' ? task.column : task.shadow_column).not.toBe('done');
        expect((await ctx.why()).holds).toContain('github_blind');
        if (state === 'blind') await ctx.blind('github:proj:o/b', false);
        await ctx.spur('none');
        await ctx.repo('o/r');
        await ctx.repo('o/b');
        await ctx.tick();
        const after = await ctx.task();
        expect(mode === 'on' ? after.column : after.shadow_column).toBe('done');
        expect((await ctx.why()).holds).not.toContain('github_blind');
      }
    },
  );

  it.each(['on', 'shadow'] as const)(
    '%s counts an open conflict link as work in flight',
    async (mode) => {
      const ctx = await started({ mode }, 'none');
      await ctx.pr();
      await ctx.store.db
        .updateTable('link')
        .set({ pr_state: 'conflict' })
        .where('entity', '=', 'pr')
        .execute();
      await ctx.ticket('closed');
      const task = await ctx.task();
      expect(mode === 'on' ? task.column : task.shadow_column).not.toBe('done');
      await ctx.pr({ state: 'closed' });
      await ctx.github();
      await ctx.spur('none');
      await ctx.tick();
      const after = await ctx.task();
      expect(mode === 'on' ? after.column : after.shadow_column).toBe('done');
    },
  );

  it('a live or paused worker blocks completion; an ended worker permits it and closes the prior turn', async () => {
    const ctx = await started();
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('dev');
    await ctx.session({ ...sessionFacts('worker-1', 'worker'), lifecycle: 'paused' });
    await ctx.tick();
    expect((await ctx.task()).column).toBe('dev');
    await ctx.spur('ended');
    expect((await ctx.task()).column).toBe('dev');
    await ctx.github();
    await ctx.spur('ended');
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toBeNull();
    expect((await ctx.turns())[0]?.closed_at).not.toBeNull();
    expect((await ctx.moves()).at(-1)).toMatchObject({ reason: 'ticket_done_no_pr' });
  });

  it.each(['spur', GITHUB] as const)(
    'waits for %s startup completeness and recovery',
    async (source) => {
      const ctx = board();
      await ctx.ticket();
      if (source !== GITHUB) await ctx.github();
      if (source !== 'spur') await ctx.spur('none');
      await ctx.ticket('closed');
      expect((await ctx.task()).column).toBe('todo');
      if (source === GITHUB) await ctx.github();
      else await ctx.spur('none');
      await ctx.github();
      await ctx.spur('none');
      await ctx.tick();
      expect((await ctx.task()).column).toBe('done');
    },
  );

  it('waits for Spur blindness to recover', async () => {
    const ctx = await started({}, 'none');
    await ctx.blind('spur', true);
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('todo');
    await ctx.blind('spur', false);
    await ctx.spur('none');
    await ctx.github();
    await ctx.tick();
    expect((await ctx.task()).column).toBe('done');
  });

  it.each(['on', 'shadow'] as const)(
    '%s completes, reopens and recloses without a PR',
    async (mode) => {
      const ctx = await started({ mode }, 'none');
      await ctx.ticket('closed');
      await ctx.github();
      await ctx.spur('none');
      const effective = async () => {
        const task = await ctx.task();
        return mode === 'on' ? task.column : task.shadow_column;
      };
      expect(await effective()).toBe('done');
      const kind = mode === 'on' ? 'task_moved' : 'task_shadow_moved';
      expect(await ctx.events(kind)).toMatchObject([
        { payload: { from: 'todo', to: 'done', reason: 'ticket_done_no_pr' } },
      ]);
      expect((await ctx.why()).holds).not.toContain('work_not_started');
      expect((await ctx.why()).moves.at(-1)).toMatchObject({ reason: 'ticket_done_no_pr' });
      expect(await ctx.turns()).toEqual([]);
      if (mode === 'shadow') expect((await ctx.task()).column).toBe('todo');
      await ctx.ticket('open');
      expect(await effective()).toBe('todo');
      await ctx.ticket('closed');
      await ctx.github();
      await ctx.spur('none');
      expect(await effective()).toBe('done');
      const events = await ctx.events();
      await ctx.tick();
      await ctx.ticket('closed');
      expect(await ctx.events()).toEqual(events);
    },
  );
});

describe('a merged PR and the ticket', () => {
  const NOTE = 'dev: no_pr (PR o/r#7 merged, ticket still open)';
  /** Merges PR #7 in the next step, with `mergedAt` at that step. */
  const merge = (ctx: Board) =>
    ctx.pr({ state: 'merged', mergedAt: new Date(Date.parse(ctx.at()) + 60_000).toISOString() });
  const devMoves = async (ctx: Board) =>
    (await ctx.moves()).filter((move) => move.to === 'dev').length;

  it('goes back to Dev with a note naming the PR', async () => {
    const ctx = await pastProductReview();
    await merge(ctx);
    expect((await ctx.task()).column).toBe('ready-to-merge');
    // A ticket untouched since the merge only waits to be moved to done; a change after the
    // merge, with the ticket still open, sends the task back to work.
    await ctx.ticket();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    await ctx.ticket('open', true, ctx.at());
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'ready-to-merge',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['no_pr'],
    });
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', NOTE));
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select('item_key')
        .where('kind', 'in', ['cycle_limit', 'course_check'])
        .execute(),
    ).toEqual([]);
  });

  /** The task in Done after the merge and the ticket close, with the worker's wrap-up taken. */
  const wrappingUp = async (ctx: Board) => {
    await ctx.pr({ state: 'merged' });
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    const wrapUp = await ctx.openTurn();
    expect(wrapUp).toEqual(turnOf('done', 'worker', 'done: wrap up'));
    await ctx.ack(WORKER, wrapUp?.id ?? '');
    return Number(wrapUp?.id.slice(1));
  };
  const openSystemBlocks = (ctx: Board) =>
    ctx.store.db
      .selectFrom('block')
      .selectAll()
      .where('author', '=', 'system')
      .where('state', '=', 'open')
      .execute();

  it.each(['complete', 'kill'] as const)(
    'closes the Done wrap-up turn when its holder session ends (%s)',
    async (end) => {
      const ctx = await inDev();
      const id = await wrappingUp(ctx);
      await (end === 'complete'
        ? ctx.spur('ended')
        : ctx.session({
            ...sessionFacts('worker-1', 'worker', true),
            endReason: 'kill',
            lifecycle: 'killed',
          }));
      expect((await ctx.turns()).find((turn) => turn.id === id)).toMatchObject({
        closed_reason: 'moved',
      });
      expect((await ctx.events('turn_closed')).at(-1)?.payload).toMatchObject({
        turn: `T${String(id)}`,
        outcome: 'moved',
      });
      ctx.wait(IDLE * 2);
      await ctx.tick();
      expect(
        await ctx.store.db
          .selectFrom('operator_item')
          .selectAll()
          .where('kind', '=', 'anomaly')
          .execute(),
      ).toEqual([]);
      expect(await openSystemBlocks(ctx)).toEqual([]);
      expect(await ctx.openTurn()).toBeNull();
    },
  );

  it('withdraws a stuck-turn block when the task reaches Done', async () => {
    const ctx = await inDev();
    await ctx.session({ ...sessionFacts('worker-1', 'worker'), health: 'waiting' });
    ctx.wait(IDLE);
    await ctx.tick();
    // Seed a failed reminder for the live holder; ended holders use worker_ended instead.
    await ctx.store.db
      .updateTable('notification')
      .set({ exhausted_at: ctx.at() })
      .where('kind', '=', 'turn_reminder')
      .where('turn_id', '=', 1)
      .execute();
    await ctx.tick();
    const items = () =>
      ctx.store.db
        .selectFrom('operator_item')
        .select(['item_key', 'block_id'])
        .where('item_key', '=', 'stuck-turn:1')
        .where('cleared_at', 'is', null)
        .execute();
    const [stuck] = await items();
    expect(stuck?.block_id).not.toBeNull();
    expect(await openSystemBlocks(ctx)).toHaveLength(1);
    await ctx.pr({ state: 'merged' });
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'moved' });
    expect(
      await ctx.store.db
        .selectFrom('block')
        .select('outcome')
        .where('id', '=', stuck?.block_id ?? -1)
        .executeTakeFirstOrThrow(),
    ).toEqual({ outcome: 'withdrawn' });
    expect(await items()).toEqual([]);
    await ctx.ack(WORKER, (await ctx.openTurn())?.id ?? '');
    await ctx.spur('ended');
    expect(await ctx.openTurn()).toBeNull();
  });

  it('opens a new wrap-up for another live worker after the holder ends', async () => {
    const ctx = await inDev();
    const id = await wrappingUp(ctx);
    await ctx.session(sessionFacts('worker-2', 'worker'));
    await ctx.spur('ended');
    await ctx.tick();
    const next = await ctx.openTurn();
    expect(next).toEqual(turnOf('done', 'worker', 'done: wrap up'));
    expect(next?.id).not.toBe(`T${String(id)}`);
  });

  it('a split task reaches Done on its second merge and shows both merged PRs', async () => {
    const ctx = await pastProductReview();
    await merge(ctx);
    await ctx.ticket();
    await ctx.ticket('open', true, ctx.at());
    const note = await ctx.openTurn();
    expect(note).toEqual(turnOf('dev', 'worker', NOTE));
    await ctx.ack(WORKER, note?.id ?? '');
    await ctx.pr({ number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' });
    expect((await ctx.task()).column).toBe('dev');
    await ctx.pr({ number: 8, state: 'merged' });
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toEqual(turnOf('done', 'worker', 'done: wrap up'));
    expect((await ctx.get()).links.filter((link) => link.kind === 'pr')).toEqual([
      { kind: 'pr', ref: 'o/r#7', role: null, state: 'merged' },
      { kind: 'pr', ref: 'o/r#8', role: null, state: 'merged' },
    ]);
  });

  /** #7 merged with the ticket open, the task back in Dev, then follow-up #8 closed unmerged. */
  const followUpClosed = async () => {
    const ctx = await pastProductReview();
    await merge(ctx);
    await ctx.ticket();
    await ctx.ticket('open', true, ctx.at());
    const note = await ctx.openTurn();
    expect(note).toEqual(turnOf('dev', 'worker', NOTE));
    await ctx.ack(WORKER, note?.id ?? '');
    await ctx.pr({ number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' });
    await ctx.pr({ number: 8, state: 'closed' });
    return ctx;
  };

  it('a split task whose follow-up PR closed reaches Done on its earlier merge once the ticket closes', async () => {
    const ctx = await followUpClosed();
    expect((await ctx.task()).column).toBe('dev');
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toEqual(turnOf('done', 'worker', 'done: wrap up'));
    expect((await ctx.why()).holds).toEqual([]);
  });

  it('a split task whose follow-up PR closed stays in Dev without a PR while the ticket is open', async () => {
    const ctx = await followUpClosed();
    await ctx.ticket('open', true, ctx.at());
    expect((await ctx.task()).column).toBe('dev');
    const dev = (await ctx.why()).gates.find((gate) => gate.column === 'dev');
    expect(dev?.conditions.map((condition) => condition.reason)).toContain('no_pr');
    expect(dev?.conditions.map((condition) => condition.reason)).not.toContain('pr_closed');
  });

  it.each([
    ['in Dev', false, 'dev'],
    ['in Review', true, 'review'],
  ] as const)(
    'a split task with follow-up #8 open %s reaches Done on its earlier merge once the ticket closes',
    async (_label, submitted, column) => {
      const ctx = await pastProductReview();
      await merge(ctx);
      await ctx.ticket();
      await ctx.ticket('open', true, ctx.at());
      const note = await ctx.openTurn();
      expect(note).toEqual(turnOf('dev', 'worker', NOTE));
      await ctx.ack(WORKER, note?.id ?? '');
      await ctx.pr({ number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' });
      if (submitted) await ctx.submit(WORKER, note?.id ?? '', C);
      expect((await ctx.task()).column).toBe(column);
      await ctx.ticket('closed');
      expect((await ctx.task()).column).toBe('done');
      expect((await ctx.moves()).at(-1)).toEqual({ from: column, to: 'done', reason: 'merged' });
      expect(await ctx.openTurn()).toEqual(turnOf('done', 'worker', 'done: wrap up'));
      expect((await ctx.why()).holds).toEqual([]);
    },
  );

  it('a task with an open PR and live worker stays off Done when its ticket closes', async () => {
    const ctx = await pastProductReview();
    const before = await ctx.moves();
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect(await ctx.moves()).toEqual(before);
  });

  it('holds a merged task while its ticket is unconfirmed', async () => {
    const ctx = await pastProductReview();
    const before = await devMoves(ctx);
    await merge(ctx);
    await ctx.ticket();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.why()).holds).toEqual(['ticket_unconfirmed']);
    // Out of the filter, the stored status may be stale: still held past the interval.
    await ctx.ticket('open', false);
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.why()).holds).toEqual(['ticket_unconfirmed']);
    // In the filter but untouched since the merge, long past the tracker interval: the ticket
    // only waits to be moved to done.
    ctx.wait(10 * 60_000);
    await ctx.ticket();
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.why()).holds).toEqual(['ticket_unconfirmed']);
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    expect(await devMoves(ctx)).toBe(before);
  });

  it('a timestamp-only ticket poll after the merge sends the task to Dev', async () => {
    const ctx = await pastProductReview();
    await merge(ctx);
    await ctx.ticket();
    const changes = (await ctx.events()).filter((event) => event.kind.startsWith('ticket_')).length;
    await ctx.ticket('open', true, ctx.at());
    expect((await ctx.events()).filter((event) => event.kind.startsWith('ticket_'))).toHaveLength(
      changes,
    );
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', NOTE));
  });

  it('a ticket that closes one poll after the merge reaches Done with no Dev visit', async () => {
    const ctx = await pastProductReview();
    const before = await devMoves(ctx);
    await merge(ctx);
    await ctx.ticket('closed');
    expect((await ctx.task()).column).toBe('done');
    expect(await ctx.openTurn()).toEqual(turnOf('done', 'worker', 'done: wrap up'));
    expect(await devMoves(ctx)).toBe(before);
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'ready-to-merge',
      to: 'done',
      reason: 'merged',
    });
  });

  it('holds a merged task on a repo with no poll since start once its ticket changed after the merge', async () => {
    const ctx = await pastProductReview();
    const before = await devMoves(ctx);
    // After a restart the project also tracks o/b, which has no complete poll yet.
    ctx.restart({ secondRepo: true });
    await ctx.spur();
    const operatorTurn = await ctx.openTurn();
    await merge(ctx);
    await ctx.ticket();
    await ctx.ticket('open', true, ctx.at());
    // The merged PR counts as no PR, so a follow-up PR in o/b may not be seen yet.
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.why()).holds).toEqual(['github_blind']);
    expect(await devMoves(ctx)).toBe(before);
    expect(await ctx.openTurn()).toEqual(operatorTurn);
    await ctx.repo('o/b');
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', NOTE));
  });

  it('a hand-added task outside the filter goes back to Dev once its ticket changed after the merge', async () => {
    const ctx = board();
    await ctx.add();
    await ctx.ticket('open', false);
    await ctx.github();
    await ctx.spur('live');
    const turn = await ctx.openTurn();
    await ctx.ack(WORKER, turn?.id ?? '');
    await ctx.pr();
    await ctx.submit(WORKER, turn?.id ?? '', A);
    expect((await ctx.task()).column).toBe('review');
    await merge(ctx);
    await ctx.ticket('open', false);
    expect((await ctx.task()).column).toBe('review');
    await ctx.ticket('open', false, ctx.at());
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.why()).holds).toEqual([]);
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', NOTE));
  });
});

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
    // Merged after the ticket's last change, so the open ticket is only not moved yet.
    await ctx.pr({
      state: 'merged',
      mergedAt: new Date(Date.parse(ctx.at()) + 60_000).toISOString(),
    });
    await ctx.ticket('closed');

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
    expect((await ctx.events('task_submitted'))[0]?.payload).toEqual({
      column: 'dev',
      sha: A,
      basis: 'tested',
    });
  });

  it('status shows the shadow column next to the column on every row', async () => {
    const ctx = board({ mode: 'shadow' });
    await ctx.ticket();
    const addedAt = (await ctx.task()).created_at;
    await ctx.github();
    await ctx.spur('none');
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: null });
    expect(await ctx.status()).toEqual({
      key: KEY,
      project: 'proj',
      column: 'todo',
      position: 1,
      columnEnteredAt: addedAt,
      membership: 'active',
      shadowColumn: 'todo',
      shadowDiffers: false,
      submission: null,
      qaSubmission: null,
      state: 'ticket open',
      prCount: 0,
      sessionCount: 0,
      openBlocks: 0,
      blocks: [],
      turn: null,
      prSummary: null,
      links: { ticket: 'https://github.com/o/r/issues/9', prs: [], sessions: [] },
    });

    await ctx.spur('live');
    await ctx.pr();
    const prAt = ctx.at();
    await ctx.submit(WORKER, KEY, A);
    expect(await ctx.task()).toMatchObject({ column: 'todo', shadow_column: 'review' });
    expect(await ctx.status()).toEqual({
      key: KEY,
      project: 'proj',
      column: 'todo',
      position: 1,
      columnEnteredAt: addedAt,
      membership: 'active',
      shadowColumn: 'review',
      shadowDiffers: true,
      submission: {
        column: 'dev',
        sha: A,
        at: ctx.at(),
        basis: 'tested',
        from: null,
        testedOrigin: null,
        reason: null,
        pending: false,
        voided: false,
      },
      qaSubmission: null,
      state: 'ticket open; PRs 1 open; sessions 1 working',
      prCount: 1,
      sessionCount: 1,
      openBlocks: 0,
      blocks: [],
      turn: null,
      prSummary: [
        {
          repo: 'o/r',
          number: 7,
          checks: { pass: 1, fail: 0, pending: 0 },
          mergeable: 'mergeable',
          threads: { unresolved: 0, total: 0 },
          reviewsOnHead: { approved: [], changesRequested: [] },
          draft: false,
          factAt: prAt,
          unconfirmed: false,
        },
      ],
      links: {
        ticket: 'https://github.com/o/r/issues/9',
        prs: [{ repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' }],
        sessions: [{ id: 'worker-1' }],
      },
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
      events.filter(
        (event) =>
          event.summary ===
          'Would move review → dev (shadow mode): gate_broken (external_comments), with a course check',
      ),
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
    ).toEqual([
      'Moved todo → dev: gate_passed',
      'Moved dev → review: gate_passed',
      'Moved review → dev',
      'Moved dev → review: gate_passed',
      'Moved review → dev: gate_broken (conflict)',
    ]);

    const shadow = await started({ mode: 'shadow' });
    expect((await shadow.history()).events).toContainEqual(
      expect.objectContaining({
        kind: 'task_shadow_moved',
        summary: 'Would move todo → dev (shadow mode): gate_passed',
      }),
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
    await ctx.ticket('closed');
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
    await scanTransaction(
      ctx.store,
      boardConfig(),
      async (trx) => {
        const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
        await archiveTask(trx, { task, reason: 'out_of_filter', actor: 'system', at: ctx.at() });
      },
      { now: () => Date.parse(ctx.at()) },
    );
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
  it('task.get shows the unclosed turn, unacked then acked', async () => {
    const ctx = await started();
    const opened = ctx.at();
    const unacked = await ctx.get();
    expect(unacked.turn).toEqual({
      id: 'T1',
      column: 'dev',
      addressee: 'worker',
      at: opened,
      taken: null,
      handed: [],
      closed: null,
    });
    expect(unacked).not.toHaveProperty('turns');

    await ctx.ack(WORKER, 'T1');
    expect((await ctx.get()).turn).toMatchObject({
      id: 'T1',
      at: opened,
      taken: { by: WORKER, at: ctx.at() },
      closed: null,
    });

    await ctx.pr();
    await ctx.submit(WORKER, 'T1', A);
    await ctx.archive();
    expect((await ctx.get()).turn).toBeNull();
  });

  it('task.get, inbox and why show the same handed entries', async () => {
    const ctx = await inDev();
    const links = {
      url: 'https://github.com/o/r/pull/7#pullrequestreview-1',
      editedAt: at(2),
      comments: [
        { id: 'rc-1', url: 'https://github.com/o/r/pull/7#discussion_r1', threadId: 'PRRT_1' },
      ],
    };
    await ctx.pr({
      feedback: [
        {
          kind: 'review',
          id: 'r-1',
          author: { login: EXTERNAL, type: 'user' },
          postedAt: at(1),
          state: 'changes_requested',
          ...links,
        },
      ],
    });
    await ctx.submit(WORKER, 'T1', A);
    await ctx.ack(WORKER, 'T2');
    const expected = [
      { repo: 'o/r', number: 7, kind: 'review', id: 'r-1', postedAt: at(1), ...links },
    ];

    expect((await ctx.get()).turn).toMatchObject({ id: 'T2', handed: expected });
    expect((await ctx.inbox(WORKER)).turns).toEqual([
      expect.objectContaining({ id: 'T2', handed: expected }),
    ]);
    expect((await ctx.why()).turn).toMatchObject({ id: 'T2', handed: expected });
  });

  it('task.get detail lists closed turns with their outcome, newest first, at most five', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.ret(REV, 'T2');
    const returned = await ctx.get(true);
    expect(returned.turns?.map((turn) => [turn.id, turn.closed?.outcome])).toEqual([
      ['T2', 'returned'],
      ['T1', 'submitted'],
    ]);
    expect(returned.turn).toMatchObject({
      column: 'dev',
      closed: null,
      returned: { by: REV, from: 'review', turn: 'T2' },
    });
    expect(returned.turns?.map((turn) => turn.id)).not.toContain(returned.turn?.id);
    for (const turn of returned.turns ?? []) expect(turn).not.toHaveProperty('returned');

    const fresh = board();
    await fresh.ticket();
    const { id } = await fresh.task();
    const at = fresh.at();
    await fresh.store.db
      .insertInto('turn')
      .values(
        Array.from({ length: 7 }, (_, index) => ({
          task_id: id,
          column: 'dev' as const,
          epoch: 0,
          seq: index + 1,
          role: 'worker' as const,
          reason: 'dev: no_pr',
          handed: '[]',
          acked_by: null,
          acked_at: null,
          closed_at: at,
          closed_reason: 'moved' as const,
          created_at: at,
          head_sha: null,
        })),
      )
      .execute();
    const detail = await fresh.get(true);
    expect(detail.turn).toBeNull();
    expect(detail.turns?.map((turn) => turn.id)).toEqual(['T7', 'T6', 'T5', 'T4', 'T3']);
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
    expect((await ctx.why()).heldBy).toEqual([`B${String(item?.block_id)}`]);

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
    expect(block.reason).toContain('Counted rounds:');
    expect(block.reason).toContain('- return to Dev from review on aaaaaaa');
    expect(block.reason).toContain('- return to Dev from review on bbbbbbb');
    expect(block.reason).toContain('- return to Dev from review on ccccccc (current head)');
    expect(block.reason).toContain('by rev/rev-1 on');
    // The submits that answered the first two returns closed their blocks; only the third stays.
    expect(block.reason).toContain('on ccccccc (current head): Handle the empty list.');
    // Counted rounds name every head; the findings section names the open block's head alone.
    const findings = block.reason.slice(block.reason.indexOf('Open findings:'));
    expect(findings).not.toContain('on aaaaaaa');
    expect(findings).not.toContain('on bbbbbbb');
    expect(block.reason).toContain('PR: https://github.com/o/r/pull/7');
    expect(block.reason).toContain('Issue: https://github.com/o/r/issues/9');
    expect(block.reason).toContain('If returns keep hitting the same mechanism');
    expect(block.reason).toContain('fix the bug class once');
    expect(block.reason).toContain('cover its variants with one table test');
    expect(block.reason).toContain('remaining edges with no user-visible effect under Risk');
    expect(block.reason).toContain('in the PR description instead of fixing them here');
    expect(block.reason).toContain('Still fix P0/P1 and user-visible findings in this PR');
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();
    expect((await ctx.why()).holds).toContain('cycle_limit');
    expect((await ctx.why()).heldBy).toEqual([`B${String(block.id)}`]);

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
    expect(await ctx.why()).not.toHaveProperty('heldBy');
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

  it('a curator answer with a note forwards the answer, not the note', async () => {
    const ctx = await inReview({ curator: true });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);

    await ctx.answer(CUR, `B${String(block.id)}`, NOTE, 'Asked the operator first.');
    const forwarded = (await ctx.inbox(WORKER)).comments.filter((c) => c.block === null);
    expect(forwarded).toEqual([expect.objectContaining({ text: NOTE, author: CUR })]);
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

  it('courseCheckTo the column orchestrator asks it, and its answer resumes Dev', async () => {
    const ctx = await inReview({ curator: true, courseCheckTo: 'rev' });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    expect(block.addressee_role).toBe('orchestrator:review');
    expect(await opens(ctx, block.id)).toBe(0);

    await ctx.answer(REV, `B${String(block.id)}`, NOTE);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    const notes = (await ctx.inbox(WORKER)).comments.filter((comment) => comment.block === null);
    expect(notes).toEqual([expect.objectContaining({ text: NOTE, author: REV })]);
  });

  it('courseCheckTo operator asks the operator even with a curator', async () => {
    const ctx = await inReview({ curator: true, courseCheckTo: 'operator' });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    expect(block.addressee_role).toBe('operator');
    expect(await opens(ctx, block.id)).toBe(1);
  });

  it('courseCheckTo the orchestrator of another column asks that column', async () => {
    const ctx = await inReview({ curator: true, courseCheckTo: 'coord' });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    expect(block.addressee_role).toBe('orchestrator:product-review');

    await expect(ctx.answer(CUR, `B${String(block.id)}`, NOTE)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await ctx.answer(COORD, `B${String(block.id)}`, NOTE);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));
  });

  it('with courseCheckTo set the cycle-limit block still goes to the operator', async () => {
    const ctx = await inReview({ courseCheckTo: 'rev', cycleLimit: 3, courseCheck: 3 });
    await threeReturns(ctx);
    const [limit] = await itemsOf(ctx, 'cycle_limit');
    expect(
      await ctx.store.db
        .selectFrom('block')
        .select('addressee_role')
        .where('id', '=', limit?.block_id ?? 0)
        .executeTakeFirst(),
    ).toEqual({ addressee_role: 'operator' });
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
  });

  it('an orchestrator course block moves to the operator once its session is gone', async () => {
    const ctx = await inReview({ curator: true, courseCheckTo: 'coord' });
    await threeReturns(ctx);
    const block = await courseBlock(ctx);
    const ref = `B${String(block.id)}`;
    expect(block.addressee_role).toBe('orchestrator:product-review');

    // A live but busy conductor is not rung, and the block waits for it.
    await ctx.ring();
    expect((await courseBlock(ctx)).addressee_role).toBe('orchestrator:product-review');
    expect(await ctx.events('block_escalated')).toEqual([]);

    await ctx.spur('live', true, ['coord-1']);
    await ctx.ring();
    expect((await courseBlock(ctx)).addressee_role).toBe('operator');
    expect((await ctx.events('block_escalated')).map((event) => event.payload)).toEqual([
      {
        block: ref,
        from: 'orchestrator:product-review',
        to: 'operator',
        reason: 'no live orchestrator session',
      },
    ]);
    expect(await opens(ctx, block.id)).toBe(1);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toBeNull();

    await ctx.reply(ref, NOTE);
    expect((await itemsOf(ctx, 'course_check'))[0]?.cleared_at).toEqual(expect.any(String));
    await ctx.tick();
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
  });
});

/** A change request by `reviewer` on `head` in Dev, dated a second after the last step. */
async function devRound(
  ctx: Board,
  head: string,
  reviewer = EXTERNAL,
  type: 'user' | 'bot' = 'user',
): Promise<void> {
  ctx.wait(1_000);
  const submittedAt = ctx.at();
  const facts = ctx.facts();
  await ctx.pr({
    headSha: head,
    reviews: [
      ...(facts?.reviews ?? []).filter((review) => review.reviewer !== reviewer),
      { reviewer, state: 'changes_requested', commitSha: head, submittedAt },
    ],
    feedback: [
      ...(facts?.feedback ?? []),
      {
        kind: 'review',
        id: `r-${reviewer}-${submittedAt}`,
        author: { login: reviewer, type },
        postedAt: submittedAt,
      },
    ],
  });
}

/** An external change request on `head` that returns the task from Review or later. */
const externalReturn = (ctx: Board, head: string) => devRound(ctx, head);

/** The payloads of the task's `external_round` events. */
const rounds = async (ctx: Board) =>
  (await ctx.events('external_round')).map((event) => event.payload);

/** The rounds recorded on `heads`, by the external reviewer. */
const roundsOn = (...heads: string[]) =>
  heads.map((head) => ({ repo: 'o/r', pr: 7, head, reviewer: EXTERNAL }));

describe('external change-request rounds', () => {
  const NOTE = 'Fix the parser once and cover its variants with one table test.';

  const openKeys = async (ctx: Board) =>
    (
      await ctx.store.db
        .selectFrom('operator_item')
        .select('item_key')
        .where('cleared_at', 'is', null)
        .orderBy('id')
        .execute()
    ).map((item) => item.item_key);

  it.each([
    { name: 'the earlier request wins', gap: 1_000, winner: 'zed', loser: 'amy' },
    { name: 'the lower login wins a tie', gap: 0, winner: 'amy', loser: 'zed' },
  ])(
    'several requests on one head in one poll make one round: $name',
    async ({ gap, winner, loser }) => {
      const ctx = await inDev({ externalReview: true });
      ctx.wait(1_000);
      const first = ctx.at();
      ctx.wait(gap);
      const second = ctx.at();
      // The loser is listed first, so only the sort picks the winner.
      const requests = [
        { reviewer: loser, submittedAt: second },
        { reviewer: winner, submittedAt: first },
      ];
      await ctx.pr({
        headSha: B,
        reviews: requests.map(({ reviewer, submittedAt }) => ({
          reviewer,
          state: 'changes_requested' as const,
          commitSha: B,
          submittedAt,
        })),
        feedback: requests.map(({ reviewer, submittedAt }) => ({
          kind: 'review' as const,
          id: `r-${reviewer}`,
          author: { login: reviewer, type: 'user' as const },
          postedAt: submittedAt,
        })),
      });
      expect(await rounds(ctx)).toEqual([{ repo: 'o/r', pr: 7, head: B, reviewer: winner }]);
    },
  );

  it.each([
    {
      name: 'a second return on one head',
      setup: async (ctx: Board) => {
        await externalReturn(ctx, A);
        await resubmit(ctx, A);
        await externalReturn(ctx, A);
      },
      start: inReview,
      cycle: 2,
      heads: [C],
      summary: '1 return for external comments, 1 change request on a new head',
      listed: 1,
    },
    {
      name: 'a return on the head of a Dev round',
      setup: async (ctx: Board) => {
        await devRound(ctx, B);
        // The first submit hands the change request over; the second reaches Review.
        await resubmit(ctx, B);
        await resubmit(ctx, B);
        expect((await ctx.task()).column).toBe('review');
        await externalReturn(ctx, B);
      },
      start: inDev,
      cycle: 1,
      heads: [B, C],
      summary: '2 change requests on new heads',
      listed: 0,
    },
  ])(
    'a head External Review already counted counts once: $name',
    async ({ setup, start, cycle: returns, heads, summary, listed }) => {
      const options = { externalReview: true, curator: true, externalCourseCheck: 2 };
      const ctx = await start(options);
      await setup(ctx);
      expect((await ctx.task()).column).toBe('dev');
      expect(await returnCounts(ctx.store.db, 1, 'review', project(options))).toEqual({
        cycle: returns,
        course: 0,
      });
      expect(
        (await returnCounts(ctx.store.db, 1, 'external-review', project(options))).course,
      ).toBe(1);
      expect(await openKeys(ctx)).toEqual([]);

      await devRound(ctx, C);
      expect(await rounds(ctx)).toEqual(roundsOn(...heads));
      const { reason } = await courseBlock(ctx);
      expect(reason).toContain(`2 external review rounds since the last check: ${summary}`);
      expect(reason.split('\n').filter((line) => line.startsWith('- return to Dev'))).toHaveLength(
        listed,
      );
    },
  );

  it.each([
    { name: 'after a restart, before the first complete poll', restart: true, blind: false },
    { name: 'while the poll reports the source blind', restart: false, blind: true },
  ])('a GitHub poll seen blind records no round: $name', async ({ restart, blind }) => {
    const options = { externalReview: true };
    const ctx = await inDev(options);
    if (restart) ctx.restart(options);
    ctx.wait(1_000);
    const submittedAt = ctx.at();
    await ctx.pr(
      {
        headSha: B,
        reviews: [{ reviewer: EXTERNAL, state: 'changes_requested', commitSha: B, submittedAt }],
        feedback: [
          {
            kind: 'review',
            id: 'r-partial',
            author: { login: EXTERNAL, type: 'user' },
            postedAt: submittedAt,
          },
        ],
      },
      false,
      undefined,
      blind,
    );
    expect(await rounds(ctx)).toEqual([]);

    await ctx.github();
    expect(await rounds(ctx)).toEqual(roundsOn(B));
  });

  it.each([
    {
      name: 'a push in the same poll does not take the reviewed head',
      act: async (ctx: Board) => {
        ctx.wait(1_000);
        const submittedAt = ctx.at();
        await ctx.pr({
          headSha: B,
          reviews: [{ reviewer: EXTERNAL, state: 'changes_requested', commitSha: A, submittedAt }],
          feedback: [
            {
              kind: 'review',
              id: 'r-on-a',
              author: { login: EXTERNAL, type: 'user' },
              postedAt: submittedAt,
            },
          ],
        });
        expect((await ctx.events('head_moved')).at(-1)?.payload).toMatchObject({ from: A, to: B });
      },
      course: 1,
      heads: [B],
    },
    {
      name: 'a changed closed PR in the same poll does not hide the active PR',
      act: async (ctx: Board) => {
        await ctx.pr({
          number: 8,
          url: 'https://github.com/o/r/pull/8',
          headSha: C,
          state: 'closed',
        });
        ctx.wait(1_000);
        const submittedAt = ctx.at();
        await ctx.prsPoll(
          {
            number: 7,
            headSha: B,
            reviews: [
              { reviewer: EXTERNAL, state: 'changes_requested', commitSha: A, submittedAt },
            ],
            feedback: [
              {
                kind: 'review',
                id: 'r-on-a',
                author: { login: EXTERNAL, type: 'user' },
                postedAt: submittedAt,
              },
            ],
          },
          { number: 8, title: 'o/r#9 closed follow-up' },
        );
        const changed = await ctx.events('pr_facts_changed');
        expect(changed.at(-1)?.payload).toMatchObject({ facts: { number: 8 } });
      },
      course: 1,
      heads: [B],
    },
    {
      name: 'a correction into Review bounces on the request it did not hand over',
      act: async (ctx: Board) => {
        await ctx.move('dev');
        await devRound(ctx, A);
        await ctx.pr({ headSha: B });
        await ctx.move('review');
        expect((await ctx.moves()).at(-1)?.gate).toContain('external_comments');
      },
      course: 1,
      heads: [A, B],
    },
    {
      name: 'a request from an earlier visit does not name a later return',
      act: async (ctx: Board) => {
        await externalReturn(ctx, A);
        await resubmit(ctx, B);
        ctx.wait(1_000);
        const postedAt = ctx.at();
        await ctx.pr({
          feedback: [
            ...(ctx.facts()?.feedback ?? []),
            { kind: 'comment', id: 'c-on-b', author: { login: EXTERNAL, type: 'user' }, postedAt },
          ],
        });
      },
      course: 2,
      heads: [],
    },
    {
      name: 'a replacement PR does not lend its head to a return on the old one',
      act: async (ctx: Board) => {
        await externalReturn(ctx, A);
        expect((await ctx.moves()).at(-1)).toMatchObject({ from: 'review', to: 'dev' });
        await ctx.prsPoll(
          { number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' },
          { number: 7, state: 'closed' },
        );
        expect(ctx.facts()).toMatchObject({ number: 8, headSha: C });
      },
      course: 1,
      next: C,
      heads: [C],
      repr: { pr: 8 },
    },
  ])(
    'a return under External Review counts the head the change request was on: $name',
    async ({ act, course, heads, next = B, repr = {} }) => {
      const options = { externalReview: true, curator: true };
      const ctx = await inReview(options);
      await act(ctx);
      expect((await ctx.moves()).filter((move) => move.from === 'review').at(-1)).toMatchObject({
        to: 'dev',
      });
      expect(
        (await returnCounts(ctx.store.db, 1, 'external-review', project(options))).course,
      ).toBe(course);

      await devRound(ctx, next);
      expect(await rounds(ctx)).toEqual(roundsOn(...heads).map((round) => ({ ...round, ...repr })));
    },
  );

  /**
   * The reviewers mark head A unless their marks still stand, and External Review's orchestrator
   * returns the task.
   */
  async function externalExecutorReturn(ctx: Board) {
    for (const actor of [REV, COORD]) {
      if ((await ctx.task()).column === 'external-review') break;
      const turn = await ctx.openTurn();
      await ctx.ack(actor, turn?.id ?? '');
      await ctx.submit(actor, turn?.id ?? '', A);
    }
    expect((await ctx.task()).column).toBe('external-review');
    const turn = await ctx.openTurn();
    await ctx.ack(COORD, turn?.id ?? '');
    await ctx.ret(COORD, turn?.id ?? '');
    expect((await ctx.moves()).at(-1)).toMatchObject({ from: 'external-review', to: 'dev' });
  }

  it.each([
    {
      name: 'an executor return on a head a Dev round counted',
      start: async (options: Options) => {
        const ctx = await inDev(options);
        await devRound(ctx, A);
        // The first submit hands the change request over; the second reaches Review.
        await resubmit(ctx, A);
        await resubmit(ctx, A);
        return ctx;
      },
      returns: 1,
      course: 2,
      summary: '1 executor return, 1 change request on a new head',
    },
    {
      name: 'repeated executor returns on one head',
      start: inReview,
      returns: 2,
      course: 2,
      summary: '2 executor returns',
    },
  ])(
    'External Review executor returns count every time: $name',
    async ({ start, returns, course, summary }) => {
      const options = {
        externalReview: true,
        curator: true,
        externalOrchestrator: 'coord',
        externalCourseCheck: 2,
      };
      const ctx = await start(options);
      for (let index = 0; index < returns; index += 1) {
        if (index > 0) await resubmit(ctx, A);
        await externalExecutorReturn(ctx);
      }
      expect(await returnCounts(ctx.store.db, 1, 'external-review', project(options))).toEqual({
        cycle: returns,
        course,
      });
      // The course question names executor returns as such, never as external comments.
      const { reason } = await courseBlock(ctx);
      expect(reason).toContain(`2 external review rounds since the last check: ${summary}\n`);
      expect(
        reason.split('\n').filter((line) => line.startsWith('- return to Dev by')),
      ).toHaveLength(returns);
      expect(reason).toContain('- return to Dev by the external-review executor on aaaaaaa');
      expect(reason).not.toContain('external comments');
    },
  );

  /** One external-comments return opens Review's cycle limit with External Review's check due. */
  const deferredCheck = {
    externalReview: true,
    curator: true,
    cycleLimit: 1,
    externalCourseCheck: 1,
  };

  /** A merged #7, the task back in Dev with an open follow-up #8 on C, then returned from Review. */
  async function followUpReturned(): Promise<Board> {
    const ctx = await pastProductReview(deferredCheck);
    const mergedAt = new Date(Date.parse(ctx.at()) + 60_000).toISOString();
    await ctx.pr({ state: 'merged', mergedAt });
    // A ticket edit at or after the merge keeps it open, so work resumes in Dev (#775).
    await ctx.ticket('open', true, mergedAt);
    await ctx.ticket('open', true, mergedAt);
    expect((await ctx.task()).column).toBe('dev');
    await ctx.ack(WORKER, (await ctx.openTurn())?.id ?? '');
    await ctx.pr({ number: 8, url: 'https://github.com/o/r/pull/8', headSha: C, state: 'open' });
    await ctx.submit(WORKER, (await ctx.openTurn())?.id ?? '', C);
    expect((await ctx.task()).column).toBe('review');
    await externalReturn(ctx, C);
    return ctx;
  }

  it.each([
    {
      name: 'the active PR merges',
      start: async () => {
        const ctx = await inReview(deferredCheck);
        await externalReturn(ctx, A);
        return ctx;
      },
      finish: async (ctx: Board) => {
        await ctx.pr({ state: 'merged' });
        await ctx.ticket('closed');
      },
      column: 'done',
      checks: [],
    },
    {
      name: 'an earlier PR merged and the ticket closes under an open follow-up',
      start: followUpReturned,
      finish: (ctx: Board) => ctx.ticket('closed'),
      column: 'done',
      checks: [],
    },
    {
      name: 'nothing completes',
      start: async () => {
        const ctx = await inReview(deferredCheck);
        await externalReturn(ctx, A);
        return ctx;
      },
      finish: (ctx: Board) => ctx.tick(),
      column: 'dev',
      checks: ['course-check:1:external-review'],
    },
    {
      name: 'nothing completes while Spur is blind and a Dev orchestrator works Dev',
      start: async () => {
        const ctx = await started({ ...deferredCheck, devOrchestrator: 'coord' });
        const dev = await ctx.openTurn();
        await ctx.ack(COORD, dev?.id ?? '');
        await ctx.pr();
        await ctx.submit(COORD, dev?.id ?? '', A);
        expect((await ctx.task()).column).toBe('review');
        await externalReturn(ctx, A);
        return ctx;
      },
      // A Dev orchestrator's turn does not wait for Spur, so neither does the course check.
      finish: async (ctx: Board) => {
        await ctx.blind('spur', true);
        await ctx.tick();
        expect((await ctx.why()).holds).toContain('spur_blind');
      },
      column: 'dev',
      checks: ['source:spur', 'course-check:1:external-review'],
    },
    {
      name: 'nothing completes after an unresolved thread returns the task from External Review',
      start: async () => {
        const ctx = await pastProductReview({
          externalReview: true,
          curator: true,
          externalThreads: true,
          externalCycleLimit: 1,
          externalCourseCheck: 1,
        });
        expect((await ctx.task()).column).toBe('external-review');
        await ctx.pr({ reviewThreads: [{ resolved: false }] });
        return ctx;
      },
      finish: (ctx: Board) => ctx.tick(),
      column: 'dev',
      checks: ['course-check:1:external-review'],
      limitKey: 'cycle-limit:1:external-review',
    },
  ])(
    'completion wins over a deferred External Review check: $name',
    async ({ start, finish, column, checks, limitKey = 'cycle-limit:1:review' }) => {
      const ctx = await start();
      expect((await ctx.task()).column).toBe('dev');
      const [limit] = (await itemsOf(ctx, 'cycle_limit')).filter(
        (item) => item.cleared_at === null,
      );
      expect(limit?.item_key).toBe(limitKey);
      expect(await itemsOf(ctx, 'course_check')).toEqual([]);
      await ctx.closeItem(`I${String(limit?.id)}`);
      expect(await itemsOf(ctx, 'course_check')).toEqual([]);

      await finish(ctx);
      expect((await ctx.task()).column).toBe(column);
      expect(await openKeys(ctx)).toEqual(checks);
      // Cleared ones included: completion raises no check at all.
      if (column === 'done') expect(await itemsOf(ctx, 'course_check')).toEqual([]);
      if (column === 'dev') expect(await ctx.openTurn()).toBeNull();
    },
  );

  it.each([
    {
      name: 'the PR had merged',
      fresh: async (ctx: Board) => {
        await ctx.pr({ state: 'merged' });
        await ctx.ticket('closed');
      },
      column: 'done',
      checks: [],
    },
    {
      name: 'the PR is still open',
      fresh: async (ctx: Board) => {
        await ctx.spur();
        expect(await openKeys(ctx)).toEqual([]);
        await ctx.github();
      },
      column: 'dev',
      checks: ['course-check:1:external-review'],
    },
  ])(
    'a deferred External Review check waits for a fresh GitHub view: $name',
    async ({ fresh, column, checks }) => {
      const ctx = await inReview(deferredCheck);
      await externalReturn(ctx, A);
      const [limit] = await itemsOf(ctx, 'cycle_limit');
      expect(limit?.item_key).toBe('cycle-limit:1:review');
      ctx.restart(deferredCheck);
      await ctx.closeItem(`I${String(limit?.id)}`);
      await ctx.tick();
      expect((await ctx.why()).holds).toContain('github_blind');
      expect(await openKeys(ctx)).toEqual([]);

      await fresh(ctx);
      expect((await ctx.task()).column).toBe(column);
      expect(await openKeys(ctx)).toEqual(checks);
      if (column === 'done') expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    },
  );

  it.each([
    {
      name: 'a new head returns the task with no submit on it',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await ctx.pr({ headSha: B });
        expect((await ctx.moves()).at(-1)).toMatchObject({
          from: 'review',
          to: 'dev',
          gate: ['no_submit_on_head'],
        });
        return ctx;
      },
      returns: 0,
      reads: 0,
    },
    {
      name: 'a push returns the task from External Review with no submit on it',
      start: async (options: Options) => {
        const ctx = await pastProductReview(options);
        expect((await ctx.task()).column).toBe('external-review');
        await ctx.pr({ headSha: B });
        expect((await ctx.moves()).at(-1)).toMatchObject({
          from: 'external-review',
          to: 'dev',
          gate: ['no_submit_on_head'],
        });
        return ctx;
      },
      returns: 0,
      reads: 0,
    },
    {
      name: 'a change request from before the task entered Dev',
      start: async (options: Options) => {
        const ctx = await inDev(options);
        const submittedAt = new Date(BASE - 3_600_000).toISOString();
        await ctx.pr({
          reviews: [{ reviewer: EXTERNAL, state: 'changes_requested', commitSha: A, submittedAt }],
        });
        expect(await ctx.events('external_round')).toEqual([]);
        return ctx;
      },
      returns: 0,
      reads: 0,
    },
    {
      name: 'snapshots, no change request and no return',
      start: async (options: Options) => {
        const ctx = await inDev(options);
        for (const head of [B, C, D]) await ctx.pr({ headSha: head });
        return ctx;
      },
      returns: 0,
      reads: 0,
    },
    {
      name: 'snapshots and a Review executor return',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await cycle(ctx);
        for (const head of [B, C, D]) await ctx.pr({ headSha: head });
        return ctx;
      },
      returns: 0,
      reads: 0,
    },
    {
      name: 'four External Review returns',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await externalReturn(ctx, A);
        for (const head of [B, C, D]) {
          await resubmit(ctx, head);
          await externalReturn(ctx, head);
        }
        return ctx;
      },
      returns: 4,
      reads: 1,
    },
  ])(
    "a dispatcher pass reads the task's course journal once: $name",
    async ({ start, returns, reads }) => {
      const options = {
        externalReview: true,
        curator: true,
        cycleLimit: 10,
        externalCourseCheck: 10,
      };
      const ctx = await start(options);
      expect((await ctx.task()).column).toBe('dev');
      expect(await returnCounts(ctx.store.db, 1, 'external-review', project(options))).toEqual({
        cycle: 0,
        course: returns,
      });
      // The facts row each return's change request is read from: the PR's last before it.
      const journal = await ctx.store.db
        .selectFrom('event')
        .select(['id', 'kind', 'payload'])
        .where('task_id', '=', 1)
        .where('kind', 'in', ['pr_facts_changed', 'task_moved'])
        .orderBy('id')
        .execute();
      const used = journal.flatMap<number>((row, index) =>
        row.kind === 'task_moved' && row.payload.includes('external_comments') && index > 0
          ? journal
              .slice(0, index)
              .filter((entry) => entry.kind === 'pr_facts_changed')
              .slice(-1)
              .map((entry) => entry.id)
          : [],
      );

      const queries: CompiledQuery[] = [];
      const logged = new Kysely<Tables>({
        dialect: new SqliteDialect({ database: rawDatabase(ctx.file) }),
        log: (event) => {
          queries.push(event.query);
        },
      });
      try {
        await logged.transaction().execute((trx) =>
          dispatchTasks(trx, [1], {
            config: ctx.config(),
            at: new Date(ctx.at()),
            complete: ctx.complete(),
          }),
        );
      } finally {
        await logged.destroy();
      }
      // The moves, rounds and every poll's PR facts come in one read; feedback and reviews only
      // for the facts rows an External Review return uses, and not at all without one.
      const facts = queries.filter((query) =>
        [query.sql, ...query.parameters.map(String)].some((text) =>
          text.includes('pr_facts_changed'),
        ),
      );
      expect(facts).toHaveLength(reads);
      const feedback = queries.filter((query) => query.sql.includes('json_group_array'));
      expect(
        feedback.map((query) =>
          query.parameters.filter((value) => typeof value === 'string' && value.startsWith('[')),
        ),
      ).toEqual(returns === 0 ? [] : [[JSON.stringify(used)]]);
      expect(used).toHaveLength(returns);
    },
  );

  it.each([
    { name: 'course checks off', courseCheck: 0, reads: 0 },
    { name: "Review's course check on", courseCheck: 10, reads: 1 },
  ])(
    'a return in a dispatcher pass reads PR history only for a course count: $name',
    async ({ courseCheck, reads }) => {
      const ctx = await inDev({ cycleLimit: 10, courseCheck });
      for (const head of [B, C]) await ctx.pr({ headSha: head });
      await ctx.submit(WORKER, 'T1', C);
      expect((await ctx.task()).column).toBe('review');
      // The stored PR head moves on with no poll, so the logged pass itself returns the task.
      await ctx.store.db
        .updateTable('pr_snapshot')
        .set({ detail: sql<string>`json_set(detail, '$.headSha', ${D})` })
        .execute();

      const queries: CompiledQuery[] = [];
      const logged = new Kysely<Tables>({
        dialect: new SqliteDialect({ database: rawDatabase(ctx.file) }),
        log: (event) => {
          queries.push(event.query);
        },
      });
      try {
        // A move needs the scan transaction the poll runs in, here on the logged connection.
        const store = {
          transaction: <T>(fn: (trx: Kysely<Tables>) => Promise<T>) =>
            logged.transaction().execute(fn),
        } as Store;
        await scanTransaction(
          store,
          ctx.config(),
          (trx) =>
            dispatchTasks(trx, [1], {
              config: ctx.config(),
              at: new Date(ctx.at()),
              complete: ctx.complete(),
            }),
          { now: () => Date.parse(ctx.at()) },
        );
      } finally {
        await logged.destroy();
      }
      expect((await ctx.task()).column).toBe('dev');
      expect((await ctx.moves()).at(-1)).toMatchObject({
        from: 'review',
        gate: ['no_submit_on_head'],
      });
      // A read of PR history asks for the `pr_facts_changed` kind; the cycle events alone do not.
      const facts = queries.filter((query) => query.parameters.includes('pr_facts_changed'));
      expect(facts).toHaveLength(reads);
    },
  );

  it.each([
    {
      name: 'an external-comments return from Review',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await externalReturn(ctx, A);
        return ctx;
      },
      counts: true,
    },
    {
      name: 'an unresolved-threads return from External Review',
      start: async (options: Options) => {
        const ctx = await pastProductReview(options);
        await ctx.pr({ reviewThreads: [{ resolved: false }] });
        expect((await ctx.moves()).at(-1)).toMatchObject({
          from: 'external-review',
          gate: ['unresolved_threads'],
        });
        return ctx;
      },
      counts: true,
    },
    {
      name: 'an External Review executor return',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await externalExecutorReturn(ctx);
        return ctx;
      },
      counts: true,
    },
    {
      name: 'a Review executor return',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await cycle(ctx);
        return ctx;
      },
      counts: false,
    },
    {
      name: 'a no_submit_on_head return',
      start: async (options: Options) => {
        const ctx = await inReview(options);
        await ctx.pr({ headSha: B });
        expect((await ctx.moves()).at(-1)?.gate).toEqual(['no_submit_on_head']);
        return ctx;
      },
      counts: false,
    },
    {
      name: 'an external_round',
      start: async (options: Options) => {
        const ctx = await inDev(options);
        await devRound(ctx, B);
        return ctx;
      },
      counts: true,
    },
  ])(
    "a replay runs exactly when External Review's counter takes an entry: $name",
    async ({ start, counts }) => {
      const options = {
        externalReview: true,
        curator: true,
        externalOrchestrator: 'coord',
        externalThreads: true,
        cycleLimit: 10,
        externalCycleLimit: 10,
        externalCourseCheck: 10,
      };
      const ctx = await start(options);
      expect((await ctx.task()).column).toBe('dev');
      const { course } = await returnCounts(ctx.store.db, 1, 'external-review', project(options));
      expect(course > 0).toBe(counts);
      expect(await mayCount(ctx.store.db, 1)).toBe(counts);
    },
  );

  it('repeated change requests on one head count once', async () => {
    const ctx = await inDev({ externalReview: true, curator: true });
    await devRound(ctx, B);
    await devRound(ctx, B);
    await devRound(ctx, B, 'second-reviewer');
    await ctx.tick();
    await ctx.tick();
    await ctx.github();
    expect(await rounds(ctx)).toEqual(roundsOn(B));

    await ctx.pr({ headSha: C });
    await ctx.github();
    expect(await rounds(ctx)).toEqual(roundsOn(B));
  });

  it.each([
    { name: 'an executor return head counts again', external: false, head: A, heads: [A] },
    { name: 'an external return head counts once', external: true, head: A, heads: [] },
    { name: 'a new head after an external return counts', external: true, head: B, heads: [B] },
  ])(
    "only External Review's counted heads dedupe a round: $name",
    async ({ external, head, heads }) => {
      const ctx = await inReview({ externalReview: true });
      if (external) await externalReturn(ctx, A);
      else await cycle(ctx);
      expect((await ctx.task()).column).toBe('dev');
      expect(await rounds(ctx)).toEqual([]);

      await devRound(ctx, head);
      expect(await rounds(ctx)).toEqual(roundsOn(...heads));
    },
  );

  it.each([
    { name: 'a bot changes-request', act: (ctx: Board) => devRound(ctx, B, 'review-app', 'bot') },
    { name: 'the agent login', act: (ctx: Board) => devRound(ctx, B, 'agent-bot') },
    {
      name: 'shadow mode',
      act: async (ctx: Board) => {
        ctx.restart({ externalReview: true, mode: 'shadow' });
        expect((await ctx.task()).column).toBe('dev');
        await devRound(ctx, B);
      },
    },
    {
      name: 'a request before the Dev entry',
      act: (ctx: Board) =>
        ctx.pr({
          reviews: [
            { reviewer: EXTERNAL, state: 'changes_requested', commitSha: A, submittedAt: at(-10) },
          ],
          feedback: [
            {
              kind: 'review',
              id: 'r-early',
              author: { login: EXTERNAL, type: 'user' },
              postedAt: at(-10),
            },
          ],
        }),
    },
  ])(
    'bots, the agent login, shadow mode and requests before the Dev entry make no round: $name',
    async ({ act }) => {
      const ctx = await inDev({ externalReview: true });
      await act(ctx);
      await ctx.tick();
      expect(await rounds(ctx)).toEqual([]);
    },
  );

  it('N external change requests on new heads in Dev fire the course check at the threshold', async () => {
    const ctx = await inDev({ externalReview: true, curator: true });
    await devRound(ctx, A);
    await ctx.submit(WORKER, 'T1', A);
    expect((await ctx.task()).column).toBe('dev');
    const handed = await ctx.openTurn();
    expect(handed).toMatchObject({ column: 'dev', role: 'worker' });
    expect(JSON.parse(handed?.handed ?? '[]')).toEqual([
      expect.objectContaining({
        kind: 'review',
        id: expect.stringMatching(/^r-reviewer-/) as unknown,
      }),
    ]);

    await devRound(ctx, B);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    const before = await ctx.openTurn();
    expect(before).not.toBeNull();
    await devRound(ctx, C);

    expect(await rounds(ctx)).toEqual(roundsOn(A, B, C));
    expect(await openKeys(ctx)).toEqual(['course-check:1:external-review']);
    expect(await courseBlock(ctx)).toMatchObject({
      type: 'needs_input',
      author: 'system',
      addressee_role: 'curator',
      state: 'open',
    });
    expect((await ctx.why()).holds).toContain('cycle_limit');
    const held = (await ctx.turns()).find((turn) => `T${String(turn.id)}` === before?.id);
    expect(held?.closed_at).toBeNull();

    const count = (await ctx.turns()).length;
    await ctx.tick();
    expect(await ctx.turns()).toHaveLength(count);

    await ctx.ack(WORKER, before?.id ?? '');
    await ctx.submit(WORKER, before?.id ?? '', C);
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();
    expect(await openKeys(ctx)).toEqual(['course-check:1:external-review']);
  });

  it('an External Review return and Dev rounds add up to one counter', async () => {
    const options = { externalReview: true, curator: true };
    const ctx = await pastProductReview(options);
    expect((await ctx.task()).column).toBe('external-review');
    await ctx.pr({
      reviews: [
        { reviewer: EXTERNAL, state: 'changes_requested', commitSha: A, submittedAt: at(30) },
      ],
      feedback: [
        {
          kind: 'review',
          id: `r-${EXTERNAL}`,
          author: { login: EXTERNAL, type: 'user' },
          postedAt: at(30),
        },
      ],
    });
    expect((await ctx.task()).column).toBe('dev');
    // A pass in Dev with the request on A still current: its head counted with the return.
    await ctx.ack(WORKER, (await ctx.openTurn())?.id ?? '');
    await ctx.tick();
    expect(await rounds(ctx)).toEqual([]);
    await devRound(ctx, B);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    await devRound(ctx, C);

    expect(await rounds(ctx)).toEqual(roundsOn(B, C));
    expect(await returnCounts(ctx.store.db, 1, 'external-review', project(options))).toEqual({
      cycle: 1,
      course: 3,
    });
    expect(await openKeys(ctx)).toEqual(['course-check:1:external-review']);
    const block = await courseBlock(ctx);
    expect(block.addressee_role).toBe('curator');
    expect(block.reason).toContain('3 external review rounds');
    expect(block.reason).toContain(
      '3 external review rounds since the last check: 1 return for external comments, 2 change requests on new heads',
    );
    expect(block.reason).toContain(
      '- return to Dev from external-review for external comments on aaaaaaa',
    );
    expect(block.reason).toContain('- change request by reviewer on bbbbbbb');
    expect(block.reason).toContain('- change request by reviewer on ccccccc (current head)');
    const item = await ctx.store.db
      .selectFrom('operator_item')
      .select('text')
      .where('kind', '=', 'course_check')
      .executeTakeFirstOrThrow();
    expect(item.text).toMatch(/course check after 3 external review rounds$/);
  });

  it.each([
    {
      name: 'Dev rounds',
      options: { externalReview: true, curator: true, cycleLimit: 1, courseCheck: 0 },
      act: async (ctx: Board) => {
        await cycle(ctx);
        expect((await ctx.task()).column).toBe('dev');
        await devRound(ctx, B);
        await devRound(ctx, C);
        await devRound(ctx, D);
        expect(await rounds(ctx)).toEqual(roundsOn(B, C, D));
      },
      first: '3 external review rounds since the last check: 3 change requests on new heads\n',
      text: 'course check after 3 external review rounds',
    },
    {
      name: 'returns only',
      options: { externalReview: true, curator: true, cycleLimit: 1, externalCourseCheck: 1 },
      act: async (ctx: Board) => {
        await externalReturn(ctx, A);
        expect((await ctx.task()).column).toBe('dev');
        expect(await rounds(ctx)).toEqual([]);
      },
      first: '1 external review round since the last check: 1 return for external comments\n',
      text: 'course check after 1 external review round',
    },
  ])(
    'a threshold reached while another item is open raises on the first pass after it closes: $name',
    async ({ options, act, first, text }) => {
      const ctx = await inReview(options);
      await act(ctx);
      const [limit] = await itemsOf(ctx, 'cycle_limit');
      expect(limit?.item_key).toBe('cycle-limit:1:review');
      expect(await itemsOf(ctx, 'course_check')).toEqual([]);

      await ctx.closeItem(`I${String(limit?.id)}`);
      await ctx.tick();
      expect(await openKeys(ctx)).toEqual(['course-check:1:external-review']);
      expect(await ctx.openTurn()).toBeNull();
      // One round reads in the singular, several in the plural.
      expect((await courseBlock(ctx)).reason).toContain(first);
      const [item] = (await itemsOf(ctx, 'course_check')).map((entry) => entry.id);
      const { text: itemText } = await ctx.store.db
        .selectFrom('operator_item')
        .select('text')
        .where('id', '=', item ?? 0)
        .executeTakeFirstOrThrow();
      expect(itemText.endsWith(text)).toBe(true);
    },
  );

  it('after the answer the count restarts and old heads never recount', async () => {
    const ctx = await inDev({ externalReview: true, curator: true });
    await devRound(ctx, A);
    await devRound(ctx, B);
    await devRound(ctx, C);
    const block = await courseBlock(ctx);
    await ctx.answer(CUR, `B${String(block.id)}`, NOTE);
    await ctx.tick();
    expect(await openKeys(ctx)).toEqual([]);

    await devRound(ctx, D);
    expect(await rounds(ctx)).toEqual(roundsOn(A, B, C, D));
    expect(await openKeys(ctx)).toEqual([]);
    for (const [index, head] of [A, B, C].entries())
      await devRound(ctx, head, `again-${String(index)}`);
    expect(await rounds(ctx)).toEqual(roundsOn(A, B, C, D));
    expect(await openKeys(ctx)).toEqual([]);
  });

  it.each([
    { name: 'no External Review', options: { curator: true } },
    {
      name: 'External Review courseCheck 0',
      options: { externalReview: true, externalCourseCheck: 0, curator: true },
    },
  ])('no External Review or courseCheck 0 records nothing: $name', async ({ options }) => {
    const ctx = await inDev(options);
    for (const head of [A, B, C]) await devRound(ctx, head);
    expect(await rounds(ctx)).toEqual([]);
    expect(await openKeys(ctx)).toEqual([]);

    const returned = await inReview(options);
    await externalReturn(returned, A);
    expect((await returned.task()).column).toBe('dev');
    expect(await returnCounts(returned.store.db, 1, 'review', project(options))).toEqual(
      options.externalReview === true ? { cycle: 1, course: 0 } : { cycle: 1, course: 1 },
    );
    expect(await itemsOf(returned, 'course_check')).toEqual([]);
  });

  it('a return from Review for external comments counts under External Review; an executor return stays on Review', async () => {
    const options = { externalReview: true, curator: true };
    const ctx = await inReview(options);
    const counts = async (column: ColumnId) =>
      returnCounts(ctx.store.db, 1, column, project(options));
    await externalReturn(ctx, A);
    expect((await ctx.moves()).at(-1)).toMatchObject({
      from: 'review',
      to: 'dev',
      gate: expect.arrayContaining(['external_comments']) as unknown,
    });
    expect(await counts('external-review')).toEqual({ cycle: 0, course: 1 });
    expect(await counts('review')).toEqual({ cycle: 1, course: 0 });
    expect(await rounds(ctx)).toEqual([]);

    await resubmit(ctx, B);
    await cycle(ctx);
    expect(await counts('review')).toEqual({ cycle: 2, course: 1 });
    expect(await counts('external-review')).toEqual({ cycle: 0, course: 1 });
  });

  it("three external-comments returns from Review raise External Review's course check to its recipient", async () => {
    const ctx = await inReview({ externalReview: true, curator: true, courseCheckTo: 'rev' });
    await externalReturn(ctx, A);
    await resubmit(ctx, B);
    await externalReturn(ctx, B);
    await resubmit(ctx, C);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    await externalReturn(ctx, C);

    expect(await openKeys(ctx)).toEqual(['course-check:1:external-review']);
    expect((await courseBlock(ctx)).addressee_role).toBe('curator');
    expect((await ctx.why()).holds).toContain('cycle_limit');
    expect(await ctx.openTurn()).toBeNull();
  });

  it("external-comments returns still reach the from column's cycle limit first", async () => {
    const options = { externalReview: true, curator: true, cycleLimit: 2 };
    const ctx = await inReview(options);
    await externalReturn(ctx, A);
    await resubmit(ctx, B);
    await externalReturn(ctx, B);

    expect(await openKeys(ctx)).toEqual(['cycle-limit:1:review']);
    expect(await itemsOf(ctx, 'course_check')).toEqual([]);
    expect((await returnCounts(ctx.store.db, 1, 'external-review', project(options))).course).toBe(
      2,
    );
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
      'submission',
      'qaSubmission',
      'columnEnteredAt',
      'position',
      'state',
      'prCount',
      'sessionCount',
      'openBlocks',
      'blocks',
      'turn',
      'prSummary',
      'links',
    ]);
    expect(row).toEqual({
      submission: null,
      qaSubmission: null,
      key: KEY,
      project: 'proj',
      column: 'dev',
      position: 1,
      columnEnteredAt: on.at(),
      membership: 'active',
      state: 'ticket open; sessions 1 working',
      prCount: 0,
      sessionCount: 1,
      openBlocks: 0,
      blocks: [],
      turn: {
        id: 'T1',
        task: KEY,
        column: 'dev',
        addressee: 'worker',
        reason: 'dev: no_pr',
        head: null,
        at: on.at(),
        taken: null,
        addressedTo: null,
        stalledSince: null,
      },
      prSummary: null,
      links: { ticket: 'https://github.com/o/r/issues/9', prs: [], sessions: [{ id: 'worker-1' }] },
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

    const shadowAt = ctx.at();
    ctx.restart({ mode: 'on' });
    await ctx.tick();
    const promotedAt = ctx.at();
    for (const detail of [false, true])
      expect((await ctx.status(detail)).columnEnteredAt).toBe(promotedAt);
    expect(promotedAt).not.toBe(shadowAt);
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

  it('closes a turn left open in shadow mode as mode_changed on a switch to on', async () => {
    const ctx = await started({ mode: 'shadow' });
    await ctx.pr();
    await ctx.submit(WORKER, KEY, A);
    const task = await ctx.task();
    expect(task).toMatchObject({ column: 'todo', shadow_column: 'review' });
    // Shadow mode opens no turns; this row stands for one an older version left open.
    await ctx.store.db
      .insertInto('turn')
      .values({
        task_id: task.id,
        column: 'todo',
        epoch: 0,
        seq: 1,
        role: 'operator',
        reason: 'todo: left open',
        handed: '[]',
        acked_by: null,
        acked_at: null,
        closed_at: null,
        closed_reason: null,
        created_at: ctx.at(),
        head_sha: null,
      })
      .execute();

    ctx.restart({ mode: 'on' });
    await ctx.tick();
    expect(await ctx.task()).toMatchObject({ column: 'review', shadow_column: null });
    expect(await ctx.turns()).toEqual([
      expect.objectContaining({ id: 1, closed_reason: 'mode_changed' }),
    ]);
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
    ).toBe('mode_changed');
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
    await ctx.ticket('closed');
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

  it.each([false, true])(
    'checksGate external-review, qa %s: an approved task with a cancel in grace never moves right',
    async (qa) => {
      const ctx = await pastProductReview({
        externalReview: true,
        qa,
        checksGate: 'external-review',
      });
      await ctx.pr({
        ...review(EXTERNAL, 'approved', 30),
        requiredChecks: [{ name: 'ci', state: 'cancelled', completedAt: at(40) }],
      });
      expect((await ctx.task()).column).toBe('external-review');
      await ctx.github();
      expect((await ctx.task()).column).toBe('external-review');
      await ctx.github();
      expect((await ctx.task()).column).toBe('dev');
      expect(
        (await ctx.moves()).filter((move) => move.to === 'qa' || move.to === 'ready-to-merge'),
      ).toEqual([]);
    },
  );

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
    const links = {
      url: 'https://github.com/o/r/pull/7#pullrequestreview-30',
      comments: [
        { id: 'rc-1', url: 'https://github.com/o/r/pull/7#discussion_r1', threadId: 'PRRT_1' },
      ],
    };
    const changes = review(EXTERNAL, 'changes_requested', 30);
    await ctx.pr({
      ...changes,
      feedback: changes.feedback.map((entry) => ({ ...entry, ...links })),
    });
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['external_comments'] });
    const turn = await ctx.openTurn();
    expect(turn).toEqual(turnOf('dev', 'worker', 'dev: external_comments, no_submit_on_head'));
    expect(JSON.parse(turn?.handed ?? '[]')).toEqual([
      { repo: 'o/r', number: 7, kind: 'review', id: `r-${EXTERNAL}`, postedAt: at(30), ...links },
    ]);
    expect((await ctx.get()).turn?.handed).toEqual(JSON.parse(turn?.handed ?? '[]'));
  });

  it.each([
    {
      name: 'a bot approval',
      states: [['review-app', 'approved']],
      column: 'external-review',
      turn: null,
    },
    {
      name: 'a bot changes-requested review',
      states: [['review-app', 'changes_requested']],
      column: 'external-review',
      turn: null,
    },
    {
      name: 'a human approval beside a bot changes-requested review',
      states: [
        [EXTERNAL, 'approved'],
        ['review-app', 'changes_requested'],
      ],
      column: 'ready-to-merge',
      turn: turnOf('ready-to-merge', 'operator', 'ready-to-merge: not_merged'),
    },
  ] as const)(
    'bots in External Review: after $name the task is in $column',
    async ({ states, column, turn }) => {
      const ctx = await pastProductReview({ externalReview: true });
      await ctx.pr({
        reviews: states.map(([reviewer, state], index) => ({
          reviewer,
          state,
          commitSha: A,
          submittedAt: at(30 + index),
        })),
        feedback: states.map(([reviewer, state], index) => ({
          kind: 'review' as const,
          id: `r-${reviewer}`,
          author: {
            login: reviewer,
            type: reviewer === 'review-app' ? ('bot' as const) : ('user' as const),
          },
          postedAt: at(30 + index),
          state,
        })),
      });
      await ctx.tick();
      expect((await ctx.task()).column).toBe(column);
      expect(await ctx.openTurn()).toEqual(turn);
    },
  );

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

  it('a force-push in Review closes the taken conductor turn and goes to Dev at once', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.pr({ headSha: B });
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.turns())[1]).toMatchObject({
      id: 2,
      column: 'review',
      closed_reason: 'moved',
    });
    expect((await ctx.moves()).at(-1)).toMatchObject({
      from: 'review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['no_submit_on_head'],
    });
    expect(await ctx.openTurn()).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
  });

  it('red CI on a new head in Product Review closes the taken turn and goes to Dev', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    await ctx.ack(COORD, 'T3');
    await ctx.pr({
      headSha: B,
      requiredChecks: [{ name: 'ci', state: 'failure', completedAt: null }],
    });
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.turns())[2]).toMatchObject({
      id: 3,
      column: 'product-review',
      closed_reason: 'moved',
    });
    expect((await ctx.moves()).at(-1)).toMatchObject({
      from: 'product-review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['checks_red', 'no_submit_on_head'],
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: checks_red, no_submit_on_head'),
    );
  });

  it('a head back to an earlier commit needs fresh Review and Product Review marks', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    await ctx.ack(COORD, 'T3');
    await ctx.submit(COORD, 'T3', A);
    expect((await ctx.task()).column).toBe('ready-to-merge');
    await ctx.pr({ headSha: B });
    expect((await ctx.task()).column).toBe('dev');
    await ctx.pr({ headSha: A });
    const dev = await ctx.openTurn();
    expect(dev).toEqual(turnOf('dev', 'worker', 'dev: no_submit_on_head'));
    await ctx.ack(WORKER, dev?.id ?? '');

    await expect(ctx.submit(WORKER, dev?.id ?? '', A)).resolves.toMatchObject({
      task: { column: 'review' },
    });
    expect(await ctx.openTurn()).toEqual(
      expect.objectContaining({
        column: 'review',
        role: 'orchestrator:review',
        reason: 'review: no_review_on_head',
        head_sha: A,
      }),
    );
    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select(['column', 'commit_sha'])
        .where('voided_at', 'is not', null)
        .where('column', 'in', ['review', 'product-review'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { column: 'review', commit_sha: A },
      { column: 'product-review', commit_sha: A },
    ]);
  });

  it('only a new head of its own PR voids a mark', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    const task = await ctx.task();
    await ctx.store.db
      .insertInto('submission')
      .values({
        task_id: task.id,
        column: 'review',
        epoch: 0,
        commit_sha: A,
        author: REV,
        submitted_at: ctx.at(),
        note: null,
        pr_repo: 'o/r',
        pr_number: 8,
      })
      .execute();
    const voided = () =>
      ctx.store.db
        .selectFrom('submission')
        .select(['column', 'pr_number'])
        .where('voided_at', 'is not', null)
        .orderBy('id')
        .execute();
    await ctx.github();
    expect(await voided()).toEqual([]);

    await ctx.pr({ headSha: B });
    expect(await voided()).toEqual([
      { column: 'dev', pr_number: 7 },
      { column: 'review', pr_number: 7 },
    ]);
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

  /** A thread reply (a `commented` review) and a PR comment by `login`. */
  const posts = (login: string) => ({
    feedback: [
      {
        kind: 'review' as const,
        id: 'r-reply',
        author: { login, type: 'user' as const },
        postedAt: at(20),
        state: 'commented' as const,
      },
      {
        kind: 'comment' as const,
        id: 'c-reply',
        author: { login, type: 'user' as const },
        postedAt: at(21),
      },
    ],
  });

  it.each(
    [
      { author: 'agent-bot', returns: false },
      { author: EXTERNAL, returns: true },
      { author: 'operator-human', returns: true },
    ].flatMap((row) => (['submit', 'return'] as const).map((via) => ({ ...row, via }))),
  )(
    'posts by $author during a taken Review turn return to Dev at $via: $returns',
    async ({ author, returns, via }) => {
      const ctx = await inReview();
      await ctx.ack(REV, 'T2');
      await ctx.pr(posts(author));
      expect((await ctx.task()).column).toBe('review');
      expect((await ctx.turns())[1]).toMatchObject({
        id: 2,
        column: 'review',
        acked_by: REV,
        closed_at: null,
      });

      if (via === 'return') {
        await ctx.ret(REV, 'T2');
        expect((await ctx.task()).column).toBe('dev');
        expect((await ctx.moves()).at(-1)).toMatchObject({ from: 'review', to: 'dev' });
        const turn = await ctx.openTurn();
        expect(turn).toEqual(
          turnOf(
            'dev',
            'worker',
            returns ? 'dev: external_comments, no_submit_on_head' : 'dev: no_submit_on_head',
          ),
        );
        expect(JSON.parse(turn?.handed ?? '[]')).toEqual(
          returns
            ? [
                { repo: 'o/r', number: 7, kind: 'review', id: 'r-reply', postedAt: at(20) },
                { repo: 'o/r', number: 7, kind: 'comment', id: 'c-reply', postedAt: at(21) },
              ]
            : [],
        );
        expect(
          await ctx.store.db
            .selectFrom('block')
            .select(['type', 'reason', 'addressee_role', 'state'])
            .execute(),
        ).toEqual([
          {
            type: 'code',
            reason: 'Handle the empty list.',
            addressee_role: 'worker',
            state: 'open',
          },
        ]);
        return;
      }
      await ctx.submit(REV, 'T2', A);
      if (!returns) {
        expect((await ctx.task()).column).toBe('product-review');
        return;
      }
      expect((await ctx.task()).column).toBe('dev');
      expect((await ctx.moves()).at(-1)).toMatchObject({
        from: 'review',
        to: 'dev',
        reason: 'gate_broken',
        gate: ['external_comments'],
      });
    },
  );

  it("a comment by the agents' account in External Review opens no Dev turn", async () => {
    const ctx = await pastProductReview({ externalReview: true });
    await ctx.pr(posts('agent-bot'));
    await ctx.tick();
    expect((await ctx.task()).column).toBe('external-review');
    expect(await ctx.openTurn()).toBeNull();
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

describe('pending submit', () => {
  const TIMEOUT = err({ kind: 'timeout' as const, message: 'GitHub timed out' });
  const BOUND = 180_000;

  it('confirms unseen-head QA and retains it through upstream revalidation', async () => {
    const ctx = await inQa();
    ctx.pollAnswers(TIMEOUT);
    await expect(ctx.submit(COORD, 'T4', B)).resolves.toMatchObject({ status: 'pending' });
    expect(await ctx.openTurn()).toBeNull();
    await ctx.tick();
    expect((await ctx.task()).column).toBe('qa');
    expect((await ctx.why()).holds).toContain('submit_pending');
    await ctx.pr({ headSha: B });
    expect((await ctx.task()).column).toBe('dev');
    for (const actor of [WORKER, REV, COORD]) {
      const turn = await ctx.openTurn();
      await ctx.ack(actor, turn?.id ?? '');
      await ctx.submit(actor, turn?.id ?? '', B);
    }
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ctx.turns()).filter((turn) => turn.column === 'qa')).toHaveLength(1);
    expect(
      await ctx.store.db
        .selectFrom('submission')
        .select(['pending_until', 'voided_at'])
        .where('column', '=', 'qa')
        .executeTakeFirstOrThrow(),
    ).toEqual({ pending_until: null, voided_at: null });
  });

  /** The submission rows, oldest first. */
  const submissions = (ctx: Board) =>
    ctx.store.db
      .selectFrom('submission')
      .select([
        'column',
        'commit_sha',
        'submitted_at',
        'pending_until',
        'voided_at',
        'pr_repo',
        'pr_number',
      ])
      .orderBy('id')
      .execute();

  /** The worker took the Dev turn of a task with no PR, and submitted A pending. */
  async function pendingNoPr(options: Options = {}, branch: string | null = 'work-9') {
    const ctx = await started(options);
    await ctx.store.db
      .updateTable('session_snapshot')
      .set({ branch })
      .where('id', '=', 'worker-1')
      .execute();
    await ctx.ack(WORKER, 'T1');
    await expect(ctx.submit(WORKER, 'T1', A)).resolves.toMatchObject({ status: 'pending' });
    return { ctx, submittedAt: ctx.at() };
  }

  /** The worker took the Dev turn on PR #7 at A and submitted B, which no poll saw: pending. */
  async function pendingOnPr() {
    const ctx = await inDev();
    ctx.pollAnswers(TIMEOUT);
    await expect(ctx.submit(WORKER, 'T1', B)).resolves.toMatchObject({ status: 'pending' });
    return { ctx, submittedAt: ctx.at() };
  }

  it('confirms a submit when the next poll links the PR at its head', async () => {
    const { ctx, submittedAt } = await pendingNoPr();
    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toBeNull();

    await ctx.pr();

    expect((await ctx.task()).column).toBe('review');
    expect(await ctx.openTurn()).toEqual(
      turnOf('review', 'orchestrator:review', 'review: no_review_on_head'),
    );
    expect(await submissions(ctx)).toEqual([
      {
        column: 'dev',
        commit_sha: A,
        submitted_at: submittedAt,
        pending_until: null,
        voided_at: null,
        pr_repo: 'o/r',
        pr_number: 7,
      },
    ]);
    expect((await ctx.why()).holds).toEqual([]);
  });

  it('confirms on the tick when the linking poll started before the submit', async () => {
    const { ctx, submittedAt } = await pendingNoPr();

    await ctx.pr({}, true, new Date(Date.parse(submittedAt) - 1).toISOString());
    expect((await ctx.task()).column).toBe('dev');
    // A timestamp-only refresh journals no facts, so only the tick decides.
    const factsEvents = await ctx.events('pr_facts_changed');
    await ctx.pr({ updatedAt: ctx.at() });
    expect(await ctx.events('pr_facts_changed')).toEqual(factsEvents);
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.why()).holds).toEqual([]);

    await ctx.tick();

    expect((await ctx.task()).column).toBe('review');
    expect((await submissions(ctx))[0]).toMatchObject({
      submitted_at: submittedAt,
      pending_until: null,
    });
  });

  it('hands the turn back when a poll after the submit sees another head', async () => {
    const { ctx } = await pendingOnPr();
    expect(await submissions(ctx)).toMatchObject([
      { commit_sha: B, pending_until: expect.any(String) as string, voided_at: null },
    ]);

    await ctx.pr({ headSha: C });

    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: no_submit_on_head (submit of bbbbbbb: head moved to ccccccc)'),
    );
    expect((await submissions(ctx))[0]?.voided_at).toBe(ctx.at());
  });

  it('hands the turn back when a poll after the submit sees the PR closed', async () => {
    const { ctx } = await pendingOnPr();

    await ctx.pr({ state: 'closed' });

    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: pr_closed (submit of bbbbbbb: PR o/r#7 closed)'),
    );
    expect((await submissions(ctx))[0]?.voided_at).toBe(ctx.at());
  });

  // Complete polls skip a PR already seen merged or closed (#469), so its snapshot never gets
  // an observation after the submit.
  it('confirms a submit on a PR seen merged before it, which no poll reads again', async () => {
    const ctx = await inDev();
    await ctx.pr({ state: 'merged', headSha: B, mergedAt: ctx.at() });
    await ctx.repo('o/r');
    ctx.pollAnswers(TIMEOUT);
    const turn = await ctx.openTurn();
    await expect(ctx.submit(WORKER, turn?.id ?? '', B)).resolves.toMatchObject({
      status: 'pending',
    });

    // A merged PR's ticket holds the task until it is seen done.
    await ctx.ticket('closed');

    expect((await submissions(ctx))[0]).toMatchObject({
      commit_sha: B,
      pending_until: null,
      voided_at: null,
    });
  });

  /** PR #7 seen closed, then a complete poll that skips it; the worker submits B pending. */
  async function pendingOnClosedPr() {
    const ctx = await inDev();
    await ctx.pr({ state: 'closed' });
    await ctx.repo('o/r');
    ctx.pollAnswers(TIMEOUT);
    const turn = await ctx.openTurn();
    if (turn?.id !== 'T1') await ctx.ack(WORKER, turn?.id ?? '');
    await expect(ctx.submit(WORKER, turn?.id ?? '', B)).resolves.toMatchObject({
      status: 'pending',
    });
    return ctx;
  }

  it('hands the turn back on a PR seen closed before the submit only past the bound', async () => {
    const ctx = await pendingOnClosedPr();
    expect(await ctx.openTurn()).toBeNull();
    expect((await submissions(ctx))[0]).toMatchObject({
      pending_until: expect.any(String) as string,
      voided_at: null,
    });
    ctx.wait(BOUND);
    await ctx.tick();
    expect(await ctx.openTurn()).toBeNull();
    expect((await submissions(ctx))[0]?.voided_at).toBeNull();

    await ctx.repo('o/r');
    await ctx.tick();

    expect((await ctx.openTurn())?.reason).toBe(
      'dev: pr_closed (submit of bbbbbbb: PR o/r#7 closed)',
    );
    expect((await submissions(ctx))[0]?.voided_at).toBe(ctx.at());
  });

  it('confirms a submit on a PR seen closed before it when a poll sees it reopened at the head', async () => {
    const ctx = await pendingOnClosedPr();

    await ctx.pr({ state: 'open', headSha: B });

    expect((await submissions(ctx))[0]).toMatchObject({
      commit_sha: B,
      pending_until: null,
      voided_at: null,
    });
    expect(await ctx.openTurn()).not.toMatchObject({ role: 'worker' });
  });

  it('settles a submit superseded by a merge at another head with no Dev turn', async () => {
    const { ctx } = await pendingOnPr();
    const turns = (await ctx.turns()).length;

    await ctx.pr({ state: 'merged', mergedAt: ctx.at() });

    expect((await ctx.task()).column).toBe('dev');
    expect((await submissions(ctx))[0]).toMatchObject({ commit_sha: B, voided_at: ctx.at() });
    expect(await ctx.turns()).toHaveLength(turns);
    const superseded = (await ctx.history()).events.filter(
      (event) => event.kind === 'task_submitted',
    );
    expect(superseded.at(-1)).toMatchObject({
      summary: 'Submit of bbbbbbb superseded: PR merged at aaaaaaa',
    });

    await ctx.ticket('closed');

    expect((await ctx.task()).column).toBe('done');
    expect((await ctx.turns()).filter((turn) => turn.column === 'dev')).toHaveLength(turns);
    const events = (await ctx.events()).length;
    const after = (await ctx.turns()).length;
    await ctx.tick();
    await ctx.tick();
    expect((await ctx.events()).slice(events)).toEqual([]);
    expect(await ctx.turns()).toHaveLength(after);
    expect(await ctx.events('task_submitted')).toHaveLength(2);
  });

  /** The agent that takes each column's turn in `boardConfig({ qa: true })`. */
  const EXECUTOR: Partial<Record<ColumnId, ActorId>> = {
    review: REV,
    'product-review': COORD,
    qa: COORD,
    'ready-to-merge': COORD,
  };

  // A failed pending submit survives every left move until the Dev turn that hands it back opens;
  // a merge at another head supersedes it with no turn.
  it.each(
    (['review', 'product-review', 'qa', 'ready-to-merge'] as const).flatMap((column) =>
      [false, true].flatMap((blind) =>
        (['closed', 'merged'] as const).map((outcome) => ({ column, blind, outcome })),
      ),
    ),
  )('a $column submit pending when the PR is $outcome (Spur blind: $blind)', async (row) => {
    const ctx = await inDev({ qa: true });
    await ctx.submit(WORKER, 'T1', A);
    for (;;) {
      const turn = await ctx.openTurn();
      const actor = EXECUTOR[turn?.column ?? 'dev'];
      if (turn === null || actor === undefined) throw new Error('no executor turn');
      await ctx.ack(actor, turn.id);
      if (turn.column === row.column) {
        ctx.pollAnswers(TIMEOUT);
        await expect(ctx.submit(actor, turn.id, C)).resolves.toMatchObject({ status: 'pending' });
        break;
      }
      await ctx.submit(actor, turn.id, A);
    }
    const pending = async () =>
      (await submissions(ctx)).find(
        (entry) => entry.column === row.column && entry.commit_sha === C,
      );
    const devTurns = async () => (await ctx.turns()).filter((turn) => turn.column === 'dev');
    const before = (await devTurns()).length;
    if (row.blind) await ctx.blind('spur', true);

    if (row.outcome === 'closed') {
      await ctx.pr({ state: 'closed' });
      expect((await ctx.task()).column).toBe('dev');
      if (row.blind) {
        expect(await ctx.openTurn()).toBeNull();
        expect((await pending())?.voided_at).toBeNull();
        await ctx.blind('spur', false);
        await ctx.spur();
        await ctx.tick();
      }
      expect(await ctx.openTurn()).toEqual(
        turnOf('dev', 'worker', 'dev: pr_closed (submit of ccccccc: PR o/r#7 closed)'),
      );
      expect((await pending())?.voided_at).not.toBeNull();
      expect(await devTurns()).toHaveLength(before + 1);
    } else {
      // The ticket is already done, so the merge takes the task to Done in the same pass.
      await ctx.ticket('closed');
      await ctx.pr({ state: 'merged', mergedAt: ctx.at() });
      expect((await ctx.task()).column).toBe('done');
      expect((await pending())?.voided_at).not.toBeNull();
      expect(
        (await ctx.history()).events.filter((event) => event.kind === 'task_submitted').at(-1),
      ).toMatchObject({ summary: 'Submit of ccccccc superseded: PR merged at aaaaaaa' });
      if (row.blind) {
        await ctx.blind('spur', false);
        await ctx.spur();
        await ctx.tick();
      }
      expect(await devTurns()).toHaveLength(before);
    }

    const events = (await ctx.events()).length;
    const turns = (await ctx.turns()).length;
    await ctx.tick();
    await ctx.spur();
    await ctx.tick();
    expect((await ctx.events()).slice(events)).toEqual([]);
    expect(await ctx.turns()).toHaveLength(turns);
  });

  it('holds a pending submit while the clock alone passes the bound', async () => {
    const { ctx } = await pendingNoPr();
    ctx.wait(BOUND + 1);

    await ctx.tick();

    expect(await ctx.openTurn()).toBeNull();
    expect(await submissions(ctx)).toMatchObject([
      { pending_until: expect.any(String) as string, voided_at: null },
    ]);
    const why = await ctx.why();
    expect(why.holds).toEqual(['submit_pending']);
    expect(why.pendingSubmit?.text).toBe('submit pending confirmation of aaaaaaa');

    // A complete poll that started after the bound and still finds no PR fails it on the tick.
    await ctx.github();
    expect(await ctx.openTurn()).toBeNull();
    await ctx.tick();

    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: no_pr (submit of aaaaaaa: no PR found for work-9)'),
    );
    expect((await submissions(ctx))[0]?.voided_at).toBe(ctx.at());
    expect(await ctx.why()).not.toHaveProperty('pendingSubmit');
  });

  it('names no branch when the author session has none', async () => {
    const { ctx } = await pendingNoPr({}, null);
    ctx.wait(BOUND);
    await ctx.github();
    await ctx.tick();

    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: no_pr (submit of aaaaaaa: no PR found)'),
    );
  });

  it('decides nothing before the bound', async () => {
    const { ctx, submittedAt } = await pendingNoPr();
    ctx.wait(BOUND - 120_000 - 1);
    await ctx.github();
    await ctx.tick();

    expect(ctx.at()).toBe(new Date(Date.parse(submittedAt) + BOUND - 1).toISOString());
    expect(await ctx.openTurn()).toBeNull();
    expect((await submissions(ctx))[0]?.voided_at).toBeNull();
  });

  it('keeps a submit on a linked PR no poll observed pending past the bound', async () => {
    const { ctx } = await pendingOnPr();
    await ctx.store.db.deleteFrom('pr_snapshot').execute();
    await ctx.store.db
      .insertInto('pr_snapshot')
      .values({
        repo: 'o/r',
        number: 7,
        head_sha: A,
        head_branch: 'o/r#9-work',
        state: 'open',
        draft: 0,
        mergeable: 'mergeable',
        merge_state: 'clean',
        detail: JSON.stringify(prFacts()),
        source: GITHUB,
        observed_at: '2026-11-04T08:00:00.000Z',
      })
      .execute();
    ctx.wait(BOUND);
    await ctx.repo('o/r');
    await ctx.tick();
    await ctx.tick();

    expect(await ctx.openTurn()).toBeNull();
    expect((await submissions(ctx))[0]).toMatchObject({
      voided_at: null,
      pending_until: expect.any(String) as string,
    });
    expect((await ctx.why()).holds).toEqual(['submit_pending']);
  });

  it('expiry while GitHub is blind decides nothing', async () => {
    const { ctx } = await pendingNoPr();
    await ctx.blind(GITHUB, true);
    ctx.wait(BOUND);
    const before = await ctx.snapshot();

    await ctx.tick();

    expect(await ctx.snapshot()).toEqual(before);
    expect(await ctx.openTurn()).toBeNull();
    expect((await ctx.why()).holds).toEqual(['github_blind', 'submit_pending']);

    await ctx.blind(GITHUB, false);
    await ctx.github();
    await ctx.tick();

    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: no_pr (submit of aaaaaaa: no PR found for work-9)'),
    );
  });

  it('failure under a cycle hold waits for the hold', async () => {
    const { ctx } = await pendingNoPr();
    const task = await ctx.task();
    await ctx.store.db
      .insertInto('operator_item')
      .values({
        item_key: `cycle-limit:${String(task.id)}:dev`,
        raise_no: 1,
        kind: 'cycle_limit',
        text: 'Cycle limit',
        url: 'https://example.invalid/item',
        task_id: task.id,
        block_id: null,
        raised_at: ctx.at(),
        cleared_at: null,
        line_outbox_id: null,
        inbound_event_json: null,
      })
      .execute();
    ctx.wait(BOUND);
    await ctx.github();
    await ctx.tick();

    expect(await ctx.openTurn()).toBeNull();
    expect((await submissions(ctx))[0]?.voided_at).toBeNull();

    await ctx.store.db.updateTable('operator_item').set({ cleared_at: ctx.at() }).execute();
    await ctx.tick();

    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: no_pr (submit of aaaaaaa: no PR found for work-9)'),
    );
    expect((await submissions(ctx))[0]?.voided_at).toBe(ctx.at());
  });

  it('a failed Review submit is voided by id', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    ctx.pollAnswers(TIMEOUT);
    await expect(ctx.submit(REV, 'T2', C)).resolves.toMatchObject({ status: 'pending' });

    await ctx.github();
    await ctx.tick();

    expect(await ctx.openTurn()).toEqual(
      turnOf(
        'review',
        'orchestrator:review',
        'review: no_review_on_head (submit of ccccccc: head moved to aaaaaaa)',
      ),
    );
    const failed = (await submissions(ctx)).find((row) => row.column === 'review');
    // Voided in the pass that opened the turn, though `voids: review` skips the mark column.
    expect(failed?.voided_at).toBe((await ctx.turns()).at(-1)?.created_at);

    const events = (await ctx.events()).length;
    await ctx.tick();
    await ctx.tick();
    expect(await ctx.events()).toHaveLength(events);

    await ctx.pr({ headSha: C });
    await ctx.tick();

    expect((await submissions(ctx)).find((row) => row.column === 'review')).toEqual(failed);
    expect(
      (await ctx.moves()).filter((move) => move.from === 'review' && move.reason === 'gate_passed'),
    ).toEqual([]);
  });

  it('a Review submit failed by a closed PR moves to Dev with the reason on the worker turn', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    ctx.pollAnswers(TIMEOUT);
    await expect(ctx.submit(REV, 'T2', C)).resolves.toMatchObject({ status: 'pending' });

    await ctx.pr({ state: 'closed' });

    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: pr_closed (submit of ccccccc: PR o/r#7 closed)'),
    );
    expect((await submissions(ctx)).find((row) => row.column === 'review')?.voided_at).toBe(
      ctx.at(),
    );

    const turns = (await ctx.turns()).length;
    const events = (await ctx.events()).length;
    await ctx.tick();
    await ctx.github();
    await ctx.tick();
    expect(await ctx.turns()).toHaveLength(turns);
    expect(await ctx.events()).toHaveLength(events);
  });

  it('a Review submit failed by a moved head that breaks the Dev gate names it on the worker turn', async () => {
    const ctx = await inReview();
    await ctx.ack(REV, 'T2');
    ctx.pollAnswers(TIMEOUT);
    await expect(ctx.submit(REV, 'T2', C)).resolves.toMatchObject({ status: 'pending' });

    await ctx.pr({ headSha: B, mergeable: 'conflicting' });

    expect((await ctx.task()).column).toBe('dev');
    expect(await ctx.openTurn()).toEqual(
      turnOf(
        'dev',
        'worker',
        'dev: conflict, no_submit_on_head (submit of ccccccc: head moved to bbbbbbb)',
      ),
    );
    expect((await submissions(ctx)).find((row) => row.column === 'review')?.voided_at).toBe(
      ctx.at(),
    );
  });
});

describe('edited feedback', () => {
  const URL_1 = 'https://github.com/o/r/pull/7#issuecomment-1';
  const comment = (editedAt?: string) => ({
    kind: 'comment' as const,
    id: 'c-1',
    author: { login: EXTERNAL, type: 'user' as const },
    postedAt: at(1),
    url: URL_1,
    ...(editedAt === undefined ? {} : { editedAt }),
  });
  const handed = (editedAt?: string) => ({
    repo: 'o/r',
    number: 7,
    kind: 'comment',
    id: 'c-1',
    postedAt: at(1),
    url: URL_1,
    ...(editedAt === undefined ? {} : { editedAt }),
  });
  /** What each turn that handed anything handed, oldest first. */
  const handedSoFar = async (ctx: Board) =>
    (await ctx.turns())
      .map((turn) => JSON.parse(turn.handed) as unknown[])
      .filter((entries) => entries.length > 0);
  /** The worker's submit of T1 left `entry` unhandled: Dev turn T2 handed it and was taken. */
  async function handedInDev(entry = comment()) {
    const ctx = await inDev();
    await ctx.pr({ feedback: [entry] });
    await ctx.submit(WORKER, 'T1', A);
    expect(await ctx.openTurn()).toMatchObject({ id: 'T2', column: 'dev' });
    await ctx.ack(WORKER, 'T2');
    return ctx;
  }
  /** The worker submits the taken Dev turn `turn` and takes the Dev turn it leaves, if any. */
  async function submitDev(ctx: Board, turn: string) {
    await ctx.submit(WORKER, turn, A);
    const next = await ctx.openTurn();
    if (next?.column === 'dev') await ctx.ack(WORKER, next.id);
    return next;
  }

  it('hands a comment edited after its hand once more, and again after a second edit', async () => {
    const ctx = await handedInDev();
    const first = ctx.at();
    await ctx.pr({ feedback: [comment(first)] });
    const t3 = await submitDev(ctx, 'T2');
    expect(t3).toMatchObject({ id: 'T3', column: 'dev' });
    expect(JSON.parse(t3?.handed ?? '[]')).toEqual([handed(first)]);

    const second = ctx.at();
    await ctx.pr({ feedback: [comment(second)] });
    const t4 = await submitDev(ctx, 'T3');
    expect(t4).toMatchObject({ id: 'T4', column: 'dev' });
    expect(JSON.parse(t4?.handed ?? '[]')).toEqual([handed(second)]);

    expect(await submitDev(ctx, 'T4')).toMatchObject({ column: 'review' });
    expect(await handedSoFar(ctx)).toEqual([[handed()], [handed(first)], [handed(second)]]);
  });

  it('hands a comment edited before any hand once, with its edit', async () => {
    const ctx = await handedInDev(comment(at(2)));
    expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handed(at(2))]);

    expect(await submitDev(ctx, 'T2')).toMatchObject({ column: 'review' });
    expect(await handedSoFar(ctx)).toEqual([[handed(at(2))]]);
  });

  it('counts edits of an entry handed without url or edit only after its turn opened', async () => {
    const ctx = await handedInDev();
    // As a turn handed it before entries carried a url.
    const legacy = { repo: 'o/r', number: 7, kind: 'comment', id: 'c-1', postedAt: at(1) };
    await ctx.store.db
      .updateTable('turn')
      .set({ handed: JSON.stringify([legacy]) })
      .where('id', '=', 2)
      .execute();
    const opened = (await ctx.turns())[1]?.created_at ?? '';

    await ctx.pr({ feedback: [comment(opened)] });
    expect(await submitDev(ctx, 'T2')).toMatchObject({ id: 'T3', column: 'review' });

    const later = ctx.at();
    await ctx.pr({ feedback: [comment(later)] });
    expect((await ctx.task()).column).toBe('dev');
    expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handed(later)]);
    expect(await handedSoFar(ctx)).toEqual([[legacy], [handed(later)]]);
  });

  it('returns the task to Dev when a handed comment is edited in Review', async () => {
    const ctx = await handedInDev();
    expect(await submitDev(ctx, 'T2')).toMatchObject({ id: 'T3', column: 'review' });
    const moves = await ctx.moves();

    const edited = ctx.at();
    await ctx.pr({ feedback: [comment(edited)] });

    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).slice(moves.length)).toEqual([
      expect.objectContaining({ from: 'review', to: 'dev', gate: ['external_comments'] }),
    ]);
    expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handed(edited)]);
  });

  it('hands an entry handed with url once more for an edit dated before its turn opened', async () => {
    const ctx = await handedInDev();
    const opened = (await ctx.turns())[1]?.created_at ?? '';
    expect(Date.parse(at(2))).toBeLessThan(Date.parse(opened));

    await ctx.pr({ feedback: [comment(at(2))] });
    const t3 = await submitDev(ctx, 'T2');
    expect(t3).toMatchObject({ id: 'T3', column: 'dev' });
    expect(JSON.parse(t3?.handed ?? '[]')).toEqual([handed(at(2))]);

    expect(await submitDev(ctx, 'T3')).toMatchObject({ column: 'review' });
    expect(await handedSoFar(ctx)).toEqual([[handed()], [handed(at(2))]]);
  });

  it('hands the edited copy in the turn a reroute opens, and nothing more after it', async () => {
    const ctx = await started({}, 'none');
    await ctx.pr({ feedback: [comment()] });
    expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handed()]);
    const edited = ctx.at();
    await ctx.pr({ feedback: [comment(edited)] });
    expect(await ctx.openTurn()).toMatchObject({ id: 'T1', role: 'operator' });

    await ctx.spur('live');

    expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: 'rerouted' });
    const t2 = await ctx.openTurn();
    expect(t2).toMatchObject({ id: 'T2', column: 'dev', role: 'worker' });
    expect(JSON.parse(t2?.handed ?? '[]')).toEqual([handed(edited)]);
    await ctx.ack(WORKER, 'T2');
    expect(await submitDev(ctx, 'T2')).toMatchObject({ column: 'review' });
    expect(await handedSoFar(ctx)).toEqual([[handed()], [handed(edited)]]);
  });

  it('recalls the newest edit an untaken turn handed, once, after a correction', async () => {
    const ctx = await started({}, 'none');
    await ctx.pr({ feedback: [comment()] });
    const edited = ctx.at();
    await ctx.pr({ feedback: [comment(edited)] });
    await ctx.spur('live');
    expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handed(edited)]);
    // A poll dropped c-1 from the snapshot: only the closed untaken turns T1 and T2 recall it.
    await ctx.pr({ feedback: [] });

    await ctx.move('dev');

    expect((await ctx.turns()).map((turn) => turn.closed_reason)).toEqual([
      'rerouted',
      'corrected',
      null,
    ]);
    const t3 = await ctx.openTurn();
    expect(t3).toMatchObject({ id: 'T3', column: 'dev', role: 'worker' });
    expect(JSON.parse(t3?.handed ?? '[]')).toEqual([handed(edited)]);
    await ctx.ack(WORKER, 'T3');
    expect(await submitDev(ctx, 'T3')).toMatchObject({ column: 'review' });
    expect(await handedSoFar(ctx)).toEqual([[handed()], [handed(edited)], [handed(edited)]]);
  });
});

describe('reviewer-service status comments', () => {
  const comment = (statusComment?: true) => ({
    kind: 'comment' as const,
    id: 'c-1',
    author: { login: EXTERNAL, type: 'user' as const },
    postedAt: at(1),
    ...(statusComment === undefined ? {} : { statusComment }),
  });

  it.each([
    { statusComment: true as const, returns: false },
    { statusComment: undefined, returns: true },
  ])(
    'a comment with statusComment $statusComment during a taken Review turn returns the task: $returns',
    async ({ statusComment, returns }) => {
      const ctx = await inReview();
      await ctx.ack(REV, 'T2');
      await ctx.pr({ feedback: [comment(statusComment)] });

      await ctx.submit(REV, 'T2', A);

      if (returns) {
        expect((await ctx.task()).column).toBe('dev');
        expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['external_comments'] });
      } else {
        expect((await ctx.task()).column).toBe('product-review');
      }
    },
  );

  it('a status comment in External Review opens no Dev turn', async () => {
    const ctx = await pastProductReview({ externalReview: true });
    const outbox = async () =>
      (await ctx.store.db.selectFrom('outbox').select('id').orderBy('id').execute()).map(
        (row) => row.id,
      );
    const moves = await ctx.moves();
    const queued = await outbox();

    await ctx.pr({ feedback: [{ ...comment(true), postedAt: ctx.at() }] });
    await ctx.tick();

    expect((await ctx.task()).column).toBe('external-review');
    expect(await ctx.openTurn()).toBeNull();
    expect(await ctx.moves()).toEqual(moves);
    expect(await outbox()).toEqual(queued);
  });

  const handedC1 = { repo: 'o/r', number: 7, kind: 'comment', id: 'c-1', postedAt: at(1) };

  // Every path that hands earlier handed feedback over again: T1 handed c-1 before the snapshot
  // flagged it, then the path opens the next turn.
  it.each([
    {
      path: 'a recall after a correction',
      closed: 'corrected',
      next: { id: 'T2', column: 'dev', role: 'operator', reason: 'dev: no_submit_on_head' },
      run: async () => {
        const ctx = await started({}, 'none');
        await ctx.pr({ feedback: [comment()] });
        expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handedC1]);
        await ctx.pr({ feedback: [comment(true)] });
        await ctx.move('dev');
        return ctx;
      },
    },
    {
      // A reroute keeps T1's reason, so the row does not assert it.
      path: 'the carry of a reroute to a live worker',
      closed: 'rerouted',
      next: { id: 'T2', role: 'worker' },
      run: async () => {
        const ctx = await started({}, 'none');
        await ctx.pr({ feedback: [comment()] });
        expect(JSON.parse((await ctx.openTurn())?.handed ?? '[]')).toEqual([handedC1]);
        await ctx.pr({ feedback: [comment(true)] });
        expect(await ctx.openTurn()).toMatchObject({ id: 'T1', role: 'operator' });
        await ctx.spur('live');
        return ctx;
      },
    },
    {
      path: 'the reroute of a demoted worker turn',
      closed: 'rerouted',
      next: { id: 'T2', role: 'operator' },
      run: async () => {
        const ctx = await inDev({ workerRole: 'worker' });
        await ctx.store.transaction((trx) =>
          trx
            .updateTable('turn')
            .set({ handed: JSON.stringify([handedC1]) })
            .where('id', '=', 1)
            .execute(),
        );
        await ctx.pr({ feedback: [comment(true)] });
        ctx.restart({ workerRole: 'orchestrator' });
        await ctx.spur();
        return ctx;
      },
    },
  ])(
    '$path does not hand over a comment the snapshot now flags as a status comment',
    async ({ run, closed, next }) => {
      const ctx = await run();

      expect((await ctx.turns())[0]).toMatchObject({ id: 1, closed_reason: closed });
      const turn = await ctx.openTurn();
      expect(turn).toMatchObject(next);
      expect(JSON.parse(turn?.handed ?? '[]')).toEqual([]);
    },
  );
});

// Captured from pinned main 92a7d7b0; full ordered rows, no field normalization.
const expectedCompatibility = JSON.parse(String.raw`{
"effective": {
"checkpoints": [{"column": "dev", "reason": "dev: external_comments"}, {"column": "ready-to-merge", "reason": "ready-to-merge: not_merged"}, {"column": "dev", "reason": "dev: external_comments, no_submit_on_head"}, {"column": "ready-to-merge", "reason": "ready-to-merge: not_merged"}],
"journal": [
{"id": 1, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "task_added", "actor": "system", "actor_ref": null, "payload": {"column": "todo"}, "v": 1, "request_id": null, "via": null},
{"id": 2, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "ticket_status_changed", "actor": "system", "actor_ref": null, "payload": {"from": null, "to": "open"}, "v": 1, "request_id": null, "via": null},
{"id": 3, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "ticket_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"trackerId": "github-issues:proj:o/r", "id": "node-9", "key": "o/r#9", "title": "A ticket", "status": "open", "assignee": null, "sprint": null, "labels": ["board"], "inFilter": true, "url": "https://github.com/o/r/issues/9", "updatedAt": "2026-11-04T08:00:00.000Z"}}, "v": 1, "request_id": null, "via": null},
{"id": 4, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "link_added", "actor": "system", "actor_ref": null, "payload": {"entity": "session", "session": "worker-1", "role": "worker", "source": "spawn_link", "facts": {"id": "worker-1", "spurProject": "worker", "branch": null, "pr": null, "links": {"board-worker": "https://github.com/o/r/issues/9"}, "lifecycle": "running", "health": "working", "healthSince": "2026-11-04T08:00:00.000Z", "lastActivityAt": null, "endedAt": null, "endReason": null}}, "v": 1, "request_id": null, "via": null},
{"id": 5, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "session_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"id": "worker-1", "spurProject": "worker", "branch": null, "pr": null, "links": {"board-worker": "https://github.com/o/r/issues/9"}, "lifecycle": "running", "health": "working", "healthSince": "2026-11-04T08:00:00.000Z", "lastActivityAt": null, "endedAt": null, "endReason": null}}, "v": 1, "request_id": null, "via": null},
{"id": 6, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "todo", "to": "dev", "reason": "gate_passed"}, "v": 1, "request_id": null, "via": null},
{"id": 7, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T1", "column": "dev", "addressee": "worker", "reason": "dev: no_pr"}, "v": 1, "request_id": null, "via": null},
{"id": 8, "at": "2026-11-04T08:04:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N1"}, "v": 1, "request_id": "key-1", "via": null},
{"id": 9, "at": "2026-11-04T08:04:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T1", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-1", "via": null},
{"id": 10, "at": "2026-11-04T08:05:00.000Z", "project": "proj", "task_id": 1, "kind": "link_added", "actor": "system", "actor_ref": null, "payload": {"entity": "pr", "repo": "o/r", "pr": 7, "state": "active", "source": "branch", "facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 11, "at": "2026-11-04T08:05:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 12, "at": "2026-11-04T08:06:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 13, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T1", "outcome": "submitted"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 14, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T1", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 15, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T2", "column": "dev", "addressee": "worker", "reason": "dev: external_comments"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 16, "at": "2026-11-04T08:08:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N2"}, "v": 1, "request_id": "key-3", "via": null},
{"id": 17, "at": "2026-11-04T08:08:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T2", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-3", "via": null},
{"id": 18, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T2", "outcome": "submitted"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 19, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T2", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 20, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "dev", "to": "review", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 21, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T3", "column": "review", "addressee": "orchestrator:review", "reason": "review: no_review_on_head"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 22, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N3"}, "v": 1, "request_id": "key-5", "via": null},
{"id": 23, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"rev\",\"session\":\"rev-1\"}", "payload": {"turn": "T3", "taker": "agent:rev/rev-1"}, "v": 1, "request_id": "key-5", "via": null},
{"id": 24, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T3", "outcome": "submitted"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 25, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"rev\",\"session\":\"rev-1\"}", "payload": {"basis": "tested", "turn": "T3", "column": "review", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 26, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "review", "to": "product-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 27, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T4", "column": "product-review", "addressee": "orchestrator:product-review", "reason": "product-review: no_review_on_head"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 28, "at": "2026-11-04T08:12:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N4"}, "v": 1, "request_id": "key-7", "via": null},
{"id": 29, "at": "2026-11-04T08:12:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"coord\",\"session\":\"coord-1\"}", "payload": {"turn": "T4", "taker": "agent:coord/coord-1"}, "v": 1, "request_id": "key-7", "via": null},
{"id": 30, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T4", "outcome": "submitted"}, "v": 1, "request_id": "key-8", "via": null},
{"id": 31, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"coord\",\"session\":\"coord-1\"}", "payload": {"basis": "tested", "turn": "T4", "column": "product-review", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-8", "via": null},
{"id": 32, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "product-review", "to": "external-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-8", "via": null},
{"id": 33, "at": "2026-11-04T08:14:00.000Z", "project": "proj", "task_id": 1, "kind": "review_submitted", "actor": "system", "actor_ref": null, "payload": {"repo": "o/r", "pr": 7, "reviewer": "reviewer", "state": "approved"}, "v": 1, "request_id": null, "via": null},
{"id": 34, "at": "2026-11-04T08:14:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [{"reviewer": "reviewer", "state": "approved", "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-11-04T08:13:00.000Z"}], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 35, "at": "2026-11-04T08:14:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "external-review", "to": "ready-to-merge", "reason": "gate_passed"}, "v": 1, "request_id": null, "via": null},
{"id": 36, "at": "2026-11-04T08:14:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T5", "column": "ready-to-merge", "addressee": "orchestrator:ready-to-merge", "reason": "ready-to-merge: not_merged"}, "v": 1, "request_id": null, "via": null},
{"id": 37, "at": "2026-11-04T08:15:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [{"reviewer": "reviewer", "state": "approved", "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-11-04T08:13:00.000Z"}], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}, {"kind": "comment", "id": "compat-return", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:14:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 38, "at": "2026-11-04T08:15:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T5", "outcome": "moved"}, "v": 1, "request_id": null, "via": null},
{"id": 39, "at": "2026-11-04T08:15:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "ready-to-merge", "to": "dev", "reason": "gate_broken", "gate": ["external_comments"]}, "v": 1, "request_id": null, "via": null},
{"id": 40, "at": "2026-11-04T08:15:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T6", "column": "dev", "addressee": "worker", "reason": "dev: external_comments, no_submit_on_head"}, "v": 1, "request_id": null, "via": null},
{"id": 41, "at": "2026-11-04T08:16:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N6"}, "v": 1, "request_id": "key-9", "via": null},
{"id": 42, "at": "2026-11-04T08:16:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T6", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-9", "via": null},
{"id": 43, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T6", "outcome": "submitted"}, "v": 1, "request_id": "key-10", "via": null},
{"id": 44, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T6", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-10", "via": null},
{"id": 45, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "dev", "to": "review", "reason": "gate_passed"}, "v": 1, "request_id": "key-10", "via": null},
{"id": 46, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "review", "to": "product-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-10", "via": null},
{"id": 47, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "product-review", "to": "external-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-10", "via": null},
{"id": 48, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "external-review", "to": "ready-to-merge", "reason": "gate_passed"}, "v": 1, "request_id": "key-10", "via": null},
{"id": 49, "at": "2026-11-04T08:17:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T7", "column": "ready-to-merge", "addressee": "orchestrator:ready-to-merge", "reason": "ready-to-merge: not_merged"}, "v": 1, "request_id": "key-10", "via": null}
]
},
"default": {
"checkpoints": [{"column": "dev", "reason": "dev: external_comments"}, {"column": "ready-to-merge", "reason": "ready-to-merge: not_merged"}, {"column": "dev", "reason": "dev: external_comments, no_submit_on_head"}, {"column": "ready-to-merge", "reason": "ready-to-merge: not_merged"}],
"journal": [
{"id": 1, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "task_added", "actor": "system", "actor_ref": null, "payload": {"column": "todo"}, "v": 1, "request_id": null, "via": null},
{"id": 2, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "ticket_status_changed", "actor": "system", "actor_ref": null, "payload": {"from": null, "to": "open"}, "v": 1, "request_id": null, "via": null},
{"id": 3, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "ticket_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"trackerId": "github-issues:proj:o/r", "id": "node-9", "key": "o/r#9", "title": "A ticket", "status": "open", "assignee": null, "sprint": null, "labels": ["board"], "inFilter": true, "url": "https://github.com/o/r/issues/9", "updatedAt": "2026-11-04T08:00:00.000Z"}}, "v": 1, "request_id": null, "via": null},
{"id": 4, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "link_added", "actor": "system", "actor_ref": null, "payload": {"entity": "session", "session": "worker-1", "role": "worker", "source": "spawn_link", "facts": {"id": "worker-1", "spurProject": "worker", "branch": null, "pr": null, "links": {"board-worker": "https://github.com/o/r/issues/9"}, "lifecycle": "running", "health": "working", "healthSince": "2026-11-04T08:00:00.000Z", "lastActivityAt": null, "endedAt": null, "endReason": null}}, "v": 1, "request_id": null, "via": null},
{"id": 5, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "session_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"id": "worker-1", "spurProject": "worker", "branch": null, "pr": null, "links": {"board-worker": "https://github.com/o/r/issues/9"}, "lifecycle": "running", "health": "working", "healthSince": "2026-11-04T08:00:00.000Z", "lastActivityAt": null, "endedAt": null, "endReason": null}}, "v": 1, "request_id": null, "via": null},
{"id": 6, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "todo", "to": "dev", "reason": "gate_passed"}, "v": 1, "request_id": null, "via": null},
{"id": 7, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T1", "column": "dev", "addressee": "worker", "reason": "dev: no_pr"}, "v": 1, "request_id": null, "via": null},
{"id": 8, "at": "2026-11-04T08:04:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N1"}, "v": 1, "request_id": "key-1", "via": null},
{"id": 9, "at": "2026-11-04T08:04:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T1", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-1", "via": null},
{"id": 10, "at": "2026-11-04T08:05:00.000Z", "project": "proj", "task_id": 1, "kind": "link_added", "actor": "system", "actor_ref": null, "payload": {"entity": "pr", "repo": "o/r", "pr": 7, "state": "active", "source": "branch", "facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 11, "at": "2026-11-04T08:05:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 12, "at": "2026-11-04T08:06:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 13, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T1", "outcome": "submitted"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 14, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T1", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 15, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T2", "column": "dev", "addressee": "worker", "reason": "dev: external_comments"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 16, "at": "2026-11-04T08:08:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N2"}, "v": 1, "request_id": "key-3", "via": null},
{"id": 17, "at": "2026-11-04T08:08:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T2", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-3", "via": null},
{"id": 18, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T2", "outcome": "submitted"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 19, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T2", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 20, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "dev", "to": "review", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 21, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "review", "to": "product-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 22, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "product-review", "to": "external-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 23, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "review_submitted", "actor": "system", "actor_ref": null, "payload": {"repo": "o/r", "pr": 7, "reviewer": "reviewer", "state": "approved"}, "v": 1, "request_id": null, "via": null},
{"id": 24, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [{"reviewer": "reviewer", "state": "approved", "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-11-04T08:09:00.000Z"}], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 25, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "external-review", "to": "qa", "reason": "gate_passed"}, "v": 1, "request_id": null, "via": null},
{"id": 26, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "qa", "to": "ready-to-merge", "reason": "gate_passed"}, "v": 1, "request_id": null, "via": null},
{"id": 27, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T3", "column": "ready-to-merge", "addressee": "worker", "reason": "ready-to-merge: not_merged"}, "v": 1, "request_id": null, "via": null},
{"id": 28, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [{"reviewer": "reviewer", "state": "approved", "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-11-04T08:09:00.000Z"}], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}, {"kind": "comment", "id": "compat-return", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:10:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 29, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T3", "outcome": "moved"}, "v": 1, "request_id": null, "via": null},
{"id": 30, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "ready-to-merge", "to": "dev", "reason": "gate_broken", "gate": ["external_comments"]}, "v": 1, "request_id": null, "via": null},
{"id": 31, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T4", "column": "dev", "addressee": "worker", "reason": "dev: external_comments, no_submit_on_head"}, "v": 1, "request_id": null, "via": null},
{"id": 32, "at": "2026-11-04T08:12:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N4"}, "v": 1, "request_id": "key-5", "via": null},
{"id": 33, "at": "2026-11-04T08:12:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T4", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-5", "via": null},
{"id": 34, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T4", "outcome": "submitted"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 35, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T4", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 36, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "dev", "to": "review", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 37, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "review", "to": "product-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 38, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "product-review", "to": "external-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 39, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "external-review", "to": "qa", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 40, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "qa", "to": "ready-to-merge", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 41, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T5", "column": "ready-to-merge", "addressee": "worker", "reason": "ready-to-merge: not_merged"}, "v": 1, "request_id": "key-6", "via": null}
]
},
"simple": {
"checkpoints": [{"column": "dev", "reason": "dev: external_comments"}, {"column": "ready-to-merge", "reason": "ready-to-merge: not_merged"}, {"column": "dev", "reason": "dev: external_comments, no_submit_on_head"}, {"column": "ready-to-merge", "reason": "ready-to-merge: not_merged"}],
"journal": [
{"id": 1, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "task_added", "actor": "system", "actor_ref": null, "payload": {"column": "todo"}, "v": 1, "request_id": null, "via": null},
{"id": 2, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "ticket_status_changed", "actor": "system", "actor_ref": null, "payload": {"from": null, "to": "open"}, "v": 1, "request_id": null, "via": null},
{"id": 3, "at": "2026-11-04T08:01:00.000Z", "project": "proj", "task_id": 1, "kind": "ticket_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"trackerId": "github-issues:proj:o/r", "id": "node-9", "key": "o/r#9", "title": "A ticket", "status": "open", "assignee": null, "sprint": null, "labels": ["board"], "inFilter": true, "url": "https://github.com/o/r/issues/9", "updatedAt": "2026-11-04T08:00:00.000Z"}}, "v": 1, "request_id": null, "via": null},
{"id": 4, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "link_added", "actor": "system", "actor_ref": null, "payload": {"entity": "session", "session": "worker-1", "role": "worker", "source": "spawn_link", "facts": {"id": "worker-1", "spurProject": "worker", "branch": null, "pr": null, "links": {"board-worker": "https://github.com/o/r/issues/9"}, "lifecycle": "running", "health": "working", "healthSince": "2026-11-04T08:00:00.000Z", "lastActivityAt": null, "endedAt": null, "endReason": null}}, "v": 1, "request_id": null, "via": null},
{"id": 5, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "session_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"id": "worker-1", "spurProject": "worker", "branch": null, "pr": null, "links": {"board-worker": "https://github.com/o/r/issues/9"}, "lifecycle": "running", "health": "working", "healthSince": "2026-11-04T08:00:00.000Z", "lastActivityAt": null, "endedAt": null, "endReason": null}}, "v": 1, "request_id": null, "via": null},
{"id": 6, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "todo", "to": "dev", "reason": "gate_passed"}, "v": 1, "request_id": null, "via": null},
{"id": 7, "at": "2026-11-04T08:03:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T1", "column": "dev", "addressee": "worker", "reason": "dev: no_pr"}, "v": 1, "request_id": null, "via": null},
{"id": 8, "at": "2026-11-04T08:04:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N1"}, "v": 1, "request_id": "key-1", "via": null},
{"id": 9, "at": "2026-11-04T08:04:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T1", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-1", "via": null},
{"id": 10, "at": "2026-11-04T08:05:00.000Z", "project": "proj", "task_id": 1, "kind": "link_added", "actor": "system", "actor_ref": null, "payload": {"entity": "pr", "repo": "o/r", "pr": 7, "state": "active", "source": "branch", "facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 11, "at": "2026-11-04T08:05:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 12, "at": "2026-11-04T08:06:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 13, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T1", "outcome": "submitted"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 14, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T1", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 15, "at": "2026-11-04T08:07:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T2", "column": "dev", "addressee": "worker", "reason": "dev: external_comments"}, "v": 1, "request_id": "key-2", "via": null},
{"id": 16, "at": "2026-11-04T08:08:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N2"}, "v": 1, "request_id": "key-3", "via": null},
{"id": 17, "at": "2026-11-04T08:08:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T2", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-3", "via": null},
{"id": 18, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T2", "outcome": "submitted"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 19, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T2", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 20, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "dev", "to": "review", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 21, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "review", "to": "product-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 22, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "product-review", "to": "ready-to-merge", "reason": "gate_passed"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 23, "at": "2026-11-04T08:09:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T3", "column": "ready-to-merge", "addressee": "worker", "reason": "ready-to-merge: not_merged"}, "v": 1, "request_id": "key-4", "via": null},
{"id": 24, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "review_submitted", "actor": "system", "actor_ref": null, "payload": {"repo": "o/r", "pr": 7, "reviewer": "reviewer", "state": "approved"}, "v": 1, "request_id": null, "via": null},
{"id": 25, "at": "2026-11-04T08:10:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [{"reviewer": "reviewer", "state": "approved", "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-11-04T08:09:00.000Z"}], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 26, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "pr_facts_changed", "actor": "system", "actor_ref": null, "payload": {"facts": {"repo": "o/r", "number": 7, "url": "https://github.com/o/r/pull/7", "title": "o/r#9 work", "author": "agent-bot", "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "headBranch": "o/r#9-work", "state": "open", "draft": false, "mergeable": "mergeable", "mergeState": "clean", "requiredChecks": [{"name": "ci", "state": "success", "completedAt": "2026-11-04T08:00:00.000Z"}], "checks": [], "reviews": [{"reviewer": "reviewer", "state": "approved", "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-11-04T08:09:00.000Z"}], "reviewThreads": [], "reviewRequests": [], "ticketKeys": ["o/r#9"], "updatedAt": "2026-11-04T08:00:00.000Z", "feedback": [{"kind": "comment", "id": "compat-first", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:05:00.000Z"}, {"kind": "comment", "id": "compat-return", "author": {"login": "reviewer", "type": "user"}, "postedAt": "2026-11-04T08:10:00.000Z"}], "feedbackComplete": true}}, "v": 1, "request_id": null, "via": null},
{"id": 27, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T3", "outcome": "moved"}, "v": 1, "request_id": null, "via": null},
{"id": 28, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "ready-to-merge", "to": "dev", "reason": "gate_broken", "gate": ["external_comments"]}, "v": 1, "request_id": null, "via": null},
{"id": 29, "at": "2026-11-04T08:11:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T4", "column": "dev", "addressee": "worker", "reason": "dev: external_comments, no_submit_on_head"}, "v": 1, "request_id": null, "via": null},
{"id": 30, "at": "2026-11-04T08:12:00.000Z", "project": "proj", "task_id": 1, "kind": "doorbell_read", "actor": "system", "actor_ref": null, "payload": {"doorbell": "N4"}, "v": 1, "request_id": "key-5", "via": null},
{"id": 31, "at": "2026-11-04T08:12:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_taken", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"turn": "T4", "taker": "agent:worker/worker-1"}, "v": 1, "request_id": "key-5", "via": null},
{"id": 32, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_closed", "actor": "system", "actor_ref": null, "payload": {"turn": "T4", "outcome": "submitted"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 33, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_submitted", "actor": "agent", "actor_ref": "{\"project\":\"worker\",\"session\":\"worker-1\"}", "payload": {"basis": "tested", "turn": "T4", "column": "dev", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 34, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "dev", "to": "review", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 35, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "review", "to": "product-review", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 36, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "task_moved", "actor": "system", "actor_ref": null, "payload": {"from": "product-review", "to": "ready-to-merge", "reason": "gate_passed"}, "v": 1, "request_id": "key-6", "via": null},
{"id": 37, "at": "2026-11-04T08:13:00.000Z", "project": "proj", "task_id": 1, "kind": "turn_opened", "actor": "system", "actor_ref": null, "payload": {"turn": "T5", "column": "ready-to-merge", "addressee": "worker", "reason": "ready-to-merge: not_merged"}, "v": 1, "request_id": "key-6", "via": null}
]
}
}`) as Record<string, unknown>;

describe('pinned main compatibility', () => {
  it.each(['effective', 'default', 'simple'] as const)(
    'preserves full journal for %s pattern',
    async (pattern) => {
      const ctx = await inDev({ compatibility: pattern });
      const checkpoints: { column: string; reason: string | null }[] = [];
      const capture = async () =>
        checkpoints.push({
          column: (await ctx.task()).column,
          reason: (await ctx.openTurn())?.reason ?? null,
        });
      const first = {
        kind: 'comment' as const,
        id: 'compat-first',
        author: { login: EXTERNAL, type: 'user' as const },
        postedAt: ctx.at(),
      };
      await ctx.pr({ feedback: [first] });
      await ctx.submit(WORKER, 'T1', A);
      await capture();
      const handed = await ctx.openTurn();
      await ctx.ack(WORKER, handed?.id ?? '');
      await ctx.submit(WORKER, handed?.id ?? '', A);
      for (const actor of [REV, COORD]) {
        const turn = await ctx.openTurn();
        if (turn?.column === 'review' || turn?.column === 'product-review') {
          await ctx.ack(actor, turn.id);
          await ctx.submit(actor, turn.id, A);
        }
      }
      await ctx.pr({
        reviews: [{ reviewer: EXTERNAL, state: 'approved', commitSha: A, submittedAt: ctx.at() }],
      });
      await capture();
      expect((await ctx.task()).column).toBe('ready-to-merge');
      expect(
        await ctx.store.db
          .selectFrom('submission')
          .selectAll()
          .where('column', '=', 'qa')
          .execute(),
      ).toEqual([]);
      await ctx.pr({ feedback: [first, { ...first, id: 'compat-return', postedAt: ctx.at() }] });
      await capture();
      const repair = await ctx.openTurn();
      await ctx.ack(WORKER, repair?.id ?? '');
      await ctx.submit(WORKER, repair?.id ?? '', A);
      await capture();
      const journal = (
        await ctx.store.db.selectFrom('event').selectAll().orderBy('id').execute()
      ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
      const transcript = { checkpoints, journal };
      expect(transcript).toEqual(expectedCompatibility[pattern]);
    },
  );
});

describe('checksGate', () => {
  const GATED = { externalReview: true, checksGate: 'external-review' } as const;
  const ci = (state: 'pending' | 'failure' | 'cancelled' | 'success', minute?: number) => ({
    requiredChecks: [{ name: 'ci', state, completedAt: minute === undefined ? null : at(minute) }],
  });
  const approved = {
    reviews: [
      { reviewer: EXTERNAL, state: 'approved' as const, commitSha: A, submittedAt: at(30) },
    ],
    feedback: [
      {
        kind: 'review' as const,
        id: `r-${EXTERNAL}`,
        author: { login: EXTERNAL, type: 'user' as const },
        postedAt: at(30),
      },
    ],
  };
  const cancelRows = (ctx: Board) =>
    ctx.store.db
      .selectFrom('meta')
      .select(['key', 'value'])
      .where('key', 'like', 'checks-cancel:%')
      .execute();
  const cancelCount = async (ctx: Board) =>
    (await cancelRows(ctx)).map((row) => JSON.parse(row.value) as unknown);

  it('checksGate external-review: pending passes Dev, Review, Product Review and holds at External Review', async () => {
    const ctx = await started(GATED);
    await ctx.ack(WORKER, 'T1');
    await ctx.pr(ci('pending'));
    await ctx.submit(WORKER, 'T1', A);
    expect((await ctx.task()).column).toBe('review');
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    await ctx.ack(COORD, 'T3');
    await ctx.submit(COORD, 'T3', A);
    expect((await ctx.task()).column).toBe('external-review');
    expect(await ctx.openTurn()).toBeNull();
    expect((await ctx.turns()).map((turn) => turn.column)).toEqual([
      'dev',
      'review',
      'product-review',
    ]);
    const why = await ctx.why();
    expect(why.waiting).toEqual([
      {
        reason: 'checks_pending',
        head: A,
        text: 'checks running, exit from external-review waits for green',
      },
    ]);
    expect(why.gates.find((gate) => gate.column === 'external-review')?.conditions).toContainEqual({
      condition: 'checks_green',
      state: 'waiting',
      reason: 'checks_pending',
    });

    await ctx.pr({ ...approved, ...ci('pending') });
    expect((await ctx.task()).column).toBe('external-review');
    await ctx.pr(ci('success'));
    expect((await ctx.task()).column).toBe('ready-to-merge');
  });

  it('checksGate external-review: green releases from External Review', async () => {
    const ctx = await pastProductReview(GATED);
    expect((await ctx.task()).column).toBe('external-review');
    await ctx.pr(approved);
    expect((await ctx.task()).column).toBe('ready-to-merge');
  });

  it('checksGate external-review: a review mark on head survives a red return', async () => {
    const ctx = await inReview(GATED);
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    expect((await ctx.task()).column).toBe('product-review');
    await ctx.pr(ci('failure', 20));
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'product-review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['checks_red'],
    });
    const why = await ctx.why();
    expect(why.gates.find((gate) => gate.column === 'dev')?.conditions).toContainEqual({
      condition: 'checks_not_red',
      state: 'failed',
      reason: 'checks_red',
    });
    await ctx.pr(ci('success', 25));
    const turn = await ctx.openTurn();
    await ctx.ack(WORKER, turn?.id ?? '');
    await expect(ctx.submit(WORKER, turn?.id ?? '', A)).resolves.toMatchObject({
      task: { column: 'product-review' },
    });
    expect((await ctx.turns()).map((entry) => entry.column)).toEqual([
      'dev',
      'review',
      'product-review',
      'dev',
      'product-review',
    ]);
  });

  /** The task in `column` with no taken turn, under `checksGate`. */
  async function inColumn(column: CheckGateColumn, checksGate: CheckGateColumn): Promise<Board> {
    const options = { externalReview: true, checksGate };
    if (column === 'dev') return inDev(options);
    const ctx = await inReview(options);
    if (column === 'review') return ctx;
    await ctx.ack(REV, 'T2');
    await ctx.submit(REV, 'T2', A);
    if (column === 'product-review') return ctx;
    await ctx.ack(COORD, 'T3');
    await ctx.submit(COORD, 'T3', A);
    return ctx;
  }

  it.each(
    CHECKS_GATE_COLUMNS.flatMap((checksGate) =>
      CHECKS_GATE_COLUMNS.map((column) => ({ checksGate, column })),
    ),
  )('checksGate $checksGate: red returns to Dev from $column', async ({ checksGate, column }) => {
    const ctx = await inColumn(column, checksGate);
    expect((await ctx.task()).column).toBe(column);
    await ctx.pr(ci('failure', 20));
    expect((await ctx.task()).column).toBe('dev');
    if (column !== 'dev')
      expect((await ctx.moves()).at(-1)).toEqual({
        from: column,
        to: 'dev',
        reason: 'gate_broken',
        gate: ['checks_red'],
      });
  });

  it('checksGate external-review: red while a Review turn is taken returns after its submit', async () => {
    const ctx = await inReview(GATED);
    await ctx.ack(REV, 'T2');
    await ctx.pr(ci('failure', 20));
    expect((await ctx.task()).column).toBe('review');
    expect(await ctx.openTurn()).toMatchObject({ id: 'T2' });
    expect((await ctx.why()).waiting).toContainEqual({
      reason: 'checks_red',
      head: A,
      text: 'checks red',
    });

    await ctx.submit(REV, 'T2', A);
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['checks_red'],
    });
    expect(await ctx.openTurn()).toEqual(
      turnOf('dev', 'worker', 'dev: checks_red, no_submit_on_head'),
    );
  });

  it('checksGate external-review: a cancelled check turns red on the second complete poll after its sighting', async () => {
    const ctx = await pastProductReview(GATED);
    await ctx.pr(ci('cancelled', 40));
    expect((await ctx.task()).column).toBe('external-review');
    expect((await ctx.why()).waiting).toEqual([
      {
        reason: 'checks_pending',
        head: A,
        text: 'checks running, exit from external-review waits for green',
      },
    ]);
    await ctx.github();
    expect((await ctx.task()).column).toBe('external-review');
    await ctx.github();
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toEqual({
      from: 'external-review',
      to: 'dev',
      reason: 'gate_broken',
      gate: ['checks_red'],
    });
  });

  it('checksGate external-review: a new run after a cancel keeps the task in place', async () => {
    const ctx = await pastProductReview(GATED);
    await ctx.pr(ci('cancelled', 40));
    await ctx.pr(ci('pending'));
    await ctx.github();
    await ctx.github();
    await ctx.pr(ci('success', 50));
    expect((await ctx.task()).column).toBe('external-review');
    expect((await ctx.moves()).filter((move) => move.to === 'dev')).toHaveLength(1);
    expect(await cancelRows(ctx)).toEqual([]);
  });

  it('checksGate external-review: incomplete polls and demand reads do not count a cancel', async () => {
    const ctx = await pastProductReview(GATED);
    await ctx.pr(ci('cancelled', 40));
    await ctx.pr({}, false);
    await ctx.pr({}, false);
    expect((await ctx.task()).column).toBe('external-review');
    expect(await cancelCount(ctx)).toEqual([
      { headSha: A, cancelled: [{ name: 'ci', completedAt: at(40), polls: 0 }] },
    ]);
    await ctx.github();
    expect((await ctx.task()).column).toBe('external-review');
    await ctx.github();
    expect((await ctx.task()).column).toBe('dev');
  });

  it('checksGate external-review: a head change restarts the cancel count', async () => {
    const ctx = await pastProductReview(GATED);
    await ctx.pr(ci('cancelled', 40));
    await ctx.github();
    expect(await cancelCount(ctx)).toEqual([
      { headSha: A, cancelled: [{ name: 'ci', completedAt: at(40), polls: 1 }] },
    ]);
    await ctx.pr({ headSha: B, ...ci('cancelled', 45) });
    expect(await cancelCount(ctx)).toEqual([
      { headSha: B, cancelled: [{ name: 'ci', completedAt: at(45), polls: 0 }] },
    ]);
  });

  it('without the key a cancelled required check returns the task to Dev at once', async () => {
    const ctx = await inReview();
    await ctx.pr(ci('cancelled', 20));
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['checks_red'] });
    expect(await cancelRows(ctx)).toEqual([]);
  });
});

describe('approvalRule github-rules', () => {
  const RULED = { externalReview: true, approvalRule: 'github-rules' } as const;
  const HALF_HOUR = 30 * 60_000;
  const rule = (patch: Partial<PrReviewRule> = {}): PrReviewRule => ({
    reviewDecision: 'review_required',
    rule: {
      sources: ['ruleset'],
      approvals: 1,
      codeOwners: false,
      conversationResolution: true,
      requiredChecks: ['ci'],
    },
    ...patch,
  });
  const approved = {
    reviews: [
      { reviewer: EXTERNAL, state: 'approved' as const, commitSha: A, submittedAt: at(30) },
    ],
  };
  const ruleRows = (ctx: Board) =>
    ctx.store.db
      .selectFrom('meta')
      .select(['key', 'value'])
      .where('key', 'like', 'review-rule:%')
      .orderBy('key')
      .execute();
  const ruleItems = (ctx: Board) =>
    ctx.store.db
      .selectFrom('operator_item')
      .select(['id', 'item_key', 'text', 'cleared_at'])
      .where('item_key', 'like', 'review-rule:%')
      .orderBy('id')
      .execute();
  const externalConditions = async (ctx: Board) =>
    (await ctx.why()).gates.find((gate) => gate.column === 'external-review')?.conditions;

  // The transition table: one read of the head under each state the task and its stored decision
  // can be in, and every pair of reads from External Review and from Ready to Merge. Every read
  // is a full read of the project's own source with the approval, except where it names a
  // reviewer's changes request.
  const run = (name: string, state: 'success' | 'pending') => ({
    name,
    state,
    completedAt: state === 'pending' ? null : at(29),
  });
  const READS = {
    clean: { facts: { mergeState: 'clean' } },
    'blocked, required checks met': { facts: { mergeState: 'blocked' } },
    'blocked, a required check pending': {
      facts: {
        mergeState: 'blocked',
        requiredChecks: [run('ci', 'success'), run('e2e', 'pending')],
        checks: [run('ci', 'success'), run('e2e', 'pending')],
      },
    },
    // The rule lists e2e and GitHub marks only ci required: another app's e2e run fills no slot.
    'blocked, a listed check missing': {
      facts: { mergeState: 'blocked', checks: [run('ci', 'success'), run('e2e', 'success')] },
      listed: ['ci', 'e2e'],
    },
    'blocked, an unresolved thread': {
      facts: { mergeState: 'blocked', reviewThreads: [{ resolved: false, id: 'PRRT_1' }] },
    },
    behind: { facts: { mergeState: 'behind' } },
    unknown: { facts: { mergeState: 'unknown' } },
    // A rule the token could not read, while GitHub has not computed the merge state.
    denied: { facts: { mergeState: 'unknown' }, denied: true },
    'changes requested by GitHub': {
      facts: { mergeState: 'blocked' },
      reviewDecision: 'changes_requested',
    },
    'changes requested by a reviewer': {
      facts: {
        mergeState: 'blocked',
        reviews: [
          { reviewer: EXTERNAL, state: 'changes_requested', commitSha: A, submittedAt: at(31) },
        ],
      },
    },
  } as const satisfies Record<
    string,
    {
      facts: Partial<PrFacts>;
      listed?: readonly string[];
      denied?: true;
      reviewDecision?: 'changes_requested';
    }
  >;
  type Read = keyof typeof READS;
  type State =
    | 'external-review/none'
    | 'external-review/blocked'
    | 'external-review/satisfied'
    | 'ready-to-merge/satisfied'
    | 'dev/blocked';
  type Outcome = {
    /** The stored decision after the read. */
    stored: 'none' | 'satisfied' | 'blocked';
    /** The column after the read; a move is one move. */
    column: 'dev' | 'external-review' | 'ready-to-merge';
    /** The `--why` waiting reasons. */
    waiting: string[];
    /** External Review's review rule condition: its reason, or met. */
    rule: string;
    /** Whether the 30-minute clock runs, and so whether an item is open 30 minutes later. */
    clock: boolean;
  };
  const outcome = (
    stored: Outcome['stored'],
    column: Outcome['column'],
    waiting: string[],
    rule: string,
    clock = false,
  ): Outcome => ({ stored, column, waiting, rule, clock });
  const ER = 'external-review';
  const RTM = 'ready-to-merge';
  const DEV = 'dev';
  const BLOCKED = 'review_rule_blocked';
  const PENDING = 'checks_pending';
  const UNKNOWN = 'merge_state_unknown';
  const UNREADABLE = 'review_rule_unreadable';
  const CHANGES = 'changes_requested';
  const THREADS = 'unresolved_threads';
  // Rows: the state before the read. Only GitHub's answer (clean, or blocked with the required
  // checks met) changes the stored decision; every other read keeps it and holds the task. The
  // clock runs only on an undecided answer for a head with no decision.
  const TRANSITIONS: Record<State, Record<Read, Outcome>> = {
    'external-review/none': {
      clean: outcome('satisfied', RTM, [], 'met'),
      'blocked, required checks met': outcome('blocked', ER, [BLOCKED], BLOCKED),
      'blocked, a required check pending': outcome('none', ER, [PENDING], PENDING),
      'blocked, a listed check missing': outcome('none', ER, [PENDING], PENDING),
      'blocked, an unresolved thread': outcome('blocked', ER, [], THREADS),
      behind: outcome('none', ER, [UNKNOWN], UNKNOWN, true),
      unknown: outcome('none', ER, [UNKNOWN], UNKNOWN, true),
      denied: outcome('none', ER, [UNREADABLE], UNREADABLE, true),
      'changes requested by GitHub': outcome('none', ER, [CHANGES], 'met'),
      'changes requested by a reviewer': outcome('none', ER, [CHANGES], 'met'),
    },
    'external-review/blocked': {
      clean: outcome('satisfied', RTM, [], 'met'),
      'blocked, required checks met': outcome('blocked', ER, [BLOCKED], BLOCKED),
      'blocked, a required check pending': outcome('blocked', ER, [PENDING], PENDING),
      'blocked, a listed check missing': outcome('blocked', ER, [PENDING], PENDING),
      'blocked, an unresolved thread': outcome('blocked', ER, [], THREADS),
      behind: outcome('blocked', ER, [UNKNOWN], UNKNOWN),
      unknown: outcome('blocked', ER, [UNKNOWN], UNKNOWN),
      denied: outcome('blocked', ER, [UNREADABLE], UNREADABLE),
      'changes requested by GitHub': outcome('blocked', ER, [CHANGES], 'met'),
      'changes requested by a reviewer': outcome('blocked', ER, [CHANGES], 'met'),
    },
    // Back from Ready to Merge on a changes request, the satisfied decision kept.
    'external-review/satisfied': {
      clean: outcome('satisfied', RTM, [], 'met'),
      'blocked, required checks met': outcome('blocked', ER, [BLOCKED], BLOCKED),
      'blocked, a required check pending': outcome('satisfied', ER, [PENDING], PENDING),
      'blocked, a listed check missing': outcome('satisfied', ER, [PENDING], PENDING),
      'blocked, an unresolved thread': outcome('blocked', ER, [], THREADS),
      behind: outcome('satisfied', ER, [UNKNOWN], UNKNOWN),
      unknown: outcome('satisfied', ER, [UNKNOWN], UNKNOWN),
      denied: outcome('satisfied', ER, [UNREADABLE], UNREADABLE),
      'changes requested by GitHub': outcome('satisfied', ER, [CHANGES], 'met'),
      'changes requested by a reviewer': outcome('satisfied', ER, [CHANGES], 'met'),
    },
    'ready-to-merge/satisfied': {
      clean: outcome('satisfied', RTM, [], 'met'),
      'blocked, required checks met': outcome('blocked', ER, [BLOCKED], BLOCKED),
      'blocked, a required check pending': outcome('satisfied', RTM, [PENDING], PENDING),
      'blocked, a listed check missing': outcome('satisfied', RTM, [PENDING], PENDING),
      // Unresolved threads at Ready to Merge are Dev's, as without the key.
      'blocked, an unresolved thread': outcome('blocked', DEV, [], THREADS),
      behind: outcome('satisfied', RTM, [UNKNOWN], UNKNOWN),
      unknown: outcome('satisfied', RTM, [UNKNOWN], UNKNOWN),
      denied: outcome('satisfied', RTM, [UNREADABLE], UNREADABLE),
      'changes requested by GitHub': outcome('satisfied', ER, [CHANGES], 'met'),
      'changes requested by a reviewer': outcome('satisfied', ER, [CHANGES], 'met'),
    },
    // Back in Dev without a submit on the head, where only Dev's own waits show.
    'dev/blocked': {
      clean: outcome('satisfied', DEV, [], 'met'),
      'blocked, required checks met': outcome('blocked', DEV, [], BLOCKED),
      'blocked, a required check pending': outcome('blocked', DEV, [PENDING], PENDING),
      'blocked, a listed check missing': outcome('blocked', DEV, [], PENDING),
      'blocked, an unresolved thread': outcome('blocked', DEV, [], THREADS),
      behind: outcome('blocked', DEV, [], UNKNOWN),
      unknown: outcome('blocked', DEV, [], UNKNOWN),
      denied: outcome('blocked', DEV, [], UNREADABLE),
      'changes requested by GitHub': outcome('blocked', DEV, [], 'met'),
      'changes requested by a reviewer': outcome('blocked', DEV, [], 'met'),
    },
  };
  const NAMES = Object.keys(READS) as Read[];
  it.each(
    ([ER, RTM] as const).flatMap((start) =>
      NAMES.flatMap((previous) => NAMES.map((current) => ({ start, previous, current }))),
    ),
  )('in $start: $previous, then $current', async ({ start, previous, current }) => {
    const ctx = await pastProductReview(RULED);
    if (start === RTM) await ctx.rulePr({ ...approved, mergeState: 'clean' }, rule());
    expect((await ctx.task()).column).toBe(start);
    let state: keyof typeof TRANSITIONS = start === RTM ? `${RTM}/satisfied` : `${ER}/none`;
    const steps: Outcome[] = [];
    for (const name of [previous, current]) {
      const read: (typeof READS)[Read] & {
        listed?: readonly string[];
        denied?: true;
        reviewDecision?: 'changes_requested';
      } = READS[name];
      const want = TRANSITIONS[state][name];
      const moves = (await ctx.moves()).length;
      await ctx.rulePr(
        {
          ...approved,
          requiredChecks: [run('ci', 'success')],
          checks: [run('ci', 'success')],
          reviewThreads: [],
          ...read.facts,
        },
        rule({
          ...(read.reviewDecision === undefined ? {} : { reviewDecision: read.reviewDecision }),
          rule:
            read.denied === true
              ? null
              : {
                  sources: ['ruleset'],
                  approvals: 1,
                  codeOwners: false,
                  conversationResolution: true,
                  requiredChecks: [...(read.listed ?? ['ci'])],
                },
        }),
      );
      const [row] = await ruleRows(ctx);
      const stored = JSON.parse(row?.value ?? '{}') as {
        decision: 'satisfied' | 'blocked' | null;
        undecidedSince: string | null;
      };
      const condition = (await externalConditions(ctx))?.find(
        (entry) => entry.condition === 'review_rule_satisfied',
      );
      expect({
        stored: stored.decision ?? 'none',
        column: (await ctx.task()).column,
        moved: (await ctx.moves()).length - moves,
        waiting: (await ctx.why()).waiting?.map((entry) => entry.reason) ?? [],
        rule: condition?.reason ?? condition?.state,
        clock: stored.undecidedSince !== null,
      }).toEqual({ ...want, moved: state.startsWith(`${want.column}/`) ? 0 : 1 });
      ctx.wait(HALF_HOUR);
      await ctx.tick();
      const open = (await ruleItems(ctx)).filter((item) => item.cleared_at === null);
      expect(open).toHaveLength(want.clock && want.column === ER ? 1 : 0);
      steps.push(want);
      state = `${want.column}/${want.stored}` as keyof typeof TRANSITIONS;
    }
    // The open item names the current cause GitHub left undecided: a rule the token could not
    // read, or the merge state, even when the stretch started on the other one.
    const last = steps.at(-1);
    if (last?.clock === true && last.column === ER) {
      const open = (await ruleItems(ctx)).filter((item) => item.cleared_at === null);
      expect(open.at(-1)?.text).toContain(
        current === 'denied'
          ? 'The GitHub review rule for the base branch of o/r#7 could not be read'
          : 'GitHub has not decided the review rule of o/r#7',
      );
    }
  });

  it('waits on GitHub until the first full read of the head and drops the decision on a new head', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.pr(approved);
    expect((await ctx.task()).column).toBe('external-review');
    expect((await ctx.why()).waiting).toEqual([
      {
        reason: 'merge_state_unknown',
        head: A,
        text: 'GitHub has not computed the merge state yet',
      },
    ]);
    await ctx.rulePr({ mergeState: 'blocked' }, rule());
    expect((await externalConditions(ctx))?.at(-1)).toEqual({
      condition: 'review_rule_satisfied',
      state: 'failed',
      reason: 'review_rule_blocked',
    });
    await ctx.rulePr({ headSha: B, mergeState: 'unknown' }, rule());
    const [row] = await ruleRows(ctx);
    expect(JSON.parse(row?.value ?? '{}')).toMatchObject({ headSha: B, decision: null });
    expect((await externalConditions(ctx))?.at(-1)).toEqual({
      condition: 'review_rule_satisfied',
      state: 'waiting',
      reason: 'merge_state_unknown',
    });
  });

  it.each(['clean', 'unknown'] as const)(
    'a rule the token could not read leaves the head undecided on a merge state %s',
    async (mergeState) => {
      const ctx = await pastProductReview(RULED);
      await ctx.rulePr({ ...approved, mergeState }, rule({ rule: null }));
      expect((await ctx.task()).column).toBe('external-review');
      expect((await ctx.why()).waiting).toEqual([
        {
          reason: 'review_rule_unreadable',
          head: A,
          text: 'the GitHub review rule for the base branch could not be read',
        },
      ]);
      const [row] = await ruleRows(ctx);
      expect(JSON.parse(row?.value ?? '{}')).toMatchObject({ decision: null, rule: null });
      await ctx.rulePr({ mergeState: 'clean' }, rule());
      expect((await ctx.task()).column).toBe('ready-to-merge');
    },
  );

  it('names changes requested by GitHub after the external comment is handled', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr(
      { ...approved, mergeState: 'blocked' },
      rule({ reviewDecision: 'changes_requested' }),
    );
    expect((await ctx.task()).column).toBe('external-review');
    expect((await ctx.why()).waiting).toEqual([
      { reason: 'changes_requested', head: A, text: 'changes requested' },
    ]);
    expect((await externalConditions(ctx))?.[0]).toEqual({
      condition: 'approved',
      state: 'failed',
      reason: 'changes_requested',
    });
  });

  it('raises one item for a head left undecided for 30 minutes, keeps it raised and clears it on a decision', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr({ ...approved, mergeState: 'unknown' }, rule());
    ctx.wait(HALF_HOUR - 2 * 60_000);
    await ctx.tick();
    expect(await ruleItems(ctx)).toEqual([]);
    ctx.wait(60_000);
    await ctx.tick();
    const [item, ...rest] = await ruleItems(ctx);
    expect(rest).toEqual([]);
    expect(item?.item_key).toBe(`review-rule:${String((await ctx.task()).id)}:o/r#7:${A}`);
    expect(item?.cleared_at).toBeNull();
    // The clock counts undecided time on the head, which can start before External Review.
    expect(item?.text).toContain(
      `${KEY}: GitHub has not decided the review rule of o/r#7 on ${A.slice(0, 7)}: undecided for 30 minutes on this head (`,
    );
    for (const raw of [
      'mergeStateStatus=UNKNOWN',
      'mergeable=MERGEABLE',
      'reviewDecision=REVIEW_REQUIRED',
    ])
      expect(item?.text).toContain(raw);
    await ctx.rulePr({ mergeState: 'unknown' }, rule({ reviewDecision: 'approved' }));
    ctx.restart();
    await ctx.tick();
    expect(await ruleItems(ctx)).toEqual([item]);
    expect((await ctx.task()).column).toBe('external-review');

    await ctx.rulePr({ mergeState: 'clean' }, rule({ reviewDecision: 'approved' }));
    expect((await ctx.task()).column).toBe('ready-to-merge');
    expect((await ruleItems(ctx)).map((entry) => entry.cleared_at === null)).toEqual([false]);
  });

  it('two tasks on one PR each get an item naming their own task, kept on the next reconcile', async () => {
    const ctx = await pastProductReview(RULED);
    /** A copy of `row` for an insert, without its generated id. */
    const withoutId = <T extends { id: number }>(row: T): Omit<T, 'id'> => {
      const copy: Partial<T> = { ...row };
      delete copy.id;
      return copy as Omit<T, 'id'>;
    };
    const first = await ctx.task();
    const second = await ctx.store.db
      .insertInto('task')
      .values({ ...withoutId(first), key: 'o/r#10', tracker_id: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    const link = await ctx.store.db
      .selectFrom('link')
      .selectAll()
      .where('task_id', '=', first.id)
      .where('entity', '=', 'pr')
      .executeTakeFirstOrThrow();
    await ctx.store.db
      .insertInto('link')
      .values({ ...withoutId(link), task_id: second.id })
      .execute();
    // The reviewers' marks on the head, so the second task also stays in External Review.
    for (const submission of await ctx.store.db
      .selectFrom('submission')
      .selectAll()
      .where('task_id', '=', first.id)
      .execute())
      await ctx.store.db
        .insertInto('submission')
        .values({ ...withoutId(submission), task_id: second.id })
        .execute();
    await ctx.rulePr({ ...approved, mergeState: 'behind' }, rule());
    ctx.wait(HALF_HOUR);
    await ctx.tick();
    const items = await ruleItems(ctx);
    expect(items.map((item) => item.item_key)).toEqual([
      `review-rule:${String(first.id)}:o/r#7:${A}`,
      `review-rule:${String(second.id)}:o/r#7:${A}`,
    ]);
    expect(items.map((item) => item.text.split(':')[0])).toEqual([KEY, 'o/r#10']);
    expect(items[1]?.text.slice('o/r#10'.length)).toBe(items[0]?.text.slice(KEY.length));
    await ctx.tick();
    expect(await ruleItems(ctx)).toEqual(items);
  });

  // A manual link refreshes the snapshot with a lowercase slug and the next poll can bring back
  // the mixed case: the item stays one, and a closed one stays closed.
  it.each([
    { first: 'o/r', later: 'o/r' },
    { first: 'O/R', later: 'o/r' },
    { first: 'o/r', later: 'O/R' },
  ])(
    'keeps one item, and a closed item closed for a later undecided stretch with the same text, from repo $first to $later',
    async ({ first: from, later }) => {
      const ctx = await pastProductReview(RULED);
      // A rerun of the required check stops the clock of a head with no decision yet.
      const behind = (state: 'success' | 'pending') => ({
        repo: later,
        mergeState: state === 'pending' ? ('blocked' as const) : ('behind' as const),
        requiredChecks: [{ name: 'ci', state, completedAt: state === 'pending' ? null : at(29) }],
      });
      await ctx.rulePr({ ...approved, ...behind('success'), repo: from }, rule());
      ctx.wait(HALF_HOUR);
      await ctx.tick();
      const [first, ...rest] = await ruleItems(ctx);
      expect(rest).toEqual([]);
      expect(first?.item_key).toBe(`review-rule:${String((await ctx.task()).id)}:o/r#7:${A}`);
      await ctx.rulePr(behind('success'), rule());
      await ctx.tick();
      expect(await ruleItems(ctx)).toEqual([first]);
      await ctx.closeItem(`I${String(first?.id)}`);
      await ctx.rulePr(behind('pending'), rule());
      await ctx.rulePr(behind('success'), rule());
      ctx.wait(HALF_HOUR);
      await ctx.tick();
      expect((await ruleItems(ctx)).map((entry) => entry.cleared_at === null)).toEqual([false]);
    },
  );

  it('a return to External Review on the same head keeps the clock that ran outside it', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr({ ...approved, mergeState: 'behind' }, rule());
    ctx.wait(HALF_HOUR);
    await ctx.tick();
    const [first] = await ruleItems(ctx);
    await ctx.move('dev');
    await ctx.tick();
    expect((await ruleItems(ctx)).map((entry) => entry.cleared_at === null)).toEqual([false]);
    await ctx.ack(WORKER, 'T4');
    await ctx.submit(WORKER, 'T4', A);
    expect((await ctx.task()).column).toBe('external-review');
    await ctx.tick();
    const items = await ruleItems(ctx);
    expect(items.map((entry) => entry.cleared_at === null)).toEqual([false, true]);
    expect(items[1]?.text).toBe(first?.text);
  });

  it.each([
    {
      name: 'a draft',
      patch: { draft: true, mergeState: 'draft' },
      review: rule(),
      column: 'dev',
      gate: ['pr_draft'],
    },
    {
      name: 'a draft with a merge state GitHub has not computed',
      patch: { draft: true, mergeState: 'unknown' },
      review: rule(),
      column: 'dev',
      gate: ['pr_draft'],
    },
    {
      name: 'a conflict',
      patch: { mergeable: 'conflicting', mergeState: 'dirty' },
      review: rule(),
      column: 'dev',
      gate: ['conflict'],
    },
    {
      name: 'a conflict with a merge state GitHub has not computed',
      patch: { mergeable: 'conflicting', mergeState: 'unknown' },
      review: rule(),
      column: 'dev',
      gate: ['conflict'],
    },
  ] satisfies {
    name: string;
    patch: Partial<PrFacts>;
    review: PrReviewRule;
    column: ColumnId;
    gate: string[];
  }[])('$name raises no item after 30 minutes', async ({ patch, review, column, gate }) => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr({ ...approved, ...patch }, review);
    expect((await ctx.task()).column).toBe(column);
    expect((await ctx.moves()).at(-1)).toMatchObject({ to: 'dev', gate });
    ctx.wait(HALF_HOUR);
    await ctx.tick();
    await ctx.rulePr({ ...patch }, review);
    ctx.wait(HALF_HOUR);
    await ctx.tick();
    expect(await ruleItems(ctx)).toEqual([]);
    const [row] = await ruleRows(ctx);
    expect(JSON.parse(row?.value ?? '{}')).toMatchObject({ undecidedSince: null, raised: null });
  });

  it('an external review comment still returns the task to Dev', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr(
      {
        ...approved,
        mergeState: 'blocked',
        feedback: [
          {
            kind: 'comment',
            id: 'c-1',
            author: { login: EXTERNAL, type: 'user' },
            postedAt: at(31),
          },
        ],
      },
      rule(),
    );
    expect((await ctx.task()).column).toBe('dev');
    expect((await ctx.moves()).at(-1)).toMatchObject({ gate: ['external_comments'] });
  });

  it('a reused read sending the same review rule leaves the row byte-identical and writes a lost one back', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr({ ...approved, mergeState: 'behind' }, rule());
    const before = await ruleRows(ctx);
    expect(JSON.parse(before[0]?.value ?? '{}')).not.toMatchObject({ undecidedSince: null });
    ctx.wait(60_000);
    await ctx.rulePr({}, rule());
    expect(await ruleRows(ctx)).toEqual(before);
    await ctx.rulePr({ mergeState: 'blocked' }, rule());
    const blocked = await ruleRows(ctx);
    // The first observation's row is gone, as after a rollback: the replay writes it again, as
    // observed at the replay.
    await ctx.store.db.deleteFrom('meta').where('key', 'like', 'review-rule:%').execute();
    expect((await ctx.why()).waiting?.[0]?.reason).toBe('merge_state_unknown');
    await ctx.rulePr({}, rule());
    const parsed = (rows: { key: string; value: string }[], observedAt?: string) =>
      rows.map((row) => ({
        key: row.key,
        value: {
          ...(JSON.parse(row.value) as Record<string, unknown>),
          ...(observedAt === undefined ? {} : { observedAt }),
        },
      }));
    expect(parsed(await ruleRows(ctx))).toEqual(parsed(blocked, ctx.at()));
    expect((await ctx.why()).waiting).toEqual([
      { reason: 'review_rule_blocked', head: A, text: 'merge blocked by the GitHub review rule' },
    ]);
  });

  it('a reused read without the review rule leaves the row as it is', async () => {
    const ctx = await pastProductReview(RULED);
    await ctx.rulePr({ ...approved, mergeState: 'blocked' }, rule());
    const before = await ruleRows(ctx);
    expect(before).toHaveLength(1);
    await ctx.github();
    await ctx.pr({ mergeState: 'clean' });
    expect(await ruleRows(ctx)).toEqual(before);
    expect((await ctx.why()).waiting).toEqual([
      { reason: 'review_rule_blocked', head: A, text: 'merge blocked by the GitHub review rule' },
    ]);
  });

  it("another project's poll of the shared repo does not change the decision", async () => {
    const ctx = await pastProductReview({ ...RULED, sharedRepo: true });
    await ctx.rulePr({ ...approved, mergeState: 'blocked' }, rule());
    const before = await ruleRows(ctx);
    expect(before.map((row) => row.key)).toEqual([`review-rule:${GITHUB}:pr:o/r#7`]);
    await ctx.rulePr({ mergeState: 'blocked' }, undefined, 'github:web:o/r');
    await ctx.rulePr(
      { mergeState: 'blocked' },
      rule({ reviewDecision: 'approved' }),
      'github:web:o/r',
    );
    expect(await ruleRows(ctx)).toEqual(before);
    expect((await ctx.why()).waiting).toEqual([
      { reason: 'review_rule_blocked', head: A, text: 'merge blocked by the GitHub review rule' },
    ]);
  });

  // The gate reads another project's newer read of the shared head with the project's own stored
  // decision and the newest rule any source read; that read changes no row.
  it.each([
    { stored: 'clean', newer: { mergeState: 'blocked' }, reason: 'review_rule_blocked' },
    { stored: 'blocked', newer: { mergeState: 'clean' }, reason: 'review_rule_blocked' },
    // A read the project's own source has not stored decides nothing, and stops no clock.
    { stored: 'behind', newer: { mergeState: 'clean' }, reason: 'merge_state_unknown' },
    { stored: 'behind', newer: { mergeState: 'blocked' }, reason: 'merge_state_unknown' },
    {
      stored: 'clean',
      newer: {
        mergeState: 'blocked',
        requiredChecks: [
          { name: 'ci', state: 'success', completedAt: at(29) },
          { name: 'e2e', state: 'pending', completedAt: null },
        ],
      },
      reason: 'checks_pending',
    },
    // The other project follows the rule too, and its read lists a newly required e2e.
    {
      stored: 'clean',
      newer: { mergeState: 'blocked' },
      listed: ['ci', 'e2e'],
      reason: 'checks_pending',
    },
  ] satisfies {
    stored: PrFacts['mergeState'];
    newer: Partial<PrFacts>;
    listed?: string[];
    reason: string;
  }[])(
    "another project's newer read $newer over a stored $stored read gives $reason",
    async ({ stored, newer, reason, ...entry }) => {
      const listed: string[] | undefined = 'listed' in entry ? entry.listed : undefined;
      const ctx = await pastProductReview({
        ...RULED,
        sharedRepo: listed === undefined ? true : 'github-rules',
      });
      // Without the approval a satisfied decision does not release the task yet.
      await ctx.rulePr({ mergeState: stored }, rule());
      expect((await ctx.task()).column).toBe('external-review');
      const before = await ruleRows(ctx);
      await ctx.rulePr(
        { ...approved, ...newer },
        listed === undefined
          ? undefined
          : rule({
              rule: {
                sources: ['ruleset'],
                approvals: 1,
                codeOwners: false,
                conversationResolution: true,
                requiredChecks: listed,
              },
            }),
        'github:web:o/r',
      );
      expect((await ctx.task()).column).toBe('external-review');
      const own = `review-rule:${GITHUB}:pr:o/r#7`;
      expect((await ruleRows(ctx)).filter((row) => row.key === own)).toEqual(before);
      expect((await externalConditions(ctx))?.at(-1)).toEqual({
        condition: 'review_rule_satisfied',
        state: reason === 'review_rule_blocked' ? 'failed' : 'waiting',
        reason,
      });
      ctx.wait(HALF_HOUR);
      await ctx.tick();
      expect(await ruleItems(ctx)).toEqual([]);
    },
  );

  it('without the key a review rule beside the facts writes nothing and changes no wait', async () => {
    const ctx = await pastProductReview({ externalReview: true });
    await ctx.rulePr({ mergeState: 'blocked' }, rule({ reviewDecision: 'changes_requested' }));
    expect(await ruleRows(ctx)).toEqual([]);
    expect(await externalConditions(ctx)).toEqual([
      { condition: 'approved', state: 'failed', reason: 'not_approved' },
    ]);
    await ctx.rulePr({ ...approved, mergeState: 'blocked' }, rule());
    expect((await ctx.task()).column).toBe('ready-to-merge');
    ctx.wait(HALF_HOUR);
    await ctx.tick();
    expect(await ruleItems(ctx)).toEqual([]);
  });
});
