import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Tables } from '../../src/store/schema.ts';
import { getStatus } from '../../src/app/status.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { CHECK_STATES, OPERATIONS, configSchema, roleCanUseOperation } from '@spur-board/contracts';
import { afterEach, expect, expectTypeOf, it } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  type Store,
} from '../../src/index.ts';
import { clearItem, raiseItem } from '../../src/app/feed.ts';
import type { OperationHandlers } from '../../src/app/operations.ts';
import { openTempStore } from '../support/store.ts';
import { liveSession } from '../support/conversation.ts';
import { bestProjectSession, selectNotificationRecipient } from '../../src/app/doorbells.ts';
import { blockAddressee, escalateBlock } from '../../src/domain/blocks/blocks.ts';
import { courseAddressee } from '../../src/app/course-check.ts';
import { stuckTurnAfterMs, turnExecutor } from '../../src/app/turns.ts';
import { sampleRows } from '../store/sample-rows.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'first',
      tracker: { type: 'github-issues', repo: 'o/first', label: 'board' },
      repos: ['o/first'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'first-worker', role: 'worker' }],
    },
    {
      id: 'second',
      tracker: { type: 'github-issues', repo: 'o/second', label: 'board' },
      repos: ['o/second'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'second-worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

it('describes only visible enabled column policies without changing board state', async () => {
  const store = openTempStore('board-column-policy-').store;
  stores.push(store);
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const query = createQuery({ store, config, clock });
  const before = await store.db.selectFrom('event').selectAll().execute();
  const result = await query(registry['columns.describe'], {}, 'agent:first-worker/session');
  expect(result.projects.map((project) => project.id)).toEqual(['first']);
  const project = result.projects[0];
  expect(project?.columns.map((column) => column.id)).toEqual(
    config.projects[0]?.columns.filter((column) => column.enabled).map((column) => column.id),
  );
  const todo = project?.columns.find((column) => column.id === 'todo');
  expect(todo).toMatchObject({
    group: 'todo',
    exit: { to: 'dev', conditions: [{ id: 'work_started' }] },
    limits: null,
    movedBy: { kind: 'manual' },
    escalation: { chain: [], silent: null },
  });
  expect(todo?.executor.text).toContain('No executor turn');
  const external = project?.columns.find((column) => column.id === 'external-review');
  expect(external).toMatchObject({
    executor: { kind: 'dispatcher', project: null, session: null },
    exit: { conditions: [{ id: 'approved', text: 'Approved by an external reviewer.' }] },
    escalation: { chain: [], silent: null },
  });
  expect(external?.returns.join(' ')).not.toContain('executor can return');
  expect(external?.returns.join(' ')).toContain('external change request on a new PR head');
  const review = project?.columns.find((column) => column.id === 'review')?.returns.join(' ');
  expect(review).toContain("count toward External Review's courseCheck");
  expect(review).not.toContain('external change request on a new PR head');
  expect(external?.limits?.courseCheckTo).toMatchObject({
    role: 'operator',
    project: null,
    session: null,
  });
  expect(
    project?.columns
      .find((column) => column.id === 'dev')
      ?.escalation.chain.map((step) => step.role),
  ).toEqual(['worker', 'operator']);
  expect(project?.columns.find((column) => column.id === 'dev')?.executor).toMatchObject({
    kind: 'worker',
    project: null,
    session: null,
  });
  expect(project?.columns.find((column) => column.id === 'done')).toMatchObject({
    exit: { to: null, conditions: [] },
    limits: null,
  });
  expect(project?.columns.find((column) => column.id === 'done')?.executor.text).toContain(
    'wrap-up turn',
  );
  expect(
    (await query(registry['columns.describe'], {}, 'operator')).projects.map((entry) => entry.id),
  ).toEqual(['first', 'second']);
  expect(
    (await query(registry['columns.describe'], { project: 'second' }, 'operator')).projects.map(
      (entry) => entry.id,
    ),
  ).toEqual(['second']);
  expect(await store.db.selectFrom('event').selectAll().execute()).toEqual(before);
  for (const table of ['turn', 'notification', 'block', 'outbox', 'operator_item'] as const)
    expect(await store.db.selectFrom(table).selectAll().execute()).toEqual([]);
  await expect(
    query(registry['columns.describe'], { project: 'second' }, 'agent:first-worker/session'),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    query(registry['columns.describe'], { project: 'missing' }, 'operator'),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    query(registry['columns.describe'], {}, 'agent:outsider/session'),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(query(registry['config.get'], {}, 'agent:outsider/session')).rejects.toMatchObject({
    code: 'not_found',
  });
});

it("describes external-comments returns under External Review's courseCheck 0", async () => {
  const [first] = config.projects;
  const off = configSchema.parse({
    ...config,
    projects: [
      {
        ...first,
        columns: first?.columns.map((column) =>
          column.id === 'external-review' ? { ...column, courseCheck: 0 } : column,
        ),
      },
    ],
  });
  const store = openTempStore('board-column-policy-').store;
  stores.push(store);
  const registry = createOperationRegistry({ config: off, clock, completeSince: new Map() });
  const query = createQuery({ store, config: off, clock });
  const [project] = (await query(registry['columns.describe'], {}, 'operator')).projects;
  const returns = (id: string) =>
    project?.columns.find((column) => column.id === id)?.returns.join(' ');
  expect(returns('external-review')).toContain(
    "count toward this column's courseCheck, which is 0",
  );
  expect(returns('external-review')).not.toContain('once per head');
  expect(returns('review')).toContain("count toward External Review's courseCheck");
});

it.each([
  ['dev', ['approved', 'review_rule_satisfied']],
  ['external-review', ['checks_green', 'approved', 'review_rule_satisfied']],
] as const)(
  'describes the review rule at External Review under approvalRule github-rules, checksGate %s',
  async (checksGate, conditions) => {
    const ruled = configSchema.parse({
      projects: [
        {
          id: 'first',
          tracker: { type: 'github-issues', repo: 'o/first', label: 'board' },
          repos: ['o/first'],
          operatorGithubLogin: 'operator',
          checksGate,
          columns: [
            { id: 'todo' },
            { id: 'dev' },
            { id: 'external-review', approvalRule: 'github-rules' },
            { id: 'ready-to-merge' },
            { id: 'done' },
          ],
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    const store = openTempStore('board-column-policy-').store;
    stores.push(store);
    const registry = createOperationRegistry({ config: ruled, clock, completeSince: new Map() });
    const query = createQuery({ store, config: ruled, clock });
    const result = await query(registry['columns.describe'], {}, 'operator');
    const columns = result.projects[0]?.columns;
    const external = columns?.find((column) => column.id === 'external-review');
    expect(external?.exit.conditions.map((condition) => condition.id)).toEqual(conditions);
    expect(external?.exit.conditions.at(-1)?.text).toContain("GitHub's review rule");
    expect(
      columns?.find((column) => column.id === 'ready-to-merge')?.exit.conditions.map((c) => c.id),
    ).toEqual(['threads_resolved', 'merged']);
  },
);

it('uses effective bindings, project session selection, routing and configured timings', async () => {
  const store = openTempStore('board-column-routing-').store;
  stores.push(store);
  const effective = configSchema.parse({
    ...config,
    projects: [
      {
        ...config.projects[0],
        spurProjects: [
          { name: 'first-worker', role: 'worker' },
          { name: 'cur', role: 'curator', displayName: 'Course guide' },
          { name: 'reviewer', role: 'orchestrator' },
        ],
        checksGate: 'review',
        repos: ['o/first', 'o/no-ci'],
        reposWithoutCi: ['o/no-ci'],
        columns: [
          { id: 'todo' },
          { id: 'triage' },
          { id: 'dev' },
          {
            id: 'review',
            orchestrator: 'reviewer',
            requireResolvedThreads: true,
            cycleLimit: 7,
            courseCheck: 0,
            courseCheckTo: 'reviewer',
          },
          { id: 'product-review', orchestrator: 'cur' },
          { id: 'external-review', orchestrator: 'operator' },
          { id: 'qa' },
          { id: 'done', orchestrator: 'operator' },
        ],
      },
      config.projects[1],
    ],
    spurProjects: [
      { name: 'global', role: 'orchestrator', columns: ['qa'], displayName: 'Global QA' },
    ],
    health: { idleInDevAfterMs: 12345, turnStallAfterMs: 23456 },
    doorbells: { firstRetryMs: 1000, secondRetryMs: 2000, unansweredAfterMs: 3000 },
  });
  const registry = createOperationRegistry({ config: effective, clock, completeSince: new Map() });
  const query = createQuery({ store, config: effective, clock });
  await liveSession(store, 'old', 'reviewer');
  await liveSession(store, 'selected', 'reviewer');
  await liveSession(store, 'finished', 'reviewer');
  await liveSession(store, 'absent', 'reviewer');
  await liveSession(store, 'arbitrary-worker', 'first-worker');
  await store.transaction(async (trx) => {
    await trx
      .updateTable('session_snapshot')
      .set({ first_seen: '2026-11-04T07:00:00Z' })
      .where('id', 'in', ['selected', 'finished', 'absent'])
      .execute();
    await trx
      .updateTable('session_snapshot')
      .set({ ended_at: '2026-11-04T07:30:00Z' })
      .where('id', '=', 'finished')
      .execute();
    await trx
      .updateTable('session_snapshot')
      .set({ absent_since: '2026-11-04T07:30:00Z' })
      .where('id', '=', 'absent')
      .execute();
    const selected = await trx
      .selectFrom('session_snapshot')
      .selectAll()
      .where('id', '=', 'selected')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('session_snapshot')
      .set({
        detail: JSON.stringify({
          ...JSON.parse(selected.detail),
          links: { logs: 'https://example.test/logs' },
        }),
      })
      .where('id', '=', 'selected')
      .execute();
  });
  const result = await query(registry['columns.describe'], { project: 'first' }, 'operator');
  const project = result.projects[0];
  if (project === undefined) throw new Error('missing policy');
  const byId = (id: string) => {
    const column = project.columns.find((column) => column.id === id);
    if (column === undefined) throw new Error(`missing ${id}`);
    return column;
  };
  expect(project).toMatchObject({
    checksGate: 'review',
    reposWithoutCi: ['o/no-ci'],
    resolvedThreadsFrom: 'review',
  });
  expect(byId('triage').exit.to).toBe('dev');
  expect(byId('review').executor).toMatchObject({
    kind: 'orchestrator',
    project: 'reviewer',
    role: 'orchestrator',
    displayName: 'reviewer',
    session: {
      id: (await bestProjectSession(store.db, 'reviewer'))?.id,
      links: [{ label: 'logs', url: 'https://example.test/logs' }],
    },
  });
  expect(byId('qa').executor).toMatchObject({
    kind: 'orchestrator',
    project: 'global',
    displayName: 'Global QA',
    session: null,
  });
  expect(byId('qa').executor.text).toContain('turn waits for a session');
  expect(byId('product-review').executor).toMatchObject({
    kind: 'curator',
    project: 'cur',
    displayName: 'Course guide',
    session: null,
  });
  expect(byId('product-review').executor.text).toContain('turn waits for a session');
  expect(byId('external-review').executor.kind).toBe('operator');
  expect(byId('external-review').returns.join(' ')).toContain('executor can return');
  expect(byId('external-review').escalation).toMatchObject({
    chain: [{ role: 'operator' }],
    silent: null,
  });
  expect(byId('dev').executor.session).toBeNull();
  expect(byId('review').exit.conditions.map((rule) => rule.id)).toEqual([
    'checks_green',
    'threads_resolved',
    'review_on_head',
  ]);
  expect(byId('review').returns.join(' ')).toContain('Unresolved review threads');
  expect(byId('review').limits).toMatchObject({
    cycleLimit: 7,
    courseCheck: 0,
    courseCheckTo: {
      role: courseAddressee(effective, 'first', 'review'),
      project: 'reviewer',
      session: { id: 'selected' },
    },
  });
  expect(byId('qa').limits?.courseCheckTo).toMatchObject({
    role: 'curator',
    project: 'cur',
    session: null,
  });
  expect(byId('qa').limits?.courseCheckTo.text).toContain('falls back to the operator');
  const routed = blockAddressee({
    type: 'needs_input',
    author: 'agent:reviewer/selected',
    authorRole: 'orchestrator:review',
    column: 'review',
    orchestrator: 'reviewer',
    curator: 'cur',
    hasWorker: false,
  });
  expect(byId('review').escalation.chain.map((step) => step.role)).toEqual([
    'orchestrator:review',
    routed,
    escalateBlock(
      {
        type: 'needs_input',
        state: 'open',
        outcome: null,
        unblockedBy: null,
        author: 'agent:reviewer/selected',
        addressee: routed,
      },
      true,
    ).addressee,
  ]);
  expect(byId('product-review').escalation.chain.map((step) => step.role)).toEqual([
    'curator',
    'operator',
  ]);
  expect(byId('dev').escalation.chain.map((step) => step.role)).toEqual([
    'worker',
    'curator',
    'operator',
  ]);
  expect(byId('dev').escalation.silent).toMatchObject({
    remindAfterMs: stuckTurnAfterMs(effective, 'first', { column: 'dev', role: 'worker' }),
    operatorItemAfterReminderReadMs: 12345,
    unhealthyAfterMs: 23456,
  });
  expect(byId('dev').escalation.silent?.text).toContain('1000, then 2000');
  expect(byId('dev').escalation.silent?.text).toContain('shadow');
  await store.db
    .updateTable('session_snapshot')
    .set({ detail: '{broken' })
    .where('id', '=', 'selected')
    .execute();
  const malformed = await query(registry['columns.describe'], { project: 'first' }, 'operator');
  expect(
    malformed.projects[0]?.columns.find((column) => column.id === 'review')?.executor.session,
  ).toEqual({ id: 'selected', links: [] });
});

it.each([
  { purpose: 'executor', column: 'product-review', project: 'cur', canOverride: true },
  { purpose: 'question', column: 'dev', project: 'cur', canOverride: false },
  { purpose: 'course-check', column: 'review', project: 'cur', canOverride: false },
  { purpose: 'executor', column: 'review', project: 'reviewer', canOverride: true },
  { purpose: 'question', column: 'review', project: 'reviewer', canOverride: true },
  { purpose: 'course-check', column: 'product-review', project: 'reviewer', canOverride: true },
] as const)(
  'describes $project $purpose recipient overrides consistently with routing',
  async ({ purpose, column, project, canOverride }) => {
    const store = openTempStore('board-column-recipient-scope-').store;
    stores.push(store);
    const effective = configSchema.parse({
      ...config,
      projects: [
        {
          ...config.projects[0],
          spurProjects: [
            { name: 'first-worker', role: 'worker' },
            { name: 'cur', role: 'curator' },
            { name: 'reviewer', role: 'orchestrator' },
          ],
          columns: [
            { id: 'todo' },
            { id: 'dev' },
            { id: 'review', orchestrator: 'reviewer', courseCheckTo: 'cur' },
            { id: 'product-review', orchestrator: 'cur', courseCheckTo: 'reviewer' },
            { id: 'done' },
          ],
        },
      ],
    });
    await store.db
      .insertInto('task')
      .values({ ...sampleRows.task, project: 'first', membership: 'active', archive_reason: null })
      .execute();
    for (const name of ['cur', 'reviewer']) {
      await liveSession(store, `${name}-old`, name);
      await liveSession(store, `${name}-current`, name);
      await store.db
        .updateTable('session_snapshot')
        .set({ first_seen: '2026-11-04T07:00:00.000Z' })
        .where('id', '=', `${name}-current`)
        .execute();
    }
    await store.db
      .insertInto('link')
      .values({
        ...sampleRows.link,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        session_id: `${project}-old`,
        role: 'orchestrator',
      })
      .execute();
    const registry = createOperationRegistry({
      config: effective,
      clock,
      completeSince: new Map(),
    });
    const result = await createQuery({ store, config: effective, clock })(
      registry['columns.describe'],
      {},
      'operator',
    );
    const policy = result.projects[0]?.columns.find((entry) => entry.id === column);
    if (policy === undefined) throw new Error('missing policy');
    const isCurator =
      effective.projects[0]?.spurProjects.find((entry) => entry.name === project)?.role ===
      'curator';
    const description =
      purpose === 'executor'
        ? policy.executor
        : purpose === 'course-check'
          ? policy.limits?.courseCheckTo
          : policy.escalation.chain.find((step) => step.project === project);
    expect(description?.session?.id).toBe(`${project}-current`);
    expect(description?.text).toContain(
      canOverride
        ? 'task-linked or author sessions can override'
        : 'task-linked and author sessions do not override',
    );
    expect(description?.text).toContain(
      purpose === 'executor'
        ? 'turn waits for a session'
        : isCurator || purpose === 'course-check'
          ? 'falls back to the operator'
          : 'ordinary questions wait for a session',
    );
    if (purpose === 'executor' && isCurator)
      expect(description?.text).toContain('column orchestrator routing');
    const role =
      purpose === 'executor'
        ? turnExecutor(column, project, false)
        : purpose === 'course-check'
          ? courseAddressee(effective, 'first', column)
          : isCurator
            ? 'curator'
            : 'orchestrator:review';
    // Curator questions ignore both the older author and the task's orchestrator link;
    // a named executor turn (including curator-bound) and orchestrator questions can use them.
    for (const author_session of [`${project}-old`, null]) {
      const recipient = await selectNotificationRecipient(
        store.db,
        { task_id: 1, role, author_session },
        effective,
      );
      expect(recipient?.id).toBe(`${project}-${canOverride ? 'old' : 'current'}`);
    }
  },
);

it('registers one handler with a matching id for every catalog operation', () => {
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  expectTypeOf(registry).toEqualTypeOf<OperationHandlers>();
  expectTypeOf<Omit<OperationHandlers, 'item.close'>>().not.toExtend<OperationHandlers>();
  expect(Object.keys(registry).sort()).toEqual(OPERATIONS.map(({ id }) => id).sort());
  for (const { id } of OPERATIONS) expect(registry[id].id).toBe(id);
});

const entryTime = (hour: number) => `2026-11-04T0${String(hour)}:00:00.000Z`;
it('orders Todo-group visits by entry then journal position under a frozen clock', async () => {
  const store = openTempStore('board-manual-order-').store;
  stores.push(store);
  for (const id of [1, 2, 3, 4])
    await store.db
      .insertInto('task')
      .values({
        project: 'first',
        tracker_kind: 'github-issues',
        tracker_id: String(id),
        key: `o/first#${String(id)}`,
        membership: 'active',
        column: 'ready-for-dev',
        created_at: new Date(clock.now()).toISOString(),
      })
      .execute();
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const apply = createApply({ store, config, clock });
  const query = createQuery({ store, config, clock });
  await apply(
    registry['task.move'],
    { mode: 'manual', task: 'o/first#2', column: 'ready-for-dev', reason: 'Re-enter.' },
    'operator',
    'manual-two',
  );
  await apply(
    registry['task.move'],
    { mode: 'manual', task: 'o/first#1', column: 'ready-for-dev', reason: 'Re-enter again.' },
    'operator',
    'manual-one',
  );
  await store.db
    .insertInto('task')
    .values({
      project: 'first',
      tracker_kind: 'github-issues',
      tracker_id: '5',
      key: 'o/first#5',
      membership: 'active',
      column: 'ready-for-dev',
      created_at: new Date(clock.now()).toISOString(),
    })
    .execute();
  await store.db
    .insertInto('event')
    .values({
      actor: 'operator',
      actor_ref: null,
      request_id: null,
      v: 1,
      via: 'web',
      project: 'first',
      task_id: 5,
      kind: 'task_added',
      at: new Date(clock.now()).toISOString(),
      payload: JSON.stringify({ column: 'ready-for-dev' }),
    })
    .execute();
  for (const detail of [false, true]) {
    const status = await query(registry['status.get'], { project: 'first', detail }, 'operator');
    expect(status.tasks.map((task) => task.key)).toEqual([
      'o/first#3',
      'o/first#4',
      'o/first#2',
      'o/first#1',
      'o/first#5',
    ]);
    expect(new Set(status.tasks.map((task) => task.columnEnteredAt)).size).toBe(1);
  }
  const schema = await query(registry['schema.get'], {}, 'operator');
  expect(schema.operations.find((operation) => operation.id === 'task.move')).toMatchObject({
    explicitKeyModes: ['manual'],
    cli: { defaultMode: 'manual' },
  });
  const policies = await query(registry['columns.describe'], { project: 'first' }, 'operator');
  const movedBy = policies.projects[0]?.columns.find(
    (column) => column.id === 'ready-for-dev',
  )?.movedBy;
  expect(movedBy?.kind).toBe('manual');
  expect(movedBy?.text).toContain('Manual moves');
});
const move = (to: string, time: number, kind = 'task_moved', shadow = false) => ({
  kind,
  at: entryTime(time),
  payload: JSON.stringify({
    from: 'todo',
    to,
    reason: kind === 'task_corrected' ? 'Operator correction' : 'gate_passed',
    shadow,
  }),
});
it.each([
  { name: 'original add', events: [], expected: 0 },
  {
    name: 'two real moves',
    events: [move('dev', 1), move('review', 2)],
    expected: 2,
  },
  {
    name: 'later shadow move',
    events: [move('review', 1), move('review', 2, 'task_shadow_moved')],
    expected: 1,
  },
  {
    name: 'exit and return',
    events: [move('review', 1), move('dev', 2), move('review', 3)],
    expected: 3,
  },
  {
    name: 'real correction',
    events: [move('review', 1), move('review', 2, 'task_corrected')],
    expected: 2,
  },
  {
    name: 'shadow correction',
    events: [move('review', 1), move('review', 2, 'task_corrected', true)],
    expected: 1,
  },
  {
    name: 'journal order over timestamp',
    events: [move('review', 3), move('review', 1)],
    expected: 1,
  },
  {
    name: 'reactivation preserves original add',
    events: [],
    expected: 0,
  },
])('derives real column entry in both status modes: $name', async ({ name, events, expected }) => {
  const store = openTempStore('board-status-entry-').store;
  stores.push(store);
  const task = await store.db
    .insertInto('task')
    .values({
      project: 'first',
      tracker_kind: 'github-issues',
      tracker_id: '1',
      key: 'o/first#1',
      membership: 'active',
      column: 'review',
      created_at: entryTime(0),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const event of events)
    await store.db
      .insertInto('event')
      .values({
        ...event,
        task_id: task.id,
        project: 'first',
        actor: 'operator',
        actor_ref: null,
        v: 1,
        request_id: null,
      })
      .execute();
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  if (name === 'reactivation preserves original add') {
    const apply = createApply({ store, config, clock });
    await apply(registry['task.archive'], { task: 'o/first#1' }, 'operator');
    await apply(registry['task.add'], { task: 'o/first#1' }, 'operator');
  }
  const query = createQuery({ store, config, clock });
  for (const detail of [false, true]) {
    const status = await query(registry['status.get'], { detail }, 'operator');
    expect(status.tasks[0]?.columnEnteredAt).toBe(entryTime(expected));
  }
  const view = await query(registry['task.get'], { task: 'o/first#1', why: true }, 'operator');
  expect(view).not.toHaveProperty('columnEnteredAt');
});

it('registers status and limits an agent to its configured project', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  await scanTransaction(store, config, async (trx) => {
    for (const [project, key] of [
      ['first', 'o/first#1'],
      ['second', 'o/second#2'],
    ] as const) {
      await trx
        .insertInto('task')
        .values({
          project,
          tracker_kind: 'github-issues',
          tracker_id: key,
          key,
          membership: 'active',
          archive_reason: null,
          column: 'todo',
          shadow_column: null,
          created_at: new Date(clock.now()).toISOString(),
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
    }
    const block = {
      type: 'needs_input',
      reason: 'Restart?',
      // An operator's own block raises no item, so the item lists below stay as they are.
      author: 'operator',
      addressee_role: 'operator',
      state: 'open',
      created_at: new Date(clock.now()).toISOString(),
    } as const;
    await trx
      .insertInto('block')
      .values({ ...block, task_id: 1 })
      .execute();
    await trx
      .insertInto('block')
      .values({ ...block, project: 'first' })
      .execute();
  });
  const core = createObservationCore({ store, config, clock });
  for (const [source, message] of [
    ['github-issues:first:o/first', 'First source unavailable'],
    ['github-issues:second:o/second', 'Second source unavailable'],
  ] as const) {
    await core.reportSourceState(source, {
      blind: { reason: 'auth', message },
      gone: [],
    });
  }
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const status = registry['status.get'];
  const query = createQuery({ store, config, clock });
  const agent = 'agent:first-worker/session-1' as const;
  const visible = await query(status, {}, agent);
  expect(visible.tasks.map((task) => task.key)).toEqual(['o/first#1']);
  expect(visible.tasks.map((task) => task.openBlocks)).toEqual([1]);
  expect(visible.projectBlocks).toEqual([{ project: 'first', openBlocks: 1 }]);
  expect(visible.sources.every((source) => !source.source.includes('second'))).toBe(true);
  expect(visible.items.map((item) => item.summary)).toEqual([
    'github-issues:first:o/first: First source unavailable (not confirmed)',
  ]);
  await expect(query(status, { project: 'second' }, agent)).rejects.toMatchObject({
    code: 'forbidden',
  });
  const operator = await query(status, {}, 'operator');
  expect(operator.tasks.map((task) => task.key).sort()).toEqual(['o/first#1', 'o/second#2']);
  expect(operator.projectBlocks).toEqual([
    { project: 'first', openBlocks: 1 },
    { project: 'second', openBlocks: 0 },
  ]);
  expect(operator.items).toHaveLength(2);
  const schema = registry['schema.get'];
  const catalog = await query(schema, { role: 'worker' }, agent);
  expect(catalog.version).toMatch(/^[0-9a-f]{64}$/);
  expect(catalog.operations.map(({ id, cli }) => [id, cli.command])).toEqual(
    OPERATIONS.filter((operation) => roleCanUseOperation(operation, 'worker')).map((operation) => [
      operation.id,
      operation.cli.command,
    ]),
  );
  expect(catalog.operations.map(({ id }) => id)).toContain('comment.add');
  expect(catalog.operations.map(({ id }) => id)).not.toContain('task.add');
  expect(
    JSON.stringify(catalog.operations.find(({ id }) => id === 'status.get')?.outputSchema),
  ).toContain('columnEnteredAt');
  const all = await query(schema, {}, agent);
  expect(all.operations.map(({ id }) => id)).toEqual(OPERATIONS.map(({ id }) => id));
});

it('keeps board-wide items from a project agent on a one-project board', async () => {
  const oneProject = configSchema.parse({ ...config, projects: [config.projects[0]] });
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  await scanTransaction(store, config, async (trx) => {
    await raiseItem(trx, {
      itemKey: 'delivery:1',
      kind: 'post_failed',
      text: 'Board feed delivery failed',
      url: 'https://example.com/feed',
      taskId: null,
      blockId: null,
      at: new Date(clock.now()),
    });
  });
  const registry = createOperationRegistry({ config: oneProject, clock, completeSince: new Map() });
  const status = registry['status.get'];
  const query = createQuery({ store, config: oneProject, clock });
  const agent = await query(status, {}, 'agent:first-worker/session-1');
  expect(agent.items).toEqual([]);
  const operator = await query(status, {}, 'operator');
  expect(operator.items.map((item) => item.key)).toEqual(['delivery:1']);
});

it('reports transport state per gateway and keeps the health item board-wide', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const since = '2026-11-04T07:50:00.000Z';
  await scanTransaction(store, config, async (trx) => {
    await trx
      .insertInto('transport_health')
      .values(
        (['orchestrators', 'feed'] as const).map((space) => ({
          gateway: 'slack',
          space,
          reason: 'down',
          since,
          probe_at: since,
        })),
      )
      .execute();
    await raiseItem(trx, {
      itemKey: 'transport:slack',
      kind: 'transport_health',
      text: 'slack delivery down',
      url: '',
      taskId: null,
      blockId: null,
      priority: 1,
      at: new Date(clock.now()),
    });
  });
  const registry = createOperationRegistry({
    config,
    clock,
    completeSince: new Map(),
    gateways: ['slack'],
  });
  const status = registry['status.get'];
  const query = createQuery({ store, config, clock });
  const down = {
    gateway: 'slack',
    state: 'down',
    since,
    reason: 'down',
    spaces: ['feed', 'orchestrators'],
  };
  const operator = await query(status, {}, 'operator');
  expect(operator.transport).toEqual([down]);
  expect(operator.items.map((item) => item.key)).toEqual(['transport:slack']);
  const agent = await query(status, {}, 'agent:first-worker/session-1');
  expect(agent.transport).toEqual([down]);
  expect(agent.items).toEqual([]);
  const slackRow = (output: { services: { service: string }[] }) =>
    output.services.find((row) => row.service === 'slack');
  const failing = {
    service: 'slack',
    state: 'failing',
    since,
    lastGoodAt: null,
    reason: 'down',
  };
  expect(slackRow(operator)).toEqual(failing);
  expect(slackRow(agent)).toEqual(failing);
  expect(operator.services.map((row) => row.service)).toEqual([
    'daemon',
    'slack',
    'github',
    'spur',
  ]);

  const startedAt = new Date(clock.now()).toISOString();
  const healthy = (at: string) => ({
    service: 'slack',
    state: 'healthy',
    since: at,
    lastGoodAt: null,
    reason: null,
  });
  await scanTransaction(store, config, (trx) => trx.deleteFrom('transport_health').execute());
  expect((await query(status, {}, 'operator')).transport).toEqual([
    { gateway: 'slack', state: 'up', since: null, reason: null, spaces: [] },
  ]);
  expect(slackRow(await query(status, {}, 'operator'))).toEqual(healthy(startedAt));
  const clearedAt = '2026-11-04T08:05:00.000Z';
  await scanTransaction(store, config, async (trx) => {
    const item = await trx
      .selectFrom('operator_item')
      .select('id')
      .where('item_key', '=', 'transport:slack')
      .executeTakeFirstOrThrow();
    await clearItem(trx, item.id, new Date(clearedAt));
  });
  expect(slackRow(await query(status, {}, 'agent:first-worker/session-1'))).toEqual(
    healthy(clearedAt),
  );
  await scanTransaction(store, config, (trx) =>
    trx.updateTable('operator_item').set({ cleared_at: '2026-11-04T07:55:00.000Z' }).execute(),
  );
  expect(slackRow(await query(status, {}, 'operator'))).toEqual(healthy(startedAt));
  await scanTransaction(store, config, (trx) => trx.deleteFrom('operator_item').execute());
  expect(slackRow(await query(status, {}, 'operator'))).toEqual(healthy(startedAt));
});

it('rolls sources and the daemon into one health row per service', async () => {
  const healthConfig = configSchema.parse({
    projects: [
      {
        id: 'alpha',
        tracker: {
          type: 'jira',
          baseUrl: 'https://jira.example.test',
          jql: 'project = ALPHA',
          doneStatuses: ['Done'],
          readyStatuses: ['Ready'],
          projectKeys: ['ALPHA'],
        },
        repos: ['o/a'],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: 'alpha-worker', role: 'worker' }],
      },
      {
        id: 'beta',
        tracker: { type: 'github-issues', repo: 'o/b', label: 'board' },
        repos: ['o/b'],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: 'beta-worker', role: 'worker' }],
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
    thresholds: { staleMultiplier: 10 },
  });
  let now = Date.parse('2026-11-04T08:00:00.000Z');
  const movingClock = { now: () => now };
  const iso = () => new Date(now).toISOString();
  const startedAt = iso();
  let lastDispatchAt: string | null = startedAt;
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const core = createObservationCore({ store, config: healthConfig, clock: movingClock });
  // The sources the adapter runner pauses for the rate budget.
  const budgetWaits = new Set<string>();
  const registry = createOperationRegistry({
    config: healthConfig,
    clock: movingClock,
    completeSince: core.completeSince,
    healthySince: core.healthySince,
    budgetWaits: () => budgetWaits,
    lastDispatchAt: () => lastDispatchAt,
  });
  const query = createQuery({ store, config: healthConfig, clock: movingClock });
  const status = (
    actor: 'operator' | `agent:${string}/${string}` = 'operator',
    input: { project?: string } = {},
  ) => query(registry['status.get'], input, actor);
  const row = async (service: string, actor?: `agent:${string}/${string}`) =>
    (await status(actor)).services.find((entry) => entry.service === service);
  const githubAlpha = 'github:alpha:o/a';
  const issuesBeta = 'github-issues:beta:o/b';
  const githubBeta = 'github:beta:o/b';
  const sources = ['spur', 'jira:alpha', githubAlpha, issuesBeta, githubBeta];
  const observe = (
    source: string,
    options: {
      lastCompleteAt?: string;
      blind?: { reason: 'stale'; message: string };
      budget?: { remaining: number; limit: number; resetAt: string };
    } = {},
  ) =>
    core.observe(source, {
      batch: {
        source,
        observedAt: iso(),
        complete: true,
        items: [],
        entities: [],
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      },
      effectiveComplete: true,
      state: {
        lastCompleteAt: options.lastCompleteAt ?? iso(),
        gone: [],
        ...(options.blind === undefined ? {} : { blind: options.blind }),
      },
      outcomes: [],
    });

  expect(await row('github')).toEqual({
    service: 'github',
    state: 'degraded',
    since: null,
    lastGoodAt: null,
    reason: `${githubAlpha} warming up`,
  });

  // warmingUp follows the requested project, while sources still list every project.
  for (const source of ['spur', issuesBeta, githubBeta]) await observe(source);
  const betaWarming = await status('operator', { project: 'beta' });
  expect(betaWarming.warmingUp).toBe(false);
  expect(betaWarming.sources.map((entry) => entry.source)).toEqual(sources);
  expect((await status()).warmingUp).toBe(true);
  for (const source of sources) await observe(source);
  const healthy = (service: string, since: string, lastGoodAt: string | null = since) => ({
    service,
    state: 'healthy',
    since,
    lastGoodAt,
    reason: null,
  });
  expect((await status()).services).toEqual([
    healthy('daemon', startedAt),
    healthy('github', startedAt),
    healthy('spur', startedAt),
    healthy('jira', startedAt),
  ]);

  now += 30_000;
  const later = iso();
  await core.reportSourceState(githubAlpha, {
    gone: [],
    blind: { reason: 'auth', message: 'Bad credentials' },
  });
  expect(await row('github')).toEqual({
    service: 'github',
    state: 'failing',
    since: null,
    lastGoodAt: startedAt,
    reason: `${githubAlpha} blind (auth): Bad credentials`,
  });
  // The rollup of a project agent covers only the sources it sees.
  const agent = 'agent:beta-worker/session-1' as const;
  const agentView = await status(agent);
  expect(agentView.sources.map((entry) => entry.source)).toEqual(['spur', issuesBeta, githubBeta]);
  expect(agentView.services).toEqual([
    healthy('daemon', startedAt),
    healthy('github', startedAt),
    healthy('spur', startedAt),
  ]);
  expect(agentView.daemon.startedAt).toBe(startedAt);
  await observe(githubAlpha);
  expect(await row('github')).toEqual(healthy('github', later, startedAt));

  now += 30_000;
  const resetAt = new Date(now + 3_600_000).toISOString();
  await observe(issuesBeta, { budget: { remaining: 999, limit: 5000, resetAt } });
  budgetWaits.add(issuesBeta);
  expect(await row('github')).toEqual({
    service: 'github',
    state: 'degraded',
    since: null,
    lastGoodAt: startedAt,
    reason: `${issuesBeta} waits for its rate budget`,
  });
  expect((await status()).sources.find((entry) => entry.source === issuesBeta)?.healthySince).toBe(
    startedAt,
  );
  // The stored budget stays under the reserve; the row follows the runner's pause alone.
  budgetWaits.delete(issuesBeta);
  expect(await row('github')).toEqual(healthy('github', later, startedAt));

  await core.reportSourceState('jira:alpha', {
    lastCompleteAt: iso(),
    gone: [],
    blind: { reason: 'auth', message: 'Jira credential is missing' },
  });
  expect(await row('jira')).toEqual({
    service: 'jira',
    state: 'failing',
    since: null,
    lastGoodAt: startedAt,
    reason: 'jira:alpha blind (auth): Jira credential is missing',
  });
  // Another project's blind source still rolls into the services of a chosen project.
  const betaView = await status('operator', { project: 'beta' });
  expect(betaView.sources.map((entry) => [entry.source, entry.project])).toEqual([
    ['spur', null],
    ['jira:alpha', 'alpha'],
    [githubAlpha, 'alpha'],
    [issuesBeta, 'beta'],
    [githubBeta, 'beta'],
  ]);
  expect(betaView.services.find((entry) => entry.service === 'jira')).toMatchObject({
    state: 'failing',
    reason: 'jira:alpha blind (auth): Jira credential is missing',
  });
  expect(betaView.projectBlocks).toEqual([{ project: 'beta', openBlocks: 0 }]);
  expect((await status(agent, { project: 'beta' })).sources.map((entry) => entry.source)).toEqual([
    'spur',
    issuesBeta,
    githubBeta,
  ]);
  await observe('jira:alpha', { lastCompleteAt: new Date(now - 1_200_001).toISOString() });
  expect(await row('jira')).toEqual({
    service: 'jira',
    state: 'degraded',
    since: null,
    lastGoodAt: iso(),
    reason: 'jira:alpha stale',
  });
  await observe('jira:alpha');
  expect(await row('jira')).toEqual(healthy('jira', iso()));

  await observe('spur', { blind: { reason: 'stale', message: 'Spur polls keep failing' } });
  expect(await row('spur')).toEqual({
    service: 'spur',
    state: 'failing',
    since: null,
    lastGoodAt: iso(),
    reason: 'spur blind (stale): Spur polls keep failing',
  });

  lastDispatchAt = iso();
  now += 120_001;
  expect(await row('daemon')).toEqual({
    service: 'daemon',
    state: 'degraded',
    since: null,
    lastGoodAt: lastDispatchAt,
    reason: `no board tick completed since ${lastDispatchAt}`,
  });
  now -= 1;
  expect(await row('daemon')).toEqual(healthy('daemon', startedAt, lastDispatchAt));

  // An empty runner report preserves the accepted complete stamp. Process freshness still
  // makes the restarted source read as warming up until its first complete poll.
  const restarted = createObservationCore({ store, config: healthConfig, clock: movingClock });
  const restartedRegistry = createOperationRegistry({
    config: healthConfig,
    clock: movingClock,
    completeSince: restarted.completeSince,
    healthySince: restarted.healthySince,
    lastDispatchAt: () => lastDispatchAt,
  });
  const restartedGithub = async () =>
    (await query(restartedRegistry['status.get'], {}, 'operator')).services.find(
      (entry) => entry.service === 'github',
    );
  expect((await restartedGithub())?.reason).toBe(`${githubAlpha} warming up`);
  const previousComplete = (
    await query(restartedRegistry['status.get'], {}, 'operator')
  ).sources.find((entry) => entry.source === githubAlpha)?.lastCompleteAt;
  expect(previousComplete).toEqual(expect.any(String));
  await restarted.reportSourceState(githubAlpha, { gone: [] });
  expect(
    (await query(restartedRegistry['status.get'], {}, 'operator')).sources.find(
      (entry) => entry.source === githubAlpha,
    )?.lastCompleteAt,
  ).toBe(previousComplete);
  expect(await restartedGithub()).toMatchObject({
    state: 'degraded',
    reason: `${githubAlpha} warming up`,
  });
});

it('keeps the default status for 100 tasks under the budget and lists every item', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const at = new Date(clock.now()).toISOString();
  const sha = (n: number) => n.toString(16).padStart(40, 'a');
  const check = (n: number) => ({
    name: `ci / test-shard-${String(n)}`,
    state: 'success' as const,
    completedAt: at,
  });
  const prFacts = (number: number) => ({
    repo: 'o/first',
    number,
    url: `https://github.com/o/first/pull/${String(number)}`,
    title: `Fix the board status output for agents, part ${String(number)}`,
    author: 'worker-bot',
    headSha: sha(number),
    headBranch: `worker/fix-status-${String(number)}`,
    state: 'open' as const,
    draft: false,
    mergeable: 'mergeable' as const,
    mergeState: 'clean' as const,
    requiredChecks: [check(0)],
    checks: Array.from({ length: 13 }, (_, n) => check(n)),
    reviews: ['alice', 'bob'].map((reviewer) => ({
      reviewer,
      state: 'commented' as const,
      commitSha: sha(number),
      submittedAt: at,
    })),
    reviewThreads: Array.from({ length: 13 }, (_, n) => ({ resolved: n % 2 === 0 })),
    reviewRequests: [{ reviewer: 'carol', asCodeOwner: true }],
    ticketKeys: [`o/first#${String(number)}`],
    updatedAt: at,
  });
  const sessionFacts = (id: string) => ({
    id,
    spurProject: 'first-worker',
    branch: `worker/${id}`,
    pr: null,
    links: { log: `https://spur.example.com/sessions/${id}/log` },
    lifecycle: 'running' as const,
    health: 'working' as const,
    healthSince: at,
    lastActivityAt: at,
    endedAt: null,
    endReason: null,
  });
  const ticketFacts = (key: string, n: number) => ({
    trackerId: 'github-issues:o/first',
    id: `I_kwDOAbCdEf${String(n).padStart(6, '0')}`,
    key,
    title: `Make the board status readable for an agent with many tasks, case ${String(n)}`,
    status: 'In Progress',
    assignee: 'worker-bot',
    sprint: 'Sprint 42',
    labels: ['board', 'agent-surface', 'priority-high'],
    inFilter: true,
    url: `https://github.com/o/first/issues/${String(n)}`,
    updatedAt: at,
  });
  const ids: number[] = [];
  const items: { key: string; priority: number }[] = [];
  await scanTransaction(store, config, async (trx) => {
    for (let n = 1; n <= 100; n += 1) {
      const key = `o/first#${String(n)}`;
      const task = await trx
        .insertInto('task')
        .values({
          project: 'first',
          tracker_kind: 'github-issues',
          tracker_id: key,
          key,
          membership: 'active',
          archive_reason: null,
          column: 'dev',
          shadow_column: null,
          created_at: at,
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.push(task.id);
      // Task 100 stays unobserved.
      if (n === 100) continue;
      await trx
        .insertInto('ticket_snapshot')
        .values({
          task_id: task.id,
          status: 'In Progress',
          assignee: 'worker-bot',
          detail: JSON.stringify(ticketFacts(key, n)),
          source: 'github-issues:first:o/first',
          observed_at: at,
        })
        .execute();
    }
    const link = {
      pr_state: null,
      pr_open: null,
      role: null,
      source: 'branch',
      banned: 0,
      created_at: at,
      ticket_key: null,
    } as const;
    for (let n = 1; n <= 25; n += 1) {
      const facts = prFacts(n);
      await trx
        .insertInto('pr_snapshot')
        .values({
          repo: facts.repo,
          number: n,
          head_sha: facts.headSha,
          head_branch: facts.headBranch,
          state: 'open',
          draft: 0,
          mergeable: 'mergeable',
          merge_state: 'clean',
          detail: JSON.stringify(facts),
          source: 'github:first:o/first',
          observed_at: at,
        })
        .execute();
      // PRs 21-25 stay unlinked.
      if (n > 20) continue;
      await trx
        .insertInto('link')
        .values({
          ...link,
          task_id: ids[n - 1] ?? 0,
          entity: 'pr',
          repo: 'o/first',
          number: n,
          pr_state: 'active',
          pr_open: 1,
          session_id: null,
        })
        .execute();
    }
    for (let n = 1; n <= 33; n += 1) {
      const id = `session-${String(n)}`;
      await trx
        .insertInto('session_snapshot')
        .values({
          id,
          spur_project: 'first-worker',
          branch: `worker/${id}`,
          pr: null,
          raw_state: 'running',
          state: 'running',
          first_seen: at,
          last_seen: at,
          ended_at: null,
          end_reason: null,
          detail: JSON.stringify(sessionFacts(id)),
          source: 'spur',
          observed_at: at,
        })
        .execute();
      // Sessions 21-33 stay unlinked.
      if (n > 20) continue;
      await trx
        .insertInto('link')
        .values({
          ...link,
          role: 'worker',
          task_id: ids[n - 1] ?? 0,
          entity: 'session',
          repo: null,
          number: null,
          session_id: id,
        })
        .execute();
    }
    for (let n = 1; n <= 10; n += 1) {
      await trx
        .insertInto('block')
        .values({
          task_id: ids[n - 1] ?? 0,
          type: 'needs_input',
          reason: 'Which API version should the client target?',
          author: 'agent:first-worker/session-1',
          addressee_role: 'operator',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: at,
        })
        .execute();
    }
    for (let n = 1; n <= 12; n += 1) {
      const priority = [3, 1, 2][n % 3] ?? 4;
      const key = `item:${String(n)}`;
      items.push({ key, priority });
      await raiseItem(trx, {
        itemKey: key,
        kind: 'post_failed',
        text: `Item ${String(n)} needs the operator`,
        url: 'https://example.com/item',
        taskId: ids[n - 1] ?? null,
        blockId: null,
        priority,
        at: new Date(clock.now() + n * 1_000),
      });
    }
  });
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const status = registry['status.get'];
  const query = createQuery({ store, config, clock });

  const result = await query(status, {}, 'operator');
  // Compact navigation and summaries have a disclosed 100k fixture budget; full facts stay opt-in.

  // Measured on this fixture: baseline 25,071 chars; enriched compact 42,912 chars.
  expect(JSON.stringify(result).length).toBeLessThan(100_000);
  expect(Object.keys(result)[0]).toBe('items');
  expect(result.items.map((item) => item.key)).toEqual(
    items.toSorted((a, b) => a.priority - b.priority).map((item) => item.key),
  );
  const compact = [
    'blocks',
    'column',
    'columnEnteredAt',
    'key',
    'links',
    'membership',
    'openBlocks',
    'prCount',
    'prSummary',
    'project',
    'sessionCount',
    'shadowColumn',
    'shadowDiffers',
    'state',
    'submission',
    'turn',
  ];
  expect(result.tasks).toHaveLength(100);
  for (const row of result.tasks) {
    expect(Object.keys(row).sort()).toEqual(compact);
    for (const field of ['ticket', 'prs', 'sessions', 'handed', 'feedback', 'why'])
      expect(row).not.toHaveProperty(field);
    if (row.turn !== null) expect(row.turn).not.toHaveProperty('handed');
  }
  for (const detailField of [
    'handed',
    'feedback',
    'requiredChecks',
    'reviewThreads',
    'reviewRequests',
    'headBranch',
    'returned',
  ])
    expect(JSON.stringify(result.tasks)).not.toContain(`"${detailField}":`);
  const linked = result.tasks.find((row) => row.key === 'o/first#1');
  expect(linked).toEqual({
    submission: null,
    key: 'o/first#1',
    project: 'first',
    column: 'dev',
    columnEnteredAt: new Date(clock.now()).toISOString(),
    membership: 'active',
    shadowColumn: 'dev',
    shadowDiffers: false,
    state: 'ticket In Progress; PRs 1 open; sessions 1 working',
    prCount: 1,
    sessionCount: 1,
    openBlocks: 1,
    blocks: [{ id: 'B1', addressee: 'operator', session: null }],
    turn: null,
    prSummary: [
      {
        repo: 'o/first',
        number: 1,
        checks: { pass: 1, fail: 0, pending: 0 },
        mergeable: 'mergeable',
        threads: { unresolved: 6, total: 13 },
        reviewsOnHead: { approved: [], changesRequested: [] },
        draft: false,
        factAt: at,
        unconfirmed: true,
      },
    ],
    links: {
      ticket: 'https://github.com/o/first/issues/1',
      prs: [{ repo: 'o/first', number: 1, url: 'https://github.com/o/first/pull/1' }],
      sessions: [{ id: 'session-1' }],
    },
  });
  expect(result.tasks.find((row) => row.key === 'o/first#100')?.state).toBe('ticket not observed');
  expect(result.unlinkedPrs).toHaveLength(5);
  expect(result.unlinkedPrs[0]).toEqual({
    repo: 'o/first',
    number: 21,
    url: 'https://github.com/o/first/pull/21',
    title: prFacts(21).title,
    state: 'open',
    draft: false,
  });
  expect(result.unlinkedSessions).toHaveLength(13);
  expect(Object.keys(result.unlinkedSessions[0] ?? {}).sort()).toEqual([
    'branch',
    'health',
    'id',
    'lifecycle',
    'spurProject',
  ]);

  const detail = await query(status, { detail: true }, 'operator');
  expect(JSON.stringify(detail).length).toBeGreaterThan(60_000);
  const full = detail.tasks.find((row) => row.key === 'o/first#1');
  expect(full?.ticket).toEqual(ticketFacts('o/first#1', 1));
  expect(full?.prs).toEqual([prFacts(1)]);
  expect(full?.sessions).toEqual([
    {
      ...sessionFacts('session-1'),
      links: [{ label: 'log', url: 'https://spur.example.com/sessions/session-1/log' }],
    },
  ]);
  expect(full?.links).toEqual({
    ticket: 'https://github.com/o/first/issues/1',
    prs: [{ repo: 'o/first', number: 1, url: 'https://github.com/o/first/pull/1' }],
    sessions: [{ id: 'session-1' }],
  });
  expect(detail.tasks.find((row) => row.key === 'o/first#100')?.ticket).toBeNull();
  expect(detail.unlinkedPrs[0]?.checks).toHaveLength(13);
  expect(detail.unlinkedSessions[0]?.healthSince).toBe(at);
  expect(detail.items).toEqual(result.items);
});

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;

/**
 * Writes unlinked and linked PR and session rows aged around the 7-day window, and tasks.
 * Without `confirmedAbsent` no complete Spur poll has omitted a session yet.
 */
async function seedUnlinkedAges(store: Store, confirmedAbsent: boolean) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = clock.now();
  const prRow = (
    repo: string,
    number: number,
    state: 'open' | 'merged' | 'closed',
    age: number,
  ) => {
    const facts = {
      repo,
      number,
      url: `https://github.com/${repo}/pull/${String(number)}`,
      title: `Pull request ${String(number)}`,
      author: 'worker-bot',
      headSha: number.toString(16).padStart(40, 'a'),
      headBranch: `worker/pr-${String(number)}`,
      state,
      draft: false,
      mergeable: 'mergeable' as const,
      mergeState: 'clean' as const,
      requiredChecks: [],
      checks: [],
      reviews: [],
      reviewThreads: [],
      reviewRequests: [],
      ticketKeys: [],
      updatedAt: iso(now - age),
    };
    return {
      repo,
      number,
      head_sha: facts.headSha,
      head_branch: facts.headBranch,
      state,
      draft: 0 as const,
      mergeable: 'mergeable',
      merge_state: 'clean',
      detail: JSON.stringify(facts),
      source: `github:${repo === 'o/first' ? 'first' : 'second'}:${repo}`,
      observed_at: iso(now),
    };
  };
  const sessionRow = (
    id: string,
    spurProject: string,
    lifecycle: 'running' | 'stopped' | 'completed',
    seenAge: number,
    endedAge: number | null,
    absentAge: number | null = null,
    firstSeenAge = seenAge,
  ) => {
    const endedAt = endedAge === null ? null : iso(now - endedAge);
    const endReason = endedAge === null ? null : ('complete' as const);
    const facts = {
      id,
      spurProject,
      branch: `worker/${id}`,
      pr: null,
      links: {},
      lifecycle,
      health: 'working' as const,
      healthSince: iso(now - firstSeenAge),
      lastActivityAt: null,
      endedAt,
      endReason,
    };
    return {
      id,
      spur_project: spurProject,
      branch: facts.branch,
      pr: null,
      raw_state: lifecycle,
      state: lifecycle,
      first_seen: iso(now - firstSeenAge),
      last_seen: iso(now - seenAge),
      ended_at: endedAt,
      end_reason: endReason,
      detail: JSON.stringify(facts),
      source: 'spur',
      observed_at: iso(now),
      absent_since: absentAge === null || !confirmedAbsent ? null : iso(now - absentAge),
    };
  };
  const prs = [
    // Hidden: 30 merged and 5 closed, unchanged for 8 days.
    ...Array.from({ length: 30 }, (_, n) => prRow('o/first', n + 1, 'merged', 8 * DAY)),
    ...Array.from({ length: 5 }, (_, n) => prRow('o/first', n + 31, 'closed', 8 * DAY)),
    // Listed: open whatever its age, finished within the window, finished exactly at its edge.
    prRow('o/first', 40, 'open', 30 * DAY),
    prRow('o/first', 41, 'merged', 6 * DAY),
    prRow('o/first', 42, 'merged', WINDOW),
    // Linked: under its task, never counted.
    prRow('o/first', 50, 'merged', 8 * DAY),
    // Another project.
    prRow('o/second', 1, 'merged', 8 * DAY),
  ];
  const sessions = [
    // Hidden: ended 8 days ago while still in the list.
    ...Array.from({ length: 100 }, (_, n) =>
      sessionRow(`ended-${String(n)}`, 'first-worker', 'stopped', 0, 8 * DAY),
    ),
    // Hidden: last listed as completed 8 days ago, no end time.
    ...Array.from({ length: 50 }, (_, n) =>
      sessionRow(`completed-${String(n)}`, 'first-worker', 'completed', 8 * DAY, null),
    ),
    // Hidden only by complete Spur polls: last listed running, then omitted, 8 days ago.
    ...Array.from({ length: 50 }, (_, n) =>
      sessionRow(`gone-${String(n)}`, 'first-worker', 'running', 8 * DAY, null, 8 * DAY),
    ),
    // Listed: in the latest list, ended or gone within the window or exactly at its edge.
    sessionRow('live-old', 'first-worker', 'running', 0, null, null, 30 * DAY),
    sessionRow('ended-6d', 'first-worker', 'stopped', 0, 6 * DAY),
    sessionRow('gone-6d', 'first-worker', 'running', 6 * DAY, null, 6 * DAY),
    sessionRow('ended-7d', 'first-worker', 'stopped', 0, WINDOW),
    sessionRow('gone-7d', 'first-worker', 'running', WINDOW, null, WINDOW),
    // Listed: last listed 30 days ago, but no complete poll omitted it until 6 days ago.
    sessionRow('gone-late', 'first-worker', 'running', 30 * DAY, null, 6 * DAY),
    // Linked: under its task, never counted.
    sessionRow('linked-old', 'first-worker', 'stopped', 0, 8 * DAY),
    // Another project.
    sessionRow('second-old', 'second-worker', 'stopped', 0, 8 * DAY),
  ];
  await scanTransaction(store, config, async (trx) => {
    const task = await trx
      .insertInto('task')
      .values({
        project: 'first',
        tracker_kind: 'github-issues',
        tracker_id: 'o/first#1',
        key: 'o/first#1',
        membership: 'active',
        archive_reason: null,
        column: 'dev',
        shadow_column: null,
        created_at: iso(now),
        last_change_at: null,
        terminal_at: null,
        archive_slot_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const row of prs) await trx.insertInto('pr_snapshot').values(row).execute();
    for (const row of sessions) await trx.insertInto('session_snapshot').values(row).execute();
    const link = {
      task_id: task.id,
      role: null,
      source: 'branch',
      banned: 0,
      created_at: iso(now),
      ticket_key: null,
    } as const;
    await trx
      .insertInto('link')
      .values({
        ...link,
        entity: 'pr',
        repo: 'o/first',
        number: 50,
        pr_state: 'active',
        pr_open: 0,
        session_id: null,
      })
      .execute();
    await trx
      .insertInto('link')
      .values({
        ...link,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        pr_open: null,
        session_id: 'linked-old',
      })
      .execute();
  });
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const status = registry['status.get'];
  const query = createQuery({ store, config, clock });
  return (input: { project?: string; detail?: boolean }) => query(status, input, 'operator');
}

it('hides unlinked PRs and sessions finished over 7 days ago and counts them', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const status = await seedUnlinkedAges(store, true);
  const listedSessions = ['ended-6d', 'ended-7d', 'gone-6d', 'gone-7d', 'gone-late', 'live-old'];
  for (const detail of [false, true]) {
    const result = await status({ project: 'first', detail });
    expect(result.unlinkedPrs.map((pr) => pr.number).sort((a, b) => a - b)).toEqual([40, 41, 42]);
    expect(result.unlinkedSessions.map((session) => session.id).sort()).toEqual(listedSessions);
    expect(result.hiddenUnlinkedPrs).toBe(35);
    expect(result.hiddenUnlinkedSessions).toBe(200);
    const task = result.tasks.find((row) => row.key === 'o/first#1');
    expect([task?.prCount, task?.sessionCount]).toEqual([1, 1]);
  }
  const all = await status({});
  expect(all.unlinkedSessions.map((session) => session.id).sort()).toEqual(listedSessions);
  expect([all.hiddenUnlinkedPrs, all.hiddenUnlinkedSessions]).toEqual([36, 201]);
});

it('hides no session as gone from the list until a complete Spur poll omits it', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const status = await seedUnlinkedAges(store, false);
  const result = await status({ project: 'first' });
  const ids = result.unlinkedSessions.map((session) => session.id);
  for (let n = 0; n < 50; n += 1) expect(ids).toContain(`gone-${String(n)}`);
  expect(ids).not.toContain('completed-0');
  expect(ids).not.toContain('ended-0');
  expect(result.hiddenUnlinkedSessions).toBe(150);
});

it('reports the effective bindings of the projects a caller may see', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const boardWide = configSchema.parse({
    ...config,
    projects: config.projects.map((project) =>
      project.id === 'first'
        ? {
            ...project,
            spurProjects: [
              ...project.spurProjects,
              { name: 'first-ops', role: 'operator' },
              { name: 'first-rev', role: 'orchestrator' },
            ],
            columns: project.columns.map((column) =>
              column.id === 'review' ? { ...column, orchestrator: 'first-rev' } : column,
            ),
          }
        : project,
    ),
    spurProjects: [
      { name: 'br', role: 'orchestrator', columns: ['review'] },
      { name: 'hq', role: 'operator' },
    ],
  });
  const status = createOperationRegistry({
    config: boardWide,
    clock,
    completeSince: new Map(),
  })['status.get'];
  const query = createQuery({ store, config: boardWide, clock });
  const first = {
    columns: [{ project: 'first', column: 'review', orchestrator: 'first-rev', source: 'project' }],
    operators: [{ project: 'first', operator: 'first-ops', source: 'project' }],
  };
  const defaultAddressee = { spurProject: 'hq', source: 'board-wide' };
  expect((await query(status, {}, 'operator')).bindings).toEqual({
    columns: [
      ...first.columns,
      { project: 'second', column: 'review', orchestrator: 'br', source: 'board-wide' },
    ],
    operators: [...first.operators, { project: 'second', operator: 'hq', source: 'board-wide' }],
    defaultAddressee,
  });
  expect((await query(status, {}, 'agent:first-worker/session-1')).bindings).toEqual({
    ...first,
    defaultAddressee,
  });
});

it('lists other projects operators for a project without one while no board-wide operator exists', async () => {
  const store = openTempStore('board-registry-').store;
  stores.push(store);
  const shared = configSchema.parse({
    ...config,
    projects: config.projects.map((project) =>
      project.id === 'first'
        ? {
            ...project,
            spurProjects: [...project.spurProjects, { name: 'first-ops', role: 'operator' }],
          }
        : project,
    ),
  });
  const status = createOperationRegistry({
    config: shared,
    clock,
    completeSince: new Map(),
  })['status.get'];
  const query = createQuery({ store, config: shared, clock });
  expect((await query(status, {}, 'operator')).bindings).toEqual({
    columns: [],
    operators: [
      { project: 'first', operator: 'first-ops', source: 'project' },
      { project: 'second', operator: 'first-ops', source: 'other-project' },
    ],
    defaultAddressee: null,
  });
});

it.each([
  ['restores its own project task', 'first-ops', 'add', 'o/first#1', 'allowed'],
  ['restores another project task', 'first-ops', 'add', 'o/second#2', 'denied'],
  ['adds a new key', 'first-ops', 'add', 'o/first#9', 'denied'],
  ['adds a new key as board-wide operator', 'hq', 'add', 'o/first#9', 'allowed'],
  ['closes its own project item', 'first-ops', 'close', 'I1', 'allowed'],
  ['closes another project item', 'first-ops', 'close', 'I2', 'denied'],
  ['closes a board item', 'first-ops', 'close', 'I3', 'denied'],
  ['closes a board item as board-wide operator', 'hq', 'close', 'I3', 'allowed'],
] as const)(
  'scopes target-less operator operations to the owning project under a board-wide operator: %s',
  async (_name, operator, op, target, status) => {
    const store = openTempStore('board-registry-').store;
    stores.push(store);
    const boardWide = configSchema.parse({
      ...config,
      projects: config.projects.map((project) =>
        project.id === 'first'
          ? {
              ...project,
              spurProjects: [...project.spurProjects, { name: 'first-ops', role: 'operator' }],
            }
          : project,
      ),
      spurProjects: [{ name: 'hq', role: 'operator' }],
    });
    const at = new Date(clock.now());
    await scanTransaction(store, boardWide, async (trx) => {
      for (const [project, key, membership] of [
        ['first', 'o/first#1', 'archived'],
        ['second', 'o/second#2', 'archived'],
        ['first', 'o/first#3', 'active'],
        ['second', 'o/second#4', 'active'],
      ] as const) {
        await trx
          .insertInto('task')
          .values({
            project,
            tracker_kind: 'github-issues',
            tracker_id: key,
            key,
            membership,
            archive_reason: membership === 'archived' ? 'manual' : null,
            column: 'todo',
            shadow_column: null,
            created_at: at.toISOString(),
            last_change_at: null,
            terminal_at: null,
            archive_slot_at: null,
          })
          .execute();
      }
      for (const [itemKey, taskId] of [
        ['inbound:failure:first', 3],
        ['inbound:failure:second', 4],
        ['inbound:failure:board', null],
      ] as const) {
        await raiseItem(trx, {
          itemKey,
          kind: 'inbound_failure',
          text: 'An inbound reply failed',
          url: '',
          taskId,
          blockId: null,
          at,
        });
      }
    });
    const registry = createOperationRegistry({
      config: boardWide,
      clock,
      completeSince: new Map(),
    });
    const apply = createApply({ store, clock, config: boardWide });
    const actor = `agent:${operator}/session-1` as const;
    const run =
      op === 'add'
        ? apply(registry['task.add'], { task: target }, actor, 'k-1')
        : apply(registry['item.close'], { item: target }, actor, 'k-1');
    if (status === 'allowed') await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toMatchObject({ code: 'forbidden' });
  },
);

it.each([
  [
    'a project operator sees its own task delivery only',
    true,
    'agent:first-ops/s1',
    ['delivery:1'],
  ],
  [
    'the board-wide operator sees every item',
    true,
    'agent:hq/s1',
    ['delivery:1', 'delivery:2', 'delivery:3'],
  ],
  ['the token sees every item', true, 'operator', ['delivery:1', 'delivery:2', 'delivery:3']],
  ['a worker sees no delivery item', true, 'agent:first-worker/s1', []],
  [
    'a legacy project operator sees every item',
    false,
    'agent:first-ops/s1',
    ['delivery:1', 'delivery:2', 'delivery:3'],
  ],
  ['a legacy worker sees no delivery item', false, 'agent:first-worker/s1', []],
] as const)(
  'shows failed deliveries in status by their owning task: %s',
  async (_name, withBoardWide, actor, keys) => {
    const store = openTempStore('board-registry-').store;
    stores.push(store);
    const scoped = configSchema.parse({
      ...config,
      projects: config.projects.map((project) =>
        project.id === 'first'
          ? {
              ...project,
              spurProjects: [...project.spurProjects, { name: 'first-ops', role: 'operator' }],
            }
          : project,
      ),
      ...(withBoardWide ? { spurProjects: [{ name: 'hq', role: 'operator' }] } : {}),
    });
    const at = new Date(clock.now());
    await scanTransaction(store, scoped, async (trx) => {
      for (const [project, key] of [
        ['first', 'o/first#1'],
        ['second', 'o/second#2'],
      ] as const) {
        await trx
          .insertInto('task')
          .values({
            project,
            tracker_kind: 'github-issues',
            tracker_id: key,
            key,
            membership: 'active',
            archive_reason: null,
            column: 'todo',
            shadow_column: null,
            created_at: at.toISOString(),
            last_change_at: null,
            terminal_at: null,
            archive_slot_at: null,
          })
          .execute();
      }
      // Outbox rows 1 and 2 carry their task in the payload; row 3 is a board-level post.
      for (const [kind, payload] of [
        ['conversation.open', { taskId: 1 }],
        ['conversation.open', { taskId: 2 }],
        ['feed.line', {}],
      ] as const) {
        const row = await trx
          .insertInto('outbox')
          .values({
            kind,
            dedupe_key: `${kind}:${JSON.stringify(payload)}`,
            payload: JSON.stringify(payload),
            state: 'post_failed',
            next_at: at.toISOString(),
            last_error: 'gateway refused',
            external_ref: null,
            parent_outbox_id: null,
            first_attempt_at: null,
            first_delivery_at: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await raiseItem(trx, {
          itemKey: `delivery:${String(row.id)}`,
          kind: 'post_failed',
          text: 'A post failed',
          url: '',
          taskId: null,
          blockId: null,
          at,
        });
      }
    });
    const status = createOperationRegistry({ config: scoped, clock, completeSince: new Map() })[
      'status.get'
    ];
    const query = createQuery({ store, config: scoped, clock });
    const result = await query(status, {}, actor);
    expect(result.items.map((item) => item.key).sort()).toEqual(keys);
  },
);

it.each([
  ...configSchema.shape.projects.element.shape.spurProjects
    .unwrap()
    .element.shape.role.options.flatMap((role) => [
      { name: 'none', role, binding: 'none', kind: 'automatic' },
      { name: 'operator', role, binding: 'operator', kind: 'operator' },
    ]),
  { name: 'none-custom', role: 'orchestrator', binding: 'none-custom', kind: 'orchestrator' },
  { name: 'operator-custom', role: 'curator', binding: 'operator-custom', kind: 'curator' },
])(
  'keeps $binding routing distinct from a $role project named $name',
  async ({ name, role, binding, kind }) => {
    const store = openTempStore('board-config-sentinels-').store;
    stores.push(store);
    const effective = configSchema.parse({
      ...config,
      projects: config.projects.slice(0, 1).map((project) => ({
        ...project,
        spurProjects: [{ name, role }],
        columns: project.columns.map((column) => ({ ...column, orchestrator: binding })),
      })),
    });
    const registry = createOperationRegistry({
      config: effective,
      clock,
      completeSince: new Map(),
    });
    const query = createQuery({ store, config: effective, clock });
    const result = await query(registry['config.get'], {}, 'operator');
    expect(result.projects[0]?.spurProjects).toEqual([{ name, role, displayName: name }]);
    // Triage is listed disabled on the default board, so config.get leaves it out.
    expect(result.projects[0]?.columns).toStrictEqual(
      effective.projects[0]?.columns
        .filter((column) => column.enabled)
        .map((column) => ({
          id: column.id,
          executor: {
            kind:
              kind === 'automatic'
                ? column.id === 'external-review'
                  ? 'dispatcher'
                  : 'worker'
                : kind,
            name: binding === 'none' || binding === 'operator' ? null : name,
          },
          ...(column.id === 'todo' || column.id === 'ready-for-dev'
            ? { group: 'todo', source: { kind: 'manual' } }
            : {}),
          // A named orchestrator column shows its effective turn timings, here the defaults.
          ...(kind === 'orchestrator' || kind === 'curator'
            ? { quietTurnAfterMs: 1_800_000, noRecipientAfterMs: 600_000 }
            : {}),
        })),
    );
    expect(effective.projects[0]?.columns.every((column) => column.orchestrator === binding)).toBe(
      true,
    );
  },
);

it('status.get lists the Todo group with every built-in column of it, enabled or not', async () => {
  const store = openTempStore('board-column-groups-').store;
  stores.push(store);
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const query = createQuery({ store, config, clock });
  for (const input of [{}, { project: config.projects[0]?.id ?? '' }]) {
    const result = await query(registry['status.get'], input, 'operator');
    expect(result.columnGroups).toStrictEqual([
      { id: 'todo', columns: ['todo', 'triage', 'ready-for-dev'] },
    ]);
  }
  // The config leaves triage disabled: the group still lists it.
  expect(config.projects[0]?.columns.find((column) => column.id === 'triage')?.enabled).toBe(false);
});

it('allowlists effective configuration and applies status project visibility', async () => {
  const store = openTempStore('board-config-view-').store;
  stores.push(store);
  const effective = configSchema.parse({
    projects: [
      {
        id: 'first',
        tracker: { type: 'github-issues', repo: 'o/first', label: 'board' },
        repos: ['o/first'],
        operatorGithubLogin: 'operator',
        spurProjects: [
          { name: 'first-worker', role: 'worker' },
          { name: 'curator', role: 'curator', displayName: 'Curator' },
        ],
        columns: [
          { id: 'todo' },
          { id: 'dev', orchestrator: 'curator' },
          { id: 'review', enabled: false },
          { id: 'external-review' },
          { id: 'done', orchestrator: 'operator' },
        ],
        checksGate: 'external-review',
      },
      config.projects[1],
    ],
    spurProjects: [
      { name: 'reviewer', role: 'orchestrator', columns: ['todo'], displayName: 'Reviewer' },
      { name: 'desk', role: 'operator' },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
  // Simulate future runtime fields after validation: none may enter the explicit projection.
  for (const object of [
    effective,
    effective.projects[0],
    effective.projects[0]?.columns[0],
    effective.projects[0]?.spurProjects[0],
    effective.projects[0]?.dispatcher,
  ]) {
    Object.assign(object ?? {}, {
      token: 'credential-sentinel',
      slackToken: 'slack-sentinel',
      githubToken: 'github-sentinel',
      tokenFile: 'path-sentinel',
    });
  }
  const registry = createOperationRegistry({ config: effective, clock, completeSince: new Map() });
  const query = createQuery({ store, config: effective, clock });
  const result = await query(registry['config.get'], {}, 'agent:first-worker/session');
  expect(result).toStrictEqual({
    projects: [
      {
        id: 'first',
        columns: [
          {
            id: 'todo',
            executor: { kind: 'orchestrator', name: 'reviewer' },
            group: 'todo',
            source: { kind: 'manual' },
            quietTurnAfterMs: 1_800_000,
            noRecipientAfterMs: 600_000,
          },
          {
            id: 'dev',
            executor: { kind: 'curator', name: 'curator' },
            quietTurnAfterMs: 1_800_000,
            noRecipientAfterMs: 600_000,
          },
          { id: 'external-review', executor: { kind: 'dispatcher', name: null } },
          { id: 'done', executor: { kind: 'operator', name: null } },
        ],
        dispatcher: { mode: 'shadow' },
        spurProjects: [
          { name: 'first-worker', role: 'worker', displayName: 'first-worker' },
          { name: 'curator', role: 'curator', displayName: 'Curator' },
          { name: 'reviewer', role: 'orchestrator', displayName: 'Reviewer' },
          { name: 'desk', role: 'operator', displayName: 'desk' },
        ],
        ticketBrowseBase: null,
        checksGate: 'external-review',
      },
    ],
    web: { publicOrigin: null, spurUiOrigin: null },
  });
  for (const sentinel of [
    'credential-sentinel',
    'slack-sentinel',
    'github-sentinel',
    'path-sentinel',
    'tokenFile',
  ])
    expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(
    (await query(registry['config.get'], {}, 'operator')).projects.map((project) => project.id),
  ).toEqual(['first', 'second']);
  expect(
    (await query(registry['config.get'], { project: 'first' }, 'operator')).projects,
  ).toHaveLength(1);
  await expect(
    query(registry['config.get'], { project: 'second' }, 'agent:first-worker/session'),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const ordinary = createOperationRegistry({ config, clock, completeSince: new Map() });
  expect(
    (
      await createQuery({ store, config, clock })(ordinary['config.get'], {}, 'operator')
    ).projects[0]?.columns.find((column) => column.id === 'dev')?.executor,
  ).toEqual({ kind: 'worker', name: null });
});

it('config.get gives a Jira project its ticket browse base', async () => {
  const store = openTempStore('board-config-browse-').store;
  stores.push(store);
  const read = async (baseUrl: string, extra: Record<string, unknown> = {}) => {
    const effective = configSchema.parse({
      projects: [
        {
          id: 'alpha',
          tracker: {
            type: 'jira',
            baseUrl,
            jql: 'project = JQLSENTINEL',
            doneStatuses: ['DoneSentinel'],
            readyStatuses: ['ReadySentinel'],
            projectKeys: ['KEYSENTINEL'],
          },
          repos: ['o/a'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'alpha-worker', role: 'worker' }],
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    Object.assign(effective.projects[0]?.tracker ?? {}, extra);
    const registry = createOperationRegistry({
      config: effective,
      clock,
      completeSince: new Map(),
    });
    return createQuery({ store, config: effective, clock })(registry['config.get'], {}, 'operator');
  };
  for (const [baseUrl, expected] of [
    ['https://jira.example.test', 'https://jira.example.test/browse/'],
    ['https://jira.example.test/', 'https://jira.example.test/browse/'],
    ['https://jira.example.test/jira', 'https://jira.example.test/jira/browse/'],
  ] as const)
    expect((await read(baseUrl)).projects[0]?.ticketBrowseBase, baseUrl).toBe(expected);

  const result = await read(
    'https://bot%40example.test:jira-token-sentinel@jira.example.test/jira/?jql=x#frag',
    {
      email: 'email-sentinel@example.test',
      token: 'token-sentinel',
      apiToken: 'api-token-sentinel',
    },
  );
  expect(result.projects[0]?.ticketBrowseBase).toBe('https://jira.example.test/jira/browse/');
  const json = JSON.stringify(result);
  for (const sentinel of [
    'jira-token-sentinel',
    'email-sentinel',
    'token-sentinel',
    'api-token-sentinel',
    'bot',
    'JQLSENTINEL',
    'DoneSentinel',
    'ReadySentinel',
    'KEYSENTINEL',
    'jql',
    'frag',
    '@',
  ])
    expect(json).not.toContain(sentinel);
});

it('config.get reports resolved web origins', async () => {
  const store = openTempStore('board-config-web-').store;
  stores.push(store);
  const read = async (
    web: Record<string, unknown> | undefined,
    webOrigin?: () => string | undefined,
  ) => {
    const effective = configSchema.parse({
      projects: [config.projects[0]],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
      ...(web === undefined ? {} : { web }),
    });
    const registry = createOperationRegistry({
      config: effective,
      clock,
      completeSince: new Map(),
      ...(webOrigin === undefined ? {} : { webOrigin }),
    });
    return (
      await createQuery({ store, config: effective, clock })(registry['config.get'], {}, 'operator')
    ).web;
  };
  expect(await read(undefined)).toEqual({ publicOrigin: null, spurUiOrigin: null });
  expect(
    await read({
      port: 4312,
      publicOrigin: 'https://{port}.x.test',
      spurUiOrigin: 'https://spur.x.test',
    }),
  ).toEqual({ publicOrigin: 'https://4312.x.test', spurUiOrigin: 'https://spur.x.test' });
  const unbound = { port: 0, publicOrigin: 'http://127.0.0.1:{port}' };
  expect(await read(unbound)).toEqual({ publicOrigin: null, spurUiOrigin: null });
  expect(await read(unbound, () => 'http://127.0.0.1:45678')).toEqual({
    publicOrigin: 'http://127.0.0.1:45678',
    spurUiOrigin: null,
  });
});

it('lists open task blocks with addressee and assigned session', async () => {
  const store = openTempStore('board-status-blocks-').store;
  stores.push(store);
  const at = new Date(clock.now()).toISOString();
  const task = await store.db
    .insertInto('task')
    .values({
      project: 'first',
      tracker_kind: 'github-issues',
      tracker_id: '1',
      key: 'o/first#1',
      membership: 'active',
      column: 'dev',
      created_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const block = async (
    addressee: 'operator' | 'worker' | 'curator',
    closed?: 'reason' | 'withdrawn',
  ) =>
    (
      await store.db
        .insertInto('block')
        .values({
          task_id: task.id,
          type: 'needs_input',
          reason: 'Which API?',
          author: 'agent:first-worker/session-1',
          addressee_role: addressee,
          state: closed === undefined ? 'open' : 'unblocked',
          outcome: closed ?? null,
          created_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const notify = async (blockId: number, role: 'worker' | 'curator', recipient: string) => {
    await store.db
      .insertInto('notification')
      .values({
        task_id: task.id,
        block_id: blockId,
        source_key: `block:${String(blockId)}:${role}:${recipient}`,
        kind: 'block',
        role,
        recipient_session: recipient,
        next_at: at,
        created_at: at,
      })
      .execute();
  };
  await block('operator');
  const b2 = await block('worker');
  await notify(b2, 'worker', 'old');
  await notify(b2, 'worker', 'latest');
  // Escalated from the worker to the curator: the curator's notice names the session.
  const b3 = await block('curator');
  await notify(b3, 'worker', 'w');
  await notify(b3, 'curator', 'c');
  await notify(await block('worker', 'reason'), 'worker', 'answered');
  await notify(await block('worker', 'withdrawn'), 'worker', 'withdrawn');
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const result = await createQuery({ store, config, clock })(
    registry['status.get'],
    {},
    'operator',
  );
  const row = result.tasks.find((entry) => entry.key === 'o/first#1');
  expect(row?.blocks).toEqual([
    { id: 'B1', addressee: 'operator', session: null },
    { id: 'B2', addressee: 'worker', session: 'latest' },
    { id: 'B3', addressee: 'curator', session: 'c' },
  ]);
  expect(row?.openBlocks).toBe(3);
});

it('loads compact turns once per page with newest turn notices and unchanged task read slope', async () => {
  const { store, file } = openTempStore('board-status-turns-');
  stores.push(store);
  const at = new Date(clock.now()).toISOString();
  const stalledAt = new Date(clock.now() - 600_000).toISOString();
  const addTasks = async (from: number, to: number) => {
    for (let n = from; n <= to; n += 1) {
      const task = await store.db
        .insertInto('task')
        .values({
          project: 'first',
          tracker_kind: 'github-issues',
          tracker_id: String(n),
          key: `o/first#${String(n)}`,
          membership: 'active',
          column: 'dev',
          created_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Open blocks, their notifications and a return on every task keep the read count flat.
      const blockValues = {
        task_id: task.id,
        type: 'needs_input',
        reason: 'Which API?',
        author: 'agent:first-worker/session-1',
        state: 'open',
        created_at: at,
      } as const;
      const workerBlock = await store.db
        .insertInto('block')
        .values({ ...blockValues, addressee_role: 'worker' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await store.db
        .insertInto('block')
        .values({ ...blockValues, addressee_role: 'operator' })
        .execute();
      await store.db
        .insertInto('notification')
        .values({
          task_id: task.id,
          block_id: workerBlock.id,
          source_key: `block:${String(workerBlock.id)}:worker`,
          kind: 'block',
          role: 'worker',
          recipient_session: `blocked-${String(n)}`,
          next_at: at,
          created_at: at,
        })
        .execute();
      await store.db
        .insertInto('event')
        .values({
          at,
          project: 'first',
          task_id: task.id,
          kind: 'task_moved',
          actor: 'agent',
          actor_ref: JSON.stringify({ project: 'first-reviewer', session: 'rev-1' }),
          payload: JSON.stringify({ from: 'review', to: 'dev', turn: 'T900', block: 'B900' }),
          v: 1,
          request_id: null,
        })
        .execute();
      if (n === 4) continue;
      const turn = await store.db
        .insertInto('turn')
        .values({
          task_id: task.id,
          column: 'dev',
          epoch: 0,
          seq: 1,
          role: n === 3 ? 'operator' : 'worker',
          reason: 'Act on this task',
          handed: '[]',
          acked_by: n === 2 ? 'agent:first-worker/holder' : null,
          acked_at: n === 2 ? at : null,
          closed_at: n === 5 ? at : null,
          closed_reason: n === 5 ? 'submitted' : null,
          created_at: at,
          head_sha: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (n === 1)
        await store.db
          .insertInto('operator_item')
          .values({
            item_key: `turn-stall:${String(turn.id)}:worker-1:needs_input:${stalledAt}:1`,
            raise_no: 1,
            kind: 'anomaly',
            text: 'Worker stalled',
            url: 'https://example.com/stall',
            task_id: task.id,
            block_id: null,
            raised_at: at,
            cleared_at: null,
            line_outbox_id: null,
            fact_at: stalledAt,
            inbound_event_json: null,
          })
          .execute();
      if (n === 3 || n > 5) continue;
      for (const [kind, recipient] of [
        ['turn', 'old'],
        ['turn', 'latest'],
        ['turn_reminder', 'reminder'],
      ] as const) {
        await store.db
          .insertInto('notification')
          .values({
            task_id: task.id,
            turn_id: turn.id,
            source_key: `${String(n)}:${kind}:${recipient}`,
            kind,
            role: 'worker',
            recipient_session: recipient,
            next_at: at,
            created_at: at,
          })
          .execute();
      }
    }
  };
  await addTasks(1, 1);
  const statements: string[] = [];
  const db = new Kysely<Tables>({
    dialect: new SqliteDialect({
      database: new Database(file, { readonly: true, fileMustExist: true }),
    }),
    log: (event) => {
      if (event.level === 'query') statements.push(event.query.sql);
    },
  });
  try {
    const read = () => getStatus({ store: { db }, config, clock, completeSince: new Map() });
    const small = await read();
    const smallQueries = statements.splice(0);
    expect(small.tasks[0]?.turn).toMatchObject({
      taken: null,
      addressedTo: 'latest',
      stalledSince: stalledAt,
    });
    await addTasks(2, 40);
    const many = await read();
    const manyQueries = statements.splice(0);
    const turnQueries = (queries: string[]) =>
      queries.filter((query) => query.includes('from "turn"'));
    expect(turnQueries(smallQueries)).toHaveLength(1);
    expect(turnQueries(manyQueries)).toHaveLength(1);
    for (const queries of [smallQueries, manyQueries]) {
      const grouped = queries.filter((query) => query.includes('max("entry"."id")'));
      expect(grouped).toHaveLength(1);
      expect(grouped[0]).toContain('group by "entry"."task_id"');
      expect(grouped[0]).not.toContain('where "entry"."task_id" =');
    }
    expect(small.tasks[0]?.columnEnteredAt).toBe(at);
    // Existing ticket and link reads remain two per added task; enrichment adds no slope.
    expect(manyQueries.length - smallQueries.length).toBe(39 * 2);
    // One turn query and one block query read notifications, whatever the task count.
    expect(manyQueries.filter((query) => query.includes('notification'))).toHaveLength(2);
    const count = (queries: string[], text: string) =>
      queries.filter((query) => query.includes(text)).length;
    expect(count(manyQueries, '"event"')).toBe(count(smallQueries, '"event"'));
    expect(count(manyQueries, 'from "block"')).toBe(count(smallQueries, 'from "block"'));
    expect(many.tasks).toHaveLength(40);
    expect(many.tasks[1]?.turn?.stalledSince).toBeNull();
    for (const row of many.tasks) {
      expect(row.columnEnteredAt).toBe(at);
      expect(row.blocks).toHaveLength(2);
      expect(row.openBlocks).toBe(2);
      expect(row.returned).toMatchObject({ from: 'review', block: 'B900', findings: null });
    }
    expect(many.tasks[1]?.turn).toMatchObject({
      taken: { by: 'agent:first-worker/holder', at },
      addressedTo: null,
    });
    expect(many.tasks[2]?.turn).toMatchObject({
      addressee: 'operator',
      taken: null,
      addressedTo: null,
    });
    expect(many.tasks[3]?.turn).toBeNull();
    expect(many.tasks[4]?.turn).toBeNull();
    expect(many.tasks[5]?.turn).toMatchObject({ taken: null, addressedTo: null });
    for (const row of many.tasks)
      if (row.turn !== null) {
        expect(Object.keys(row.turn).sort()).toEqual([
          'addressedTo',
          'addressee',
          'at',
          'column',
          'head',
          'id',
          'reason',
          'stalledSince',
          'taken',
          'task',
        ]);
      }
    expect(
      OPERATIONS.find((operation) => operation.id === 'status.get')?.output.safeParse(many).success,
    ).toBe(true);
  } finally {
    await db.destroy();
  }
});

it('summarizes each observed PR without gates and exposes effective navigation before observation', async () => {
  const store = openTempStore('board-status-summary-').store;
  stores.push(store);
  const at = new Date(clock.now()).toISOString();
  const head = 'a'.repeat(40);
  const oldHead = 'b'.repeat(40);
  const source = 'github:first:o/first';
  const facts = (number: number) => ({
    repo: 'o/first',
    number,
    url: `https://github.com/o/first/pull/${String(number)}`,
    title: 'A PR',
    author: 'author',
    headSha: head,
    headBranch: 'branch',
    state: 'open' as const,
    draft: true,
    mergeable: number === 1 ? ('conflicting' as const) : ('unknown' as const),
    mergeState: 'unknown' as const,
    requiredChecks:
      number === 1 ? [{ name: 'required', state: 'success' as const, completedAt: at }] : [],
    checks: CHECK_STATES.map((state) => ({ name: state, state, completedAt: at })),
    reviews: [
      { reviewer: 'approved', state: 'approved' as const, commitSha: head, submittedAt: at },
      {
        reviewer: 'changes',
        state: 'changes_requested' as const,
        commitSha: head,
        submittedAt: at,
      },
      { reviewer: 'old', state: 'approved' as const, commitSha: oldHead, submittedAt: at },
      { reviewer: 'comment', state: 'commented' as const, commitSha: head, submittedAt: at },
    ],
    reviewThreads: [{ resolved: false }, { resolved: true }, { resolved: false }],
    reviewRequests: [],
    ticketKeys: [],
    updatedAt: at,
  });
  for (const [key, tracker, url] of [
    ['o/first#1', 'github-issues', 'https://github.com/o/first/issues/1'],
    ['PROJ-2', 'jira', 'https://jira.example.com/browse/PROJ-2'],
  ] as const) {
    const task = await store.db
      .insertInto('task')
      .values({
        project: 'first',
        tracker_kind: tracker,
        tracker_id: key,
        key,
        membership: 'active',
        column: 'dev',
        created_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await store.db
      .insertInto('ticket_snapshot')
      .values({
        task_id: task.id,
        status: 'open',
        assignee: null,
        source: 'tracker',
        observed_at: at,
        detail: JSON.stringify({
          trackerId: 'tracker',
          id: key,
          key,
          title: 'Ticket',
          status: 'open',
          assignee: null,
          sprint: null,
          labels: [],
          inFilter: true,
          url,
          updatedAt: at,
        }),
      })
      .execute();
    if (tracker === 'jira') continue;
    for (const number of [1, 2, 3, 4]) {
      await store.db
        .insertInto('link')
        .values({
          task_id: task.id,
          entity: 'pr',
          repo: 'o/first',
          number,
          pr_state: number === 1 ? 'active' : 'conflict',
          pr_open: 1,
          source: 'manual',
          banned: number === 4 ? 1 : 0,
          created_at: at,
        })
        .execute();
      if (number > 2) continue;
      const pr = facts(number);
      await store.db
        .insertInto('pr_snapshot')
        .values({
          repo: pr.repo,
          number,
          head_sha: head,
          head_branch: 'branch',
          state: 'open',
          draft: 1,
          mergeable: pr.mergeable,
          merge_state: 'unknown',
          source,
          observed_at: at,
          detail: JSON.stringify(pr),
        })
        .execute();
    }
    for (const [id, banned] of [
      ['unobserved', 0],
      ['removed', 1],
    ] as const)
      await store.db
        .insertInto('link')
        .values({
          task_id: task.id,
          entity: 'session',
          session_id: id,
          role: 'worker',
          source: 'manual',
          banned,
          created_at: at,
        })
        .execute();
  }
  const query = createQuery({ store, config, clock });
  const status = createOperationRegistry({ config, clock, completeSince: new Map() })['status.get'];
  const read = () => query(status, {}, 'operator');
  const missingSource = await read();
  expect(missingSource.tasks[0]?.prSummary?.every((pr) => pr.unconfirmed)).toBe(true);
  await store.db
    .insertInto('source_state')
    .values({
      source,
      observed_at: at,
      last_complete_at: at,
      blind_reason: null,
      blind_message: null,
    })
    .execute();
  const result = await read();
  expect(result.tasks[0]?.prSummary).toEqual([
    {
      repo: 'o/first',
      number: 1,
      checks: { pass: 1, fail: 0, pending: 0 },
      mergeable: 'conflicting',
      threads: { unresolved: 2, total: 3 },
      reviewsOnHead: { approved: ['approved'], changesRequested: ['changes'] },
      draft: true,
      factAt: at,
      unconfirmed: false,
    },
    {
      repo: 'o/first',
      number: 2,
      checks: { pass: 2, fail: 7, pending: 2 },
      mergeable: 'unknown',
      threads: { unresolved: 2, total: 3 },
      reviewsOnHead: { approved: ['approved'], changesRequested: ['changes'] },
      draft: true,
      factAt: at,
      unconfirmed: false,
    },
  ]);
  expect(result.tasks[0]?.links).toEqual({
    ticket: 'https://github.com/o/first/issues/1',
    prs: [1, 2, 3].map((number) => ({
      repo: 'o/first',
      number,
      url: `https://github.com/o/first/pull/${String(number)}`,
    })),
    sessions: [{ id: 'unobserved' }],
  });
  expect(result.tasks[1]?.links).toEqual({
    ticket: 'https://jira.example.com/browse/PROJ-2',
    prs: [],
    sessions: [],
  });
  expect(result.tasks[1]?.prSummary).toBeNull();
  const detail = await query(status, { detail: true }, 'operator');
  expect(detail.tasks.map((task) => task.links)).toEqual(result.tasks.map((task) => task.links));
  expect(detail.tasks[0]?.prs).toHaveLength(2);
  await store.db
    .updateTable('pr_snapshot')
    .set({ observed_at: '2020-01-01T00:00:00.000Z' })
    .where('number', '=', 1)
    .execute();
  expect((await read()).tasks[0]?.prSummary?.map((pr) => pr.unconfirmed)).toEqual([true, false]);
  await store.db
    .updateTable('source_state')
    .set({ blind_reason: 'auth', blind_message: 'Unavailable' })
    .where('source', '=', source)
    .execute();
  expect((await read()).tasks[0]?.prSummary?.every((pr) => pr.unconfirmed)).toBe(true);
});

it('reports a GitHub Project mirror in config.get, status.get and columns.describe by one health rule', async () => {
  const mirrorConfig = configSchema.parse({
    projects: [
      {
        id: 'beta',
        tracker: { type: 'github-issues', repo: 'o/b', label: 'board' },
        repos: ['o/b'],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: 'beta-worker', role: 'worker' }],
        columns: [
          { id: 'todo' },
          {
            id: 'ready-for-dev',
            source: { type: 'tracker', project: 'acme/7', field: 'Status', value: 'Ready' },
          },
          { id: 'dev' },
          { id: 'done' },
        ],
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
    thresholds: { staleMultiplier: 10 },
  });
  let now = Date.parse('2026-11-04T08:00:00.000Z');
  const movingClock = { now: () => now };
  const iso = () => new Date(now).toISOString();
  const store = openTempStore('board-registry-mirror-').store;
  stores.push(store);
  const core = createObservationCore({ store, config: mirrorConfig, clock: movingClock });
  const budgetWaits = new Set<string>();
  const registry = createOperationRegistry({
    config: mirrorConfig,
    clock: movingClock,
    completeSince: core.completeSince,
    healthySince: core.healthySince,
    budgetWaits: () => budgetWaits,
  });
  const query = createQuery({ store, config: mirrorConfig, clock: movingClock });
  const mirror = 'github-project:beta:acme/7';
  const status = () => query(registry['status.get'], {}, 'operator');
  const service = async () =>
    (await status()).services.find((entry) => entry.service === 'github-project');
  const source = async () =>
    (await query(registry['config.get'], {}, 'operator')).projects[0]?.columns.map(
      (column) => column.source,
    );
  const observe = (id: string, mirrorRead?: { title: string }) =>
    core.observe(id, {
      batch: {
        source: id,
        observedAt: iso(),
        complete: true,
        items: [],
        entities: [],
        ...(mirrorRead === undefined ? {} : { mirror: { ...mirrorRead, readiness: [] } }),
      },
      effectiveComplete: true,
      state: { lastCompleteAt: iso(), gone: [] },
      outcomes: [],
    });
  const MANUAL = { kind: 'manual' };
  const shape = { kind: 'mirror', tracker: 'github-project', project: 'acme/7' };
  const target = { field: 'Status', value: 'Ready' };

  // Before the first read: named by the configured Project, degraded, never read.
  expect(await source()).toEqual([
    MANUAL,
    { ...shape, name: 'acme/7', ...target, health: 'degraded', readAt: null },
    undefined,
    undefined,
  ]);
  expect(await service()).toEqual({
    service: 'github-project',
    state: 'degraded',
    since: null,
    lastGoodAt: null,
    reason: `${mirror} warming up`,
  });
  // The board never waits on the mirror: warmingUp follows the other sources only.
  for (const id of ['spur', 'github-issues:beta:o/b', 'github:beta:o/b']) await observe(id);
  const before = await status();
  expect(before.warmingUp).toBe(false);
  expect(before.sources.map((entry) => entry.source)).toEqual([
    'spur',
    'github-issues:beta:o/b',
    'github:beta:o/b',
    mirror,
  ]);
  expect(before.sources.find((entry) => entry.source === mirror)).toMatchObject({
    project: 'beta',
    failure: null,
  });
  expect(before.sources.filter((entry) => 'failure' in entry).map((entry) => entry.source)).toEqual(
    [mirror],
  );

  await observe(mirror, { title: 'Roadmap' });
  const readAt = iso();
  expect(await source()).toEqual([
    MANUAL,
    { ...shape, name: 'Roadmap', ...target, health: 'healthy', readAt },
    undefined,
    undefined,
  ]);
  expect(await service()).toEqual({
    service: 'github-project',
    state: 'healthy',
    since: readAt,
    lastGoodAt: readAt,
    reason: null,
  });

  now += 30_000;
  budgetWaits.add(mirror);
  expect(await service()).toMatchObject({
    state: 'degraded',
    reason: `${mirror} waits for its rate budget`,
  });
  expect((await source())?.[1]).toMatchObject({ health: 'degraded' });

  // A coded failure outranks the budget wait in both reads.
  await core.reportSourceState(mirror, {
    gone: [],
    failure: { code: 'mirror_rate_limited', message: 'GitHub rate limit reached' },
  });
  expect(await service()).toMatchObject({
    state: 'failing',
    reason: `${mirror} failing (mirror_rate_limited): GitHub rate limit reached`,
  });
  expect((await source())?.[1]).toEqual({
    ...shape,
    name: 'Roadmap',
    ...target,
    health: 'failing',
    readAt,
    error: { code: 'mirror_rate_limited', message: 'GitHub rate limit reached' },
  });
  expect((await status()).sources.find((entry) => entry.source === mirror)?.failure).toEqual({
    code: 'mirror_rate_limited',
    message: 'GitHub rate limit reached',
  });

  // The next complete read clears the failure and keeps its title.
  budgetWaits.delete(mirror);
  await observe(mirror, { title: 'Roadmap' });
  expect((await source())?.[1]).toEqual({
    ...shape,
    name: 'Roadmap',
    ...target,
    health: 'healthy',
    readAt: iso(),
  });

  const described = await query(registry['columns.describe'], {}, 'operator');
  const movedBy = described.projects[0]?.columns.map((column) => [column.id, column.movedBy.kind]);
  expect(movedBy).toEqual([
    ['todo', 'manual'],
    ['ready-for-dev', 'mirror'],
    ['dev', 'dispatcher'],
    ['done', 'dispatcher'],
  ]);
  expect(described.projects[0]?.columns[1]?.movedBy.text).toContain('GitHub Project acme/7');
});

it('gives no source a failure key without a mirror', async () => {
  const store = openTempStore('board-registry-no-mirror-').store;
  stores.push(store);
  const core = createObservationCore({ store, config, clock });
  const registry = createOperationRegistry({ config, clock, completeSince: core.completeSince });
  const result = await createQuery({ store, config, clock })(
    registry['status.get'],
    {},
    'operator',
  );
  expect(result.sources.length).toBeGreaterThan(0);
  expect(result.sources.filter((entry) => 'failure' in entry)).toEqual([]);
  expect(result.services.map((entry) => entry.service)).not.toContain('github-project');
});
