import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ActorId, type ColumnId, type Config } from '@spur-board/contracts';
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
import { reconcileItems } from '../../src/app/fromYou.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
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
    config?: Config;
    column?: ColumnId;
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
        column: options.column ?? 'dev',
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
  const baseConfig = options.config ?? config;
  const usedConfig = options.retry
    ? configSchema.parse({ ...baseConfig, doorbells: options.retry })
    : baseConfig;
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
    config: usedConfig,
    ops: createBlockMutations(usedConfig),
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
        selectNotificationRecipient(trx, { task_id: 1, role, author_session: null }, config),
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

/** One board project with a `qa` orchestrator on `dev`, a `cur` curator and an `ops` operator. */
function policyBoard(devOrchestrator = 'qa'): Config {
  return configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [
          { name: 'web', role: 'worker' },
          { name: 'qa', role: 'worker' },
          { name: 'cur', role: 'curator' },
          { name: 'ops', role: 'operator' },
        ],
        columns: [
          { id: 'todo', orchestrator: 'none' },
          { id: 'ready-for-dev', orchestrator: 'none' },
          { id: 'dev', orchestrator: devOrchestrator },
          { id: 'review', orchestrator: 'none' },
          { id: 'qa', orchestrator: 'none' },
          { id: 'ready-to-merge', orchestrator: 'none' },
          { id: 'done', orchestrator: 'none' },
        ],
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
}
const policyConfig = policyBoard();
const worker: ActorId = 'agent:web/worker-1';

type Board = Awaited<ReturnType<typeof setup>>;

/** A live Spur session; `firstSeen` is an offset from START. */
async function addSession(
  ctx: Board,
  id: string,
  project: string,
  extra: { firstSeen?: number; activity?: string; absent?: boolean } = {},
): Promise<void> {
  const seen = new Date(START + (extra.firstSeen ?? 0)).toISOString();
  await ctx.store.transaction(async (trx) => {
    await trx
      .insertInto('session_snapshot')
      .values({
        ...sampleRows.session_snapshot,
        id,
        spur_project: project,
        state: 'waiting',
        ended_at: null,
        end_reason: null,
        first_seen: seen,
        absent_since: extra.absent === true ? seen : null,
        detail:
          extra.activity === undefined ? '{}' : JSON.stringify({ lastActivityAt: extra.activity }),
      })
      .execute();
  });
}

async function addLink(ctx: Board, id: number, session: string, role: 'worker' | 'orchestrator') {
  await ctx.store.transaction(async (trx) => {
    await trx
      .insertInto('link')
      .values({
        ...sampleRows.link,
        id,
        task_id: 1,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        session_id: session,
        role,
      })
      .execute();
  });
}

async function setSession(
  ctx: Board,
  id: string,
  values: { ended_at?: string; state?: string; absent_since?: string },
) {
  await ctx.store.transaction(async (trx) => {
    await trx.updateTable('session_snapshot').set(values).where('id', '=', id).execute();
  });
}

/** Runs the doorbell job, then one sender tick. */
async function step(ctx: Board): Promise<void> {
  await ctx.ring();
  await ctx.sender.tick();
}

const sessionsRung = (ctx: Board) => ctx.sent.map((entry) => entry.session);

function notices(ctx: Board) {
  return ctx.store.db.selectFrom('notification').selectAll().orderBy('id').execute();
}

async function journalled(ctx: Board, kind: 'block_escalated' | 'doorbell_undelivered') {
  const rows = await ctx.store.db
    .selectFrom('event')
    .select(['actor', 'payload'])
    .where('kind', '=', kind)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({ actor: row.actor, payload: JSON.parse(row.payload) as unknown }));
}

function itemKinds(ctx: Board) {
  return ctx.store.db.selectFrom('operator_item').select(['kind', 'item_key']).execute();
}

/** Where each role resolved by Spur project lives on `policyConfig`. */
const BY_PROJECT = {
  curator: { column: 'qa', project: 'cur' },
  'orchestrator:dev': { column: 'dev', project: 'qa' },
} as const;

describe('curator doorbells', () => {
  it('rings the later session, then the most active on a tie, choosing on every ring', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur', { firstSeen: -2000 });
    await addSession(ctx, 'cur-2', 'cur', {
      firstSeen: -1000,
      activity: '2026-11-03T09:00:00Z',
    });
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    expect(asked.block.addressee).toBe('curator');
    await step(ctx);
    await addSession(ctx, 'cur-3', 'cur', {
      firstSeen: -1000,
      activity: '2026-11-03T09:30:00.5Z',
    });
    ctx.advance(120_000);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-2', 'cur-3']);
  });

  it.each(['curator', 'orchestrator:dev'] as const)(
    'moves the next %s ring to a new session and keeps the count',
    async (role) => {
      const { column, project } = BY_PROJECT[role];
      const ctx = await setup({ config: policyConfig, column });
      await addSession(ctx, `${project}-1`, project, { firstSeen: -2000 });
      const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
      expect(asked.block.addressee).toBe(role);
      await step(ctx);
      await addSession(ctx, `${project}-2`, project, { firstSeen: -1000 });
      ctx.advance(120_000);
      await step(ctx);
      expect(sessionsRung(ctx)).toEqual([`${project}-1`, `${project}-2`]);
      expect(await notices(ctx)).toEqual([
        expect.objectContaining({ role, rings: 2, recipient_session: `${project}-2` }),
      ]);
    },
  );

  it.each(['curator', 'orchestrator:dev'] as const)(
    'a %s ring killed by a move does not block the ring after a move back',
    async (role) => {
      const { column, project } = BY_PROJECT[role];
      const ctx = await setup({ config: policyConfig, column });
      await addSession(ctx, `${project}-1`, project, { firstSeen: -2000 });
      await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
      await ctx.ring();
      await addSession(ctx, `${project}-2`, project, { firstSeen: -1000 });
      await ctx.ring();
      await setSession(ctx, `${project}-2`, { absent_since: ctx.now().toISOString() });
      await ctx.ring();
      await ctx.sender.tick();
      expect(sessionsRung(ctx)).toEqual([`${project}-1`]);
      const rows = await ctx.store.db
        .selectFrom('outbox')
        .select(['dedupe_key', 'state'])
        .where('kind', '=', 'doorbell')
        .orderBy('id')
        .execute();
      expect(rows.map((row) => row.state)).toEqual(['dead', 'dead', 'done']);
      expect(rows[2]?.dedupe_key).toMatch(new RegExp(`:${project}-1:1:m2$`));
    },
  );

  it('does not choose an absent curator session; a worker is unaffected', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur', { firstSeen: -2000 });
    await addSession(ctx, 'cur-2', 'cur', { firstSeen: -1000, absent: true });
    await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-1']);

    const plain = await setup();
    expect(
      await plain.store.db
        .selectFrom('session_snapshot')
        .select('absent_since')
        .where('id', '=', 'worker-1')
        .executeTakeFirst(),
    ).toEqual({ absent_since: expect.any(String) as unknown });
    await workerBlock(plain.store);
    await step(plain);
    expect(sessionsRung(plain)).toEqual(['worker-1']);
  });

  it.each(['rejected', 'no session'] as const)(
    'moves a curator block to the operator when the ring is %s',
    async (cause) => {
      const ctx = await setup({ config: policyConfig, column: 'qa' });
      if (cause === 'rejected') {
        await addSession(ctx, 'cur-1', 'cur');
        ctx.failNext(
          new SpurRejectedError('Spur send failed with HTTP 404: Session not found: cur-1'),
        );
      }
      const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
      await step(ctx);
      expect(
        await ctx.store.db.selectFrom('block').select('addressee_role').executeTakeFirst(),
      ).toEqual({ addressee_role: 'operator' });
      expect(await journalled(ctx, 'block_escalated')).toEqual([
        {
          actor: 'system',
          payload: {
            block: asked.block.id,
            from: 'curator',
            to: 'operator',
            reason:
              cause === 'rejected'
                ? (expect.stringContaining('HTTP 404') as unknown)
                : 'no live curator session',
          },
        },
      ]);
      expect(
        await ctx.store.db
          .selectFrom('outbox')
          .select('kind')
          .where('kind', '=', 'conversation.open')
          .execute(),
      ).toHaveLength(1);
      // The item rules parse full session facts, which these fixture sessions do not carry.
      await scanTransaction(ctx.store, ctx.config, async (trx) => {
        await trx.deleteFrom('link').execute();
        await trx.deleteFrom('session_snapshot').execute();
        await reconcileItems(trx, ctx.config, ctx.now().getTime(), true);
      });
      expect(await itemKinds(ctx)).toEqual([
        {
          kind: expect.any(String) as unknown,
          item_key: `operator-block:${asked.block.id.slice(1)}`,
        },
      ]);
      expect(await journalled(ctx, 'doorbell_undelivered')).toHaveLength(1);
    },
  );

  it('escalates after three unanswered rings', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur');
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    for (const pause of [0, 120_000, 300_000]) {
      ctx.advance(pause);
      await step(ctx);
    }
    expect(ctx.sent).toHaveLength(3);
    ctx.advance(900_000);
    await step(ctx);
    expect(await journalled(ctx, 'block_escalated')).toEqual([
      {
        actor: 'system',
        payload: { block: asked.block.id, from: 'curator', to: 'operator', reason: 'unanswered' },
      },
    ]);
    expect(await itemKinds(ctx)).toEqual([]);
    expect(ctx.sent).toHaveLength(3);
  });

  it('stops the series on an ack from a curator session that was not rung', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur', { firstSeen: -2000 });
    await addSession(ctx, 'cur-2', 'cur', { firstSeen: -1000 });
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-2']);
    await ctx.apply(ctx.ops.ack, { entries: [{ id: asked.block.id }] }, 'agent:cur/cur-1', 'ack');
    ctx.advance(2_000_000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
    expect((await notices(ctx))[0]?.acked_at).not.toBeNull();
  });

  it.each(['orchestrator:dev', 'operator'] as const)(
    'refuses a linked worker an %s answer and accepts the role that holds it',
    async (role) => {
      const ctx = await setup({ config: policyConfig, column: role === 'operator' ? 'qa' : 'dev' });
      const asker: ActorId = role === 'operator' ? 'agent:ops/ops-1' : 'agent:qa/qa-1';
      const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, asker, 'ask');
      const answered = await ctx.apply(
        ctx.ops.answer,
        { block: asked.block.id, text: 'A.' },
        'operator',
        'answer',
      );
      expect((await notices(ctx)).filter((n) => n.kind === 'answer')).toEqual([
        expect.objectContaining({ role, recipient_session: null }),
      ]);
      const entries = { entries: [{ id: answered.comment.id, revision: 1 }] };
      await expect(ctx.apply(ctx.ops.ack, entries, worker, 'ack-worker')).rejects.toMatchObject({
        code: 'forbidden',
      });
      let holder = asker;
      if (role === 'orchestrator:dev') {
        await addSession(ctx, 'helper-1', 'web');
        await addLink(ctx, 20, 'helper-1', 'orchestrator');
        holder = 'agent:web/helper-1';
      }
      await ctx.apply(ctx.ops.ack, entries, holder, 'ack-holder');
      expect((await notices(ctx)).every((n) => n.acked_at !== null)).toBe(true);
    },
  );

  it.each([
    { role: 'worker', column: 'qa', project: 'web', session: 'worker-1' },
    { role: 'curator', column: 'qa', project: 'cur', session: 'cur-1' },
    { role: 'orchestrator:dev', column: 'dev', project: 'qa', session: 'qa-1' },
  ] as const)(
    'rings the $role author after an answer and after a clarification',
    async ({ role, column, project, session }) => {
      const ctx = await setup({ config: policyConfig, column });
      if (role !== 'worker') await addSession(ctx, session, project);
      const asker: ActorId = `agent:${project}/${session}`;
      const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, asker, 'ask');
      const answered = await ctx.apply(
        ctx.ops.answer,
        { block: asked.block.id, text: 'A.' },
        'operator',
        'answer',
      );
      await step(ctx);
      expect(sessionsRung(ctx)).toEqual([session]);
      await ctx.apply(
        ctx.ops.ack,
        { entries: [{ id: answered.comment.id, revision: 1 }] },
        asker,
        'ack',
      );
      await ctx.apply(ctx.ops.edit, { comment: answered.comment.id, text: 'A2.' }, 'operator');
      await step(ctx);
      expect(sessionsRung(ctx)).toEqual([session, session]);
      expect(
        (await notices(ctx))
          .filter((n) => n.kind === 'answer')
          .map((n) => ({ role: n.role, revision: n.revision })),
      ).toEqual([
        { role, revision: 1 },
        { role, revision: 2 },
      ]);
    },
  );

  it.each([
    {
      name: 'rings the later curator session over a live older author',
      ...BY_PROJECT.curator,
      author: { firstSeen: -2000 },
      other: { firstSeen: -1000 },
      expected: 'cur-2',
    },
    {
      name: 'does not ring an absent curator author',
      ...BY_PROJECT.curator,
      author: { firstSeen: -1000, absent: true },
      other: { firstSeen: -2000 },
      expected: 'cur-2',
    },
    {
      name: 'rings a live orchestrator author first',
      ...BY_PROJECT['orchestrator:dev'],
      author: { firstSeen: -2000 },
      other: { firstSeen: -1000 },
      expected: 'qa-1',
    },
    {
      name: 'passes over an absent orchestrator author',
      ...BY_PROJECT['orchestrator:dev'],
      author: { firstSeen: -2000, absent: true },
      other: { firstSeen: -3000 },
      expected: 'qa-2',
    },
  ])('$name', async ({ column, project, author, other, expected }) => {
    const ctx = await setup({ config: policyConfig, column });
    await addSession(ctx, `${project}-1`, project, author);
    await addSession(ctx, `${project}-2`, project, other);
    const asked = await ctx.apply(
      ctx.ops.ask,
      { task: KEY, text: 'Q?' },
      `agent:${project}/${project}-1`,
      'ask',
    );
    await ctx.apply(ctx.ops.answer, { block: asked.block.id, text: 'A.' }, 'operator', 'answer');
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual([expected]);
  });

  it('holds a curator answer with no live session and keeps its rings', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur');
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, 'agent:cur/cur-1', 'ask');
    await ctx.apply(ctx.ops.answer, { block: asked.block.id, text: 'A.' }, 'operator', 'answer');
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-1']);
    await setSession(ctx, 'cur-1', { ended_at: ctx.now().toISOString(), state: 'stopped' });
    ctx.advance(120_000);
    await step(ctx);
    expect(await notices(ctx)).toEqual([
      expect.objectContaining({
        kind: 'answer',
        rings: 1,
        exhausted_at: null,
        recipient_session: null,
      }),
    ]);
    expect(await itemKinds(ctx)).toEqual([]);
    await addSession(ctx, 'cur-2', 'cur', { firstSeen: 120_000 });
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-1', 'cur-2']);
    expect((await notices(ctx))[0]?.rings).toBe(2);
  });
});

describe('doorbell policy', () => {
  it('rings the addressee of an opened block, then only the new one after an escalation', async () => {
    const ctx = await setup({ config: policyConfig, column: 'dev' });
    await addSession(ctx, 'qa-1', 'qa');
    await addSession(ctx, 'cur-1', 'cur');
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['qa-1']);
    await ctx.apply(ctx.ops.escalate, { block: asked.block.id }, 'agent:qa/qa-1', 'esc');
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['qa-1', 'cur-1']);
    expect((await notices(ctx)).map((n) => [n.source_key, n.acked_at === null])).toEqual([
      ['block:1:orchestrator:dev', false],
      ['block:1:curator', true],
    ]);
  });

  const reviewByCurator = configSchema.parse({
    ...policyConfig,
    projects: policyConfig.projects.map((project) => ({
      ...project,
      columns: project.columns.map((column) =>
        column.id === 'review' ? { ...column, orchestrator: 'cur' } : column,
      ),
    })),
  });
  const withdraw = (block: string) => ({
    mode: 'withdraw' as const,
    block,
    answer: 'Never mind.',
  });
  /** Opens a question from `asker` after starting the live `session` of `project`. */
  const question = (asker: ActorId, session: string, project: string) => async (ctx: Board) => {
    await addSession(ctx, session, project);
    return (await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, asker, 'ask')).block.id;
  };

  it.each([
    {
      by: 'its author',
      actor: worker,
      config: policyConfig,
      column: 'qa' as const,
      open: question(worker, 'cur-1', 'cur'),
      input: withdraw,
      session: 'cur-1',
      addressee: 'curator',
    },
    {
      by: 'the operator',
      actor: 'operator' as const,
      config: policyConfig,
      column: 'qa' as const,
      open: (ctx: Board) => workerBlock(ctx.store),
      input: (block: string) => ({ mode: 'reason' as const, block, reason: 'Never mind.' }),
      session: 'worker-1',
      addressee: 'worker',
    },
    {
      by: 'a new orchestrator session at the curator',
      actor: 'agent:qa/qa-2' as const,
      config: policyConfig,
      column: 'dev' as const,
      open: question('agent:qa/qa-1', 'cur-1', 'cur'),
      input: withdraw,
      session: 'cur-1',
      addressee: 'curator',
    },
    {
      by: 'a new orchestrator session at another orchestrator',
      actor: 'agent:qa/qa-2' as const,
      config: reviewByCurator,
      column: 'review' as const,
      open: question('agent:qa/qa-1', 'cur-1', 'cur'),
      input: withdraw,
      session: 'cur-1',
      addressee: 'orchestrator:review',
    },
  ])(
    'rings the addressee once when $by removes the block',
    async ({ actor, config, column, open, input, session, addressee }) => {
      const ctx = await setup({ config, column });
      const block = await open(ctx);
      await ctx.apply(ctx.ops.unblock, input(block), actor, 'remove');
      expect(
        await ctx.store.db
          .selectFrom('block')
          .select(['outcome_reason', 'addressee_role'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ outcome_reason: 'Never mind.', addressee_role: addressee });
      expect((await notices(ctx)).filter((n) => n.kind === 'answer')).toEqual([]);
      await step(ctx);
      expect(ctx.sent).toEqual([
        {
          session,
          text: `${KEY} block ${block} was removed by ${actor}; see board task ${KEY} (N2-1)`,
        },
      ]);
      expect((await notices(ctx)).find((n) => n.kind === 'removed')?.acked_at).not.toBeNull();
      ctx.advance(2_000_000);
      await step(ctx);
      expect(ctx.sent).toHaveLength(1);
    },
  );

  it('rings nobody when the addressee closes a block with --done', async () => {
    const ctx = await setup({ config: policyConfig });
    const block = await workerBlock(ctx.store);
    await ctx.apply(ctx.ops.unblock, { mode: 'done', block }, worker, 'done');
    await step(ctx);
    expect(ctx.sent).toEqual([]);
    expect((await notices(ctx)).map((n) => n.kind)).toEqual(['block']);
  });

  it('rings nobody for a task-level comment', async () => {
    const ctx = await setup({ config: policyConfig });
    await ctx.apply(ctx.ops.add, { task: KEY, text: 'Note.' }, 'operator', 'note');
    await step(ctx);
    expect(await notices(ctx)).toEqual([]);
    expect(ctx.sent).toEqual([]);
  });

  it.each(['rejected', 'timed out'] as const)(
    'ends a removal ring Spur %s without an operator item',
    async (cause) => {
      const ctx = await setup({ config: policyConfig });
      const block = await workerBlock(ctx.store);
      await ctx.apply(
        ctx.ops.unblock,
        { mode: 'reason', block, reason: 'Moot.' },
        'operator',
        'remove',
      );
      if (cause === 'rejected') {
        ctx.failNext(new SpurRejectedError('Spur send failed with HTTP 409: Session completed'));
        await step(ctx);
      } else {
        ctx.failAlways(true);
        for (let minute = 0; minute <= 30; minute++) {
          await step(ctx);
          ctx.advance(60_000);
        }
        ctx.failAlways(false);
      }
      const removed = (await notices(ctx)).find((n) => n.kind === 'removed');
      expect(removed?.exhausted_at).not.toBeNull();
      expect(await journalled(ctx, 'doorbell_undelivered')).toEqual([
        { actor: 'system', payload: { doorbell: 'N2', reason: expect.any(String) as unknown } },
      ]);
      expect(await itemKinds(ctx)).toEqual([]);
      ctx.advance(24 * 60 * 60_000);
      await step(ctx);
      expect(ctx.sent).toEqual([]);
    },
  );

  it.each([
    {
      name: 'a question opened to the operator',
      run: (ctx: Board) =>
        ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, 'agent:cur/cur-1', 'ask'),
    },
    {
      name: 'an escalation to the operator',
      run: async (ctx: Board) => {
        const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
        await ctx.apply(ctx.ops.escalate, { block: asked.block.id }, 'agent:cur/cur-1', 'esc');
      },
    },
    {
      name: 'a withdrawn operator question',
      run: async (ctx: Board) => {
        const asked = await ctx.apply(
          ctx.ops.ask,
          { task: KEY, text: 'Q?' },
          'agent:cur/cur-1',
          'ask',
        );
        await ctx.apply(
          ctx.ops.unblock,
          { mode: 'withdraw', block: asked.block.id, answer: 'Never mind.' },
          'agent:cur/cur-1',
          'withdraw',
        );
      },
    },
    {
      name: 'an operator question withdrawn by a new curator session',
      run: async (ctx: Board) => {
        const asked = await ctx.apply(
          ctx.ops.ask,
          { task: KEY, text: 'Q?' },
          'agent:cur/cur-1',
          'ask',
        );
        await ctx.apply(
          ctx.ops.unblock,
          { mode: 'withdraw', block: asked.block.id, answer: 'Never mind.' },
          'agent:cur/cur-2',
          'withdraw',
        );
        expect(
          (await ctx.store.db.selectFrom('outbox').select('kind').orderBy('id').execute()).map(
            (row) => row.kind,
          ),
        ).toEqual(['conversation.open', 'conversation.reply', 'conversation.close']);
      },
    },
  ])('registers no operator notification for $name', async ({ run }) => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await run(ctx);
    expect((await notices(ctx)).filter((n) => n.role === 'operator')).toEqual([]);
    await step(ctx);
    expect(
      await ctx.store.db.selectFrom('outbox').select('id').where('kind', '=', 'doorbell').execute(),
    ).toEqual([]);
    expect(await journalled(ctx, 'doorbell_undelivered')).toEqual([]);
  });

  it.each([
    ['dependency', 'qa', 'agent:qa/qa-1'],
    ['external', 'qa', 'agent:qa/qa-1'],
    ['dependency', 'cur', 'agent:cur/cur-1'],
  ] as const)(
    'rings nobody for an orchestrator own %s block (orchestrator %s)',
    async (type, orchestrator, actor) => {
      const ctx = await setup({ config: policyBoard(orchestrator), column: 'dev' });
      await addSession(ctx, actor.split('/')[1] ?? '', orchestrator);
      const created = await ctx.apply(
        ctx.ops.create,
        { task: KEY, type, reason: 'Waiting.' },
        actor,
        'create',
      );
      expect(created.block.addressee).toBe('orchestrator:dev');
      await step(ctx);
      expect(await notices(ctx)).toEqual([]);
      expect(ctx.sent).toEqual([]);
    },
  );

  it("a second session of the addressee's role closing a block rings nobody", async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur');
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await ctx.apply(
      ctx.ops.unblock,
      { mode: 'reason', block: asked.block.id, reason: 'Moot.' },
      'agent:cur/cur-2',
      'close',
    );
    await step(ctx);
    expect((await notices(ctx)).map((n) => n.kind)).toEqual(['block']);
    expect(ctx.sent).toEqual([]);
  });

  it('a dual-role escalation still rings the curator role', async () => {
    const ctx = await setup({ config: policyBoard('cur'), column: 'dev' });
    await addSession(ctx, 'cur-1', 'cur');
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    expect(asked.block.addressee).toBe('orchestrator:dev');
    const moved = await ctx.apply(
      ctx.ops.escalate,
      { block: asked.block.id },
      'agent:cur/cur-1',
      'esc',
    );
    expect(moved.block.addressee).toBe('curator');
    expect((await notices(ctx)).map((n) => [n.role, n.acked_at === null])).toEqual([
      ['orchestrator:dev', false],
      ['curator', true],
    ]);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-1']);
  });

  it.each(['curator', 'orchestrator:dev'] as const)(
    'registers no answer when a later %s session comments on or edits its question',
    async (role) => {
      const { column, project } = BY_PROJECT[role];
      const ctx = await setup({ config: policyConfig, column });
      const asked = await ctx.apply(
        ctx.ops.ask,
        { task: KEY, text: 'Q?' },
        `agent:${project}/${project}-1`,
        'ask',
      );
      const later: ActorId = `agent:${project}/${project}-2`;
      const added = await ctx.apply(
        ctx.ops.add,
        { task: KEY, block: asked.block.id, text: 'More detail.' },
        later,
        'add',
      );
      await ctx.store.transaction((trx) =>
        trx.updateTable('comment').set({ acked_revision: 1 }).execute(),
      );
      const edited = await ctx.apply(
        ctx.ops.edit,
        { comment: added.comment.id, text: 'Even more detail.' },
        later,
        'edit',
      );
      expect(edited.comment.revision).toBe(2);
      expect((await notices(ctx)).filter((n) => n.kind === 'answer')).toEqual([]);
    },
  );
});
