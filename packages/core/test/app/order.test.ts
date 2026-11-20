import { configSchema, type ActorId, type ColumnId, type PrPoller } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandError,
  createApply,
  createOperationRegistry,
  createQuery,
  type Store,
} from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

const AT = '2026-11-04T08:00:00.000Z';

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function boardConfig(options: { mirror?: boolean } = {}) {
  const project = (id: string, repo: string) => ({
    id,
    tracker: { type: 'github-issues', repo, label: 'board' },
    repos: [repo],
    operatorGithubLogin: 'operator',
    columns: [
      { id: 'todo', orchestrator: 'none' },
      { id: 'triage', orchestrator: 'none' },
      {
        id: 'ready-for-dev',
        orchestrator: 'none',
        ...(options.mirror === true
          ? { source: { type: 'tracker', project: 'acme/7', field: 'Status', value: 'Ready' } }
          : {}),
      },
      { id: 'dev', orchestrator: 'none' },
      { id: 'review', orchestrator: 'none' },
      { id: 'qa', orchestrator: 'none' },
      { id: 'ready-to-merge', orchestrator: 'none' },
      { id: 'done', orchestrator: 'none' },
    ],
    dispatcher: { mode: 'on' },
  });
  return configSchema.parse({
    projects: [project('proj', 'o/r'), project('other', 'o/s')],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
}

/** Seeds `todo` with o/r#1..#4 in that order and returns the board's entry points. */
async function setup(options: { mirror?: boolean; todo?: number } = {}) {
  const config = boardConfig(options);
  let now = Date.parse(AT);
  // Each read advances the clock, so seeded tasks get distinct creation times.
  const clock = { now: () => (now += 1_000) };
  const store = openTempStore('board-order-').store;
  stores.push(store);
  const polls: unknown[] = [];
  const pollPr: PrPoller['pollPr'] = (...args) => {
    polls.push(args);
    return Promise.reject(new Error('No poll expected'));
  };
  const registry = createOperationRegistry({
    config,
    clock,
    completeSince: new Map(),
    prPoller: () => pollPr,
  });
  const apply = createApply({ store, clock, config });
  const query = createQuery({ store, clock, config });
  const insert = (key: string, column: ColumnId, extra: { project?: string } = {}) =>
    store.transaction(async (trx) => {
      await trx
        .insertInto('task')
        .values({
          project: extra.project ?? 'proj',
          tracker_kind: 'github-issues',
          tracker_id: key,
          key,
          membership: 'active',
          archive_reason: null,
          column,
          shadow_column: null,
          created_at: new Date(clock.now()).toISOString(),
          manual_include: 1,
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
    });
  for (let n = 1; n <= (options.todo ?? 4); n++) await insert(`o/r#${String(n)}`, 'todo');

  let keys = 0;
  const order = (
    input:
      | { mode: 'before' | 'after'; task: string; anchor: string }
      | { mode: 'top' | 'bottom'; task: string },
    key = `order-${String((keys += 1))}`,
    actor: ActorId = 'operator',
  ) => apply(registry['task.order'], input, actor, key);

  /** Live keys of a (project, column), by stored position. */
  const column = async (id: ColumnId, project = 'proj') =>
    (
      await store.db
        .selectFrom('task')
        .select('key')
        .where('project', '=', project)
        .where('column', '=', id)
        .where('membership', '!=', 'archived')
        .orderBy('position')
        .execute()
    ).map((row) => row.key);

  /** Every live (project, column) holds exactly 1..n. */
  async function expectDense() {
    const rows = await store.db
      .selectFrom('task')
      .select(['project', 'column', 'position'])
      .where('membership', '!=', 'archived')
      .execute();
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const group = `${row.project}/${row.column}`;
      groups.set(group, [...(groups.get(group) ?? []), row.position]);
    }
    for (const [group, positions] of groups)
      expect(
        positions.sort((a, b) => a - b),
        group,
      ).toEqual(positions.map((_position, index) => index + 1));
  }

  const tables = () =>
    Promise.all(
      (['task', 'event', 'command'] as const).map((table) =>
        store.db.selectFrom(table).selectAll().execute(),
      ),
    );

  return {
    store,
    config,
    registry,
    apply,
    query,
    polls,
    insert,
    order,
    column,
    expectDense,
    tables,
    status: () => query(registry['status.get'], {}, 'operator'),
    events: (kind: string) =>
      store.db
        .selectFrom('event')
        .select(['kind', 'payload', 'actor', 'task_id'])
        .where('kind', '=', kind)
        .orderBy('id')
        .execute(),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

describe('task.order placement', () => {
  it.each([
    {
      input: { mode: 'before', task: 'o/r#4', anchor: 'o/r#2' } as const,
      order: ['o/r#1', 'o/r#4', 'o/r#2', 'o/r#3'],
      reply: { position: 2, previous: 'o/r#1', next: 'o/r#2' },
    },
    {
      input: { mode: 'after', task: 'o/r#1', anchor: 'o/r#3' } as const,
      order: ['o/r#2', 'o/r#3', 'o/r#1', 'o/r#4'],
      reply: { position: 3, previous: 'o/r#3', next: 'o/r#4' },
    },
    {
      input: { mode: 'top', task: 'o/r#3' } as const,
      order: ['o/r#3', 'o/r#1', 'o/r#2', 'o/r#4'],
      reply: { position: 1, previous: null, next: 'o/r#1' },
    },
    {
      input: { mode: 'bottom', task: 'o/r#2' } as const,
      order: ['o/r#1', 'o/r#3', 'o/r#4', 'o/r#2'],
      reply: { position: 4, previous: 'o/r#4', next: null },
    },
  ])('places $input.mode and returns the position and neighbours', async ({ input, ...want }) => {
    const ctx = await setup();
    const result = await ctx.order(input);
    expect(result).toEqual({
      task: { key: input.task, project: 'proj', column: 'todo', membership: 'active' },
      ...want.reply,
    });
    expect(await ctx.column('todo')).toEqual(want.order);
    await ctx.expectDense();
    const from = Number(input.task.split('#')[1]);
    expect(await ctx.events('task_reordered')).toEqual([
      {
        kind: 'task_reordered',
        payload: JSON.stringify({ column: 'todo', from, to: want.reply.position }),
        actor: 'operator',
        task_id: from,
      },
    ]);
  });

  it('writes no event and no task row for a placement that keeps the place', async () => {
    const ctx = await setup();
    const tasks = await ctx.store.db.selectFrom('task').selectAll().execute();
    expect(await ctx.order({ mode: 'after', task: 'o/r#2', anchor: 'o/r#1' })).toMatchObject({
      position: 2,
      previous: 'o/r#1',
      next: 'o/r#3',
    });
    expect(await ctx.order({ mode: 'top', task: 'o/r#1' })).toMatchObject({ position: 1 });
    expect(await ctx.store.db.selectFrom('task').selectAll().execute()).toEqual(tasks);
    expect(await ctx.events('task_reordered')).toEqual([]);
  });

  it('keeps status row order and column entry times and reports every position', async () => {
    const ctx = await setup();
    const before = await ctx.status();
    expect(before.tasks.map((row) => [row.key, row.position])).toEqual([
      ['o/r#1', 1],
      ['o/r#2', 2],
      ['o/r#3', 3],
      ['o/r#4', 4],
    ]);
    await ctx.order({ mode: 'top', task: 'o/r#4' });
    const after = await ctx.status();
    expect(after.tasks.map((row) => row.key)).toEqual(before.tasks.map((row) => row.key));
    expect(after.tasks.map((row) => row.columnEnteredAt)).toEqual(
      before.tasks.map((row) => row.columnEnteredAt),
    );
    const stored = await ctx.column('todo');
    for (const row of after.tasks) expect(row.position).toBe(stored.indexOf(row.key) + 1);
    expect(after.tasks.map((row) => row.position)).toEqual([2, 3, 4, 1]);
  });

  it('journals the reorder but leaves it out of task.history', async () => {
    const ctx = await setup();
    await ctx.order({ mode: 'top', task: 'o/r#3' });
    expect(await ctx.events('task_reordered')).toHaveLength(1);
    const history = await ctx.query(ctx.registry['task.history'], { task: 'o/r#3' }, 'operator');
    expect(history.events.map((event) => event.kind)).not.toContain('task_reordered');
  });

  it('changes only positions: no column, epoch, last change, turn or submission writes', async () => {
    const ctx = await setup();
    const strip = (rows: { position: number }[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'position')));
    const before = await ctx.store.db.selectFrom('task').selectAll().orderBy('id').execute();
    await ctx.order({ mode: 'bottom', task: 'o/r#1' });
    const after = await ctx.store.db.selectFrom('task').selectAll().orderBy('id').execute();
    expect(strip(after)).toEqual(strip(before));
    expect(await ctx.store.db.selectFrom('turn').selectAll().execute()).toEqual([]);
    expect(await ctx.store.db.selectFrom('submission').selectAll().execute()).toEqual([]);
  });

  it('reorders a mirrored ready-for-dev column without a tracker call', async () => {
    const ctx = await setup({ mirror: true, todo: 0 });
    for (const n of [1, 2, 3]) await ctx.insert(`o/r#${String(n)}`, 'ready-for-dev');
    expect(await ctx.order({ mode: 'top', task: 'o/r#3' })).toMatchObject({
      task: { column: 'ready-for-dev' },
      position: 1,
      next: 'o/r#1',
    });
    expect(await ctx.column('ready-for-dev')).toEqual(['o/r#3', 'o/r#1', 'o/r#2']);
    expect(ctx.polls).toEqual([]);
  });

  it('takes the short key of a configured repo for the task and the anchor', async () => {
    const ctx = await setup();
    expect(await ctx.order({ mode: 'before', task: 'r#4', anchor: 'r#1' })).toMatchObject({
      position: 1,
      next: 'o/r#1',
    });
  });
});

describe('task.order refusals', () => {
  async function refusalBoard() {
    const ctx = await setup();
    await ctx.insert('o/r#5', 'triage');
    await ctx.insert('o/s#1', 'todo', { project: 'other' });
    await ctx.insert('o/r#6', 'todo');
    await ctx.apply(ctx.registry['task.archive'], { task: 'o/r#6' }, 'operator', 'archive-6');
    return ctx;
  }

  it.each([
    { name: 'the task itself', anchor: 'o/r#2' },
    { name: 'an unknown task', anchor: 'o/r#99' },
    { name: 'an unresolvable short key', anchor: 'nope#1' },
    { name: 'an archived task', anchor: 'o/r#6' },
    { name: 'a task in another column', anchor: 'o/r#5' },
    { name: 'a task in another project', anchor: 'o/s#1' },
  ])('refuses an anchor that is $name without writes', async ({ anchor }) => {
    const ctx = await refusalBoard();
    const before = await ctx.tables();
    for (const mode of ['before', 'after'] as const) {
      const error: unknown = await ctx.order({ mode, task: 'o/r#2', anchor }).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(CommandError);
      if (!(error instanceof CommandError)) continue;
      expect(error.code).toBe('order_anchor_invalid');
      expect(error.hint).toContain('--top or --bottom');
    }
    expect(await ctx.tables()).toEqual(before);
  });

  it('refuses an unknown task with not_found and an archived one with task_archived', async () => {
    const ctx = await refusalBoard();
    const before = await ctx.tables();
    await expect(ctx.order({ mode: 'top', task: 'o/r#99' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(ctx.order({ mode: 'top', task: 'o/r#6' })).rejects.toMatchObject({
      code: 'task_archived',
    });
    expect(await ctx.tables()).toEqual(before);
  });

  it.each(['<missing>', '', '   '])('requires an explicit key %j', async (key) => {
    const ctx = await setup();
    const before = await ctx.tables();
    await expect(
      ctx.apply(
        ctx.registry['task.order'],
        { mode: 'top', task: 'o/r#2' },
        'operator',
        key === '<missing>' ? undefined : key,
      ),
    ).rejects.toMatchObject({ code: 'usage' });
    expect(await ctx.tables()).toEqual(before);
  });

  it('refuses every caller but the operator', async () => {
    const ctx = await setup();
    await expect(
      ctx.order({ mode: 'top', task: 'o/r#2' }, 'order-1', 'agent:worker/worker-1'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await ctx.column('todo')).toEqual(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4']);
  });
});

describe('task.order concurrency and retry', () => {
  it('serializes two concurrent reorders on one store', async () => {
    const ctx = await setup();
    const [top, bottom] = await Promise.all([
      ctx.order({ mode: 'top', task: 'o/r#4' }),
      ctx.order({ mode: 'bottom', task: 'o/r#1' }),
    ]);
    expect(await ctx.column('todo')).toEqual(['o/r#4', 'o/r#2', 'o/r#3', 'o/r#1']);
    expect(top.position).toBe(1);
    expect(bottom.position).toBe(4);
    await ctx.expectDense();
  });

  it('gives one of the serial results for two crossing reorders', async () => {
    const b = { mode: 'before', task: 'o/r#2', anchor: 'o/r#3' } as const;
    const c = { mode: 'before', task: 'o/r#3', anchor: 'o/r#2' } as const;
    const serial = async (first: 'b' | 'c') => {
      const ctx = await setup();
      const replies =
        first === 'b'
          ? { b: await ctx.order(b), c: await ctx.order(c) }
          : { c: await ctx.order(c), b: await ctx.order(b) };
      return { order: await ctx.column('todo'), replies };
    };
    const runs = [await serial('b'), await serial('c')];
    const ctx = await setup();
    const [replyB, replyC] = await Promise.all([ctx.order(b), ctx.order(c)]);
    const order = await ctx.column('todo');
    await ctx.expectDense();
    // Each reply is what its commit saw, so the pair equals the serial run with the same result.
    const match = runs.find((run) => JSON.stringify(run.order) === JSON.stringify(order));
    expect(match).toBeDefined();
    expect({ b: replyB, c: replyC }).toEqual(match?.replies);
  });

  it('replays a same-key retry with the stored reply and refuses changed input', async () => {
    const ctx: Ctx = await setup();
    const first = await ctx.order({ mode: 'before', task: 'o/r#4', anchor: 'o/r#1' }, 'same');
    await ctx.order({ mode: 'bottom', task: 'o/r#4' }, 'other');
    const events = await ctx.events('task_reordered');
    const tasks = await ctx.store.db.selectFrom('task').selectAll().execute();
    expect(await ctx.order({ mode: 'before', task: 'o/r#4', anchor: 'o/r#1' }, 'same')).toEqual(
      first,
    );
    expect(await ctx.events('task_reordered')).toEqual(events);
    expect(await ctx.store.db.selectFrom('task').selectAll().execute()).toEqual(tasks);
    await expect(
      ctx.order({ mode: 'before', task: 'o/r#4', anchor: 'o/r#2' }, 'same'),
    ).rejects.toMatchObject({ code: 'idempotency_key_mismatch' });
  });
});

describe('column position on entry', () => {
  const positions = async (ctx: Ctx) =>
    Object.fromEntries(
      (
        await ctx.store.db
          .selectFrom('task')
          .select(['key', 'position'])
          .where('membership', '!=', 'archived')
          .execute()
      ).map((row) => [row.key, row.position]),
    );

  it('appends a task added through task.add', async () => {
    const ctx = await setup({ todo: 1 });
    await ctx.apply(ctx.registry['task.add'], { task: 'o/r#7' }, 'operator', 'add-7');
    expect(await positions(ctx)).toEqual({ 'o/r#1': 1, 'o/r#7': 2 });
  });

  it('appends a manual move and closes the gap it leaves', async () => {
    const ctx = await setup({ todo: 3 });
    await ctx.insert('o/r#5', 'ready-for-dev');
    await ctx.apply(
      ctx.registry['task.move'],
      { mode: 'manual', task: 'o/r#1', column: 'ready-for-dev', reason: 'Ready.' },
      'operator',
      'move-1',
    );
    expect(await ctx.column('ready-for-dev')).toEqual(['o/r#5', 'o/r#1']);
    expect(await ctx.column('todo')).toEqual(['o/r#2', 'o/r#3']);
    await ctx.expectDense();
  });

  it('puts a same-column manual move last as a new visit', async () => {
    const ctx = await setup({ todo: 3 });
    await ctx.apply(
      ctx.registry['task.move'],
      { mode: 'manual', task: 'o/r#1', column: 'todo', reason: 'Again.' },
      'operator',
      'move-1',
    );
    expect(await ctx.column('todo')).toEqual(['o/r#2', 'o/r#3', 'o/r#1']);
    await ctx.expectDense();
  });

  it('appends a correction in on mode', async () => {
    const ctx = await setup({ todo: 3 });
    await ctx.insert('o/r#5', 'triage');
    await ctx.apply(
      ctx.registry['task.move'],
      { mode: 'correct', task: 'o/r#2', column: 'triage', reason: 'Wrong column.' },
      'operator',
      'correct-1',
    );
    expect(await ctx.column('triage')).toEqual(['o/r#5', 'o/r#2']);
    expect(await ctx.column('todo')).toEqual(['o/r#1', 'o/r#3']);
    await ctx.expectDense();
  });

  it('closes the gap of an archive and appends the task when it is added again', async () => {
    const ctx = await setup({ todo: 3 });
    await ctx.apply(ctx.registry['task.archive'], { task: 'o/r#1' }, 'operator', 'archive-1');
    expect(await positions(ctx)).toEqual({ 'o/r#2': 1, 'o/r#3': 2 });
    await ctx.apply(ctx.registry['task.add'], { task: 'o/r#1' }, 'operator', 'add-1');
    expect(await positions(ctx)).toEqual({ 'o/r#1': 3, 'o/r#2': 1, 'o/r#3': 2 });
  });
});
