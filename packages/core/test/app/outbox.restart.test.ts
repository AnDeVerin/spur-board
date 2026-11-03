import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_TYPES, MEMBERSHIPS, type Persona } from '@spur-board/contracts';
import { createFakeGateway, type FakeGateway, type FakeProfile } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSender,
  enqueueConversationOpen,
  openStore,
  type Sender,
  type Store,
} from '../../src/index.ts';
import {
  observeGateway,
  observeSpur,
  type ObservedGateway,
  type ObservedSpur,
} from '../support/observe.ts';

const PERSONA: Persona = { name: 'worker', role: 'worker' };
const PROFILES: FakeProfile[] = ['slack-like', 'telegram-like'];

const stores: Store[] = [];
const registered: { violations: string[] }[] = [];

afterEach(async () => {
  // A crashed store is closed already; closing it again is a no-op.
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

function senderFor(ctx: Omit<Ctx, 'sender'>): Sender {
  return createSender({
    store: ctx.store,
    gateway: ctx.observed.gateway,
    spur: ctx.spur.spur,
    now: () => ctx.fake.platform.now(),
  });
}

function setup(profile: FakeProfile): Ctx {
  const file = join(mkdtempSync(join(tmpdir(), 'core-restart-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  const fake = createFakeGateway({ profile });
  const observed = observeGateway(fake, file);
  const spur = observeSpur(file);
  registered.push(observed, spur);
  const base = { store, file, fake, observed, spur };
  return { ...base, sender: senderFor(base) };
}

/**
 * A new process on the same file and the same platform: open, recover. A crash closed the old
 * store, so the tick that crashed rejected when it recorded the result.
 */
async function restart(ctx: Ctx): Promise<void> {
  ctx.store = openStore(ctx.file);
  stores.push(ctx.store);
  ctx.sender = senderFor(ctx);
  await ctx.sender.recover();
}

/** A task, an open block addressed to the operator and its `conversation.open` row. */
async function enqueueOpen(ctx: Ctx): Promise<{ id: number; key: string }> {
  const at = ctx.fake.platform.now().toISOString();
  const id = await ctx.store.transaction(async (trx) => {
    const task = await trx
      .insertInto('task')
      .values({
        project: 'proj',
        tracker_kind: 'github-issues',
        tracker_id: '101',
        key: 'o/r#101',
        membership: MEMBERSHIPS[0],
        archive_reason: null,
        column: 'todo',
        shadow_column: null,
        created_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const block = await trx
      .insertInto('block')
      .values({
        task_id: task.id,
        type: BLOCK_TYPES[0],
        reason: 'needs a decision',
        author: 'agent:proj/sess-2',
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
      .returning('id')
      .executeTakeFirstOrThrow();
    return enqueueConversationOpen(trx, {
      blockId: block.id,
      commentId: null,
      persona: PERSONA,
      at: ctx.fake.platform.now(),
    });
  });
  if (id === null) throw new Error('no open row');
  const row = await outboxRow(ctx, id);
  return { id, key: row.dedupe_key };
}

async function enqueueDoorbell(ctx: Ctx): Promise<number> {
  const row = await ctx.store.transaction((trx) =>
    trx
      .insertInto('outbox')
      .values({
        kind: 'doorbell',
        dedupe_key: 'doorbell:1',
        payload: JSON.stringify({ session: 'sess-1', text: 'ping 1' }),
        state: 'pending',
        next_at: ctx.fake.platform.now().toISOString(),
        last_error: null,
        external_ref: null,
        parent_outbox_id: null,
        first_attempt_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

async function outboxRow(ctx: Ctx, id: number) {
  return ctx.store.db
    .selectFrom('outbox')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function step(ctx: Ctx, ms = 1000): Promise<void> {
  ctx.fake.platform.advance(ms);
  await ctx.sender.tick();
}

function markedRefs(ctx: Ctx, key: string): string[] {
  return ctx.fake.platform
    .conversations()
    .filter((c) => c.marker === key)
    .map((c) => c.ref);
}

/** Every row reached a terminal state and none disappeared. */
async function expectNoRowLost(ctx: Ctx, inserted: number): Promise<void> {
  const rows = await ctx.store.db.selectFrom('outbox').select('state').execute();
  expect(rows).toHaveLength(inserted);
  for (const row of rows) expect(['done', 'post_failed', 'dead']).toContain(row.state);
}

/** Core keeps exactly one conversation, the platform's latest marked one. */
async function expectOneConversation(ctx: Ctx, id: number, key: string): Promise<void> {
  const conversations = await ctx.store.db.selectFrom('conversation').selectAll().execute();
  const latest = markedRefs(ctx, key).at(-1);
  expect(conversations.map((c) => c.ref)).toEqual([latest]);
  const ref = JSON.parse((await outboxRow(ctx, id)).external_ref ?? 'null') as {
    conversation: string;
  };
  expect(ref.conversation).toBe(latest);
}

/** How many marked threads an outcome leaves, by profile. */
const UNKNOWN = { 'slack-like': 1, 'telegram-like': 2 } as const;
const KNOWN = { 'slack-like': 1, 'telegram-like': 1 } as const;

interface Outcome {
  name: string;
  threads: Record<FakeProfile, number>;
  /** Makes the first attempt end this way and gets the row delivered afterwards. */
  run(ctx: Ctx): Promise<void>;
}

const OUTCOMES: Outcome[] = [
  {
    name: 'a rate limit',
    threads: KNOWN,
    async run(ctx) {
      ctx.fake.platform.rateLimitNext(1000);
      await ctx.sender.tick();
      await step(ctx);
    },
  },
  {
    name: 'a message failure, then recover',
    threads: KNOWN,
    async run(ctx) {
      ctx.fake.platform.failNextPermanently({ scope: 'message' });
      await ctx.sender.tick();
      await ctx.sender.recover();
      await step(ctx);
    },
  },
  {
    name: 'a timeout before the post',
    threads: KNOWN,
    async run(ctx) {
      ctx.fake.platform.timeoutNext({ visible: false });
      await ctx.sender.tick();
      await step(ctx);
    },
  },
  {
    name: 'a crash before deliver',
    threads: KNOWN,
    async run(ctx) {
      ctx.observed.crashNext({ store: ctx.store, when: 'before' });
      await expect(ctx.sender.tick()).rejects.toThrow();
      await restart(ctx);
      await step(ctx);
    },
  },
  {
    name: 'a deliver rejection',
    threads: KNOWN,
    async run(ctx) {
      ctx.observed.throwNext();
      await ctx.sender.tick();
      await step(ctx);
    },
  },
  {
    name: 'a timeout after the post',
    threads: UNKNOWN,
    async run(ctx) {
      ctx.fake.platform.timeoutNext({ visible: true });
      await ctx.sender.tick();
      await step(ctx);
    },
  },
  {
    name: 'a crash after deliver',
    threads: UNKNOWN,
    async run(ctx) {
      ctx.observed.crashNext({ store: ctx.store, when: 'after' });
      await expect(ctx.sender.tick()).rejects.toThrow();
      await restart(ctx);
      await step(ctx);
    },
  },
];

describe.each(PROFILES)('restart on %s', (profile) => {
  it('restart before the post', async () => {
    const ctx = setup(profile);
    const { id, key } = await enqueueOpen(ctx);
    ctx.observed.crashNext({ store: ctx.store, when: 'before' });
    await expect(ctx.sender.tick()).rejects.toThrow('destroyed');
    await restart(ctx);
    // The crashed send started the space's slot; the retry waits for it.
    await ctx.sender.tick();
    expect(ctx.observed.requests).toHaveLength(1);
    await step(ctx);
    expect(ctx.observed.requests.map((r) => [r.key, r.maybeSent])).toEqual([
      [key, false],
      [key, true],
    ]);
    expect(markedRefs(ctx, key)).toHaveLength(1);
    await expectOneConversation(ctx, id, key);
    await expectNoRowLost(ctx, 1);
  });

  it('restart after the post before refs', async () => {
    const ctx = setup(profile);
    const { id, key } = await enqueueOpen(ctx);
    ctx.observed.crashNext({ store: ctx.store, when: 'after' });
    await expect(ctx.sender.tick()).rejects.toThrow('destroyed');
    await restart(ctx);
    expect(await outboxRow(ctx, id)).toMatchObject({
      state: 'pending',
      uncertain: 1,
      attempt_started: 1,
    });
    await step(ctx);
    expect(ctx.observed.requests[1]).toMatchObject({ key, maybeSent: true });
    expect(markedRefs(ctx, key)).toHaveLength(UNKNOWN[profile]);
    await expectOneConversation(ctx, id, key);
    await expectNoRowLost(ctx, 1);
  });

  it('restart during a doorbell', async () => {
    const ctx = setup(profile);
    const id = await enqueueDoorbell(ctx);
    ctx.spur.crashNext(ctx.store);
    await expect(ctx.sender.tick()).rejects.toThrow('destroyed');
    await restart(ctx);
    expect(await outboxRow(ctx, id)).toMatchObject({ state: 'pending', uncertain: 1 });
    await ctx.sender.tick();
    expect(ctx.spur.sends).toEqual([
      ['sess-1', 'ping 1'],
      ['sess-1', 'ping 1'],
    ]);
    await expectNoRowLost(ctx, 1);
  });

  it('send timeout without restart', async () => {
    const ctx = setup(profile);
    const { id, key } = await enqueueOpen(ctx);
    ctx.fake.platform.timeoutNext({ visible: true });
    await ctx.sender.tick();
    await step(ctx);
    expect(ctx.observed.requests[1]).toMatchObject({ key, maybeSent: true });
    expect(markedRefs(ctx, key)).toHaveLength(UNKNOWN[profile]);
    await expectOneConversation(ctx, id, key);
    await expectNoRowLost(ctx, 1);
  });

  it('a deliver rejection without restart', async () => {
    const ctx = setup(profile);
    const { id, key } = await enqueueOpen(ctx);
    const t0 = ctx.fake.platform.now().getTime();
    ctx.observed.throwNext('boom');
    await ctx.sender.tick();
    const row = await outboxRow(ctx, id);
    expect(row).toMatchObject({ state: 'pending', uncertain: 1 });
    expect(row.last_error).toContain('boom');
    expect(row.next_at).toBe(new Date(t0 + 1000).toISOString());
    await step(ctx);
    expect(ctx.observed.requests[1]).toMatchObject({ key, maybeSent: true });
    expect(markedRefs(ctx, key)).toHaveLength(1);
    await expectNoRowLost(ctx, 1);
  });

  it('post_failed is retried on start', async () => {
    const ctx = setup(profile);
    const { id } = await enqueueOpen(ctx);
    ctx.fake.platform.failNextPermanently({ scope: 'message' });
    await ctx.sender.tick();
    expect((await outboxRow(ctx, id)).state).toBe('post_failed');
    await ctx.store.close();
    await restart(ctx);
    expect(await outboxRow(ctx, id)).toMatchObject({ state: 'pending', first_attempt_at: null });
    await step(ctx);
    expect((await outboxRow(ctx, id)).state).toBe('done');
  });

  it('in_flight returns as uncertain', async () => {
    const ctx = setup(profile);
    const { id } = await enqueueOpen(ctx);
    ctx.observed.crashNext({ store: ctx.store, when: 'before' });
    await expect(ctx.sender.tick()).rejects.toThrow();
    const reopened = openStore(ctx.file);
    stores.push(reopened);
    const before = await reopened.db
      .selectFrom('outbox')
      .select(['state', 'uncertain', 'attempt_started'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(before).toEqual({ state: 'in_flight', uncertain: 0, attempt_started: 1 });
    await reopened.close();
    await restart(ctx);
    expect(await outboxRow(ctx, id)).toMatchObject({
      state: 'pending',
      uncertain: 1,
      attempt_started: 1,
    });
  });

  it.each(OUTCOMES)('a second thread only on unknown: $name', async (outcome) => {
    const ctx = setup(profile);
    const { id, key } = await enqueueOpen(ctx);
    await outcome.run(ctx);
    expect((await outboxRow(ctx, id)).state).toBe('done');
    expect(markedRefs(ctx, key)).toHaveLength(outcome.threads[profile]);
    await expectOneConversation(ctx, id, key);
    await expectNoRowLost(ctx, 1);
  });
});
