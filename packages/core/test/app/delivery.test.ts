import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOCK_TYPES,
  MEMBERSHIPS,
  type ActorId,
  type AddresseeRole,
  type DeliverRequest,
  type Gateway,
  type Persona,
} from '@spur-board/contracts';
import { createFakeGateway, type FakeGateway, type FakeProfile } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSender,
  enqueueConversationOpen,
  enqueueConversationReply,
  openStore,
  type OutboxKind,
  type Sender,
  type Store,
} from '../../src/index.ts';
import { HEALTH_PROBE_MS } from '../../src/app/sender.ts';
import {
  observeGateway,
  observeSpur,
  type ObservedGateway,
  type ObservedSpur,
} from '../support/observe.ts';

const PERSONA: Persona = { name: 'worker', role: 'worker' };

const stores: Store[] = [];
const registered: { violations: string[] }[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const observed of registered.splice(0)) expect(observed.violations).toEqual([]);
});

interface Ctx {
  store: Store;
  file: string;
  fake: FakeGateway;
  observed: ObservedGateway;
  spur: ObservedSpur;
  sender: Sender;
}

function setup(profile: FakeProfile = 'slack-like', spaceIntervalMs?: number): Ctx {
  const file = join(mkdtempSync(join(tmpdir(), 'core-delivery-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  const fake = createFakeGateway({ profile });
  const observed = observeGateway(fake, file);
  const spur = observeSpur(file);
  registered.push(observed, spur);
  const sender = createSender({
    store,
    gateway: observed.gateway,
    spur: spur.spur,
    now: () => fake.platform.now(),
    ...(spaceIntervalMs === undefined ? {} : { spaceIntervalMs }),
  });
  return { store, file, fake, observed, spur, sender };
}

let taskCount = 0;

interface Seed {
  taskId: number;
  key: string;
  blockId: number;
  commentId: number;
}

async function seedBlock(
  ctx: Ctx,
  block: { author?: ActorId; addressee?: AddresseeRole } = {},
): Promise<Seed> {
  taskCount += 1;
  const key = `o/r#${String(100 + taskCount)}`;
  const at = ctx.fake.platform.now().toISOString();
  return ctx.store.transaction(async (trx) => {
    const task = await trx
      .insertInto('task')
      .values({
        project: 'proj',
        tracker_kind: 'github-issues',
        tracker_id: String(100 + taskCount),
        key,
        membership: MEMBERSHIPS[0],
        archive_reason: null,
        column: 'todo',
        shadow_column: null,
        created_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('block')
      .values({
        task_id: task.id,
        type: BLOCK_TYPES[0],
        reason: 'needs a decision',
        author: block.author ?? 'agent:proj/sess-2',
        addressee_role: block.addressee ?? 'operator',
        target_column: null,
        state: 'open',
        outcome: null,
        outcome_reason: null,
        repeat_of: null,
        unblocked_by: null,
        unblocked_at: null,
        created_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const commentId = await insertComment(trx, task.id, row.id, 'which way?', at);
    return { taskId: task.id, key, blockId: row.id, commentId };
  });
}

async function insertComment(
  trx: Parameters<Parameters<Store['transaction']>[0]>[0],
  taskId: number,
  blockId: number,
  text: string,
  at: string,
): Promise<number> {
  const row = await trx
    .insertInto('comment')
    .values({
      task_id: taskId,
      block_id: blockId,
      author: 'agent:proj/sess-2',
      text,
      conversation_ref: null,
      message_ref: null,
      acked_revision: null,
      created_at: at,
      delivery_state: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addComment(ctx: Ctx, seed: Seed, text: string): Promise<number> {
  const at = ctx.fake.platform.now().toISOString();
  return ctx.store.transaction((trx) => insertComment(trx, seed.taskId, seed.blockId, text, at));
}

async function enqueueOpen(ctx: Ctx, seed: Seed): Promise<number> {
  const id = await ctx.store.transaction((trx) =>
    enqueueConversationOpen(trx, {
      blockId: seed.blockId,
      commentId: seed.commentId,
      persona: PERSONA,
      at: ctx.fake.platform.now(),
    }),
  );
  if (id === null) throw new Error('no open row');
  return id;
}

async function enqueueReply(ctx: Ctx, commentId: number): Promise<number> {
  const id = await ctx.store.transaction((trx) =>
    enqueueConversationReply(trx, { commentId, persona: PERSONA, at: ctx.fake.platform.now() }),
  );
  if (id === null) throw new Error('no reply row');
  return id;
}

/** Rows whose producers belong to #36 and #37, written directly. */
async function insertRow(
  ctx: Ctx,
  kind: OutboxKind,
  dedupeKey: string,
  payload: unknown,
  parent: number | null = null,
): Promise<number> {
  const row = await ctx.store.transaction((trx) =>
    trx
      .insertInto('outbox')
      .values({
        kind,
        dedupe_key: dedupeKey,
        payload: JSON.stringify(payload),
        state: 'pending',
        next_at: ctx.fake.platform.now().toISOString(),
        last_error: null,
        external_ref: null,
        parent_outbox_id: parent,
        first_attempt_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

function closeRow(ctx: Ctx, seed: Seed, parent: number): Promise<number> {
  return insertRow(
    ctx,
    'conversation.close',
    `conversation.close:block:${String(seed.blockId)}`,
    {
      key: seed.key,
      text: 'resolved',
      persona: PERSONA,
      taskId: seed.taskId,
      blockId: seed.blockId,
      commentId: null,
    },
    parent,
  );
}

function feedLine(ctx: Ctx, key: string, item: string): Promise<number> {
  return insertRow(ctx, 'feed.line', `feed.line:${item}`, {
    key,
    title: `${key} line`,
    text: 'needs you',
    persona: PERSONA,
    itemKey: item,
  });
}

function feedEdit(ctx: Ctx, key: string, item: string, parent: number): Promise<number> {
  return insertRow(
    ctx,
    'feed.line.edit',
    `feed.line.edit:${item}`,
    { key, text: 'cleared', persona: PERSONA, itemKey: item },
    parent,
  );
}

async function outboxRow(ctx: Ctx, id: number) {
  return ctx.store.db
    .selectFrom('outbox')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function commentRow(ctx: Ctx, id: number) {
  return ctx.store.db
    .selectFrom('comment')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

function externalConversation(row: { external_ref: string | null }): unknown {
  return (JSON.parse(row.external_ref ?? 'null') as { conversation?: unknown } | null)
    ?.conversation;
}

function marked(fake: FakeGateway, key: string): number {
  return fake.platform.conversations().filter((c) => c.marker === key).length;
}

function request(ctx: Ctx, index: number): DeliverRequest {
  const found = ctx.observed.requests[index];
  if (found === undefined) throw new Error(`no request ${String(index)}`);
  return found;
}

async function step(ctx: Ctx, ms = 1000): Promise<void> {
  ctx.fake.platform.advance(ms);
  await ctx.sender.tick();
}

async function healthRows(ctx: Ctx) {
  return ctx.store.db.selectFrom('transport_health').selectAll().orderBy('space').execute();
}

async function unblock(ctx: Ctx, seed: Seed): Promise<void> {
  await ctx.store.transaction((trx) =>
    trx.updateTable('block').set({ state: 'unblocked' }).where('id', '=', seed.blockId).execute(),
  );
}

/** An open row whose task key fails `taskKeySchema`, so the sender kills it as invalid. */
function invalidOpen(ctx: Ctx, seed: Seed): Promise<number> {
  return insertRow(ctx, 'conversation.open', `conversation.open:block:${String(seed.blockId)}`, {
    key: 'not a task key',
    title: 'bad',
    text: 'bad',
    persona: PERSONA,
    taskId: seed.taskId,
    blockId: seed.blockId,
    commentId: null,
  });
}

/** A reply row written directly under `parent`, as an older producer could have left it. */
async function replyRow(ctx: Ctx, seed: Seed, commentId: number, parent: number): Promise<number> {
  const id = await insertRow(
    ctx,
    'conversation.reply',
    `conversation.reply:comment:${String(commentId)}`,
    {
      key: seed.key,
      text: 'late',
      persona: PERSONA,
      taskId: seed.taskId,
      blockId: seed.blockId,
      commentId,
    },
    parent,
  );
  await ctx.store.transaction((trx) =>
    trx
      .updateTable('comment')
      .set({ delivery_state: 'pending' })
      .where('id', '=', commentId)
      .execute(),
  );
  return id;
}

describe('producers', () => {
  it('writes one open per block, idempotent by its dedupe key', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const ids = await ctx.store.transaction(async (trx) => {
      const input = {
        blockId: seed.blockId,
        commentId: seed.commentId,
        persona: PERSONA,
        at: ctx.fake.platform.now(),
      };
      return [await enqueueConversationOpen(trx, input), await enqueueConversationOpen(trx, input)];
    });
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).toBe(ids[0]);
    const rows = await ctx.store.db.selectFrom('outbox').selectAll().execute();
    expect(rows.map((r) => [r.kind, r.state])).toEqual([['conversation.open', 'pending']]);
    expect((await commentRow(ctx, seed.commentId)).delivery_state).toBe('pending');
  });

  it("leaves nothing when the caller's transaction rolls back", async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    await expect(
      ctx.store.transaction(async (trx) => {
        await enqueueConversationOpen(trx, {
          blockId: seed.blockId,
          commentId: seed.commentId,
          persona: PERSONA,
          at: ctx.fake.platform.now(),
        });
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect(await ctx.store.db.selectFrom('outbox').selectAll().execute()).toEqual([]);
    expect((await commentRow(ctx, seed.commentId)).delivery_state).toBeNull();
  });

  it('writes nothing for a block by the operator or not addressed to the operator', async () => {
    const ctx = setup();
    for (const block of [{ author: 'operator' as const }, { addressee: 'worker' as const }]) {
      const seed = await seedBlock(ctx, block);
      const id = await ctx.store.transaction((trx) =>
        enqueueConversationOpen(trx, {
          blockId: seed.blockId,
          commentId: null,
          persona: PERSONA,
          at: ctx.fake.platform.now(),
        }),
      );
      expect(id).toBeNull();
    }
    expect(await ctx.store.db.selectFrom('outbox').selectAll().execute()).toEqual([]);
  });

  it('chains each reply to the previous thread row', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const openId = await enqueueOpen(ctx, seed);
    const c2 = await addComment(ctx, seed, 'option A');
    const c3 = await addComment(ctx, seed, 'option B');
    const r1 = await enqueueReply(ctx, c2);
    const r2 = await enqueueReply(ctx, c3);
    expect((await outboxRow(ctx, r1)).parent_outbox_id).toBe(openId);
    expect((await outboxRow(ctx, r2)).parent_outbox_id).toBe(r1);
    expect((await outboxRow(ctx, r1)).kind).toBe('conversation.reply');
    expect((await commentRow(ctx, c2)).delivery_state).toBe('pending');
  });

  it('writes no reply for a block without an open row', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const id = await ctx.store.transaction((trx) =>
      enqueueConversationReply(trx, {
        commentId: seed.commentId,
        persona: PERSONA,
        at: ctx.fake.platform.now(),
      }),
    );
    expect(id).toBeNull();
  });

  it('writes no reply when the thread tail is dead', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    await enqueueOpen(ctx, seed);
    await unblock(ctx, seed);
    await ctx.sender.tick();
    const c2 = await addComment(ctx, seed, 'too late');
    const id = await ctx.store.transaction((trx) =>
      enqueueConversationReply(trx, {
        commentId: c2,
        persona: PERSONA,
        at: ctx.fake.platform.now(),
      }),
    );
    expect(id).toBeNull();
    expect(await ctx.store.db.selectFrom('outbox').selectAll().execute()).toHaveLength(1);
    expect((await commentRow(ctx, c2)).delivery_state).toBeNull();
  });

  it('writes no reply when the open died for an invalid payload', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    await invalidOpen(ctx, seed);
    await ctx.sender.tick();
    const c2 = await addComment(ctx, seed, 'too late');
    const id = await ctx.store.transaction((trx) =>
      enqueueConversationReply(trx, {
        commentId: c2,
        persona: PERSONA,
        at: ctx.fake.platform.now(),
      }),
    );
    expect(id).toBeNull();
    expect((await commentRow(ctx, c2)).delivery_state).toBeNull();
  });

  it("sends the caller's persona and starts the text with the task key", async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    await enqueueOpen(ctx, seed);
    await ctx.sender.tick();
    const sent = request(ctx, 0);
    expect(sent.persona).toEqual(PERSONA);
    expect(sent.body[0]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: seed.key }],
    });
    expect(sent.target).toMatchObject({ kind: 'open', space: 'orchestrators' });
    expect(sent.target.kind === 'open' && sent.target.title.startsWith(seed.key)).toBe(true);
  });
});

describe('kind priority', () => {
  it('delivers a due open before a due close in orchestrators', async () => {
    const ctx = setup();
    const a = await seedBlock(ctx);
    const openA = await enqueueOpen(ctx, a);
    await ctx.sender.tick();
    await closeRow(ctx, a, openA);
    const b = await seedBlock(ctx);
    await enqueueOpen(ctx, b);
    await step(ctx);
    expect(request(ctx, 1).target.kind).toBe('open');
    await step(ctx);
    expect(request(ctx, 2).target.kind).toBe('close');
  });

  it('sends conversation rows before feed rows and each into its space', async () => {
    const ctx = setup();
    const a = await seedBlock(ctx);
    const openA = await enqueueOpen(ctx, a);
    await ctx.sender.tick();
    expect(request(ctx, 0).target).toMatchObject({ kind: 'open', space: 'orchestrators' });
    await feedLine(ctx, a.key, 'item-1');
    await closeRow(ctx, a, openA);
    await step(ctx);
    expect(ctx.observed.requests.map((r) => r.target.kind)).toEqual(['open', 'close', 'open']);
    expect(request(ctx, 2).target).toMatchObject({ kind: 'open', space: 'feed' });
  });
});

describe('limiter', () => {
  it('sends at most one row per space per interval', async () => {
    const ctx = setup('slack-like', 1000);
    for (let i = 0; i < 3; i++) await enqueueOpen(ctx, await seedBlock(ctx));
    await ctx.sender.tick();
    expect(ctx.observed.requests).toHaveLength(1);
    await step(ctx, 500);
    expect(ctx.observed.requests).toHaveLength(1);
    await step(ctx, 500);
    expect(ctx.observed.requests).toHaveLength(2);
  });

  it('does not throttle one space by another', async () => {
    const ctx = setup('slack-like', 1000);
    const seed = await seedBlock(ctx);
    await enqueueOpen(ctx, seed);
    await feedLine(ctx, seed.key, 'item-1');
    await ctx.sender.tick();
    expect(ctx.observed.requests.map((r) => r.target)).toMatchObject([
      { space: 'orchestrators' },
      { space: 'feed' },
    ]);
  });

  it('reschedules a rate-limited row without stalling the next one', async () => {
    const ctx = setup();
    const first = await enqueueOpen(ctx, await seedBlock(ctx));
    const second = await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.fake.platform.rateLimitNext(30_000);
    const t0 = ctx.fake.platform.now().getTime();
    await ctx.sender.tick();
    expect((await outboxRow(ctx, first)).next_at).toBe(new Date(t0 + 30_000).toISOString());
    await step(ctx);
    expect(request(ctx, 1).key).toBe((await outboxRow(ctx, second)).dedupe_key);
    expect((await outboxRow(ctx, second)).state).toBe('done');
  });

  it('starts the space interval when the send starts, after a slow earlier send', async () => {
    const ctx = setup('slack-like', 1000);
    const slow = slowOrchestrators(ctx, 900);
    const seed = await seedBlock(ctx);
    await enqueueOpen(ctx, seed);
    await feedLine(ctx, seed.key, 'item-1');
    await feedLine(ctx, seed.key, 'item-2');
    await slow.sender.tick();
    await step({ ...ctx, sender: slow.sender }, 100);
    await step({ ...ctx, sender: slow.sender }, 900);
    expect(slow.starts.get('feed')).toHaveLength(2);
    expect(gaps(slow.starts)).toEqual([]);
  });

  it('runs overlapping ticks one after another', async () => {
    const ctx = setup('slack-like', 1000);
    const slow = slowOrchestrators(ctx, 1000);
    for (let i = 0; i < 2; i++) {
      const seed = await seedBlock(ctx);
      await enqueueOpen(ctx, seed);
      await feedLine(ctx, seed.key, `item-${String(i)}`);
    }
    await Promise.all([slow.sender.tick(), slow.sender.tick()]);
    for (let i = 0; i < 3; i++) await step({ ...ctx, sender: slow.sender });
    const keys = ctx.observed.requests.map((r) => r.key);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(keys.length);
    expect(gaps(slow.starts)).toEqual([]);
  });

  it('keeps the space slot across a restart', async () => {
    const ctx = setup('slack-like', 1000);
    for (let i = 0; i < 2; i++) await enqueueOpen(ctx, await seedBlock(ctx));
    await ctx.sender.tick();
    expect(ctx.observed.requests).toHaveLength(1);
    const restarted = await restart(ctx, 1000);
    await restarted.sender.tick();
    await step(restarted, 999);
    expect(ctx.observed.requests).toHaveLength(1);
    await step(restarted, 1);
    expect(ctx.observed.requests).toHaveLength(2);
  });
});

/** Reopens the store and makes a new sender on it, as a daemon restart does. */
async function restart(ctx: Ctx, spaceIntervalMs?: number): Promise<Ctx> {
  await ctx.store.close();
  const store = openStore(ctx.file);
  stores.push(store);
  const sender = createSender({
    store,
    gateway: ctx.observed.gateway,
    spur: ctx.spur.spur,
    now: () => ctx.fake.platform.now(),
    ...(spaceIntervalMs === undefined ? {} : { spaceIntervalMs }),
  });
  await sender.recover();
  return { ...ctx, store, sender };
}

describe('tick', () => {
  it('runs the next tick after one that rejected', async () => {
    const ctx = setup();
    await enqueueOpen(ctx, await seedBlock(ctx));
    let fail = true;
    const store: Store = {
      ...ctx.store,
      transaction: (fn) => {
        if (!fail) return ctx.store.transaction(fn);
        fail = false;
        return Promise.reject(new Error('disk full'));
      },
    };
    const sender = createSender({
      store,
      gateway: ctx.observed.gateway,
      spur: ctx.spur.spur,
      now: () => ctx.fake.platform.now(),
    });
    const first = sender.tick();
    const second = sender.tick();
    await expect(first).rejects.toThrow('disk full');
    await second;
    expect(ctx.observed.requests).toHaveLength(1);
  });
});

/**
 * A sender whose orchestrators opens take `ms` on the platform clock before they post. It logs
 * when each open starts, per space.
 */
function slowOrchestrators(ctx: Ctx, ms: number) {
  const starts = new Map<string, number[]>();
  const gateway: Gateway = {
    ...ctx.observed.gateway,
    async deliver(request) {
      if (request.target.kind === 'open') {
        const space = request.target.space;
        starts.set(space, [...(starts.get(space) ?? []), ctx.fake.platform.now().getTime()]);
        if (space === 'orchestrators') ctx.fake.platform.advance(ms);
      }
      return ctx.observed.gateway.deliver(request);
    },
  };
  const sender = createSender({
    store: ctx.store,
    gateway,
    spur: ctx.spur.spur,
    now: () => ctx.fake.platform.now(),
    spaceIntervalMs: 1000,
  });
  return { sender, starts, gateway };
}

/** Two sends into one space that started less than 1000 ms apart. */
function gaps(starts: Map<string, number[]>): string[] {
  return [...starts].flatMap(([space, times]) =>
    times.slice(1).flatMap((t, i) => {
      const gap = t - (times[i] ?? 0);
      return gap < 1000 ? [`${space}: ${String(gap)} ms`] : [];
    }),
  );
}

describe('maybeSent', () => {
  it('passes maybeSent after an uncertain retry and leaves one thread', async () => {
    const ctx = setup('slack-like');
    const id = await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.fake.platform.timeoutNext({ visible: true });
    await ctx.sender.tick();
    expect(await outboxRow(ctx, id)).toMatchObject({ state: 'pending', uncertain: 1 });
    // A known retry after an unknown one keeps the row uncertain.
    ctx.fake.platform.rateLimitNext(1000);
    await step(ctx);
    expect((await outboxRow(ctx, id)).uncertain).toBe(1);
    await step(ctx);
    const key = request(ctx, 0).key;
    expect(ctx.observed.requests.slice(1).map((r) => [r.key, r.maybeSent])).toEqual([
      [key, true],
      [key, true],
    ]);
    expect(marked(ctx.fake, key)).toBe(1);
    expect(await ctx.store.db.selectFrom('conversation').selectAll().execute()).toHaveLength(1);
    expect((await outboxRow(ctx, id)).state).toBe('done');
  });

  it('keeps maybeSent false after a known retry', async () => {
    const ctx = setup('slack-like');
    const id = await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.fake.platform.rateLimitNext(1000);
    await ctx.sender.tick();
    expect((await outboxRow(ctx, id)).uncertain).toBe(0);
    await step(ctx);
    expect(request(ctx, 0).maybeSent).toBe(false);
    expect(request(ctx, 1).maybeSent).toBe(false);
  });
});

describe('delivered records refs', () => {
  it('keeps one conversation across open, replies and close', async () => {
    const ctx = setup('slack-like');
    const seed = await seedBlock(ctx);
    const openId = await enqueueOpen(ctx, seed);
    const c2 = await addComment(ctx, seed, 'option A');
    const c3 = await addComment(ctx, seed, 'option B');
    const r1 = await enqueueReply(ctx, c2);
    const r2 = await enqueueReply(ctx, c3);
    const closeId = await closeRow(ctx, seed, r2);
    await ctx.sender.tick();
    for (let i = 0; i < 3; i++) await step(ctx);

    const conversation = await ctx.store.db
      .selectFrom('conversation')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(conversation).toMatchObject({
      gateway: ctx.observed.gateway.kind,
      space: 'orchestrators',
      purpose: 'block',
      state: 'closed',
      block_id: seed.blockId,
      task_id: seed.taskId,
    });
    expect(conversation.closed_at).not.toBeNull();
    expect(ctx.observed.requests.slice(1).map((r) => r.target)).toEqual([
      { kind: 'reply', conversation: conversation.ref },
      { kind: 'reply', conversation: conversation.ref },
      { kind: 'close', conversation: conversation.ref },
    ]);
    for (const id of [openId, r1, r2, closeId]) {
      const row = await outboxRow(ctx, id);
      expect(row.state).toBe('done');
      expect(externalConversation(row)).toBe(conversation.ref);
    }
    const comments = await Promise.all([seed.commentId, c2, c3].map((id) => commentRow(ctx, id)));
    expect(comments.map((c) => [c.delivery_state, c.conversation_ref])).toEqual([
      ['delivered', conversation.ref],
      ['delivered', conversation.ref],
      ['delivered', conversation.ref],
    ]);
    expect(new Set(comments.map((c) => c.message_ref)).size).toBe(3);
    expect(conversation.root_message_ref).toBe(comments[0]?.message_ref);
    const key = request(ctx, 0).key;
    expect(ctx.fake.platform.conversations().filter((c) => c.marker === key)).toEqual([
      expect.objectContaining({ ref: conversation.ref, done: true }),
    ]);
  });

  it('records a feed line conversation and edits its message', async () => {
    const ctx = setup('slack-like');
    const line = await feedLine(ctx, 'o/r#7', 'item-1');
    await ctx.sender.tick();
    const edit = await feedEdit(ctx, 'o/r#7', 'item-1', line);
    await step(ctx);
    const conversation = await ctx.store.db
      .selectFrom('conversation')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(conversation).toMatchObject({ purpose: 'feed_line', space: 'feed', block_id: null });
    const lineRow = await outboxRow(ctx, line);
    const lineRef = JSON.parse(lineRow.external_ref ?? 'null') as { message: string };
    expect(request(ctx, 1).target).toEqual({ kind: 'edit', message: lineRef.message });
    const editRow = await outboxRow(ctx, edit);
    expect(editRow.state).toBe('done');
    expect(externalConversation(editRow)).toBe(conversation.ref);
  });

  it('probe catches deliver inside a transaction', async () => {
    const ctx = setup();
    const probe = observeGateway(ctx.fake, ctx.file);
    const req: DeliverRequest = {
      key: 'probe',
      maybeSent: false,
      target: { kind: 'open', space: 'orchestrators', title: 'probe' },
      persona: PERSONA,
      body: [],
    };
    await ctx.store.transaction(() => probe.gateway.deliver(req));
    expect(probe.violations).toHaveLength(1);
  });
});

describe('failures', () => {
  it('30 min of retry gives post_failed', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const id = await enqueueOpen(ctx, seed);
    for (let i = 0; i < 31; i++) {
      expect((await outboxRow(ctx, id)).state).toBe('pending');
      ctx.fake.platform.rateLimitNext(60_000);
      await step(ctx, 60_000);
    }
    const row = await outboxRow(ctx, id);
    expect(row.state).toBe('post_failed');
    expect(row.last_error).not.toBeNull();
    expect(ctx.observed.requests).toHaveLength(31);
    expect((await commentRow(ctx, seed.commentId)).delivery_state).toBe('post_failed');
  });

  it('message failure is final at once', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const id = await enqueueOpen(ctx, seed);
    ctx.fake.platform.failNextPermanently({ scope: 'message', reason: 'r' });
    await ctx.sender.tick();
    await step(ctx, 60_000);
    expect(ctx.observed.requests).toHaveLength(1);
    expect(await outboxRow(ctx, id)).toMatchObject({ state: 'post_failed', last_error: 'r' });
    expect((await commentRow(ctx, seed.commentId)).delivery_state).toBe('post_failed');
    expect(await healthRows(ctx)).toEqual([]);
  });
});

describe('doorbell via SpurPort', () => {
  it('sends the text verbatim', async () => {
    const ctx = setup();
    const id = await insertRow(ctx, 'doorbell', 'doorbell:1', { session: 'sess-1', text: 'ping' });
    await ctx.sender.tick();
    expect(ctx.spur.sends).toEqual([['sess-1', 'ping']]);
    expect(await outboxRow(ctx, id)).toMatchObject({ state: 'done', external_ref: null });
  });

  it('keeps a failed send pending and resends the same text', async () => {
    const ctx = setup();
    const id = await insertRow(ctx, 'doorbell', 'doorbell:1', { session: 'sess-1', text: 'ping' });
    ctx.spur.throwNext('spur down');
    await ctx.sender.tick();
    expect(await outboxRow(ctx, id)).toMatchObject({
      state: 'pending',
      uncertain: 1,
      last_error: 'spur down',
    });
    await step(ctx);
    expect(ctx.spur.sends).toEqual([['sess-1', 'ping']]);
    expect((await outboxRow(ctx, id)).state).toBe('done');
  });
});

describe('dependencies', () => {
  it('a close never goes before its open', async () => {
    const ctx = setup('slack-like');
    const seed = await seedBlock(ctx);
    const openId = await enqueueOpen(ctx, seed);
    const reply = await enqueueReply(ctx, await addComment(ctx, seed, 'more'));
    await closeRow(ctx, seed, reply);
    ctx.fake.platform.timeoutNext({ visible: false });
    await ctx.sender.tick();
    await step(ctx);
    expect((await outboxRow(ctx, openId)).state).toBe('done');
    expect(ctx.observed.requests.map((r) => r.target.kind)).toEqual(['open', 'open']);
    await step(ctx);
    await step(ctx);
    const conversation = externalConversation(await outboxRow(ctx, openId));
    expect(ctx.observed.requests.slice(2).map((r) => r.target)).toEqual([
      { kind: 'reply', conversation },
      { kind: 'close', conversation },
    ]);
  });

  it('stale open is cancelled with its dependents', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const openId = await enqueueOpen(ctx, seed);
    const c2 = await addComment(ctx, seed, 'more');
    const reply = await enqueueReply(ctx, c2);
    const close = await closeRow(ctx, seed, reply);
    await ctx.store.transaction((trx) =>
      trx.updateTable('block').set({ state: 'unblocked' }).where('id', '=', seed.blockId).execute(),
    );
    await ctx.sender.tick();
    for (const id of [openId, reply, close]) {
      expect(await outboxRow(ctx, id)).toMatchObject({ state: 'dead', last_error: 'superseded' });
    }
    for (const id of [seed.commentId, c2]) {
      expect((await commentRow(ctx, id)).delivery_state).toBe('superseded');
    }
    expect(ctx.observed.requests).toHaveLength(0);
  });

  it('a reply written after its open died is cancelled on the next tick', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const openId = await enqueueOpen(ctx, seed);
    await unblock(ctx, seed);
    await ctx.sender.tick();
    expect((await outboxRow(ctx, openId)).state).toBe('dead');
    const c2 = await addComment(ctx, seed, 'late');
    const reply = await replyRow(ctx, seed, c2, openId);
    await step(ctx);
    expect(await outboxRow(ctx, reply)).toMatchObject({ state: 'dead', last_error: 'superseded' });
    expect((await commentRow(ctx, c2)).delivery_state).toBe('superseded');
    expect(ctx.observed.requests).toHaveLength(0);
  });

  it('a reply written after its open died for an invalid payload is cancelled', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const openId = await invalidOpen(ctx, seed);
    await ctx.sender.tick();
    expect((await outboxRow(ctx, openId)).last_error).toMatch(/^invalid payload/);
    const c2 = await addComment(ctx, seed, 'late');
    const reply = await replyRow(ctx, seed, c2, openId);
    await step(ctx);
    expect(await outboxRow(ctx, reply)).toMatchObject({ state: 'dead', last_error: 'superseded' });
    expect((await commentRow(ctx, c2)).delivery_state).toBe('superseded');
    expect(ctx.observed.requests).toHaveLength(0);
  });

  it('an invalid open cancels its pending reply and the reply comment in one tick', async () => {
    const ctx = setup();
    const seed = await seedBlock(ctx);
    const openId = await invalidOpen(ctx, seed);
    const c2 = await addComment(ctx, seed, 'more');
    const reply = await replyRow(ctx, seed, c2, openId);
    const close = await closeRow(ctx, seed, reply);
    await ctx.sender.tick();
    for (const id of [reply, close]) {
      expect(await outboxRow(ctx, id)).toMatchObject({ state: 'dead', last_error: 'superseded' });
    }
    expect((await commentRow(ctx, c2)).delivery_state).toBe('superseded');
    expect(ctx.observed.requests).toHaveLength(0);
  });

  it('an uncertain open is delivered with maybeSent after its block clears', async () => {
    const ctx = setup('slack-like');
    const seed = await seedBlock(ctx);
    const openId = await enqueueOpen(ctx, seed);
    const reply = await enqueueReply(ctx, await addComment(ctx, seed, 'more'));
    ctx.fake.platform.timeoutNext({ visible: true });
    await ctx.sender.tick();
    expect(await outboxRow(ctx, openId)).toMatchObject({ state: 'pending', uncertain: 1 });
    await unblock(ctx, seed);
    await step(ctx);
    expect((await outboxRow(ctx, openId)).state).toBe('done');
    expect(request(ctx, 1)).toMatchObject({ key: request(ctx, 0).key, maybeSent: true });
    expect(marked(ctx.fake, request(ctx, 0).key)).toBe(1);
    expect((await commentRow(ctx, seed.commentId)).delivery_state).toBe('delivered');
    await step(ctx);
    expect((await outboxRow(ctx, reply)).state).toBe('done');
  });

  it('an uncertain feed line is delivered before its edit', async () => {
    const ctx = setup('slack-like');
    const line = await feedLine(ctx, 'o/r#7', 'item-1');
    ctx.fake.platform.timeoutNext({ visible: true });
    await ctx.sender.tick();
    expect(await outboxRow(ctx, line)).toMatchObject({ state: 'pending', uncertain: 1 });
    const edit = await feedEdit(ctx, 'o/r#7', 'item-1', line);
    await step(ctx);
    expect((await outboxRow(ctx, line)).state).toBe('done');
    expect(request(ctx, 1)).toMatchObject({ target: { kind: 'open' }, maybeSent: true });
    await step(ctx);
    expect((await outboxRow(ctx, edit)).state).toBe('done');
    expect(request(ctx, 2).target.kind).toBe('edit');
    expect(marked(ctx.fake, request(ctx, 0).key)).toBe(1);
  });

  it('cleared feed line is cancelled', async () => {
    const ctx = setup();
    const line = await feedLine(ctx, 'o/r#7', 'item-1');
    const edit = await feedEdit(ctx, 'o/r#7', 'item-1', line);
    await ctx.sender.tick();
    for (const id of [line, edit]) {
      expect(await outboxRow(ctx, id)).toMatchObject({ state: 'dead', last_error: 'superseded' });
    }
    expect(ctx.observed.requests).toHaveLength(0);
  });
});

describe('transport health', () => {
  it('a revoked token gives one health item', async () => {
    const ctx = setup();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(await enqueueOpen(ctx, await seedBlock(ctx)));
    const revoke = () => {
      ctx.fake.platform.failNextPermanently({ scope: 'transport', reason: 'token_revoked' });
    };
    revoke();
    await ctx.sender.tick();
    expect(ctx.observed.requests).toHaveLength(1);
    expect(await healthRows(ctx)).toEqual([
      expect.objectContaining({ space: 'orchestrators', reason: 'token_revoked' }),
    ]);
    for (let s = 1; s < 60; s++) await step(ctx);
    expect(ctx.observed.requests).toHaveLength(1);
    const rows = await Promise.all(ids.map((id) => outboxRow(ctx, id)));
    expect(rows.map((r) => r.state)).toEqual(['pending', 'pending', 'pending']);
    revoke();
    await step(ctx);
    expect(ctx.observed.requests).toHaveLength(2);
    expect(request(ctx, 1).key).toBe(rows[1]?.dedupe_key);
    expect(await healthRows(ctx)).toHaveLength(1);
  });

  it("restarts every row's retry window of a space when health is raised", async () => {
    const ctx = setup();
    const a = await enqueueOpen(ctx, await seedBlock(ctx));
    await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.fake.platform.rateLimitNext(40 * 60_000);
    await ctx.sender.tick();
    expect((await outboxRow(ctx, a)).first_attempt_at).not.toBeNull();
    ctx.fake.platform.failNextPermanently({ scope: 'transport', reason: 'token_revoked' });
    await step(ctx);
    expect(await healthRows(ctx)).toHaveLength(1);
    expect((await outboxRow(ctx, a)).first_attempt_at).toBeNull();
    // The space stays unhealthy past 30 min; the next probe delivers and clears it.
    await step(ctx, 35 * 60_000);
    expect(await healthRows(ctx)).toEqual([]);
    ctx.fake.platform.rateLimitNext(60_000);
    await step(ctx, 5 * 60_000);
    expect(ctx.observed.requests).toHaveLength(4);
    expect((await outboxRow(ctx, a)).state).toBe('pending');
  });

  it('keeps the probe clock across a restart', async () => {
    const ctx = setup();
    for (let i = 0; i < 2; i++) await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.fake.platform.failNextPermanently({ scope: 'transport', reason: 'token_revoked' });
    await ctx.sender.tick();
    expect(ctx.observed.requests).toHaveLength(1);
    const restarted = await restart(ctx);
    await restarted.sender.tick();
    for (let s = 1; s < 60; s++) await step(restarted);
    expect(ctx.observed.requests).toHaveLength(1);
    await step(restarted);
    expect(ctx.observed.requests).toHaveLength(2);
    expect(await healthRows(restarted)).toEqual([]);
  });

  it('starts the probe clock when the probe send starts, after a slow earlier send', async () => {
    const ctx = setup();
    const slow = slowOrchestrators(ctx, 70_000);
    // Every feed send times out; the fake produces the retry.
    const gateway: Gateway = {
      ...ctx.observed.gateway,
      deliver(request) {
        if (request.target.kind === 'open' && request.target.space === 'feed') {
          ctx.fake.platform.timeoutNext({ visible: false });
        }
        return slow.gateway.deliver(request);
      },
    };
    const sender = createSender({
      store: ctx.store,
      gateway,
      spur: ctx.spur.spur,
      now: () => ctx.fake.platform.now(),
    });
    const feedSends = () =>
      ctx.observed.requests.filter((r) => r.target.kind === 'open' && r.target.space === 'feed');
    await feedLine(ctx, 'o/r#7', 'item-1');
    await feedLine(ctx, 'o/r#7', 'item-2');
    ctx.fake.platform.failNextPermanently({ scope: 'transport', reason: 'token_revoked' });
    await ctx.sender.tick();
    expect(await healthRows(ctx)).toHaveLength(1);
    await enqueueOpen(ctx, await seedBlock(ctx));
    // The open takes 70 s, so the feed probe in the same tick starts 70 s after its claim.
    await step({ ...ctx, sender }, HEALTH_PROBE_MS);
    expect(feedSends()).toHaveLength(2);
    const probeStart = slow.starts.get('feed')?.at(-1) ?? 0;
    expect((await healthRows(ctx))[0]?.probe_at).toBe(new Date(probeStart).toISOString());
    const sinceProbe = ctx.fake.platform.now().getTime() - probeStart;
    await step({ ...ctx, sender }, HEALTH_PROBE_MS - 1 - sinceProbe);
    expect(feedSends()).toHaveLength(2);
    await step({ ...ctx, sender }, 1);
    expect(feedSends()).toHaveLength(3);
  });

  it('gateway down over 5 min raises health and suspends the retry window', async () => {
    const ctx = setup();
    const id = await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.sender.recordConnection('down', ctx.fake.platform.now());
    ctx.fake.platform.timeoutNext({ visible: false });
    await step(ctx, 5 * 60_000 + 1000);
    expect((await healthRows(ctx)).map((h) => [h.space, h.reason])).toEqual([
      ['feed', 'down'],
      ['orchestrators', 'down'],
    ]);
    // The probe's own send starts the probe clock: the row, due again in 1 s, waits.
    await step(ctx);
    expect(ctx.observed.requests).toHaveLength(1);
    for (let i = 0; i < 32; i++) {
      ctx.fake.platform.timeoutNext({ visible: false });
      await step(ctx, 60_000);
    }
    expect(ctx.observed.requests).toHaveLength(33);
    expect(await outboxRow(ctx, id)).toMatchObject({ state: 'pending', first_attempt_at: null });
  });

  it('next delivery clears health', async () => {
    const ctx = setup();
    const id = await enqueueOpen(ctx, await seedBlock(ctx));
    ctx.sender.recordConnection('down', ctx.fake.platform.now());
    ctx.fake.platform.timeoutNext({ visible: false });
    await step(ctx, 5 * 60_000 + 1000);
    expect(await healthRows(ctx)).toHaveLength(2);
    ctx.sender.recordConnection('up', ctx.fake.platform.now());
    await step(ctx, HEALTH_PROBE_MS);
    expect((await outboxRow(ctx, id)).state).toBe('done');
    expect(marked(ctx.fake, request(ctx, 0).key)).toBe(1);
    expect((await healthRows(ctx)).map((h) => h.space)).toEqual(['feed']);
  });
});
