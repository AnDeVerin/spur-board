import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createBlockMutations,
  createSender,
  openStore,
  reconcileDueDoorbells,
  type Store,
} from '../../src/index.ts';
import {
  registerBlockNotification,
  restartNotification,
  selectNotificationRecipient,
} from '../../src/app/doorbells.ts';
import { SpurRejectedError } from '../../src/app/sender.ts';
import { sampleRows } from '../store/sample-rows.ts';

const KEY = 'o/r#101';
const START = Date.parse('2026-11-03T10:00:00.000Z');
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'web', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const ops = createBlockMutations(config);
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup(
  options: {
    author?: 'waiting' | 'ended';
    replacement?: boolean;
    tester?: boolean;
    retry?: { firstRetryMs: number; secondRetryMs: number; unansweredAfterMs: number };
    gateway?: boolean;
  } = {},
) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-doorbell-')), 'board.db'));
  stores.push(store);
  let now = START;
  let failNext: Error | undefined;
  let failAlways = false;
  let beforeSend: (() => Promise<void>) | undefined;
  const sent: { session: string; text: string }[] = [];
  await store.transaction(async (trx) => {
    await trx
      .insertInto('task')
      .values({
        ...sampleRows.task,
        key: KEY,
        project: 'proj',
        membership: 'active',
        archive_reason: null,
        column: 'dev',
      })
      .execute();
    const sessions = [
      {
        id: 'worker-1',
        role: 'worker' as const,
        state: options.author === 'ended' ? 'stopped' : 'waiting',
        ended: options.author === 'ended',
      },
      ...(options.replacement
        ? [{ id: 'worker-2', role: 'worker' as const, state: 'waiting', ended: false }]
        : []),
      ...(options.tester
        ? [{ id: 'tester-1', role: 'other' as const, state: 'waiting', ended: false }]
        : []),
    ];
    for (const [index, session] of sessions.entries()) {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: session.id,
          spur_project: 'web',
          state: session.state,
          ended_at: session.ended ? new Date(START).toISOString() : null,
          end_reason: session.ended ? 'complete' : null,
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: index + 1,
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: session.id,
          role: session.role,
        })
        .execute();
    }
  });
  const usedConfig = options.retry
    ? configSchema.parse({ ...config, doorbells: options.retry })
    : config;
  const apply = createApply({ store, clock: { now: () => now }, config: usedConfig });
  const fake = options.gateway ? createFakeGateway({ profile: 'slack-like' }) : undefined;
  const sender = createSender({
    store,
    ...(fake === undefined ? {} : { gateway: fake }),
    config: usedConfig,
    spur: {
      async send(session, text) {
        const hook = beforeSend;
        beforeSend = undefined;
        await hook?.();
        if (failNext !== undefined) {
          const error = failNext;
          failNext = undefined;
          throw error;
        }
        if (failAlways) throw new Error('spur send failed');
        sent.push({ session, text });
      },
    },
    now: () => new Date(now),
  });
  return {
    store,
    apply,
    sender,
    sent,
    fake,
    now: () => new Date(now),
    /** Runs the daemon's doorbell job once, as it runs before a tick. */
    ring: () => reconcileDueDoorbells(store, usedConfig, new Date(now)),
    advance(ms: number) {
      now += ms;
    },
    failNext(error = new Error('spur send failed')) {
      failNext = error;
    },
    failAlways(on: boolean) {
      failAlways = on;
    },
    /** Runs `hook` once inside the next Spur send, while its ring is in flight. */
    beforeSend(hook: () => Promise<void>) {
      beforeSend = hook;
    },
  };
}

async function workerBlock(store: Store): Promise<string> {
  return store.transaction(async (trx) => {
    const block = await trx
      .insertInto('block')
      .values({
        task_id: 1,
        type: 'code',
        reason: 'Fix checks',
        author: 'operator',
        addressee_role: 'worker',
        target_column: null,
        state: 'open',
        outcome: null,
        outcome_reason: null,
        repeat_of: null,
        unblocked_by: null,
        unblocked_at: null,
        created_at: new Date(START).toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await registerBlockNotification(trx, block, new Date(START));
    return `B${String(block.id)}`;
  });
}

describe('role addressed doorbells', () => {
  it('selects no recipient for a curator notification despite a live orchestrator link', async () => {
    const ctx = await setup();
    await ctx.store.transaction(async (trx) => {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'orchestrator-1',
          spur_project: 'web',
          state: 'waiting',
          ended_at: null,
          end_reason: null,
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: 9,
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'orchestrator-1',
          role: 'orchestrator',
        })
        .execute();
    });
    const select = (role: 'curator' | 'orchestrator:dev') =>
      ctx.store.transaction((trx) =>
        selectNotificationRecipient(trx, { task_id: 1, role, author_session: null }),
      );
    expect(await select('curator')).toBeUndefined();
    expect((await select('orchestrator:dev'))?.id).toBe('orchestrator-1');
  });

  it('rings the live author for an answer, then a replacement worker if the author ended', async () => {
    const live = await setup({ replacement: true, tester: true });
    const asked = await live.apply(
      ops.ask,
      { task: KEY, text: 'Which version?' },
      'agent:web/worker-1',
      'ask-live',
    );
    await live.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
    await live.ring();
    await live.sender.tick();
    expect(live.sent.map((entry) => entry.session)).toEqual(['worker-1']);
    expect(live.sent[0]?.text).toContain(`${KEY} block ${asked.block.id}: check board inbox`);

    const ended = await setup({ author: 'ended', replacement: true, tester: true });
    const question = await ended.apply(
      ops.ask,
      { task: KEY, text: 'Which version?' },
      'agent:web/worker-1',
      'ask-ended',
    );
    await ended.apply(ops.answer, { block: question.block.id, text: 'Use v2.' }, 'operator');
    await ended.ring();
    await ended.sender.tick();
    expect(ended.sent.map((entry) => entry.session)).toEqual(['worker-2']);
    expect(ended.sent.some((entry) => entry.session === 'tester-1')).toBe(false);
  });

  it('holds an answer without a live task worker until one appears', async () => {
    const ctx = await setup({ author: 'ended', tester: true });
    const asked = await ctx.apply(
      ops.ask,
      { task: KEY, text: 'Which version?' },
      'agent:web/worker-1',
      'ask-wait',
    );
    await ctx.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toEqual([]);
    await ctx.store.transaction(async (trx) => {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'worker-2',
          spur_project: 'web',
          state: 'waiting',
          ended_at: null,
          end_reason: null,
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: 3,
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'worker-2',
          role: 'worker',
        })
        .execute();
    });
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-2']);
  });

  it('pauses while working, then raises one worker refusal after three distinct unanswered rings', async () => {
    const ctx = await setup();
    const blockId = await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await ctx.store.transaction((trx) =>
      trx
        .updateTable('session_snapshot')
        .set({ state: 'working' })
        .where('id', '=', 'worker-1')
        .execute(),
    );
    ctx.advance(120_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await ctx.store.transaction((trx) =>
      trx
        .updateTable('session_snapshot')
        .set({ state: 'waiting' })
        .where('id', '=', 'worker-1')
        .execute(),
    );
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(300_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(3);
    expect(new Set(ctx.sent.map((entry) => entry.text)).size).toBe(3);
    ctx.advance(900_000);
    await ctx.ring();
    await ctx.sender.tick();
    const item = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(item.kind).toBe('worker_not_reading');
    expect(item.text).toBe(`worker worker-1 is not reading block ${blockId} on ${KEY}`);
    expect(
      await ctx.store.db.selectFrom('block').select('addressee_role').executeTakeFirst(),
    ).toEqual({ addressee_role: 'worker' });
    expect(ctx.sent).toHaveLength(3);
  });

  it('records down health when the threshold tick replays after a secret scan', async () => {
    const ctx = await setup({ gateway: true });
    const fake = ctx.fake;
    if (fake === undefined) throw new Error('no gateway');
    await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await ctx.store.transaction((trx) =>
      trx
        .updateTable('session_snapshot')
        .set({ state: 'working' })
        .where('id', '=', 'worker-1')
        .execute(),
    );
    ctx.advance(120_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await ctx.store.transaction((trx) =>
      trx
        .updateTable('session_snapshot')
        .set({ state: 'waiting' })
        .where('id', '=', 'worker-1')
        .execute(),
    );
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(300_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(3);
    await ctx.sender.recordConnection('down', ctx.now());
    // The feed line claimed in the threshold tick must not deliver and delete the feed row.
    fake.platform.timeoutNext({ visible: false });
    ctx.advance(900_000);
    await ctx.ring();
    await ctx.sender.tick();
    const refusal = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('kind', '=', 'worker_not_reading')
      .executeTakeFirstOrThrow();
    // Its feed line is the outbox write that made the scan replay the claim transaction.
    expect(refusal.line_outbox_id).not.toBeNull();
    expect(
      (
        await ctx.store.db.selectFrom('transport_health').select('space').orderBy('space').execute()
      ).map((row) => row.space),
    ).toEqual(['feed', 'orchestrators']);
    const transport = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', '=', `transport:${fake.kind}`)
      .where('cleared_at', 'is', null)
      .execute();
    expect(transport).toEqual([
      expect.objectContaining({ kind: 'transport_health', line_outbox_id: null }),
    ]);
    expect(ctx.sent).toHaveLength(3);
  });

  it('uses the configured pause after each delivered ring', async () => {
    const ctx = await setup({
      retry: { firstRetryMs: 2000, secondRetryMs: 6000, unansweredAfterMs: 10_000 },
    });
    await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    ctx.advance(1999);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    ctx.advance(1);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(5999);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(1);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(3);
    ctx.advance(9999);
    await ctx.ring();
    await ctx.sender.tick();
    expect(await ctx.store.db.selectFrom('operator_item').select('kind').execute()).toEqual([]);
    ctx.advance(1);
    await ctx.ring();
    await ctx.sender.tick();
    expect(await ctx.store.db.selectFrom('operator_item').select('kind').execute()).toEqual([
      { kind: 'worker_not_reading' },
    ]);
  });

  it('closes a worker notification when its block escalates to the operator', async () => {
    const ctx = await setup();
    const blockId = await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    const escalated = await ctx.apply(
      ops.escalate,
      { block: blockId },
      'agent:web/worker-1',
      'escalate-worker',
    );
    expect(escalated.block.addressee).toBe('operator');
    const closed = await ctx.store.db
      .selectFrom('notification')
      .select('acked_at')
      .executeTakeFirstOrThrow();
    expect(closed.acked_at).not.toBeNull();
    ctx.advance(2_000_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
  });

  it('delivers an escalation note as a reply in the opened thread', async () => {
    const ctx = await setup({ gateway: true });
    const fake = ctx.fake;
    if (fake === undefined) throw new Error('no gateway');
    const block = await ctx.store.transaction((trx) =>
      trx
        .insertInto('block')
        .values({
          task_id: 1,
          type: 'code',
          reason: 'Fix checks',
          author: 'agent:web/worker-1',
          addressee_role: 'worker',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: new Date(START).toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await ctx.apply(
      ops.escalate,
      { block: `B${String(block.id)}`, note: 'Tried twice already.' },
      'agent:web/worker-1',
      'escalate-note',
    );
    await ctx.sender.tick();
    ctx.advance(60_000);
    await ctx.sender.tick();
    expect(fake.platform.conversations()).toHaveLength(1);
    const texts = fake.platform.messages().map((message) => message.text);
    expect(texts.some((text) => text.includes('Fix checks'))).toBe(true);
    expect(texts.some((text) => text.includes('Tried twice already.'))).toBe(true);
    expect(ctx.sent).toEqual([]);
  });

  it('raises answer_undelivered only after three unanswered rings to a live role session', async () => {
    const ctx = await setup({ author: 'ended', replacement: true });
    const asked = await ctx.apply(
      ops.ask,
      { task: KEY, text: 'Which version?' },
      'agent:web/worker-1',
      'ask-unread',
    );
    await ctx.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
    for (const pause of [0, 120_000, 300_000]) {
      ctx.advance(pause);
      await ctx.ring();
      await ctx.sender.tick();
    }
    expect(ctx.sent).toHaveLength(3);
    ctx.advance(900_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(await ctx.store.db.selectFrom('operator_item').select('kind').execute()).toEqual([
      { kind: 'answer_undelivered' },
    ]);
    expect(
      await ctx.store.db
        .selectFrom('outbox')
        .select('kind')
        .where('kind', '=', 'feed.line')
        .execute(),
    ).toEqual([]);
    const answer = await ctx.store.db
      .selectFrom('command')
      .select('key')
      .where('operation', '=', 'block.answer')
      .executeTakeFirstOrThrow();
    const events = await ctx.store.db
      .selectFrom('event')
      .select(['id', 'kind', 'request_id'])
      .orderBy('id')
      .execute();
    expect(events.filter((event) => event.kind === 'block_opened')).toMatchObject([
      { request_id: 'ask-unread' },
    ]);
    const answered = events.filter((event) => event.request_id === answer.key);
    expect(answered.length).toBeGreaterThan(0);
    const lastCommandEvent = Math.max(...answered.map((event) => event.id));
    expect(
      events
        .filter((event) => event.id <= lastCommandEvent)
        .every((event) => event.request_id === 'ask-unread' || event.request_id === answer.key),
    ).toBe(true);
    const unkeyed = events.filter((event) => event.id > lastCommandEvent);
    expect(unkeyed.map((event) => event.kind)).toContain('doorbell_rung');
    expect(unkeyed.map((event) => event.kind)).toContain('from_you_raised');
    expect(unkeyed.map((event) => event.request_id)).toEqual(unkeyed.map(() => null));
  });

  it('does not count a transport retry as another semantic ring', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    ctx.failNext();
    await ctx.ring();
    await ctx.sender.tick();
    expect(
      await ctx.store.db.selectFrom('notification').select('rings').executeTakeFirst(),
    ).toEqual({ rings: 0 });
    ctx.advance(1000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(
      await ctx.store.db.selectFrom('notification').select('rings').executeTakeFirst(),
    ).toEqual({ rings: 1 });
    expect(
      await ctx.store.db.selectFrom('outbox').select(['attempts', 'state']).executeTakeFirst(),
    ).toEqual({ attempts: 2, state: 'done' });
    expect(ctx.sent).toHaveLength(1);
  });

  type Ctx = Awaited<ReturnType<typeof setup>>;

  /** Opens a worker block or an answer to worker-1's question; returns the block number. */
  async function ringFor(ctx: Ctx, kind: 'block' | 'answer'): Promise<string> {
    if (kind === 'block') return workerBlock(ctx.store);
    const asked = await ctx.apply(
      ops.ask,
      { task: KEY, text: 'Which version?' },
      'agent:web/worker-1',
      'ask-rejected',
    );
    await ctx.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
    return asked.block.id;
  }

  function doorbells(ctx: Ctx) {
    return ctx.store.db
      .selectFrom('outbox')
      .selectAll()
      .where('kind', '=', 'doorbell')
      .orderBy('id')
      .execute();
  }

  async function undelivered(ctx: Ctx) {
    const rows = await ctx.store.db
      .selectFrom('event')
      .select('payload')
      .where('kind', '=', 'doorbell_undelivered')
      .execute();
    return rows.map((row) => JSON.parse(row.payload) as { doorbell: string; reason: string });
  }

  const ITEM_KIND = { block: 'worker_not_reading', answer: 'answer_undelivered' } as const;

  it.each(['block', 'answer'] as const)('ends a %s ring Spur rejects', async (kind) => {
    const ctx = await setup();
    const blockId = await ringFor(ctx, kind);
    ctx.failNext(
      new SpurRejectedError('Spur send failed with HTTP 404: Session not found: worker-1'),
    );
    await ctx.ring();
    await ctx.sender.tick();
    const [ring] = await doorbells(ctx);
    expect(ring).toMatchObject({
      state: 'dead',
      last_error: expect.stringContaining('HTTP 404') as unknown,
    });
    const notification = await ctx.store.db
      .selectFrom('notification')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(notification.exhausted_at).not.toBeNull();
    const items = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('kind', '=', ITEM_KIND[kind])
      .execute();
    expect(items).toEqual([
      expect.objectContaining({ task_id: 1, text: expect.stringContaining('HTTP 404') as unknown }),
    ]);
    expect(items[0]?.text).toContain(`block ${blockId} on ${KEY}`);
    expect(await undelivered(ctx)).toEqual([
      {
        doorbell: `N${String(notification.id)}`,
        reason: expect.stringContaining('HTTP 404') as unknown,
      },
    ]);

    ctx.advance(24 * 60 * 60_000);
    for (let i = 0; i < 3; i++) {
      await ctx.ring();
      await ctx.sender.tick();
    }
    expect(ctx.sent).toEqual([]);
    expect(await doorbells(ctx)).toHaveLength(1);

    await ctx.store.transaction((trx) =>
      restartNotification(trx, notification.source_key, ctx.now()),
    );
    await ctx.ring();
    await ctx.sender.tick();
    const rings = await doorbells(ctx);
    expect(rings).toHaveLength(2);
    expect(rings[1]?.dedupe_key).toMatch(/:1:s1$/);
    expect(ctx.sent).toHaveLength(1);
  });

  it('ends a ring after 30 min of retryable Spur failures', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    ctx.failAlways(true);
    for (let minute = 0; minute < 30; minute++) {
      await ctx.ring();
      await ctx.sender.tick();
      ctx.advance(60_000);
    }
    // The last tick ran 29 min after the first attempt.
    expect(await doorbells(ctx)).toEqual([
      expect.objectContaining({ state: 'pending', uncertain: 1 }),
    ]);
    await ctx.ring();
    await ctx.sender.tick();
    expect(await doorbells(ctx)).toEqual([
      expect.objectContaining({
        state: 'dead',
        last_error: 'no answer from Spur for 30 min: spur send failed',
      }),
    ]);
    expect(
      (await ctx.store.db.selectFrom('notification').select('exhausted_at').executeTakeFirst())
        ?.exhausted_at,
    ).not.toBeNull();
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select('kind')
        .where('kind', '=', 'worker_not_reading')
        .execute(),
    ).toHaveLength(1);
    const [event] = await undelivered(ctx);
    expect(event?.reason).toMatch(/^no answer from Spur for 30 min/);
    expect(ctx.sent).toEqual([]);
  });

  it('keeps the notification ringing when a ring it no longer points at fails', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    await ctx.ring();
    // While ring A to worker-1 is in flight, worker-1 stops and worker-2 takes over: the
    // doorbell job queues ring B to worker-2, then A's send fails for good.
    ctx.beforeSend(async () => {
      await ctx.store.transaction(async (trx) => {
        await trx
          .updateTable('session_snapshot')
          .set({ state: 'stopped', ended_at: ctx.now().toISOString(), end_reason: 'complete' })
          .where('id', '=', 'worker-1')
          .execute();
        await trx
          .insertInto('session_snapshot')
          .values({
            ...sampleRows.session_snapshot,
            id: 'worker-2',
            spur_project: 'web',
            state: 'waiting',
            ended_at: null,
            end_reason: null,
          })
          .execute();
        await trx
          .insertInto('link')
          .values({
            ...sampleRows.link,
            id: 2,
            task_id: 1,
            entity: 'session',
            repo: null,
            number: null,
            pr_state: null,
            session_id: 'worker-2',
            role: 'worker',
          })
          .execute();
      });
      await ctx.ring();
    });
    ctx.failNext(
      new SpurRejectedError('Spur send failed with HTTP 404: Session not found: worker-1'),
    );
    await ctx.sender.tick();
    expect(
      await ctx.store.db.selectFrom('notification').select('exhausted_at').executeTakeFirst(),
    ).toEqual({ exhausted_at: null });
    expect(await undelivered(ctx)).toEqual([]);

    await ctx.sender.tick();
    expect((await doorbells(ctx)).map((row) => row.state)).toEqual(['dead', 'done']);
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-2']);
  });

  it('acknowledges block and comment entries atomically, and rejects another role', async () => {
    const ctx = await setup({ tester: true });
    const blockId = await workerBlock(ctx.store);
    const comment = await ctx.apply(
      ops.add,
      { task: KEY, block: blockId, text: 'Details' },
      'operator',
    );
    await expect(
      ctx.apply(ops.ack, { entries: [{ id: blockId }] }, 'agent:web/tester-1', 'ack-tester'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const result = await ctx.apply(
      ops.ack,
      { entries: [{ id: comment.comment.id, revision: 1 }, { id: blockId }] },
      'agent:web/worker-1',
      'ack-worker',
    );
    expect(result.acked).toEqual([comment.comment.id, blockId]);
    ctx.advance(2_000_000);
    await ctx.sender.tick();
    expect(ctx.sent).toEqual([]);
  });

  it('accepts an ack only from the worker selected for a delivered notification', async () => {
    const ctx = await setup({ replacement: true });
    const blockId = await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
    await expect(
      ctx.apply(ops.ack, { entries: [{ id: blockId }] }, 'agent:web/worker-2', 'ack-other-worker'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await ctx.store.db.selectFrom('notification').select('acked_at').executeTakeFirst(),
    ).toEqual({ acked_at: null });
    await ctx.apply(
      ops.ack,
      { entries: [{ id: blockId }] },
      'agent:web/worker-1',
      'ack-selected-worker',
    );
    const acked = await ctx.store.db
      .selectFrom('notification')
      .select('acked_at')
      .executeTakeFirstOrThrow();
    expect(acked.acked_at).not.toBeNull();
  });

  it.each(['waiting', 'working'] as const)(
    'allows a %s replacement to acknowledge after the selected worker ends',
    async (replacementState) => {
      const ctx = await setup({ replacement: true });
      const blockId = await workerBlock(ctx.store);
      await ctx.ring();
      await ctx.sender.tick();
      expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
      await ctx.store.transaction(async (trx) => {
        await trx
          .updateTable('session_snapshot')
          .set({ state: 'stopped', ended_at: new Date(START + 1).toISOString() })
          .where('id', '=', 'worker-1')
          .execute();
        await trx
          .updateTable('session_snapshot')
          .set({ state: replacementState })
          .where('id', '=', 'worker-2')
          .execute();
      });
      await ctx.apply(
        ops.ack,
        { entries: [{ id: blockId }] },
        'agent:web/worker-2',
        `ack-${replacementState}-handoff`,
      );
      const notification = await ctx.store.db
        .selectFrom('notification')
        .select(['acked_at', 'recipient_session'])
        .executeTakeFirstOrThrow();
      expect(notification.acked_at).not.toBeNull();
      expect(notification.recipient_session).toBe('worker-1');
      expect(ctx.sent).toHaveLength(1);
    },
  );

  it('rejects another live linked worker after the selected recipient ends', async () => {
    const ctx = await setup({ replacement: true });
    const blockId = await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    await ctx.store.transaction(async (trx) => {
      await trx
        .updateTable('session_snapshot')
        .set({ state: 'stopped', ended_at: new Date(START + 1).toISOString() })
        .where('id', '=', 'worker-1')
        .execute();
      await trx
        .updateTable('link')
        .set({ created_at: new Date(START + 2).toISOString() })
        .where('session_id', '=', 'worker-2')
        .execute();
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'worker-3',
          spur_project: 'web',
          state: 'waiting',
          ended_at: null,
          end_reason: null,
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: 3,
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'worker-3',
          role: 'worker',
          created_at: new Date(START + 1).toISOString(),
        })
        .execute();
    });
    await expect(
      ctx.apply(ops.ack, { entries: [{ id: blockId }] }, 'agent:web/worker-3', 'ack-unrelated'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await ctx.store.db.selectFrom('notification').select('acked_at').executeTakeFirst(),
    ).toEqual({ acked_at: null });
    await ctx.apply(ops.ack, { entries: [{ id: blockId }] }, 'agent:web/worker-2', 'ack-handoff');
  });
  it('rings only through the doorbell job, not in the sender tick', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    await ctx.sender.tick();
    expect(ctx.sent).toEqual([]);
    expect(await doorbells(ctx)).toEqual([]);

    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
  });

  it('opens no transaction when no notification is due', async () => {
    const ctx = await setup();
    let transactions = 0;
    const store: Store = {
      ...ctx.store,
      transaction(fn) {
        transactions += 1;
        return ctx.store.transaction(fn);
      },
    };
    const reconcile = async () => {
      const before = transactions;
      await reconcileDueDoorbells(store, config, ctx.now());
      return transactions - before;
    };
    const setNotification = (values: {
      acked_at?: string | null;
      exhausted_at?: string | null;
      next_at?: string;
    }) => ctx.store.transaction((trx) => trx.updateTable('notification').set(values).execute());
    const at = new Date(START).toISOString();

    expect(await reconcile()).toBe(0);
    await workerBlock(ctx.store);
    await setNotification({ acked_at: at });
    expect(await reconcile()).toBe(0);
    await setNotification({ acked_at: null, exhausted_at: at });
    expect(await reconcile()).toBe(0);
    await setNotification({ exhausted_at: null, next_at: new Date(START + 1).toISOString() });
    expect(await reconcile()).toBe(0);
    await setNotification({ next_at: at });
    await ctx.store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'archived' }).execute(),
    );
    expect(await reconcile()).toBe(0);
    expect(await doorbells(ctx)).toEqual([]);

    await ctx.store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'active' }).execute(),
    );
    expect(await reconcile()).toBe(1);
    expect(await doorbells(ctx)).toHaveLength(1);
  });
});
