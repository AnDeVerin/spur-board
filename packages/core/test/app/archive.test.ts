import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ActorId } from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  createSender,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';
import { reconcileDoorbells } from '../../src/app/doorbells.ts';
import { raiseItem } from '../../src/app/feed.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { observeGateway, observeSpur } from '../support/observe.ts';
import { sampleRows } from '../store/sample-rows.ts';

const KEY = 'o/r#9';
const base = Date.parse('2026-11-04T12:00:00.000Z');
let now = base;
const clock = { now: () => now };
const worker = 'agent:web/worker-1' as const;
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'web', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const tracker = 'github-issues:board:o/r';
const github = 'github:board:o/r';
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  now = base;
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a registered operation');
  return value;
}

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'core-archive-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  const core = createObservationCore({ store, config, clock });
  const registry = createOperationRegistry({ config, clock, completeSince: core.completeSince });
  const fake = createFakeGateway({ profile: 'slack-like' });
  const observed = observeGateway(fake, file);
  const spur = observeSpur(file);
  const sender = createSender({
    store,
    gateway: observed.gateway,
    spur: spur.spur,
    config,
    now: () => new Date(now),
    spaceIntervalMs: 0,
  });
  const raw = createApply({ store, clock, config });
  let keys = 0;
  // Agent mutations need an idempotency key; each call here is a new command.
  const apply: typeof raw = (op, input, actor) => raw(op, input, actor, `k-${String(++keys)}`);
  const query = createQuery({ store, config, clock });
  const ops = {
    ask: required(registry['block.ask']),
    create: required(registry['block.create']),
    answer: required(registry['block.answer']),
    unblock: required(registry['block.unblock']),
    comment: required(registry['comment.add']),
    ack: required(registry['inbox.ack']),
    add: required(registry['task.add']),
    archive: required(registry['task.archive']),
    retry: required(registry['item.retry']),
    close: required(registry['item.close']),
    get: required(registry['task.get']),
    history: required(registry['task.history']),
    status: required(registry['status.get']),
  };
  async function poll(source: string, inFilter?: boolean, status = 'open') {
    const at = new Date(now).toISOString();
    const items =
      inFilter === undefined
        ? []
        : [
            {
              kind: 'ticket' as const,
              facts: {
                trackerId: tracker,
                id: 'node-9',
                key: KEY,
                title: 'Ticket',
                status,
                assignee: null,
                sprint: null,
                labels: ['board'],
                inFilter,
                url: 'https://github.com/o/r/issues/9',
                updatedAt: at,
              },
            },
          ];
    await core.observe(source, {
      batch: { source, observedAt: at, complete: true, items, entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
  }
  async function drain() {
    for (let i = 0; i < 20; i += 1) {
      await sender.tick();
      const pending = await store.db
        .selectFrom('outbox')
        .select('id')
        .where('state', 'in', ['pending', 'post_failed'])
        .execute();
      if (pending.length === 0) return;
    }
    throw new Error('Outbox did not drain');
  }
  return { store, core, fake, observed, spur, sender, apply, query, ops, poll, drain };
}

type Ctx = ReturnType<typeof setup>;

/** Q1 delivered with a thread, Q2 with its open still pending, and an operator external block. */
async function openBlocks(ctx: Ctx) {
  const q1 = (await ctx.apply(ctx.ops.ask, { task: KEY, text: 'First question?' }, worker)).block
    .id;
  await ctx.drain();
  const q2 = (await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Second question?' }, worker)).block
    .id;
  const external = (
    await ctx.apply(
      ctx.ops.create,
      { task: KEY, type: 'external', reason: 'Waits for the vendor.' },
      'operator',
    )
  ).block.id;
  return { q1, q2, external };
}

async function outboxFor(store: Store, kind: string, blockId: string) {
  const rows = await store.db
    .selectFrom('outbox')
    .select(['id', 'kind', 'state', 'last_error', 'payload'])
    .where('kind', '=', kind)
    .execute();
  return rows.filter(
    (row) => (JSON.parse(row.payload) as { blockId?: number }).blockId === Number(blockId.slice(1)),
  );
}

async function events(store: Store, kind: string) {
  const rows = await store.db
    .selectFrom('event')
    .select(['actor', 'payload'])
    .where('kind', '=', kind)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({ actor: row.actor, payload: JSON.parse(row.payload) as unknown }));
}

async function liveWorker(store: Store) {
  await store.transaction((trx) =>
    trx
      .insertInto('session_snapshot')
      .values({
        ...sampleRows.session_snapshot,
        id: 'worker-1',
        spur_project: 'web',
        state: 'waiting',
        ended_at: null,
        end_reason: null,
      })
      .execute(),
  );
}

describe('task archive', () => {
  it.each(['manual', 'out_of_filter'] as const)(
    '%s archive clears blocks, closes the delivered thread and cancels the undelivered open',
    async (path) => {
      const ctx = setup();
      await ctx.poll(tracker, true);
      const { q1, q2, external } = await openBlocks(ctx);
      expect(ctx.fake.platform.conversations()).toHaveLength(1);
      const actor: ActorId = path === 'manual' ? 'operator' : 'system';
      if (path === 'manual') {
        await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
      } else {
        for (const source of [tracker, 'spur', github, tracker]) {
          now += 1_000;
          await ctx.poll(source);
        }
      }
      expect(
        await ctx.store.db
          .selectFrom('task')
          .select(['membership', 'archive_reason'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ membership: 'archived', archive_reason: path });
      const sent = ctx.observed.requests.length;
      await ctx.drain();

      const blocks = await ctx.store.db
        .selectFrom('block')
        .select(['id', 'state', 'outcome', 'outcome_reason', 'unblocked_by'])
        .orderBy('id')
        .execute();
      expect(blocks).toEqual(
        [q1, q2, external].map((id) => ({
          id: Number(id.slice(1)),
          state: 'unblocked',
          outcome: 'archived',
          outcome_reason: null,
          unblocked_by: actor,
        })),
      );
      expect(ctx.fake.platform.conversations()).toMatchObject([{ done: true }]);
      const after = ctx.observed.requests.slice(sent);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ target: { kind: 'close' } });
      expect(JSON.stringify(after[0])).toContain(`resolved: task archived (${actor})`);
      expect(JSON.stringify(ctx.observed.requests)).not.toContain('Second question?');
      for (const kind of ['conversation.open', 'conversation.close']) {
        expect(await outboxFor(ctx.store, kind, q2)).toMatchObject([
          { state: 'dead', last_error: 'superseded' },
        ]);
      }
      expect(await events(ctx.store, 'task_archived')).toEqual([
        { actor, payload: { reason: path } },
      ]);
      expect(await events(ctx.store, 'block_unblocked')).toEqual(
        [q1, q2, external].map((id) => ({ actor, payload: { block: id, outcome: 'archived' } })),
      );
      expect(ctx.observed.violations).toEqual([]);
    },
  );

  it('archive cancels pending doorbells', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true);
    await liveWorker(ctx.store);
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Which version?' }, worker);
    await ctx.apply(ctx.ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
    await ctx.store.transaction((trx) => reconcileDoorbells(trx, new Date(now), config));
    const notification = await ctx.store.db
      .selectFrom('notification')
      .select(['id', 'last_outbox_id'])
      .where('kind', '=', 'answer')
      .executeTakeFirstOrThrow();
    expect(notification.last_outbox_id).not.toBeNull();

    await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
    await ctx.sender.tick();
    now += 24 * 60 * 60 * 1_000;
    await ctx.sender.tick();

    const rings = await ctx.store.db
      .selectFrom('outbox')
      .select(['id', 'state', 'last_error'])
      .where('kind', '=', 'doorbell')
      .execute();
    expect(rings).toEqual([
      { id: notification.last_outbox_id, state: 'dead', last_error: 'superseded' },
    ]);
    expect(ctx.spur.sends).toEqual([]);
  });

  it('starts no new ring for an archived task', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true);
    await liveWorker(ctx.store);
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Which version?' }, worker);
    await ctx.apply(ctx.ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
    await ctx.drain();
    expect(ctx.spur.sends).toHaveLength(1);

    await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
    now += 24 * 60 * 60 * 1_000;
    await ctx.sender.tick();
    await ctx.sender.tick();

    expect(ctx.spur.sends).toHaveLength(1);
    expect(
      await ctx.store.db.selectFrom('outbox').select('id').where('kind', '=', 'doorbell').execute(),
    ).toHaveLength(1);
  });

  it('archive clears the feed items of the task before their lines are sent', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true);
    const { q2 } = await openBlocks(ctx);
    await tickBoard({ store: ctx.store, config, clock, completeSince: ctx.core.completeSince });
    const item = await ctx.store.db
      .selectFrom('operator_item')
      .select(['id', 'kind', 'block_id', 'line_outbox_id', 'text'])
      .where('item_key', '=', `operator-block:${q2.slice(1)}`)
      .executeTakeFirstOrThrow();
    expect(item).toMatchObject({ kind: 'board_observation', block_id: null });
    expect(
      await ctx.store.db
        .selectFrom('outbox')
        .select('state')
        .where('id', '=', item.line_outbox_id ?? -1)
        .executeTakeFirst(),
    ).toEqual({ state: 'pending' });

    await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
    await ctx.drain();

    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select('cleared_at')
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ cleared_at: new Date(now).toISOString() });
    const lines = await ctx.store.db
      .selectFrom('outbox')
      .select(['kind', 'state', 'last_error'])
      .where((eb) =>
        eb.or([
          eb('id', '=', item.line_outbox_id ?? -1),
          eb('parent_outbox_id', '=', item.line_outbox_id ?? -1),
        ]),
      )
      .orderBy('id')
      .execute();
    expect(lines).toEqual([
      { kind: 'feed.line', state: 'dead', last_error: 'superseded' },
      { kind: 'feed.line.edit', state: 'dead', last_error: 'superseded' },
    ]);
    expect(JSON.stringify(ctx.fake.platform.messages())).not.toContain(item.text);
  });

  it('only task.add, inbox.ack and item.close pass on an archived task', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true);
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Which version?' }, worker);
    const answered = await ctx.apply(
      ctx.ops.answer,
      { block: asked.block.id, text: 'Use v2.' },
      'operator',
    );
    const external = await ctx.apply(
      ctx.ops.create,
      { task: KEY, type: 'external', reason: 'Waits for the vendor.' },
      'operator',
    );
    const failure = await scanTransaction(ctx.store, (trx) =>
      raiseItem(trx, {
        itemKey: 'inbound:failure:archive',
        kind: 'inbound_failure',
        text: 'An inbound reply failed',
        url: 'https://github.com/o/r/issues/9',
        taskId: 1,
        blockId: null,
        at: new Date(now),
      }),
    );
    await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
    await expect(ctx.apply(ctx.ops.archive, { task: KEY }, 'operator')).rejects.toMatchObject({
      code: 'task_archived',
    });

    await expect(
      ctx.apply(ctx.ops.ask, { task: KEY, text: 'Another?' }, worker),
    ).rejects.toMatchObject({ code: 'task_archived' });
    await expect(
      ctx.apply(ctx.ops.comment, { task: KEY, text: 'Note.' }, worker),
    ).rejects.toMatchObject({ code: 'task_archived' });
    await expect(
      ctx.apply(
        ctx.ops.unblock,
        { mode: 'reason', block: external.block.id, reason: 'Vendor replied.' },
        'operator',
      ),
    ).rejects.toMatchObject({ code: 'task_archived' });
    await expect(
      ctx.apply(ctx.ops.retry, { item: `I${String(failure.id)}` }, 'operator'),
    ).rejects.toMatchObject({ code: 'task_archived' });

    await expect(
      ctx.apply(
        ctx.ops.ack,
        { entries: [{ id: answered.comment.id, revision: answered.comment.revision }] },
        worker,
      ),
    ).resolves.toMatchObject({ acked: [answered.comment.id] });
    await expect(
      ctx.apply(ctx.ops.close, { item: `I${String(failure.id)}` }, 'operator'),
    ).resolves.toBeDefined();
    await expect(ctx.apply(ctx.ops.add, { task: KEY }, 'operator')).resolves.toMatchObject({
      task: { membership: 'active' },
    });
  });

  it('task.add brings an archived task back without reopening its blocks', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true);
    await openBlocks(ctx);
    await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
    const opens = (
      await ctx.store.db
        .selectFrom('outbox')
        .select('id')
        .where('kind', '=', 'conversation.open')
        .execute()
    ).length;
    now += 1_000;
    await ctx.apply(ctx.ops.add, { task: KEY }, 'operator');
    expect(
      await ctx.store.db
        .selectFrom('task')
        .select(['membership', 'archive_reason', 'manual_include', 'manual_exclude'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ membership: 'active', archive_reason: null, manual_include: 1, manual_exclude: 0 });
    const blocks = await ctx.store.db.selectFrom('block').select(['state', 'outcome']).execute();
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.state === 'unblocked' && b.outcome === 'archived')).toBe(true);
    expect(
      await ctx.store.db
        .selectFrom('outbox')
        .select('id')
        .where('kind', '=', 'conversation.open')
        .execute(),
    ).toHaveLength(opens);
  });

  it('keeps an archived task readable and hides it from status', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true);
    await openBlocks(ctx);
    await ctx.apply(ctx.ops.archive, { task: KEY }, 'operator');
    const task = await ctx.query(ctx.ops.get, { task: KEY }, 'operator');
    expect(task.task.membership).toBe('archived');
    expect(task.blocks).toHaveLength(3);
    const history = await ctx.query(ctx.ops.history, { task: KEY }, 'operator');
    expect(history.events.map((event) => event.kind)).toContain('task_archived');
    const status = await ctx.query(ctx.ops.status, {}, 'operator');
    expect(status.tasks.map((entry) => entry.key)).not.toContain(KEY);
  });

  it('Done archive clears open blocks', async () => {
    const ctx = setup();
    await ctx.poll(tracker, true, 'closed');
    const external = await ctx.apply(
      ctx.ops.create,
      { task: KEY, type: 'external', reason: 'Waits for the vendor.' },
      'operator',
    );
    now += 1_000;
    await ctx.poll(github);
    now = Date.parse('2026-11-07T00:00:00.000Z');
    await tickBoard({ store: ctx.store, config, clock, completeSince: ctx.core.completeSince });
    expect(
      await ctx.store.db
        .selectFrom('task')
        .select(['membership', 'archive_reason', 'archive_slot_at'])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      membership: 'archived',
      archive_reason: 'done',
      archive_slot_at: '2026-11-07T00:00:00.000Z',
    });
    expect(
      await ctx.store.db
        .selectFrom('block')
        .select(['state', 'outcome', 'unblocked_by'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'unblocked', outcome: 'archived', unblocked_by: 'system' });
    expect(await events(ctx.store, 'task_archived')).toEqual([
      { actor: 'system', payload: { reason: 'done' } },
    ]);
    expect(await events(ctx.store, 'block_unblocked')).toEqual([
      { actor: 'system', payload: { block: external.block.id, outcome: 'archived' } },
    ]);
  });
});
