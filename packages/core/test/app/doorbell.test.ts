import {
  configSchema,
  parseRingMarker,
  sessionFactsSchema,
  type ActorId,
  type ColumnId,
  type Config,
} from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  createApply,
  createBlockMutations,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  createSender,
  openStore,
  reconcileDueDoorbells,
  tickBoard,
  toJson,
  type Store,
} from '../../src/index.ts';
import {
  registerBlockNotification,
  restartNotification,
  selectNotificationRecipient,
} from '../../src/app/doorbells.ts';
import { withVia } from '../../src/app/board-utils.ts';
import { curatorSessions } from '../../src/app/doctor.ts';
import { raiseCourseCheck } from '../../src/app/course-check.ts';
import { raiseCycleLimit, reconcileItems } from '../../src/app/fromYou.ts';
import { createItemMutations } from '../../src/app/items.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { SpurRejectedError } from '../../src/app/sender.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { archiveTask } from '../../src/app/archive.ts';
import { createLinkMutations } from '../../src/app/links.ts';
import { quietTurns, remindStuckTurns } from '../../src/app/quiet-turns.ts';
import { closeTurns, isTurnOpen, openTurn, turnExecutor } from '../../src/app/turns.ts';
import { openTempStore } from '../support/store.ts';
import {
  CONVERSATION_AT,
  conversationConfig,
  conversationStore,
  liveSession,
  startConversation,
} from '../support/conversation.ts';
import { recordInboundBlockMessage } from '../../src/app/blocks.ts';
import { SLACK_ON } from '../support/config.ts';

const KEY = 'o/r#101';
const DAY_MS = 86_400_000;
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
  slack: SLACK_ON,
  digest: { tz: 'UTC' },
});
const ops = createBlockMutations(config);
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup(
  options: {
    reopen?: string;
    author?: 'waiting' | 'ended';
    replacement?: boolean;
    tester?: boolean;
    retry?: { firstRetryMs: number; secondRetryMs: number; unansweredAfterMs: number };
    gateway?: boolean;
    config?: Config;
    column?: ColumnId;
  } = {},
) {
  const opened =
    options.reopen === undefined
      ? openTempStore('core-doorbell-')
      : { store: openStore(options.reopen), file: options.reopen };
  const { store, file } = opened;
  stores.push(store);
  let now = START;
  let failNext: Error | undefined;
  let failAlways = false;
  let beforeSend: (() => Promise<void>) | undefined;
  const sent: { session: string; text: string }[] = [];
  if (options.reopen === undefined)
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
    file,
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
    await registerBlockNotification(trx, block, new Date(START), config);
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

  it('holds the first ring while the recipient is observed working and rings once it waits', async () => {
    const ctx = await setup();
    await observeHealth(ctx, 'worker-1', 'working');
    expect(
      await ctx.store.db
        .selectFrom('session_snapshot')
        .select(['state', 'raw_state'])
        .where('id', '=', 'worker-1')
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'running', raw_state: 'running' });
    await workerBlock(ctx.store);
    await step(ctx);
    ctx.advance(60_000);
    await step(ctx);
    expect(ctx.sent).toEqual([]);
    expect(await ctx.store.db.selectFrom('outbox').select('id').execute()).toEqual([]);

    await observeHealth(ctx, 'worker-1', 'waiting');
    await step(ctx);
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
    expect(ctx.sent[0]?.text).toContain('(N1-1)');
  });

  it('defers a queued ring when its recipient turns working before the send', async () => {
    const ctx = await setup();
    await observeHealth(ctx, 'worker-1', 'waiting');
    await workerBlock(ctx.store);
    await ctx.ring();
    await observeHealth(ctx, 'worker-1', 'working');
    await ctx.sender.tick();
    expect(ctx.sent).toEqual([]);
    expect(
      await ctx.store.db
        .selectFrom('outbox')
        .select('state')
        .where('kind', '=', 'doorbell')
        .execute(),
    ).toEqual([{ state: 'pending' }]);

    await observeHealth(ctx, 'worker-1', 'waiting');
    ctx.advance(1000);
    await ctx.sender.tick();
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
    expect(ctx.sent[0]?.text).toContain('(N1-1)');
  });

  it.each(['waiting', 'needs_input', 'rate_limited', 'stale', 'error', 'thinking'])(
    'rings a recipient observed %s at once',
    async (value) => {
      const ctx = await setup();
      await observeHealth(ctx, 'worker-1', value);
      await workerBlock(ctx.store);
      await step(ctx);
      expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
    },
  );

  it('rings a recipient whose stored health is working while Spur is blind', async () => {
    const ctx = await setup();
    await observeHealth(ctx, 'worker-1', 'working');
    await createObservationCore({
      store: ctx.store,
      config: ctx.config,
      clock: { now: () => ctx.now().getTime() },
    }).reportSourceState('spur', {
      blind: { reason: 'auth', message: 'Access rejected' },
      gone: [],
    });
    await workerBlock(ctx.store);
    await step(ctx);
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-1']);
  });

  it('pauses while working, then raises one worker refusal after three distinct unanswered rings', async () => {
    const ctx = await setup();
    const blockId = await workerBlock(ctx.store);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await observeHealth(ctx, 'worker-1', 'working');
    ctx.advance(120_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await observeHealth(ctx, 'worker-1', 'waiting');
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
    await observeHealth(ctx, 'worker-1', 'working');
    ctx.advance(120_000);
    await ctx.ring();
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await observeHealth(ctx, 'worker-1', 'waiting');
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
    await withVia('web', () =>
      ctx.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator'),
    );
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
      .select(['id', 'kind', 'request_id', 'via'])
      .orderBy('id')
      .execute();
    expect(events.filter((event) => event.kind === 'block_opened')).toMatchObject([
      { request_id: 'ask-unread', via: null },
    ]);
    const answered = events.filter((event) => event.request_id === answer.key);
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.map((event) => event.via)).toEqual(answered.map(() => 'web'));
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
    expect(unkeyed.map((event) => event.via)).toEqual(unkeyed.map(() => null));
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

  it.each([
    {
      by: 'the operator',
      actor: 'operator' as const,
      journal: { actor: 'operator', actor_ref: null },
      input: (block: string) => ({ mode: 'reason' as const, block, reason: 'Handled.' }),
    },
    {
      by: 'the worker',
      actor: 'agent:web/worker-1' as const,
      journal: {
        actor: 'agent',
        actor_ref: JSON.stringify({ project: 'web', session: 'worker-1' }),
      },
      input: (block: string) => ({ mode: 'done' as const, block }),
    },
  ])('clears the not-reading item as $by when $by unblocks', async ({ actor, journal, input }) => {
    const ctx = await setup();
    const block = await workerBlock(ctx.store);
    ctx.failNext(
      new SpurRejectedError('Spur send failed with HTTP 404: Session not found: worker-1'),
    );
    await ctx.ring();
    await ctx.sender.tick();
    await ctx.apply(ctx.ops.unblock, input(block), actor, 'unblock');
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select('cleared_at')
        .where('kind', '=', 'worker_not_reading')
        .execute(),
    ).toEqual([{ cleared_at: ctx.now().toISOString() }]);
    expect(
      await ctx.store.db
        .selectFrom('event')
        .select(['actor', 'actor_ref'])
        .where('kind', '=', 'from_you_cleared')
        .execute(),
    ).toEqual([journal]);
    const edits = await ctx.store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line.edit')
      .execute();
    expect(edits.map((edit) => JSON.parse(edit.payload) as unknown)).toEqual([
      expect.objectContaining({ resolved: { by: actor, at: ctx.now().toISOString() } }),
    ]);
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

describe('rings held in the Spur queue', () => {
  /** The notification and ring the first sent ring carries. */
  function firstRing(ctx: Board) {
    const marker = parseRingMarker(ctx.sent[0]?.text ?? '');
    if (marker === null) throw new Error('no ring sent');
    return marker;
  }

  function items(ctx: Board) {
    return ctx.store.db.selectFrom('operator_item').selectAll().orderBy('id').execute();
  }

  function doorbellRows(ctx: Board) {
    return ctx.store.db.selectFrom('outbox').selectAll().where('kind', '=', 'doorbell').execute();
  }

  it('holds ring 2 while ring 1 waits in the Spur queue', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    await step(ctx);
    await queueRings(ctx, [{ notification: firstRing(ctx).notification, ring: 1 }]);
    for (const pause of [120_000, 300_000, 899_999]) {
      ctx.advance(pause);
      await step(ctx);
    }
    expect(ctx.sent).toHaveLength(1);
    expect(await doorbellRows(ctx)).toHaveLength(1);
    expect(await notices(ctx)).toEqual([expect.objectContaining({ rings: 1, exhausted_at: null })]);
    expect(await items(ctx)).toEqual([]);
  });

  it.each([600_000, 1_319_999])(
    'rings again on schedule once the queued ring is delivered at +%i ms',
    async (drained) => {
      const ctx = await setup();
      await workerBlock(ctx.store);
      await step(ctx);
      const { notification } = firstRing(ctx);
      await queueRings(ctx, [{ notification, ring: 1 }]);
      ctx.advance(120_000);
      await step(ctx);
      ctx.advance(drained - 120_000);
      await step(ctx);
      expect(ctx.sent).toHaveLength(1);
      await queueRings(ctx, []);
      await step(ctx);
      expect(ctx.sent).toHaveLength(2);
      expect(ctx.sent[1]?.text).toMatch(/-2\)$/);
      ctx.advance(299_999);
      await step(ctx);
      expect(ctx.sent).toHaveLength(2);
      ctx.advance(1);
      await step(ctx);
      expect(ctx.sent).toHaveLength(3);
      ctx.advance(899_999);
      await step(ctx);
      expect(await items(ctx)).toEqual([]);
      ctx.advance(1);
      await step(ctx);
      expect(await items(ctx)).toEqual([
        expect.objectContaining({
          kind: 'worker_not_reading',
          raised_at: new Date(START + drained + 1_200_000).toISOString(),
        }),
      ]);
      expect(ctx.sent).toHaveLength(3);
    },
  );

  it.each([1, 2])(
    'ends the series at the usual time while ring %i waits in the Spur queue',
    async (stuck) => {
      const ctx = await setup();
      const blockId = await workerBlock(ctx.store);
      await step(ctx);
      if (stuck === 2) {
        ctx.advance(120_000);
        await step(ctx);
      }
      expect(ctx.sent).toHaveLength(stuck);
      await queueRings(ctx, [{ notification: firstRing(ctx).notification, ring: stuck }]);
      ctx.advance(1_319_999 - (stuck === 2 ? 120_000 : 0));
      await step(ctx);
      expect(await items(ctx)).toEqual([]);
      ctx.advance(1);
      await step(ctx);
      expect(await items(ctx)).toEqual([
        expect.objectContaining({
          kind: 'worker_not_reading',
          text: `worker worker-1 is not reading block ${blockId} on ${KEY}`,
          raised_at: new Date(START + 1_320_000).toISOString(),
        }),
      ]);
      expect(await journalled(ctx, 'doorbell_undelivered')).toEqual([
        expect.objectContaining({ payload: { doorbell: 'N1', reason: 'unanswered' } }),
      ]);
      expect(ctx.sent).toHaveLength(stuck);
    },
  );

  it('never holds a first ring', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    await queueRings(ctx, [{ notification: 1, ring: 1 }]);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.text).toMatch(/\(N1-1\)$/);
  });

  it('holds only an earlier ring of the same series', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    await step(ctx);
    const { notification } = firstRing(ctx);
    await queueRings(ctx, [
      { notification: notification + 1, ring: 1 },
      { notification, ring: 2 },
    ]);
    ctx.advance(120_000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(2);
  });

  it('ignores a queue left in the snapshot while Spur is blind', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    await step(ctx);
    await queueRings(ctx, [{ notification: firstRing(ctx).notification, ring: 1 }]);
    await ctx.store.transaction((trx) =>
      trx
        .insertInto('source_state')
        .values({ ...sampleRows.source_state, source: 'spur', blind_reason: 'unavailable' })
        .execute(),
    );
    ctx.advance(120_000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(2);
  });
});

/**
 * One board project with a `qa` orchestrator on `dev`, a `cur` curator and an `ops` operator;
 * `dev` adds turn timing keys to the dev column. `board.slack: false` leaves Slack and the
 * operator's Slack handle out; `board.operator: 'top-level'` makes `ops` the board-wide operator
 * instead of the project's own.
 */
function policyBoard(
  devOrchestrator = 'qa',
  dev: { quietTurnAfterMs?: number; noRecipientAfterMs?: number } = {},
  board: { slack?: boolean; operator?: 'project-level' | 'top-level' } = {},
): Config {
  const ops = { name: 'ops', role: 'operator' } as const;
  const topLevel = board.operator === 'top-level';
  return configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [
          { name: 'web', role: 'worker' },
          { name: 'qa', role: 'orchestrator' },
          { name: 'cur', role: 'curator' },
          ...(topLevel ? [] : [ops]),
        ],
        columns: [
          { id: 'todo', orchestrator: 'none' },
          { id: 'ready-for-dev', orchestrator: 'none' },
          { id: 'dev', orchestrator: devOrchestrator, ...dev },
          { id: 'review', orchestrator: 'none' },
          { id: 'qa', orchestrator: 'none' },
          { id: 'ready-to-merge', orchestrator: 'none' },
          { id: 'done', orchestrator: 'none' },
        ],
      },
    ],
    ...(topLevel ? { spurProjects: [ops] } : {}),
    ...(board.slack === false ? {} : { operator: { slack: 'operator' }, slack: SLACK_ON }),
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
        finished_at: null,
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
  values: { ended_at?: string; state?: string; absent_since?: string; detail?: string },
) {
  await ctx.store.transaction(async (trx) => {
    await trx.updateTable('session_snapshot').set(values).where('id', '=', id).execute();
  });
}

/** Stores idle facts for a session whose Spur queue holds `rings`; none leaves the key out. */
async function queueRings(
  ctx: Board,
  rings: { notification: number; ring: number }[],
  id = 'worker-1',
): Promise<void> {
  const facts = {
    id,
    spurProject: 'web',
    branch: null,
    pr: null,
    links: {},
    lifecycle: 'running',
    health: 'waiting',
    healthSince: new Date(START).toISOString(),
    lastActivityAt: null,
    endedAt: null,
    endReason: null,
    ...(rings.length > 0 ? { queuedRings: rings } : {}),
  } as const;
  await setSession(ctx, id, { detail: toJson(sessionFactsSchema, facts) });
}

/**
 * Observes `health` for a session through the Spur observation path, as a poll does. The facts
 * are stored first so the observer reads a valid previous detail; the poll then writes the
 * lifecycle columns itself.
 */
async function observeHealth(
  ctx: Board,
  id: string,
  health: string,
  project = 'web',
  lifecycle = 'running',
) {
  const facts = sessionFactsSchema.parse({
    id,
    spurProject: project,
    branch: null,
    pr: null,
    links: {},
    lifecycle,
    health,
    healthSince: ctx.now().toISOString(),
    lastActivityAt: null,
    endedAt: null,
    endReason: null,
  });
  await setSession(ctx, id, { detail: toJson(sessionFactsSchema, facts) });
  await createObservationCore({
    store: ctx.store,
    config: ctx.config,
    clock: { now: () => ctx.now().getTime() },
  }).observe('spur', {
    batch: {
      source: 'spur',
      observedAt: ctx.now().toISOString(),
      complete: true,
      items: [{ kind: 'session', facts }],
      entities: [],
    },
    effectiveComplete: false,
    state: { lastCompleteAt: ctx.now().toISOString(), gone: [] },
    outcomes: [],
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

  it('names in board doctor the curator session it rings, also past a corrupt row', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur', { firstSeen: -3000 });
    await addSession(ctx, 'cur-2', 'cur', { firstSeen: -1000, activity: '2026-11-03T09:00:00Z' });
    await addSession(ctx, 'cur-3', 'cur', {
      firstSeen: -1000,
      activity: '2026-11-03T09:00:00.5Z',
    });
    await addSession(ctx, 'cur-errored', 'cur', { firstSeen: 0 });
    await setSession(ctx, 'cur-errored', { state: 'errored' });
    await addSession(ctx, 'cur-absent', 'cur', { firstSeen: 0, absent: true });
    await addSession(ctx, 'cur-corrupt', 'cur', { firstSeen: -2000 });
    await ctx.store.db
      .updateTable('session_snapshot')
      .set({ detail: 'not json' })
      .where('id', '=', 'cur-corrupt')
      .execute();
    const doctor = async () =>
      (await curatorSessions(ctx.store.db, policyConfig)).map((entry) => entry.session);

    await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await step(ctx);
    expect(await doctor()).toEqual(['cur-3']);
    expect(sessionsRung(ctx)).toEqual(['cur-3']);

    await setSession(ctx, 'cur-3', { absent_since: ctx.now().toISOString() });
    await setSession(ctx, 'cur-2', { state: 'completed' });
    ctx.advance(120_000);
    await step(ctx);
    expect(await doctor()).toEqual(['cur-corrupt']);
    expect(sessionsRung(ctx)).toEqual(['cur-3', 'cur-corrupt']);
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
      expect(rows[2]?.dedupe_key).toMatch(new RegExp(`:${project}-1:1:h1$`));
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

  it('keeps a non-course orchestrator block with no live session due and addressed', async () => {
    const ctx = await setup({ config: policyConfig, column: 'dev' });
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    expect(asked.block.addressee).toBe('orchestrator:dev');
    await step(ctx);
    expect(
      await ctx.store.db.selectFrom('block').select('addressee_role').executeTakeFirst(),
    ).toEqual({ addressee_role: 'orchestrator:dev' });
    expect(await journalled(ctx, 'block_escalated')).toEqual([]);
    expect(await notices(ctx)).toEqual([
      expect.objectContaining({ role: 'orchestrator:dev', exhausted_at: null }),
    ]);
    expect(ctx.sent).toEqual([]);
  });

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

  it('acks an answer by the ring id of its doorbell', async () => {
    const ctx = await setup();
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    const answered = await ctx.apply(
      ctx.ops.answer,
      { block: asked.block.id, text: 'A.' },
      'operator',
      'answer',
    );
    await step(ctx);
    const rung = ctx.sent.find(
      (entry) => entry.session === 'worker-1' && entry.text.includes(`block ${asked.block.id}`),
    );
    const marker = parseRingMarker(rung?.text ?? '');
    if (marker === null) throw new Error('no answer ring sent');
    const id = `N${String(marker.notification)}-${String(marker.ring)}`;
    const ring = { entries: [{ id }] };
    const answers = async () => (await notices(ctx)).filter((n) => n.kind === 'answer');
    const comment = () =>
      ctx.store.db
        .selectFrom('comment')
        .selectAll()
        .where('id', '=', Number(answered.comment.id.slice(1)))
        .executeTakeFirstOrThrow();

    await ctx.apply(ctx.ops.edit, { comment: answered.comment.id, text: 'A2.' }, 'operator');
    expect(await answers()).toHaveLength(1);

    await expect(ctx.apply(ctx.ops.ack, ring, worker, 'ack-ring')).resolves.toEqual({
      acked: [id],
    });
    expect((await comment()).acked_revision).toBe(2);
    expect((await answers())[0]?.acked_at).toBe(ctx.now().toISOString());
    await expect(ctx.apply(ctx.ops.ack, ring, worker, 'ack-ring-again')).resolves.toEqual({
      acked: [id],
      alreadyHandled: [id],
    });

    await ctx.apply(ctx.ops.edit, { comment: answered.comment.id, text: 'A3.' }, 'operator');
    expect((await answers()).map((n) => n.revision)).toEqual([1, 3]);
  });

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

describe('questions after config replacement', () => {
  function replacement(curator = 'cur', dev = 'web'): Config {
    return configSchema.parse({
      ...policyConfig,
      projects: policyConfig.projects.map((project) => ({
        ...project,
        spurProjects: project.spurProjects
          .filter((entry) => entry.name !== 'cur' && entry.name !== 'web')
          .concat(
            [{ name: 'web', role: curator === 'web' ? 'curator' : 'orchestrator' }],
            curator === 'none' || curator === 'web' ? [] : [{ name: curator, role: 'curator' }],
          ),
        columns: project.columns.map((column) =>
          column.id === 'dev' ? { ...column, orchestrator: dev } : column,
        ),
      })),
    });
  }

  async function validSessionFacts(ctx: Board) {
    const sessions = await ctx.store.db.selectFrom('session_snapshot').selectAll().execute();
    for (const session of sessions) {
      await setSession(ctx, session.id, {
        detail: toJson(sessionFactsSchema, {
          id: session.id,
          spurProject: session.spur_project,
          branch: null,
          pr: null,
          links: {},
          lifecycle: 'running',
          health: 'waiting',
          healthSince: ctx.now().toISOString(),
          lastActivityAt: null,
          endedAt: null,
          endReason: null,
        }),
      });
    }
  }

  async function tick(ctx: Board) {
    await tickBoard({
      store: ctx.store,
      config: ctx.config,
      clock: { now: () => ctx.now().getTime() },
      completeSince: new Map(),
    });
  }

  it.each(['cur', 'none', 'web'])(
    'repairs a persisted question with curator %s once after reopening',
    async (curator) => {
      const original = await setup({ config: policyConfig });
      await addSession(original, 'qa-1', 'qa');
      await addSession(original, 'cur-1', 'cur');
      const asked = await original.apply(
        original.ops.ask,
        { task: KEY, text: 'Q?' },
        worker,
        'ask',
      );
      const before = await original.store.db
        .selectFrom('block')
        .selectAll()
        .executeTakeFirstOrThrow();
      await original.store.transaction(async (trx) => {
        await trx.deleteFrom('link').execute();
        await trx.deleteFrom('session_snapshot').where('id', '=', 'worker-1').execute();
        await trx.updateTable('task').set({ column: 'review' }).execute();
      });
      await validSessionFacts(original);
      await original.store.close();
      stores.splice(stores.indexOf(original.store), 1);
      const ctx = await setup({
        config: replacement(curator),
        reopen: original.file,
        gateway: true,
      });
      await tick(ctx);
      const to = curator === 'cur' ? 'curator' : 'operator';
      expect(await ctx.store.db.selectFrom('block').selectAll().executeTakeFirstOrThrow()).toEqual({
        ...before,
        addressee_role: to,
      });
      expect(await journalled(ctx, 'block_escalated')).toEqual([
        {
          actor: 'system',
          payload: {
            block: asked.block.id,
            from: 'orchestrator:dev',
            to,
            reason: 'asker_is_addressee',
          },
        },
      ]);
      await step(ctx);
      expect(sessionsRung(ctx)).toEqual(curator === 'cur' ? ['cur-1'] : []);
      const notifications = await notices(ctx);
      expect(notifications[0]?.acked_at).not.toBeNull();
      expect(notifications.map((note) => note.role)).toEqual(
        curator === 'cur' ? ['orchestrator:dev', 'curator'] : ['orchestrator:dev'],
      );
      if (to === 'operator') {
        expect(
          await ctx.store.db
            .selectFrom('outbox')
            .select('id')
            .where('kind', '=', 'conversation.open')
            .execute(),
        ).toHaveLength(1);
        expect(await itemKinds(ctx)).toContainEqual({
          kind: 'board_observation',
          item_key: 'operator-block:1',
        });
      }
      const clock = { now: () => ctx.now().getTime() };
      const registry = createOperationRegistry({
        config: ctx.config,
        clock,
        completeSince: new Map(),
      });
      const query = createQuery({ store: ctx.store, config: ctx.config, clock });
      expect(
        (await query(registry['task.get'], { task: KEY, why: true }, 'operator')).blocks[0]
          ?.addressee,
      ).toBe(to);
      expect(
        (await query(registry['task.history'], { task: KEY }, 'operator')).events,
      ).toContainEqual(
        expect.objectContaining({
          kind: 'block_escalated',
          summary: `Block ${asked.block.id} escalated from orchestrator:dev to ${to}: asker_is_addressee`,
        }),
      );
      await tick(ctx);
      await step(ctx);
      expect(await notices(ctx)).toEqual(notifications);
      expect(await journalled(ctx, 'block_escalated')).toHaveLength(1);
      expect(ctx.sent).toHaveLength(curator === 'cur' ? 1 : 0);
    },
  );

  it('advances a stored curator held by the asker to the operator', async () => {
    const ctx = await setup({ config: policyConfig, column: 'qa', gateway: true });
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await validSessionFacts(ctx);
    const changed = replacement('web');
    await tickBoard({
      store: ctx.store,
      config: changed,
      clock: { now: () => ctx.now().getTime() },
      completeSince: new Map(),
    });
    expect(await journalled(ctx, 'block_escalated')).toEqual([
      {
        actor: 'system',
        payload: {
          block: asked.block.id,
          from: 'curator',
          to: 'operator',
          reason: 'asker_is_addressee',
        },
      },
    ]);
  });

  it.each([
    'code',
    'dependency',
    'external',
    'system',
    'closed',
    'archived',
    'project',
    'explicit',
    'operator',
  ])('preserves excluded %s blocks and notices', async (excluded) => {
    const ctx = await setup({ config: policyConfig });
    await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await validSessionFacts(ctx);
    await ctx.store.transaction(async (trx) => {
      if (excluded === 'code' || excluded === 'dependency' || excluded === 'external') {
        await trx.updateTable('block').set({ type: excluded }).execute();
      } else if (excluded === 'system') {
        await trx.updateTable('block').set({ author: 'system' }).execute();
      } else if (excluded === 'closed') {
        await trx.updateTable('block').set({ state: 'unblocked' }).execute();
      } else if (excluded === 'archived') {
        await trx
          .updateTable('task')
          .set({ membership: 'archived', archive_reason: 'manual' })
          .execute();
      } else if (excluded === 'project') {
        await trx.updateTable('block').set({ task_id: null, project: 'proj' }).execute();
      } else if (excluded === 'explicit') {
        await trx.updateTable('block').set({ addressee_spur_project: 'web' }).execute();
      } else {
        await trx.updateTable('block').set({ addressee_role: 'operator' }).execute();
      }
    });
    const blocks = await ctx.store.db.selectFrom('block').selectAll().execute();
    const notifications = await notices(ctx);
    await tickBoard({
      store: ctx.store,
      config: replacement(),
      clock: { now: () => ctx.now().getTime() },
      completeSince: new Map(),
    });
    expect(await ctx.store.db.selectFrom('block').selectAll().execute()).toEqual(blocks);
    expect(await notices(ctx)).toEqual(notifications);
    expect(await journalled(ctx, 'block_escalated')).toEqual([]);
  });

  it('leaves an unaffected question and its delivered notice unchanged', async () => {
    const ctx = await setup({ config: policyConfig });
    await addSession(ctx, 'qa-1', 'qa');
    await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await step(ctx);
    await validSessionFacts(ctx);
    const blocks = await ctx.store.db.selectFrom('block').selectAll().execute();
    const notifications = await notices(ctx);
    await tickBoard({
      store: ctx.store,
      config: replacement('cur', 'qa'),
      clock: { now: () => ctx.now().getTime() },
      completeSince: new Map(),
    });
    await tick(ctx);
    await step(ctx);
    expect(await ctx.store.db.selectFrom('block').selectAll().execute()).toEqual(blocks);
    expect(await notices(ctx)).toEqual(notifications);
    expect(await journalled(ctx, 'block_escalated')).toEqual([]);
    expect(ctx.sent).toHaveLength(1);
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

  it('a dual-role escalation skips the curator and rings nobody', async () => {
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
    expect(moved.block.addressee).toBe('operator');
    expect((await notices(ctx)).map((n) => [n.role, n.acked_at === null])).toEqual([
      ['orchestrator:dev', false],
    ]);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual([]);
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

describe('course-check hold', () => {
  const CURATOR: ActorId = 'agent:cur/cur-1';
  const NOTE = 'Split the parser change out first.';

  /** A board with a live curator session; the worker `worker-1` waits. */
  async function board(): Promise<Board> {
    const ctx = await setup({ config: policyConfig });
    await addSession(ctx, 'cur-1', 'cur');
    return ctx;
  }

  /** Raises the course check of task `taskId`; returns its item and block IDs. */
  async function raiseCourse(ctx: Board, taskId = 1) {
    const item = await scanTransaction(ctx.store, ctx.config, async (trx) => {
      const task = await trx
        .selectFrom('task')
        .selectAll()
        .where('id', '=', taskId)
        .executeTakeFirstOrThrow();
      return raiseCourseCheck(trx, {
        task,
        column: 'review',
        count: 3,
        at: ctx.now(),
        config: ctx.config,
      });
    });
    return { item: `I${String(item.id)}`, block: `B${String(item.block_id)}` };
  }

  /**
   * Runs `count` doorbell steps `ms` apart. A deferred ring comes due again a second later, so
   * steps shorter than that let a newer ring overtake one that waited, unless the release moves
   * the waiting ring to the front.
   */
  async function steps(ctx: Board, count: number, ms = 1000): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      ctx.advance(ms);
      await step(ctx);
    }
  }

  const workerTexts = (ctx: Board) =>
    ctx.sent.filter((entry) => entry.session === 'worker-1').map((entry) => entry.text);

  /** The block a ring names: `B<n>` from `<key> block B<n>: ...`. */
  const ringBlocks = (ctx: Board) =>
    workerTexts(ctx).map((text) => /block (B\d+):/.exec(text)?.[1] ?? text);

  async function outboxState(ctx: Board, block: string) {
    const notice = (await notices(ctx)).find(
      (n) => n.kind === 'block' && n.block_id === Number(block.slice(1)),
    );
    const rows = await ctx.store.db
      .selectFrom('outbox')
      .select('state')
      .where('kind', '=', 'doorbell')
      .where(sql<number>`json_extract(payload, '$.notificationId')`, '=', notice?.id ?? 0)
      .execute();
    return rows.map((row) => row.state);
  }

  /** Queues ring Q, raises the course check, then registers worker block R during it. */
  async function held(ctx: Board) {
    const queued = await workerBlock(ctx.store);
    await ctx.ring();
    expect(await outboxState(ctx, queued)).toEqual(['pending']);
    const course = await raiseCourse(ctx);
    const late = await workerBlock(ctx.store);
    await steps(ctx, 4);
    return { queued, course, late };
  }

  it('holds a queued and a new worker ring while the curator is rung', async () => {
    const ctx = await board();
    const { queued, course } = await held(ctx);
    expect(workerTexts(ctx)).toEqual([]);
    expect(ctx.sent).toEqual([
      expect.objectContaining({
        session: 'cur-1',
        text: expect.stringContaining(`block ${course.block}:`) as unknown,
      }),
    ]);
    expect(await outboxState(ctx, queued)).toEqual(['pending']);
    const worker = (await notices(ctx)).filter((n) => n.role === 'worker');
    expect(worker.map((n) => ({ rings: n.rings, exhausted: n.exhausted_at }))).toEqual([
      { rings: 0, exhausted: null },
      { rings: 0, exhausted: null },
    ]);
  });

  it('releases the course note first, then the queued ring, then the new one', async () => {
    const ctx = await board();
    const { queued, course, late } = await held(ctx);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, CURATOR, 'answer');
    await steps(ctx, 12, 250);
    expect(ringBlocks(ctx)).toEqual([course.block, queued, late]);
    expect(await outboxState(ctx, queued)).toEqual(['done']);
  });

  it('keeps the hold through an escalation until the operator answers', async () => {
    const ctx = await board();
    const { queued, course, late } = await held(ctx);
    await ctx.apply(ctx.ops.escalate, { block: course.block }, CURATOR, 'esc');
    await steps(ctx, 4);
    expect(workerTexts(ctx)).toEqual([]);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, 'operator', 'answer');
    await steps(ctx, 12, 250);
    expect(ringBlocks(ctx)).toEqual([course.block, queued, late]);
  });

  it('a cycle-limit item holds no worker ring', async () => {
    const ctx = await board();
    await scanTransaction(ctx.store, ctx.config, async (trx) => {
      const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
      await raiseCycleLimit(trx, { task, column: 'review', at: ctx.now(), config: ctx.config });
    });
    await workerBlock(ctx.store);
    await steps(ctx, 2);
    expect(sessionsRung(ctx)).toEqual(['worker-1']);
  });

  it('a course check on another task holds no ring of this one', async () => {
    const ctx = await board();
    await ctx.store.transaction(async (trx) => {
      await trx
        .insertInto('task')
        .values({
          ...sampleRows.task,
          id: 2,
          key: 'o/r#102',
          tracker_id: '102',
          project: 'proj',
          membership: 'active',
          archive_reason: null,
          column: 'dev',
        })
        .execute();
    });
    await raiseCourse(ctx, 2);
    const block = await workerBlock(ctx.store);
    await steps(ctx, 3);
    expect(ringBlocks(ctx)).toEqual([block]);
  });

  /** The `C<n>` ID of the course note: the task's comment copied from the answer. */
  async function noteId(ctx: Board): Promise<string> {
    const note = await ctx.store.db
      .selectFrom('comment')
      .select('id')
      .where('task_id', '=', 1)
      .where('block_id', 'is', null)
      .executeTakeFirstOrThrow();
    return `C${String(note.id)}`;
  }

  /** The comment IDs `inbox.get` lists for `actor`. */
  async function inboxComments(ctx: Board, actor: ActorId): Promise<string[]> {
    const clock = { now: () => ctx.now().getTime() };
    const registry = createOperationRegistry({
      config: ctx.config,
      clock,
      completeSince: new Map(),
    });
    const query = createQuery({ store: ctx.store, config: ctx.config, clock });
    const { comments } = await query(registry['inbox.get'], {}, actor);
    return comments.map((comment) => comment.id);
  }

  it('lists the course note once to a worker linked after it rang another', async () => {
    const ctx = await board();
    const course = await raiseCourse(ctx);
    await steps(ctx, 2);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, CURATOR, 'answer');
    await steps(ctx, 2);
    expect(ringBlocks(ctx)).toEqual([course.block]);
    const note = await noteId(ctx);
    await ctx.apply(
      createLinkMutations(ctx.config).remove,
      { mode: 'session', task: KEY, session: 'worker-1', reason: 'Handover.' },
      'operator',
    );
    await addSession(ctx, 'worker-2', 'web');
    await ctx.store.transaction((trx) =>
      trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: 9,
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'worker-2',
          role: 'worker',
        })
        .execute(),
    );
    expect(await inboxComments(ctx, 'agent:web/worker-2')).toEqual([note]);
  });

  /** Links `session` as the task's only worker: bans every other worker session link. */
  async function relink(ctx: Board, session: string): Promise<void> {
    await ctx.store.transaction(async (trx) => {
      await trx
        .updateTable('link')
        .set({ banned: 1 })
        .where('task_id', '=', 1)
        .where('role', '=', 'worker')
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: session === 'worker-1' ? 1 : 9,
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: session,
          role: 'worker',
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ banned: 0 }))
        .execute();
    });
  }

  it('releases the held rings when the note returns to a worker it already rang', async () => {
    const RETRY = config.doorbells.firstRetryMs;
    const ctx = await board();
    const course = await raiseCourse(ctx);
    await steps(ctx, 2);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, CURATOR, 'answer');
    await steps(ctx, 2);
    expect(ringBlocks(ctx)).toEqual([course.block]);
    await addSession(ctx, 'worker-2', 'web');
    await relink(ctx, 'worker-2');
    await steps(ctx, 1, RETRY);
    await steps(ctx, 2);
    expect(sessionsRung(ctx)).toEqual(['cur-1', 'worker-1', 'worker-2']);
    await relink(ctx, 'worker-1');
    await steps(ctx, 1, RETRY);
    await steps(ctx, 2);
    const block = await workerBlock(ctx.store);
    await steps(ctx, 4);
    // The return starts a new series: the note rings worker-1 again under a fresh key.
    expect(ringBlocks(ctx)).toEqual([course.block, course.block, block]);
  });

  /**
   * Retarget sequences of the course note before any of its rings is delivered. A session name
   * links that worker and runs the doorbell job, which moves the note's queued ring to it; `fail`
   * runs three steps while every Spur send fails.
   */
  it.each([
    { path: 'A-B-A', moves: ['worker-2', 'worker-1'] },
    { path: 'A-B-A-B', moves: ['worker-2', 'worker-1', 'worker-2'] },
    { path: 'A, failed send, B-A', moves: ['fail', 'worker-2', 'worker-1'] },
    { path: 'A-B, failed send, A', moves: ['worker-2', 'fail', 'worker-1'] },
    { path: 'A-B-A, failed send', moves: ['worker-2', 'worker-1', 'fail'] },
  ])('rings the note to the current worker and then the held rings: $path', async ({ moves }) => {
    const ctx = await board();
    await addSession(ctx, 'worker-2', 'web');
    const { queued, course, late } = await held(ctx);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, CURATOR, 'answer');
    await ctx.ring();
    let current = 'worker-1';
    for (const move of moves) {
      if (move === 'fail') {
        ctx.failAlways(true);
        await steps(ctx, 3);
        ctx.failAlways(false);
      } else {
        current = move;
        await relink(ctx, move);
        await ctx.ring();
      }
    }
    expect(ctx.sent).toHaveLength(1);
    await steps(ctx, 30);
    const rung = ctx.sent.filter((entry) => entry.session === current);
    expect(rung.map((entry) => /block (B\d+):/.exec(entry.text)?.[1])).toEqual([
      course.block,
      queued,
      late,
    ]);
    expect(sessionsRung(ctx)).toEqual(['cur-1', current, current, current]);
  });

  it('keeps the release order when the worker acks the note before its ring', async () => {
    const ctx = await board();
    const { queued, course, late } = await held(ctx);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, CURATOR, 'answer');
    const note = { entries: [{ id: await noteId(ctx), revision: 1 }] };
    await ctx.apply(ctx.ops.ack, note, worker, 'ack-note');
    await steps(ctx, 12, 250);
    expect(ringBlocks(ctx)).toEqual([queued, late]);
  });

  it('keeps the release order when the note ring is rejected before it rings', async () => {
    const ctx = await board();
    const { queued, course, late } = await held(ctx);
    await ctx.apply(ctx.ops.answer, { block: course.block, text: NOTE }, CURATOR, 'answer');
    ctx.failNext(new SpurRejectedError('Spur send failed with HTTP 400: Bad request'));
    await steps(ctx, 12, 250);
    expect(ringBlocks(ctx)).toEqual([queued, late]);
  });

  it('an item close without a note releases the held ring on the next step', async () => {
    const ctx = await board();
    const course = await raiseCourse(ctx);
    const block = await workerBlock(ctx.store);
    await steps(ctx, 3);
    expect(workerTexts(ctx)).toEqual([]);
    await ctx.apply(
      createItemMutations({ config }).close,
      { item: course.item },
      'operator',
      'close',
    );
    await steps(ctx, 1);
    expect(ringBlocks(ctx)).toEqual([block]);
  });

  it('keeps the release order when the item closes without a note', async () => {
    const ctx = await board();
    const { queued, course, late } = await held(ctx);
    await ctx.apply(
      createItemMutations({ config }).close,
      { item: course.item },
      'operator',
      'close',
    );
    await steps(ctx, 12, 250);
    expect(ringBlocks(ctx)).toEqual([queued, late]);
  });
});

describe('turns', () => {
  const T1 = { entries: [{ id: 'T1' }] };

  async function open(ctx: Board, reason = 'Review the PR', opener?: ActorId) {
    return scanTransaction(ctx.store, ctx.config, async (trx) => {
      const task = await trx
        .selectFrom('task')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      return openTurn(trx, {
        task,
        reason,
        handed: [],
        at: ctx.now(),
        config: ctx.config,
        opener,
      });
    });
  }

  function close(ctx: Board, reason: 'moved' | 'archived' = 'moved') {
    return scanTransaction(ctx.store, ctx.config, (trx) =>
      closeTurns(trx, { taskId: 1, reason, at: ctx.now() }),
    );
  }

  function turns(ctx: Board) {
    return ctx.store.db.selectFrom('turn').selectAll().orderBy('id').execute();
  }

  function items(ctx: Board) {
    return ctx.store.db.selectFrom('operator_item').selectAll().orderBy('id').execute();
  }

  async function events(ctx: Board, kind: 'doorbell_read' | 'from_you_cleared') {
    const rows = await ctx.store.db
      .selectFrom('event')
      .select(['actor', 'payload'])
      .where('kind', '=', kind)
      .orderBy('id')
      .execute();
    return rows.map((row) => ({ actor: row.actor, payload: JSON.parse(row.payload) as unknown }));
  }

  function outbox(ctx: Board, kind: string) {
    return ctx.store.db
      .selectFrom('outbox')
      .selectAll()
      .where('kind', '=', kind)
      .orderBy('id')
      .execute();
  }

  /** Rings three times unanswered, then lets the series end. */
  async function exhaust(ctx: Board) {
    for (const pause of [0, 120_000, 300_000]) {
      ctx.advance(pause);
      await step(ctx);
    }
    ctx.advance(900_000);
    await step(ctx);
  }

  it('a code block without a return keeps ringing after the worker takes a Dev turn', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await workerBlock(ctx.store);
    expect((await open(ctx)).role).toBe('worker');
    await ctx.apply(ctx.ops.ack, T1, worker, 'ack-t1');
    await exhaust(ctx);
    const blockRings = ctx.sent.filter((entry) => /\(N1-\d\)$/.test(entry.text));
    expect(blockRings.map((entry) => entry.session)).toEqual(['worker-1', 'worker-1', 'worker-1']);
    expect(blockRings.map((entry) => entry.text)).toEqual(
      [1, 2, 3].map((ring) => expect.stringContaining(`(N1-${String(ring)})`) as unknown),
    );
    expect(await items(ctx)).toEqual([
      expect.objectContaining({
        kind: 'worker_not_reading',
        item_key: 'worker_not_reading:block:1:worker',
      }),
    ]);
  });

  it('holds the first ring of a turn its own recipient opened and sends none once acked', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx, 'Review the PR', worker);
    expect((await notices(ctx))[0]).toMatchObject({
      next_at: new Date(START + 120_000).toISOString(),
      created_at: new Date(START).toISOString(),
      recipient_session: null,
    });
    await step(ctx);
    ctx.advance(60_000);
    await expect(ctx.apply(ctx.ops.ack, T1, worker, 'ack-held')).resolves.toEqual({
      acked: ['T1'],
    });
    ctx.advance(60_001);
    await step(ctx);
    ctx.advance(300_000);
    await step(ctx);
    expect(await outbox(ctx, 'doorbell')).toEqual([]);
    expect(ctx.sent).toEqual([]);
  });

  it('rings a self-opened turn after firstRetryMs and repeats as today', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx, 'Review the PR', worker);
    await step(ctx);
    ctx.advance(119_999);
    await step(ctx);
    expect(ctx.sent).toEqual([]);
    ctx.advance(1);
    await step(ctx);
    expect(ctx.sent.map((entry) => entry.text)).toEqual([
      `${KEY} turn T1: check board inbox (N1-1)`,
    ]);
    ctx.advance(119_999);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
    ctx.advance(1);
    await step(ctx);
    ctx.advance(299_999);
    await step(ctx);
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(1);
    await step(ctx);
    expect(ctx.sent.map((entry) => entry.text)).toEqual(
      [1, 2, 3].map((ring) => `${KEY} turn T1: check board inbox (N1-${String(ring)})`),
    );
    expect(sessionsRung(ctx)).toEqual(['worker-1', 'worker-1', 'worker-1']);
  });

  it.each([
    { name: 'no opener', opener: undefined },
    { name: 'the operator', opener: 'operator' as const },
    { name: 'another agent session', opener: 'agent:web/worker-2' as const },
  ])('rings a turn opened by $name at once', async ({ opener }) => {
    const ctx = await setup({ config: policyBoard('none'), replacement: true });
    await open(ctx, 'Review the PR', opener);
    expect((await notices(ctx))[0]?.next_at).toBe(new Date(START).toISOString());
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['worker-1']);
    expect(ctx.sent[0]?.text).toBe(`${KEY} turn T1: check board inbox (N1-1)`);
  });

  it('rings the next worker after the hold when the opener ends during it', async () => {
    const ctx = await setup({ config: policyBoard('none'), replacement: true });
    await open(ctx, 'Review the PR', worker);
    expect((await notices(ctx))[0]?.next_at).toBe(new Date(START + 120_000).toISOString());
    ctx.advance(10_000);
    await setSession(ctx, 'worker-1', { ended_at: ctx.now().toISOString() });
    await step(ctx);
    expect(ctx.sent).toEqual([]);
    ctx.advance(110_000);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['worker-2']);
  });

  it('ends a turn series on time while its ring waits in the Spur queue', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx);
    await step(ctx);
    expect(ctx.sent[0]?.text).toBe(`${KEY} turn T1: check board inbox (N1-1)`);
    await queueRings(ctx, [{ notification: 1, ring: 1 }]);
    for (const pause of [120_000, 300_000, 899_999]) {
      ctx.advance(pause);
      await step(ctx);
    }
    expect(await items(ctx)).toEqual([]);
    ctx.advance(1);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
    expect(await items(ctx)).toEqual([
      expect.objectContaining({
        kind: 'worker_not_reading',
        text: `worker worker-1 is not reading turn T1 on ${KEY}`,
        raised_at: new Date(START + 1_320_000).toISOString(),
      }),
    ]);
  });

  it.each([
    {
      name: 'rings the live worker for a turn',
      board: () => policyBoard('none'),
      session: 'worker-1',
      holder: 'worker',
      role: 'worker',
    },
    {
      name: 'rings the column orchestrator project for its turn',
      board: () => policyBoard(),
      session: 'qa-1',
      holder: 'orchestrator',
      role: 'orchestrator:dev',
    },
  ])('$name', async ({ board, session, holder, role }) => {
    const ctx = await setup({ config: board() });
    if (session === 'qa-1') await addSession(ctx, 'qa-1', 'qa');
    expect((await open(ctx)).role).toBe(role);
    await exhaust(ctx);
    expect(sessionsRung(ctx)).toEqual([session, session, session]);
    expect(ctx.sent[0]?.text).toBe(`${KEY} turn T1: check board inbox (N1-1)`);
    expect(ctx.sent.map((entry) => entry.text)).toEqual(
      [1, 2, 3].map(
        (ring) =>
          expect.stringMatching(
            new RegExp(`turn T1: check board inbox \\(N1-${String(ring)}\\)$`),
          ) as unknown,
      ),
    );
    expect(await items(ctx)).toEqual([
      expect.objectContaining({
        kind: 'worker_not_reading',
        item_key: `worker_not_reading:turn:1:${role}`,
        text: `${holder} ${session} is not reading turn T1 on ${KEY}`,
        block_id: null,
      }),
    ]);
    expect(await journalled(ctx, 'doorbell_undelivered')).toEqual([
      expect.objectContaining({ payload: { doorbell: 'N1', reason: 'unanswered' } }),
    ]);
    const [notice] = await notices(ctx);
    expect(notice).toMatchObject({
      kind: 'turn',
      turn_id: 1,
      block_id: null,
      author_session: null,
    });
    await ctx.store.transaction((trx) =>
      restartNotification(trx, notice?.source_key ?? '', ctx.now()),
    );
    await step(ctx);
    expect(ctx.sent).toHaveLength(4);
  });

  it('accepts the ack of a later orchestrator session', async () => {
    const ctx = await setup({ config: policyBoard() });
    await addSession(ctx, 'qa-1', 'qa');
    await open(ctx);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['qa-1']);
    await setSession(ctx, 'qa-1', { ended_at: ctx.now().toISOString() });
    await addSession(ctx, 'qa-2', 'qa');

    const result = await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-2', 'ack-qa-2');

    expect(result).toEqual({ acked: ['T1'] });
    expect(await turns(ctx)).toEqual([
      expect.objectContaining({ acked_by: 'agent:qa/qa-2', acked_at: ctx.now().toISOString() }),
    ]);
    expect((await notices(ctx))[0]?.acked_at).toBe(ctx.now().toISOString());
    expect(await events(ctx, 'doorbell_read')).toEqual([
      expect.objectContaining({ payload: { doorbell: 'N1' } }),
    ]);
  });

  it('accepts the ack of the worker selected after the rung worker ended', async () => {
    const ctx = await setup({ config: policyBoard('none'), replacement: true });
    await open(ctx);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['worker-1']);
    await setSession(ctx, 'worker-1', { ended_at: ctx.now().toISOString() });
    await addSession(ctx, 'worker-9', 'web');

    await expect(
      ctx.apply(ctx.ops.ack, T1, 'agent:web/worker-9', 'ack-unlinked'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await turns(ctx)).toEqual([expect.objectContaining({ acked_by: null, acked_at: null })]);
    expect((await notices(ctx))[0]?.acked_at).toBeNull();

    await expect(ctx.apply(ctx.ops.ack, T1, 'agent:web/worker-2', 'ack-selected')).resolves.toEqual(
      { acked: ['T1'] },
    );
    expect((await turns(ctx))[0]?.acked_by).toBe('agent:web/worker-2');
  });

  it.each(['other', 'banned'] as const)(
    'rejects a demoted turn recipient (%s link) and accepts the replacement before notification reconcile',
    async (mode) => {
      const ctx = await setup({ config: policyBoard('none'), replacement: true });
      await open(ctx);
      await step(ctx);
      expect(sessionsRung(ctx)).toEqual(['worker-1']);
      await expect(
        ctx.apply(ctx.ops.ack, T1, 'agent:web/worker-2', 'ack-still-pinned'),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await ctx.store.transaction((trx) =>
        trx
          .updateTable('link')
          .set(mode === 'other' ? { role: 'other' } : { banned: 1 })
          .where('session_id', '=', 'worker-1')
          .execute(),
      );
      await expect(
        ctx.apply(ctx.ops.ack, T1, 'agent:web/worker-1', 'ack-demoted'),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await turns(ctx))[0]?.acked_by).toBeNull();
      await expect(
        ctx.apply(ctx.ops.ack, T1, 'agent:web/worker-2', 'ack-replacement'),
      ).resolves.toEqual({ acked: ['T1'] });
      expect((await turns(ctx))[0]?.acked_by).toBe('agent:web/worker-2');
      expect((await notices(ctx))[0]?.recipient_session).toBe('worker-1');
    },
  );

  it('lets a later orchestrator session take over a taken turn', async () => {
    const ctx = await setup({ config: policyBoard() });
    await addSession(ctx, 'qa-2', 'qa');
    await open(ctx);
    await step(ctx);
    await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-2', 'ack-qa-2');
    const taken = ctx.now().toISOString();
    await setSession(ctx, 'qa-2', { ended_at: taken });
    await addSession(ctx, 'qa-3', 'qa');
    ctx.advance(1000);

    await expect(ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-3', 'ack-qa-3')).resolves.toEqual({
      acked: ['T1'],
    });

    expect(await turns(ctx)).toEqual([
      expect.objectContaining({ acked_by: 'agent:qa/qa-3', acked_at: ctx.now().toISOString() }),
    ]);
    expect((await notices(ctx))[0]?.acked_at).toBe(taken);
    expect(await events(ctx, 'doorbell_read')).toHaveLength(1);
    await expect(ctx.apply(ctx.ops.ack, T1, worker, 'ack-worker')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await turns(ctx))[0]?.acked_by).toBe('agent:qa/qa-3');
  });

  it('refuses a second take of a worker turn', async () => {
    const ctx = await setup({ config: policyBoard('none'), replacement: true });
    await open(ctx);
    await step(ctx);
    await ctx.apply(ctx.ops.ack, T1, worker, 'ack-1');
    const taken = (await turns(ctx))[0]?.acked_at;

    await expect(ctx.apply(ctx.ops.ack, T1, worker, 'ack-2')).resolves.toEqual({
      acked: ['T1'],
      alreadyHandled: ['T1'],
    });
    expect((await turns(ctx))[0]?.acked_at).toBe(taken);
    await expect(
      ctx.apply(ctx.ops.ack, T1, 'agent:web/worker-2', 'ack-other'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await turns(ctx))[0]?.acked_by).toBe(worker);
  });

  it('takes a turn by the ring id of its doorbell', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx);
    await step(ctx);
    const text = ctx.sent[0]?.text ?? '';
    expect(text).toBe(`${KEY} turn T1: check board inbox (N1-1)`);
    const marker = parseRingMarker(text);
    const ring = { entries: [{ id: `N${String(marker?.notification)}-${String(marker?.ring)}` }] };

    await expect(ctx.apply(ctx.ops.ack, ring, worker, 'ack-ring')).resolves.toEqual({
      acked: ['N1-1'],
    });
    expect((await turns(ctx))[0]?.acked_by).toBe(worker);
    await expect(ctx.apply(ctx.ops.ack, ring, worker, 'ack-ring-again')).resolves.toEqual({
      acked: ['N1-1'],
      alreadyHandled: ['N1-1'],
    });
    expect(await events(ctx, 'doorbell_read')).toHaveLength(1);
  });

  it('closes an open turn on a move', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx);
    await step(ctx);
    ctx.advance(120_000);
    await ctx.ring();
    expect(await outbox(ctx, 'doorbell')).toEqual([
      expect.objectContaining({ state: 'done' }),
      expect.objectContaining({ state: 'pending' }),
    ]);

    await close(ctx);
    await ctx.sender.tick();
    ctx.advance(2_000_000);
    await step(ctx);

    expect(ctx.sent).toHaveLength(1);
    expect((await outbox(ctx, 'doorbell'))[1]).toMatchObject({
      state: 'dead',
      last_error: 'notification no longer current',
    });
    expect(await turns(ctx)).toEqual([
      expect.objectContaining({ closed_reason: 'moved', closed_at: expect.any(String) as unknown }),
    ]);
    expect((await notices(ctx))[0]?.acked_at).not.toBeNull();
    const read = (await events(ctx, 'doorbell_read')).length;
    await expect(ctx.apply(ctx.ops.ack, T1, worker, 'ack-closed')).resolves.toEqual({
      acked: ['T1'],
      alreadyHandled: ['T1'],
    });
    expect(await events(ctx, 'doorbell_read')).toHaveLength(read);
  });

  it('clears the exhaustion item of a closed turn', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx);
    await exhaust(ctx);
    expect(await items(ctx)).toEqual([expect.objectContaining({ cleared_at: null })]);

    await close(ctx);

    expect(await items(ctx)).toEqual([
      expect.objectContaining({ cleared_at: ctx.now().toISOString() }),
    ]);
    expect(await events(ctx, 'from_you_cleared')).toEqual([
      expect.objectContaining({ actor: 'system' }),
    ]);
  });

  it('gives the operator a turn as one feed line', async () => {
    const ctx = await setup({ config: policyBoard('operator') });
    const turn = await open(ctx, 'Merge it');
    expect(turn.role).toBe('operator');
    expect(await notices(ctx)).toEqual([]);
    expect(await items(ctx)).toEqual([
      expect.objectContaining({
        kind: 'turn',
        item_key: 'turn:1',
        text: `turn T1 on ${KEY}: Merge it`,
        cleared_at: null,
      }),
    ]);
    const [line] = await outbox(ctx, 'feed.line');
    expect(JSON.parse(line?.payload ?? '{}')).toMatchObject({
      itemKey: 'turn:1',
      actions: [{ id: 'item:1:close', label: 'Close' }],
    });
    ctx.advance(2_000_000);
    await step(ctx);
    expect(ctx.sent).toEqual([]);
    await expect(ctx.apply(ctx.ops.ack, T1, worker, 'ack-operator-turn')).rejects.toMatchObject({
      code: 'not_found',
    });

    await close(ctx);

    expect((await items(ctx))[0]?.cleared_at).toBe(ctx.now().toISOString());
    expect(await events(ctx, 'from_you_cleared')).toEqual([
      expect.objectContaining({ actor: 'system' }),
    ]);
    const [edit] = await outbox(ctx, 'feed.line.edit');
    expect(JSON.parse(edit?.payload ?? '{}')).toMatchObject({
      itemKey: 'turn:1',
      resolved: { by: 'system' },
    });

    const ended = await setup({ config: policyBoard('none'), author: 'ended' });
    expect((await open(ended)).role).toBe('operator');
    expect(await notices(ended)).toEqual([]);
  });

  it('reuses the unclosed turn of a visit', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    const first = await open(ctx);
    expect(isTurnOpen(first)).toBe(false);
    expect((await open(ctx, 'Again')).id).toBe(first.id);
    expect(await turns(ctx)).toHaveLength(1);
    await ctx.apply(ctx.ops.ack, T1, worker, 'ack');
    const [taken] = await turns(ctx);
    expect(taken !== undefined && isTurnOpen(taken)).toBe(true);

    await close(ctx);
    const [closed] = await turns(ctx);
    expect(closed !== undefined && isTurnOpen(closed)).toBe(false);
    const second = await open(ctx);

    expect(second).toMatchObject({ id: 2, seq: 2, column: 'dev', epoch: first.epoch });
  });

  it('closes a stale turn of an earlier visit', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    const first = await open(ctx);
    await ctx.store.transaction((trx) =>
      trx
        .updateTable('task')
        .set({ column_epoch: first.epoch + 1 })
        .execute(),
    );

    await open(ctx);

    expect(await turns(ctx)).toEqual([
      expect.objectContaining({ id: 1, closed_reason: 'moved' }),
      expect.objectContaining({ id: 2, epoch: first.epoch + 1, seq: 1, closed_at: null }),
    ]);
    await expect(
      ctx.store.transaction((trx) =>
        trx
          .insertInto('turn')
          .values({ ...sampleRows.turn, id: 3, closed_at: null, closed_reason: null })
          .execute(),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  const IDLE = config.health.idleInDevAfterMs;

  /** Stores Spur facts for a session in `health` since `since`. */
  function health(ctx: Board, id: string, project: string, value: string, since: Date) {
    return setSession(ctx, id, {
      detail: JSON.stringify({
        id,
        spurProject: project,
        branch: null,
        pr: null,
        links: {},
        lifecycle: 'running',
        health: value,
        healthSince: since.toISOString(),
        lastActivityAt: null,
        endedAt: null,
        endReason: null,
      }),
    });
  }

  /** Opens the worker's turn, rings it once and lets worker-1 take it at the current time. */
  async function takenByWorker(ctx: Board) {
    await open(ctx);
    await step(ctx);
    await ctx.apply(ctx.ops.ack, T1, worker, 'ack-worker');
  }

  function remind(ctx: Board) {
    return scanTransaction(ctx.store, ctx.config, (trx) =>
      remindStuckTurns(trx, ctx.config, ctx.now()),
    );
  }

  async function reminders(ctx: Board) {
    return (await notices(ctx)).filter((notice) => notice.kind === 'turn_reminder');
  }

  async function question(ctx: Board, author: ActorId) {
    return ctx.store.transaction((trx) =>
      trx
        .insertInto('block')
        .values({
          task_id: 1,
          type: 'needs_input',
          reason: 'Which API?',
          author,
          addressee_role: 'operator',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: ctx.now().toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
  }

  describe('turn waits', () => {
    const REASON = 'waiting for a free test stand';
    const MINUTE = 60_000;

    /** The registry's `task.wait` at the board's current time. */
    function waitMutation(ctx: Board) {
      return createOperationRegistry({
        config: ctx.config,
        clock: { now: () => ctx.now().getTime() },
        completeSince: new Map(),
      })['task.wait'];
    }

    /** `task.wait` for `actor` at the board's current time; the wait it started. */
    async function waitOp(
      ctx: Board,
      minutes: number,
      reason: string,
      key: string,
      actor = worker,
    ) {
      const input = { turn: 'T1', for: minutes, reason };
      const { wait, ...rest } = await ctx.apply(waitMutation(ctx), input, actor, key);
      if (wait === undefined) throw new Error('task.wait started no wait');
      return { ...rest, wait };
    }

    /** `task.wait` with `end` for `actor`, the operator by default, at the board's current time. */
    function endOp(ctx: Board, key: string, actor: ActorId = 'operator') {
      return ctx.apply(waitMutation(ctx), { turn: 'T1', end: true }, actor, key);
    }

    /** One board tick; with `spur` Spur counts as completely polled now. */
    function boardTick(ctx: Board, spur = true) {
      return tickBoard({
        store: ctx.store,
        config: ctx.config,
        clock: { now: () => ctx.now().getTime() },
        completeSince: new Map(spur ? [['spur', ctx.now().toISOString()]] : []),
      });
    }

    /** The registry's queries at the board's current time. */
    function query(ctx: Board) {
      const clock = { now: () => ctx.now().getTime() };
      const registry = createOperationRegistry({
        config: ctx.config,
        clock,
        completeSince: new Map(),
      });
      const run = createQuery({ store: ctx.store, config: ctx.config, clock });
      return {
        status: () => run(registry['status.get'], {}, 'operator'),
        get: (why = false) => run(registry['task.get'], { task: KEY, why }, 'operator'),
        inbox: () => run(registry['inbox.get'], {}, worker),
      };
    }

    /** Records a complete poll of the project's GitHub source that began at `at`. */
    function polled(ctx: Board, at: number) {
      const row = {
        ...sampleRows.source_state,
        source: 'github:proj:o/r',
        last_complete_at: new Date(at).toISOString(),
        observed_at: new Date(at).toISOString(),
      };
      return ctx.store.transaction((trx) =>
        trx
          .insertInto('source_state')
          .values(row)
          .onConflict((oc) =>
            oc.column('source').doUpdateSet({ last_complete_at: row.last_complete_at }),
          )
          .execute(),
      );
    }

    /** A worker turn taken by worker-1, idle at its prompt since now, its PRs polled since. */
    async function idleWorker(config = policyBoard('none')) {
      const ctx = await setup({ config });
      await takenByWorker(ctx);
      await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
      await polled(ctx, ctx.now().getTime() + 1);
      return ctx;
    }

    const IDLE_KEY = 'health:1:worker-1:worker_idle';
    const activeKeys = async (ctx: Board) =>
      (
        await ctx.store.db
          .selectFrom('operator_item')
          .select('item_key')
          .where('cleared_at', 'is', null)
          .execute()
      ).map((item) => item.item_key);
    const waitEnds = async (ctx: Board) =>
      (
        await ctx.store.db
          .selectFrom('event')
          .select('payload')
          .where('kind', '=', 'turn_wait_ended')
          .orderBy('id')
          .execute()
      ).map((row) => JSON.parse(row.payload) as unknown);

    it('suppresses the reminder, the stuck turn and worker idle while waiting', async () => {
      const control = await idleWorker();
      control.advance(IDLE);
      await boardTick(control);
      expect(await activeKeys(control)).toContain(IDLE_KEY);

      const ctx = await idleWorker();
      await waitOp(ctx, 120, REASON, 'wait-1');
      for (let round = 0; round < 3; round += 1) {
        ctx.advance(IDLE);
        await boardTick(ctx);
        await step(ctx);
      }
      expect(await reminders(ctx)).toEqual([]);
      const keys = await activeKeys(ctx);
      expect(keys).not.toContain('stuck-turn:1');
      expect(keys).not.toContain(IDLE_KEY);
    });

    it('clears a stuck turn raised before the wait', async () => {
      const ctx = await setup({ config: policyBoard('none') });
      await takenByWorker(ctx);
      await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
      ctx.advance(IDLE);
      await boardTick(ctx);
      await step(ctx);
      expect(await reminders(ctx)).toEqual([expect.objectContaining({ rings: 1 })]);
      ctx.advance(IDLE);
      await boardTick(ctx);
      expect(await activeKeys(ctx)).toContain('stuck-turn:1');

      await waitOp(ctx, 30, REASON, 'wait-1');
      await boardTick(ctx);

      expect(await activeKeys(ctx)).not.toContain('stuck-turn:1');
      expect(
        await ctx.store.db
          .selectFrom('operator_item')
          .select('cleared_at')
          .where('item_key', '=', 'stuck-turn:1')
          .executeTakeFirstOrThrow(),
      ).toEqual({ cleared_at: ctx.now().toISOString() });
    });

    it('rings once at the wake and restarts the quiet clock there', async () => {
      const ctx = await setup({ config: policyBoard('none') });
      await takenByWorker(ctx);
      await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
      const { wait } = await waitOp(ctx, 30, REASON, 'wait-1');
      const sent = ctx.sent.length;
      ctx.advance(30 * MINUTE - 1);
      await boardTick(ctx);
      await step(ctx);
      expect(ctx.sent).toHaveLength(sent);
      expect((await query(ctx).get()).turn?.wait).toEqual(wait);

      ctx.advance(1);
      await boardTick(ctx);
      await step(ctx);

      const wake = (await reminders(ctx)).find((notice) => notice.source_key.includes(':wake:'));
      expect(wake).toMatchObject({
        source_key: `turn:1:wake:worker-1:${wait.since}`,
        author_session: 'worker-1',
        rings: 1,
      });
      expect(ctx.sent.slice(sent)).toEqual([
        {
          session: 'worker-1',
          text: `${KEY} turn T1 wait ended: ${REASON}; check board inbox (N${String(wake?.id)}-1)`,
        },
      ]);
      expect((await turns(ctx))[0]).toMatchObject({ wait_until: null, waited_ms: 30 * MINUTE });
      expect(await waitEnds(ctx)).toEqual([
        { turn: 'T1', outcome: 'woken', waitedMs: 30 * MINUTE, waits: 1 },
      ]);
      const views = query(ctx);
      const row = (await views.status()).tasks.find((task) => task.key === KEY);
      expect(row?.turn).not.toHaveProperty('wait');
      expect((await views.get()).turn).not.toHaveProperty('wait');
      expect((await views.get(true)).why?.turn).not.toHaveProperty('wait');
      expect((await views.inbox()).turns[0]).not.toHaveProperty('wait');

      ctx.advance(IDLE - 1);
      await boardTick(ctx);
      await step(ctx);
      expect(ctx.sent).toHaveLength(sent + 1);

      ctx.advance(1);
      await boardTick(ctx);
      await step(ctx);
      expect(ctx.sent.slice(sent + 1)).toEqual([
        {
          session: 'worker-1',
          text: expect.stringMatching(
            /^o\/r#101 turn T1 is still open: check board inbox/,
          ) as unknown,
        },
      ]);
    });

    it('rings once when the operator ends the wait and restarts the quiet clock there', async () => {
      const ctx = await setup({ config: policyBoard('none') });
      await takenByWorker(ctx);
      await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
      const { wait } = await waitOp(ctx, 30, REASON, 'wait-1');
      const sent = ctx.sent.length;
      ctx.advance(20 * MINUTE);
      expect(await endOp(ctx, 'end-1')).toEqual({ turn: 'T1', waits: 1 });
      await boardTick(ctx);
      await step(ctx);

      const ended = (await reminders(ctx)).filter((notice) =>
        notice.source_key.includes(':ended:'),
      );
      expect(ended).toEqual([
        expect.objectContaining({
          source_key: `turn:1:ended:worker-1:${wait.since}`,
          author_session: 'worker-1',
          rings: 1,
        }),
      ]);
      expect(ctx.sent.slice(sent)).toEqual([
        {
          session: 'worker-1',
          text: `${KEY} turn T1 wait ended by the operator: ${REASON}; check board inbox (N${String(ended[0]?.id)}-1)`,
        },
      ]);
      expect((await turns(ctx))[0]).toMatchObject({ wait_until: null, waited_ms: 20 * MINUTE });
      expect(await waitEnds(ctx)).toEqual([
        { turn: 'T1', outcome: 'ended', waitedMs: 20 * MINUTE, waits: 1 },
      ]);

      ctx.advance(IDLE - 1);
      await boardTick(ctx);
      await step(ctx);
      expect(ctx.sent).toHaveLength(sent + 1);

      ctx.advance(1);
      await boardTick(ctx);
      await step(ctx);
      expect(ctx.sent.slice(sent + 1)).toEqual([
        {
          session: 'worker-1',
          text: expect.stringMatching(
            /^o\/r#101 turn T1 is still open: check board inbox/,
          ) as unknown,
        },
      ]);
    });

    it('counts the ended time toward the total', async () => {
      const base = policyBoard('none');
      const limited = configSchema.parse({
        ...base,
        health: { ...base.health, turnWait: { maxWaits: 8, maxTotalMs: 40 * MINUTE } },
      });
      const ctx = await setup({ config: limited });
      await takenByWorker(ctx);
      await waitOp(ctx, 30, REASON, 'wait-1');
      ctx.advance(20 * MINUTE);
      await endOp(ctx, 'end-1');
      const { wait } = await waitOp(ctx, 30, REASON, 'wait-2');
      expect(Date.parse(wait.wakesAt) - Date.parse(wait.since)).toBe(20 * MINUTE);
    });

    it('rings no operator token that took the turn over when it ends its wait', async () => {
      const ctx = await setup({ config: policyBoard() });
      await addSession(ctx, 'qa-1', 'qa');
      await open(ctx);
      await step(ctx);
      await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-1', 'ack-qa-1');
      await ctx.apply(ctx.ops.ack, T1, 'operator', 'ack-operator');
      await waitOp(ctx, 30, REASON, 'wait-1', 'operator');
      ctx.advance(10 * MINUTE);
      const sent = ctx.sent.length;
      await endOp(ctx, 'end-1');
      await step(ctx);

      expect(await waitEnds(ctx)).toEqual([
        { turn: 'T1', outcome: 'ended', waitedMs: 10 * MINUTE, waits: 1 },
      ]);
      expect(
        (await reminders(ctx)).filter((notice) => notice.source_key.includes(':ended:')),
      ).toEqual([]);
      expect(ctx.sent).toHaveLength(sent);
    });

    it.each([
      { link: 'kept', rings: 1, end: 'wake' },
      { link: 'removed', rings: 0, end: 'wake' },
      { link: 'kept', rings: 1, end: 'operator end' },
      { link: 'removed', rings: 0, end: 'operator end' },
    ])(
      'rings a worker whose link was $link $rings times at the $end',
      async ({ link, rings, end }) => {
        const ctx = await setup({ config: policyBoard('none') });
        await takenByWorker(ctx);
        await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
        await waitOp(ctx, 30, REASON, 'wait-1');
        if (link === 'removed')
          await ctx.store.transaction((trx) =>
            trx
              .updateTable('link')
              .set({ banned: 1 })
              .where('entity', '=', 'session')
              .where('session_id', '=', 'worker-1')
              .execute(),
          );
        const sent = ctx.sent.length;
        const waited = end === 'wake' ? 30 * MINUTE : 10 * MINUTE;
        ctx.advance(waited);
        if (end !== 'wake') await endOp(ctx, 'end-1');
        await boardTick(ctx);
        await step(ctx);

        const outcome = end === 'wake' ? 'woken' : 'ended';
        expect(await waitEnds(ctx)).toEqual([{ turn: 'T1', outcome, waitedMs: waited, waits: 1 }]);
        const marker = end === 'wake' ? ':wake:' : ':ended:';
        const rung = (await reminders(ctx)).filter((notice) => notice.source_key.includes(marker));
        expect(rung).toHaveLength(rings);
        expect(ctx.sent.slice(sent)).toHaveLength(rings);
      },
    );

    it('limits the number of waits and raises one operator item', async () => {
      const base = policyBoard('none');
      const limited = configSchema.parse({
        ...base,
        health: { ...base.health, turnWait: { maxWaits: 2, maxTotalMs: 7_200_000 } },
      });
      const ctx = await setup({ config: limited });
      await takenByWorker(ctx);
      await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
      for (const key of ['wait-1', 'wait-2']) {
        await waitOp(ctx, 30, REASON, key);
        ctx.advance(30 * MINUTE);
        await boardTick(ctx);
        await step(ctx);
      }
      expect((await waitEnds(ctx)).map((end) => (end as { outcome: string }).outcome)).toEqual([
        'woken',
        'limit',
      ]);
      const rows = async () => [
        await turns(ctx),
        await ctx.store.db.selectFrom('notification').selectAll().execute(),
      ];
      const before = await rows();
      await expect(waitOp(ctx, 30, REASON, 'wait-3')).rejects.toMatchObject({
        code: 'turn_wait_limit',
      });
      expect(await rows()).toEqual(before);
      const item = await ctx.store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('item_key', '=', 'turn-wait:1')
        .execute();
      expect(item).toEqual([
        expect.objectContaining({
          kind: 'board_observation',
          text: `${KEY}: turn T1 has waited 1h for ${REASON}`,
          task_id: 1,
          cleared_at: null,
        }),
      ]);
      expect((await turns(ctx))[0]).toMatchObject({ acked_by: worker, closed_at: null });

      await close(ctx);
      await boardTick(ctx);
      expect(await activeKeys(ctx)).not.toContain('turn-wait:1');
    });

    it('cuts a wait to the time left of the total and ends it at the limit', async () => {
      const base = policyBoard('none');
      const limited = configSchema.parse({
        ...base,
        health: { ...base.health, turnWait: { maxWaits: 8, maxTotalMs: 2_700_000 } },
      });
      const ctx = await setup({ config: limited });
      await takenByWorker(ctx);
      await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
      await waitOp(ctx, 30, REASON, 'wait-1');
      ctx.advance(30 * MINUTE);
      await boardTick(ctx);
      const { wait } = await waitOp(ctx, 30, REASON, 'wait-2');
      expect(Date.parse(wait.wakesAt) - Date.parse(wait.since)).toBe(15 * MINUTE);
      ctx.advance(15 * MINUTE);
      await boardTick(ctx);
      expect((await waitEnds(ctx)).at(-1)).toMatchObject({ outcome: 'limit', waitedMs: 2_700_000 });
    });

    it('ends the wait without a ring when the holder ends', async () => {
      const ctx = await setup({ config: policyBoard('none') });
      await takenByWorker(ctx);
      await waitOp(ctx, 30, REASON, 'wait-1');
      const ended = ctx.now().toISOString();
      await setSession(ctx, 'worker-1', {
        ended_at: ended,
        detail: JSON.stringify({
          id: 'worker-1',
          spurProject: 'web',
          branch: null,
          pr: null,
          links: {},
          lifecycle: 'completed',
          health: 'stopped',
          healthSince: ended,
          lastActivityAt: null,
          endedAt: ended,
          endReason: 'complete',
        }),
      });
      const sent = ctx.sent.length;
      ctx.advance(MINUTE);
      await boardTick(ctx);
      await step(ctx);

      expect(await waitEnds(ctx)).toEqual([
        { turn: 'T1', outcome: 'closed', waitedMs: MINUTE, waits: 1 },
      ]);
      ctx.advance(30 * MINUTE);
      await boardTick(ctx);
      await step(ctx);
      expect(ctx.sent).toHaveLength(sent);
      expect(await activeKeys(ctx)).toContain('ended-turn:1:worker-1');
    });

    it('keeps worker idle off for the grace after the wake', async () => {
      const ctx = await idleWorker();
      await waitOp(ctx, 30, REASON, 'wait-1');
      ctx.advance(30 * MINUTE);
      await boardTick(ctx);
      ctx.advance(IDLE - 1);
      await boardTick(ctx);
      expect(await activeKeys(ctx)).not.toContain(IDLE_KEY);

      await polled(ctx, ctx.now().getTime());
      ctx.advance(1);
      await boardTick(ctx);
      expect(await activeKeys(ctx)).toContain(IDLE_KEY);
    });

    it('gives no grace once the holder submitted', async () => {
      const ctx = await idleWorker();
      await waitOp(ctx, 30, REASON, 'wait-1');
      ctx.advance(30 * MINUTE);
      await boardTick(ctx);
      await scanTransaction(ctx.store, ctx.config, (trx) =>
        closeTurns(trx, { taskId: 1, reason: 'submitted', at: ctx.now() }),
      );
      await polled(ctx, ctx.now().getTime());
      ctx.advance(1);
      await boardTick(ctx);
      expect(await activeKeys(ctx)).toContain(IDLE_KEY);
    });
  });

  it('rings one reminder for a quiet taken turn', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    const taken = ctx.now().toISOString();
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    const tick = () =>
      tickBoard({
        store: ctx.store,
        config: ctx.config,
        clock: { now: () => ctx.now().getTime() },
        completeSince: new Map(),
      });
    ctx.advance(IDLE - 1);
    await tick();
    expect(await reminders(ctx)).toEqual([]);

    ctx.advance(1);
    await tick();
    await step(ctx);

    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({
        source_key: `turn:1:reminder:worker-1:${taken}`,
        role: 'worker',
        turn_id: 1,
        block_id: null,
        author_session: 'worker-1',
        rings: 1,
        acked_at: ctx.now().toISOString(),
      }),
    ]);
    expect(ctx.sent.slice(1)).toEqual([
      { session: 'worker-1', text: `${KEY} turn T1 is still open: check board inbox (N2-1)` },
    ]);
    for (let round = 0; round < 4; round += 1) {
      ctx.advance(IDLE);
      await tick();
      await step(ctx);
    }
    expect(ctx.sent).toHaveLength(2);
    expect(await reminders(ctx)).toHaveLength(1);
    expect((await itemKinds(ctx)).map((item) => item.kind)).not.toContain('worker_not_reading');
  });

  it('skips the reminder while the executor has an open question', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    await question(ctx, worker);
    await question(ctx, 'agent:web/worker-2');
    ctx.advance(IDLE * 3);

    await remind(ctx);

    expect(await reminders(ctx)).toEqual([]);
    expect(await ctx.store.transaction((trx) => quietTurns(trx))).toEqual([
      expect.objectContaining({ sessionId: 'worker-1', quietSince: null }),
    ]);
  });

  it('skips the reminder while Spur is blind', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    await ctx.store.transaction((trx) =>
      trx
        .insertInto('source_state')
        .values({ ...sampleRows.source_state, source: 'spur', blind_reason: 'unavailable' })
        .execute(),
    );
    ctx.advance(IDLE * 3);

    await remind(ctx);
    expect(await reminders(ctx)).toEqual([]);

    await ctx.store.transaction((trx) =>
      trx.updateTable('source_state').set({ blind_reason: null }).execute(),
    );
    await remind(ctx);
    expect(await reminders(ctx)).toHaveLength(1);
  });

  it('skips the reminder while the executor is working and starts the clock when it waits', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'working', ctx.now());
    ctx.advance(IDLE * 3);
    await remind(ctx);
    expect(await reminders(ctx)).toEqual([]);

    const waits = ctx.now();
    await health(ctx, 'worker-1', 'web', 'waiting', waits);
    ctx.advance(IDLE - 1);
    await remind(ctx);
    expect(await reminders(ctx)).toEqual([]);
    expect(await ctx.store.transaction((trx) => quietTurns(trx))).toEqual([
      expect.objectContaining({ quietSince: waits.toISOString(), reminder: undefined }),
    ]);

    ctx.advance(1);
    await remind(ctx);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ created_at: ctx.now().toISOString() }),
    ]);
  });

  it("restarts the clock when the executor's question closes", async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    const { id } = await question(ctx, worker);
    ctx.advance(IDLE * 3);
    await remind(ctx);
    expect(await reminders(ctx)).toEqual([]);

    await ctx.store.transaction((trx) =>
      trx
        .updateTable('block')
        .set({
          state: 'unblocked',
          outcome: 'done',
          unblocked_by: 'operator',
          unblocked_at: ctx.now().toISOString(),
        })
        .where('id', '=', id)
        .execute(),
    );
    ctx.advance(IDLE - 1);
    await remind(ctx);
    expect(await reminders(ctx)).toEqual([]);

    ctx.advance(1);
    await remind(ctx);
    expect(await reminders(ctx)).toHaveLength(1);
  });

  it("reminds the orchestrator that takes over a reminded turn, whose take drops the old holder's ring", async () => {
    const ctx = await setup({ config: policyBoard() });
    await addSession(ctx, 'qa-1', 'qa');
    await open(ctx);
    await step(ctx);
    await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-1', 'ack-qa-1');
    const firstTake = ctx.now().toISOString();
    await health(ctx, 'qa-1', 'qa', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({
        source_key: `turn:1:reminder:qa-1:${firstTake}`,
        recipient_session: 'qa-1',
      }),
    ]);

    await addSession(ctx, 'qa-2', 'qa');
    ctx.advance(1000);
    await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-2', 'ack-qa-2');
    const takeOver = ctx.now().toISOString();
    await health(ctx, 'qa-2', 'qa', 'waiting', ctx.now());
    // No tick runs between the take-over and the send: the take itself drops the queued ring.
    await ctx.sender.tick();

    expect(sessionsRung(ctx)).toEqual(['qa-1']);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ author_session: 'qa-1', acked_at: ctx.now().toISOString() }),
    ]);
    expect(await ctx.store.transaction((trx) => quietTurns(trx))).toEqual([
      expect.objectContaining({ sessionId: 'qa-2', reminder: undefined }),
    ]);

    ctx.advance(IDLE - 1);
    await remind(ctx);
    expect(await reminders(ctx)).toHaveLength(1);
    ctx.advance(1);
    await remind(ctx);
    await step(ctx);
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);

    expect(sessionsRung(ctx)).toEqual(['qa-1', 'qa-2']);
    expect((await reminders(ctx)).map((notice) => notice.source_key)).toEqual([
      `turn:1:reminder:qa-1:${firstTake}`,
      `turn:1:reminder:qa-2:${takeOver}`,
    ]);
  });

  it('reminds an orchestrator again when it retakes a turn it lost', async () => {
    const ctx = await setup({ config: policyBoard() });
    await addSession(ctx, 'qa-1', 'qa');
    await addSession(ctx, 'qa-2', 'qa');
    await open(ctx);
    await step(ctx);
    await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-1', 'ack-qa-1');
    await health(ctx, 'qa-1', 'qa', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ author_session: 'qa-1', rings: 0, acked_at: null }),
    ]);

    ctx.advance(1000);
    await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-2', 'ack-qa-2');
    ctx.advance(1000);
    await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-1', 'ack-qa-1-again');
    const retaken = ctx.now().toISOString();
    await health(ctx, 'qa-1', 'qa', 'waiting', ctx.now());
    const rung = sessionsRung(ctx).length;
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);

    expect(sessionsRung(ctx).slice(rung)).toEqual(['qa-1']);
    const episode = `turn:1:reminder:qa-1:${retaken}`;
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ author_session: 'qa-1', rings: 0 }),
      expect.objectContaining({ source_key: episode, rings: 1, acked_at: ctx.now().toISOString() }),
    ]);
    expect(await ctx.store.transaction((trx) => quietTurns(trx))).toEqual([
      expect.objectContaining({
        sessionId: 'qa-1',
        reminder: expect.objectContaining({ source_key: episode }) as unknown,
      }),
    ]);

    ctx.advance(IDLE);
    await health(ctx, 'worker-1', 'web', 'working', ctx.now());
    await health(ctx, 'qa-2', 'qa', 'working', ctx.now());
    await scanTransaction(ctx.store, ctx.config, async (trx) => {
      await reconcileItems(trx, ctx.config, ctx.now().getTime(), true);
    });
    expect(await itemKinds(ctx)).toContainEqual({ kind: 'anomaly', item_key: 'stuck-turn:1' });
  });

  it('picks the executor', () => {
    expect(turnExecutor('dev', 'qa', false)).toBe('orchestrator:dev');
    expect(turnExecutor('dev', 'operator', true)).toBe('operator');
    expect(turnExecutor('dev', 'none', true)).toBe('worker');
    expect(turnExecutor('dev', 'none', false)).toBe('operator');
    expect(turnExecutor('done', 'none', true)).toBe('worker');
    for (const column of ['review', 'product-review', 'qa', 'ready-to-merge'] as const)
      expect(turnExecutor(column, 'none', true)).toBe('operator');
  });

  it('closes the turns of an archived task', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await open(ctx);
    await step(ctx);

    await scanTransaction(
      ctx.store,
      ctx.config,
      async (trx) => {
        const task = await trx
          .selectFrom('task')
          .selectAll()
          .where('id', '=', 1)
          .executeTakeFirstOrThrow();
        await archiveTask(trx, {
          task,
          reason: 'manual',
          actor: 'operator',
          at: ctx.now().toISOString(),
        });
      },
      { now: () => ctx.now().getTime() },
    );

    expect((await turns(ctx))[0]?.closed_reason).toBe('archived');
    expect((await notices(ctx))[0]?.acked_at).not.toBeNull();
    await ctx.store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'active' }).execute(),
    );
    ctx.advance(2_000_000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
  });

  it('skips the reminder for a worker whose link was removed', async () => {
    const unlink = (ctx: Board) =>
      ctx.apply(
        createLinkMutations(ctx.config).remove,
        { mode: 'session', task: KEY, session: 'worker-1', reason: 'Wrong task.' },
        'operator',
      );

    const quiet = await setup({ config: policyBoard('none') });
    await takenByWorker(quiet);
    await health(quiet, 'worker-1', 'web', 'waiting', quiet.now());
    await unlink(quiet);
    quiet.advance(IDLE * 3);
    await remind(quiet);
    expect(await reminders(quiet)).toEqual([]);
    expect(await quiet.store.transaction((trx) => quietTurns(trx))).toEqual([]);

    const queued = await setup({ config: policyBoard('none') });
    await takenByWorker(queued);
    await health(queued, 'worker-1', 'web', 'waiting', queued.now());
    queued.advance(IDLE);
    await remind(queued);
    await queued.ring();
    expect(await reminders(queued)).toEqual([
      expect.objectContaining({ recipient_session: 'worker-1', acked_at: null }),
    ]);
    await unlink(queued);
    await queued.sender.tick();
    expect(queued.sent).toHaveLength(1);
    expect(await reminders(queued)).toEqual([
      expect.objectContaining({ acked_at: queued.now().toISOString() }),
    ]);
  });

  it("re-arms a worker's reminder when its removed link is restored", async () => {
    const link = { mode: 'session', task: KEY, session: 'worker-1', reason: 'Relink.' } as const;
    const relink = (ctx: Board, op: 'add' | 'remove') =>
      op === 'add'
        ? ctx.apply(createLinkMutations(ctx.config).add, link, 'operator')
        : ctx.apply(createLinkMutations(ctx.config).remove, link, 'operator');

    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    const taken = ctx.now().toISOString();
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    await relink(ctx, 'remove');
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);

    await relink(ctx, 'add');
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);

    expect(ctx.sent.slice(1)).toEqual([
      {
        session: 'worker-1',
        text: expect.stringMatching(
          /^.+ turn T1 is still open: check board inbox \(N\d+-1\)$/,
        ) as unknown,
      },
    ]);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({
        source_key: `turn:1:reminder:worker-1:${taken}`,
        rings: 1,
        acked_at: new Date(ctx.now().getTime() - IDLE).toISOString(),
      }),
    ]);
    await scanTransaction(ctx.store, ctx.config, async (trx) => {
      await reconcileItems(trx, ctx.config, ctx.now().getTime(), true);
    });
    expect(await itemKinds(ctx)).toContainEqual({ kind: 'anomaly', item_key: 'stuck-turn:1' });
  });

  it('does not send a second reminder when a link is removed during an in-flight delivery and restored', async () => {
    const link = { mode: 'session', task: KEY, session: 'worker-1', reason: 'Relink.' } as const;
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    ctx.beforeSend(async () => {
      await ctx.apply(createLinkMutations(ctx.config).remove, link, 'operator');
    });
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);

    await ctx.apply(createLinkMutations(ctx.config).add, link, 'operator');
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);

    expect(ctx.sent.slice(1)).toEqual([
      {
        session: 'worker-1',
        text: expect.stringMatching(
          /^.+ turn T1 is still open: check board inbox \(N\d+-1\)$/,
        ) as unknown,
      },
    ]);
    expect(await reminders(ctx)).toEqual([expect.objectContaining({ rings: 1 })]);
  });

  it('does not send a second reminder when a link is removed and restored during an in-flight delivery', async () => {
    const link = { mode: 'session', task: KEY, session: 'worker-1', reason: 'Relink.' } as const;
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    ctx.beforeSend(async () => {
      await ctx.apply(createLinkMutations(ctx.config).remove, link, 'operator');
      await ctx.apply(createLinkMutations(ctx.config).add, link, 'operator');
      ctx.advance(IDLE);
      await remind(ctx);
      await ctx.ring();
    });
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);

    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);
    ctx.advance(IDLE);
    await remind(ctx);
    await step(ctx);

    expect(ctx.sent).toHaveLength(2);
    expect(await reminders(ctx)).toEqual([expect.objectContaining({ rings: 1 })]);
  });

  it('escalates a stuck turn after an uncertain reminder that a relink cancelled', async () => {
    const link = { mode: 'session', task: KEY, session: 'worker-1', reason: 'Relink.' } as const;
    const reconcile = () =>
      scanTransaction(ctx.store, ctx.config, async (trx) => {
        await reconcileItems(trx, ctx.config, ctx.now().getTime(), true);
      });
    const stuck = async () =>
      (await itemKinds(ctx)).filter((item) => item.item_key === 'stuck-turn:1');
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    ctx.failNext(new Error('spur send timed out'));
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);

    await ctx.apply(createLinkMutations(ctx.config).remove, link, 'operator');
    const removedAt = ctx.now().getTime();
    await ctx.apply(createLinkMutations(ctx.config).add, link, 'operator');
    ctx.advance(60_000);
    await ctx.sender.tick();
    const [reminder] = await reminders(ctx);
    const rows = await ctx.store.db
      .selectFrom('outbox')
      .select(['state', 'uncertain'])
      .where('kind', '=', 'doorbell')
      .where(sql<number>`json_extract(payload, '$.notificationId')`, '=', reminder?.id ?? -1)
      .execute();
    expect(rows).toEqual([{ state: 'dead', uncertain: 1 }]);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({
        rings: 0,
        exhausted_at: null,
        acked_at: expect.any(String) as unknown,
      }),
    ]);

    ctx.advance(removedAt + IDLE - 1 - ctx.now().getTime());
    await reconcile();
    expect(await stuck()).toEqual([]);
    ctx.advance(1);
    await reconcile();
    await remind(ctx);
    await step(ctx);
    ctx.advance(IDLE);
    await reconcile();
    await remind(ctx);
    await step(ctx);

    expect(await stuck()).toEqual([{ kind: 'anomaly', item_key: 'stuck-turn:1' }]);
    expect(ctx.sent).toHaveLength(1);
    expect(await reminders(ctx)).toHaveLength(1);
  });

  describe('per-column turn timings', () => {
    const NO_RECIPIENT = 600_000;

    function reconcile(ctx: Board, spurComplete = true) {
      return scanTransaction(ctx.store, ctx.config, async (trx) => {
        await reconcileItems(trx, ctx.config, ctx.now().getTime(), spurComplete);
      });
    }

    function noSession(ctx: Board) {
      return ctx.store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('item_key', 'like', 'no-session:%')
        .orderBy('id')
        .execute();
    }

    async function active(ctx: Board) {
      return (await noSession(ctx)).filter((item) => item.cleared_at === null);
    }

    async function raisedCount(ctx: Board) {
      const rows = await ctx.store.db
        .selectFrom('event')
        .select('id')
        .where('kind', '=', 'from_you_raised')
        .execute();
      return rows.length;
    }

    /** Inserts task 2 in Dev and opens its turn at the current time. */
    async function openSecond(ctx: Board) {
      await ctx.store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            ...sampleRows.task,
            id: 2,
            key: 'o/r#102',
            tracker_id: '102',
            project: 'proj',
            membership: 'active',
            archive_reason: null,
            column: 'dev',
          })
          .execute();
      });
      return scanTransaction(ctx.store, ctx.config, async (trx) => {
        const task = await trx
          .selectFrom('task')
          .selectAll()
          .where('id', '=', 2)
          .executeTakeFirstOrThrow();
        return openTurn(trx, {
          task,
          reason: 'Review',
          handed: [],
          at: ctx.now(),
          config: ctx.config,
        });
      });
    }

    /** A dev board orchestrated by qa with no qa session; worker-1 has full facts. */
    async function waitingBoard(
      dev: { quietTurnAfterMs?: number; noRecipientAfterMs?: number } = {},
    ) {
      const ctx = await setup({ config: policyBoard('qa', dev) });
      await health(ctx, 'worker-1', 'web', 'working', ctx.now());
      return ctx;
    }

    async function liveQa(ctx: Board, id: string) {
      await addSession(ctx, id, 'qa', { firstSeen: ctx.now().getTime() - START });
      await health(ctx, id, 'qa', 'waiting', ctx.now());
    }

    it.each([IDLE / 2, IDLE * 3])(
      'reminds a quiet orchestrator turn at its column quietTurnAfterMs (%d)',
      async (quiet) => {
        const ctx = await setup({ config: policyBoard('qa', { quietTurnAfterMs: quiet }) });
        await addSession(ctx, 'qa-1', 'qa');
        await open(ctx);
        await step(ctx);
        await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-1', 'ack-qa-1');
        await health(ctx, 'qa-1', 'qa', 'waiting', ctx.now());
        const rung = sessionsRung(ctx).length;
        if (quiet > IDLE) {
          ctx.advance(IDLE);
          await remind(ctx);
          expect(await reminders(ctx)).toEqual([]);
          ctx.advance(quiet - IDLE - 1);
        } else ctx.advance(quiet - 1);
        await remind(ctx);
        expect(await reminders(ctx)).toEqual([]);

        ctx.advance(1);
        await remind(ctx);
        await step(ctx);
        expect(sessionsRung(ctx).slice(rung)).toEqual(['qa-1']);
      },
    );

    it('keeps the global threshold for a worker turn left in a column that became orchestrated', async () => {
      const first = await setup({ config: policyBoard('none') });
      await takenByWorker(first);
      await health(first, 'worker-1', 'web', 'waiting', first.now());
      const quietStart = first.now().getTime();
      const ctx = await setup({
        reopen: first.file,
        config: policyBoard('qa', { quietTurnAfterMs: IDLE / 2 }),
      });
      expect((await turns(ctx)).map((turn) => turn.role)).toEqual(['worker']);
      ctx.advance(quietStart - START + IDLE / 2);
      await remind(ctx);
      expect(await reminders(ctx)).toEqual([]);

      ctx.advance(IDLE / 2);
      await remind(ctx);
      expect(await reminders(ctx)).toEqual([
        expect.objectContaining({ author_session: 'worker-1', role: 'worker' }),
      ]);
    });

    it('escalates a stuck orchestrator turn at its column quietTurnAfterMs', async () => {
      const quiet = IDLE / 2;
      const ctx = await setup({ config: policyBoard('qa', { quietTurnAfterMs: quiet }) });
      await addSession(ctx, 'qa-1', 'qa');
      await open(ctx);
      await step(ctx);
      await ctx.apply(ctx.ops.ack, T1, 'agent:qa/qa-1', 'ack-qa-1');
      await health(ctx, 'qa-1', 'qa', 'waiting', ctx.now());
      await health(ctx, 'worker-1', 'web', 'working', ctx.now());
      ctx.advance(quiet);
      await remind(ctx);
      await step(ctx);
      expect(await reminders(ctx)).toEqual([
        expect.objectContaining({ rings: 1, acked_at: ctx.now().toISOString() }),
      ]);
      const stuck = async () =>
        (await itemKinds(ctx)).filter((item) => item.item_key === 'stuck-turn:1');

      ctx.advance(quiet - 1);
      await reconcile(ctx);
      expect(await stuck()).toEqual([]);
      ctx.advance(1);
      await reconcile(ctx);
      expect(await stuck()).toEqual([{ kind: 'anomaly', item_key: 'stuck-turn:1' }]);
    });

    it.each([undefined, 2_700_000])(
      'raises one no-session item per column after noRecipientAfterMs (%s)',
      async (afterMs) => {
        const threshold = afterMs ?? NO_RECIPIENT;
        const ctx = await waitingBoard(
          afterMs === undefined ? {} : { noRecipientAfterMs: afterMs },
        );
        await open(ctx);
        const ring = (await notices(ctx))[0];
        expect(ring).toEqual(expect.objectContaining({ kind: 'turn', role: 'orchestrator:dev' }));
        ctx.advance(threshold - 1);
        await reconcile(ctx);
        expect(await noSession(ctx)).toEqual([]);

        ctx.advance(1);
        await reconcile(ctx);
        const [item, ...rest] = await noSession(ctx);
        expect(rest).toEqual([]);
        expect(item).toEqual(
          expect.objectContaining({
            item_key: 'no-session:proj:dev',
            kind: 'board_observation',
            task_id: 1,
            cleared_at: null,
            fact_at: ring?.created_at,
            text: `proj dev: turns wait for a live session of Spur project qa; oldest T1 since ${ring?.created_at ?? ''}`,
          }),
        );
        expect(item?.text).not.toMatch(/\d+ waiting/);
        const raised = await raisedCount(ctx);
        const outboxRows = (await ctx.store.db.selectFrom('outbox').select('id').execute()).length;

        ctx.advance(60_000);
        await reconcile(ctx);
        await openSecond(ctx);
        ctx.advance(threshold);
        await reconcile(ctx);
        expect((await active(ctx)).map((row) => row.id)).toEqual([item?.id]);
        expect(await raisedCount(ctx)).toBe(raised);
        expect((await ctx.store.db.selectFrom('outbox').select('id').execute()).length).toBe(
          outboxRows,
        );

        await liveQa(ctx, 'qa-1');
        await reconcile(ctx);
        expect(await active(ctx)).toEqual([]);
      },
    );

    it('raises nothing for a session gap shorter than noRecipientAfterMs', async () => {
      // A ring with no session that a session takes up before the threshold.
      const late = await waitingBoard();
      await open(late);
      late.advance(NO_RECIPIENT - 1);
      await liveQa(late, 'qa-1');
      await reconcile(late);
      late.advance(NO_RECIPIENT * 2);
      await reconcile(late);
      expect(await noSession(late)).toEqual([]);

      // A session restart shorter than the threshold.
      const ctx = await waitingBoard();
      await liveQa(ctx, 'qa-1');
      await open(ctx);
      ctx.advance(NO_RECIPIENT * 2);
      await reconcile(ctx);
      expect(await noSession(ctx)).toEqual([]);
      await setSession(ctx, 'qa-1', { ended_at: ctx.now().toISOString(), state: 'stopped' });
      await reconcile(ctx);
      expect(await noSession(ctx)).toEqual([]);
      ctx.advance(NO_RECIPIENT - 1);
      await reconcile(ctx);
      await liveQa(ctx, 'qa-2');
      await reconcile(ctx);
      ctx.advance(NO_RECIPIENT * 3);
      await reconcile(ctx);
      expect(await noSession(ctx)).toEqual([]);
    });

    // Every way a session that could take the ring stops being a recipient, alone and followed
    // by later timestamps on the same gap. `listed` steps come from a Spur poll that still lists
    // the session with no end time, as Spur does for a finished session; `new listed killed`
    // lists a second session of the column's Spur project that was never a recipient.
    type GoneStep =
      | 'ended'
      | 'absent'
      | 'listed stopped'
      | 'listed completed'
      | 'listed errored'
      | 'listed killed'
      | 'new listed killed';
    it.each<{ steps: readonly GoneStep[]; linked: boolean }>([
      { steps: ['ended'], linked: false },
      { steps: ['absent'], linked: false },
      { steps: ['listed stopped'], linked: false },
      { steps: ['listed completed'], linked: false },
      { steps: ['listed errored'], linked: false },
      { steps: ['listed killed'], linked: false },
      { steps: ['ended'], linked: true },
      { steps: ['listed stopped'], linked: true },
      { steps: ['listed killed'], linked: true },
      { steps: ['listed killed', 'absent'], linked: false },
      { steps: ['listed killed', 'ended'], linked: false },
      { steps: ['absent', 'ended'], linked: false },
      { steps: ['listed killed', 'ended'], linked: true },
      { steps: ['ended', 'listed killed'], linked: false },
      { steps: ['absent', 'listed killed'], linked: false },
      { steps: ['listed completed', 'listed killed'], linked: false },
      { steps: ['ended', 'new listed killed'], linked: false },
    ])(
      'raises noRecipientAfterMs after the first loss of a gap and keeps it open ($steps, linked $linked)',
      async ({ steps, linked }) => {
        const ctx = await waitingBoard();
        const [session, project] = linked ? ['cur-9', 'cur'] : ['qa-1', 'qa'];
        if (linked) {
          await addSession(ctx, 'cur-9', 'cur');
          await addLink(ctx, 50, 'cur-9', 'orchestrator');
          await health(ctx, 'cur-9', 'cur', 'waiting', ctx.now());
        } else await liveQa(ctx, 'qa-1');
        await open(ctx);
        // Each check follows a fresh Spur poll, so stale Spur data never holds the item.
        const poll = async () => {
          await observeHealth(ctx, 'worker-1', 'working');
          await reconcile(ctx);
        };
        ctx.advance(NO_RECIPIENT * 2);
        await poll();
        expect(await noSession(ctx)).toEqual([]);
        const apply = async (step: GoneStep) => {
          const at = ctx.now().toISOString();
          if (step === 'ended') await setSession(ctx, session, { ended_at: at });
          else if (step === 'absent') await setSession(ctx, session, { absent_since: at });
          else if (step === 'new listed killed')
            await observeHealth(ctx, 'qa-2', 'waiting', 'qa', 'killed');
          else await observeHealth(ctx, session, 'waiting', project, step.slice('listed '.length));
        };
        const [first, ...later] = steps;
        const end = ctx.now().toISOString();
        if (first !== undefined) await apply(first);
        await poll();
        expect(await noSession(ctx)).toEqual([]);
        ctx.advance(NO_RECIPIENT - 1);
        // A later poll that still lists the finished session keeps the first finish time.
        if (first?.startsWith('listed ') === true) await apply(first);
        await poll();
        expect(await noSession(ctx)).toEqual([]);
        ctx.advance(1);
        await poll();
        const [item] = await active(ctx);
        expect(await noSession(ctx)).toEqual([
          expect.objectContaining({ item_key: 'no-session:proj:dev', fact_at: end }),
        ]);
        const raised = await raisedCount(ctx);
        const outboxRows = (await ctx.store.db.selectFrom('outbox').select('id').execute()).length;

        for (const step of later) {
          ctx.advance(60_000);
          await apply(step);
          await poll();
        }
        ctx.advance(NO_RECIPIENT);
        await poll();
        expect(await noSession(ctx)).toEqual([
          expect.objectContaining({ id: item?.id, cleared_at: null, fact_at: end }),
        ]);
        expect(await raisedCount(ctx)).toBe(raised);
        expect((await ctx.store.db.selectFrom('outbox').select('id').execute()).length).toBe(
          outboxRows,
        );
      },
    );

    it('keeps a closed no-session item closed while its oldest turn waits', async () => {
      const ctx = await waitingBoard();
      await open(ctx);
      await openSecond(ctx);
      ctx.advance(NO_RECIPIENT);
      await reconcile(ctx);
      const [item] = await active(ctx);
      expect(item?.text).toContain('oldest T1 since');
      await ctx.apply(
        createItemMutations({ config }).close,
        { item: `I${String(item?.id)}` },
        'operator',
        'close',
      );
      await reconcile(ctx);
      expect(await active(ctx)).toEqual([]);

      await liveQa(ctx, 'qa-1');
      await reconcile(ctx);
      await setSession(ctx, 'qa-1', { ended_at: ctx.now().toISOString(), state: 'stopped' });
      ctx.advance(NO_RECIPIENT + 1);
      await reconcile(ctx);
      expect(await active(ctx)).toEqual([]);

      await close(ctx);
      await reconcile(ctx);
      expect(await active(ctx)).toEqual([
        expect.objectContaining({
          item_key: 'no-session:proj:dev',
          task_id: 2,
          text: expect.stringContaining('oldest T2 since') as unknown,
        }),
      ]);
    });

    it('keeps one no-session item across a restart', async () => {
      const ctx = await waitingBoard();
      await open(ctx);
      ctx.advance(NO_RECIPIENT);
      await reconcile(ctx);
      const [item] = await active(ctx);
      const raised = await raisedCount(ctx);
      const reopened = await setup({ reopen: ctx.file, config: ctx.config });
      reopened.advance(NO_RECIPIENT * 2);
      await reconcile(reopened, false);
      expect((await active(reopened)).map((row) => row.id)).toEqual([item?.id]);
      await reconcile(reopened, true);
      expect((await active(reopened)).map((row) => row.id)).toEqual([item?.id]);
      expect(await raisedCount(reopened)).toBe(raised);

      // A ring created before a restart raises after it on its stored creation time.
      const before = await waitingBoard();
      await open(before);
      const [ring] = await notices(before);
      const after = await setup({ reopen: before.file, config: before.config });
      after.advance(NO_RECIPIENT - 1);
      await reconcile(after, false);
      expect(await noSession(after)).toEqual([]);
      after.advance(1);
      await reconcile(after, true);
      expect(await active(after)).toEqual([expect.objectContaining({ fact_at: ring?.created_at })]);
    });
  });

  it('defers a queued reminder while its holder has an open question and sends it after a fresh quiet period', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    const { id } = await question(ctx, worker);

    await ctx.sender.tick();
    ctx.advance(IDLE * 2);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ rings: 0, acked_at: null, exhausted_at: null }),
    ]);

    await ctx.store.transaction((trx) =>
      trx
        .updateTable('block')
        .set({
          state: 'unblocked',
          outcome: 'done',
          unblocked_by: 'operator',
          unblocked_at: ctx.now().toISOString(),
        })
        .where('id', '=', id)
        .execute(),
    );
    // The sender defers a ring for a second, so this retry falls due exactly at the threshold.
    ctx.advance(IDLE - 1000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);

    ctx.advance(1000);
    await step(ctx);
    expect(ctx.sent.slice(1)).toEqual([
      { session: 'worker-1', text: `${KEY} turn T1 is still open: check board inbox (N2-1)` },
    ]);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ rings: 1, acked_at: ctx.now().toISOString() }),
    ]);
    ctx.advance(IDLE * 2);
    await remind(ctx);
    await step(ctx);
    expect(ctx.sent).toHaveLength(2);
  });

  it('defers a queued reminder while Spur is blind and sends it once Spur reports again', async () => {
    const ctx = await setup({ config: policyBoard('none') });
    const core = createObservationCore({
      store: ctx.store,
      config: ctx.config,
      clock: { now: () => ctx.now().getTime() },
    });
    await takenByWorker(ctx);
    await health(ctx, 'worker-1', 'web', 'waiting', ctx.now());
    ctx.advance(IDLE);
    await remind(ctx);
    await ctx.ring();
    expect(await reminders(ctx)).toHaveLength(1);
    await core.reportSourceState('spur', {
      blind: { reason: 'auth', message: 'Access rejected' },
      gone: [],
    });

    await ctx.sender.tick();
    ctx.advance(IDLE * 2);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ rings: 0, acked_at: null, exhausted_at: null }),
    ]);

    await core.reportSourceState('spur', { lastCompleteAt: ctx.now().toISOString(), gone: [] });
    ctx.advance(1000);
    await step(ctx);
    expect(ctx.sent.slice(1)).toEqual([
      { session: 'worker-1', text: `${KEY} turn T1 is still open: check board inbox (N2-1)` },
    ]);
    expect(await reminders(ctx)).toEqual([
      expect.objectContaining({ rings: 1, acked_at: ctx.now().toISOString() }),
    ]);
  });
});

describe('project question doorbells', () => {
  const askProject = (ctx: Board, actor: ActorId) =>
    ctx.apply(
      ctx.ops.projectAsk,
      { project: 'proj', to: 'operator', text: 'Restart?' },
      actor,
      'q',
    );
  const answer = (ctx: Board, block: string) =>
    ctx.apply(ctx.ops.answer, { block, text: 'Yes.' }, 'operator', 'answer');

  it('rings the curator that asked with the project in the text', async () => {
    const ctx = await setup({ config: policyConfig });
    await addSession(ctx, 'cur-1', 'cur');
    const { block } = await askProject(ctx, 'agent:cur/cur-1');
    await answer(ctx, block.id);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['cur-1']);
    const [notice] = await notices(ctx);
    expect(ctx.sent[0]?.text).toBe(
      `proj (project) block ${block.id}: check board inbox (N${String(notice?.id)}-1)`,
    );
  });

  it("rings a worker author's own session", async () => {
    const ctx = await setup({ config: policyConfig });
    const { block } = await askProject(ctx, worker);
    await answer(ctx, block.id);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['worker-1']);
  });

  it('ends the series of a worker author with no live session, not ringing a linked worker', async () => {
    const ctx = await setup({ config: policyConfig });
    const { block } = await askProject(ctx, 'agent:web/worker-9');
    await answer(ctx, block.id);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual([]);
    const [notice] = await notices(ctx);
    expect(notice?.exhausted_at).toBe(ctx.now().toISOString());
    expect(await journalled(ctx, 'doorbell_undelivered')).toEqual([
      {
        actor: 'system',
        payload: { doorbell: `N${String(notice?.id)}`, reason: 'no live addressee' },
      },
    ]);
  });
});

describe('operator doorbells without Slack', () => {
  const offBoard = policyBoard('qa', {}, { slack: false });
  const operatorColumnBoard = policyBoard('operator', {}, { slack: false });
  const T1 = { entries: [{ id: 'T1' }] };
  const blockAck = (id: string) => ({ entries: [{ id }] });
  const askProject = (ctx: Board, actor: ActorId) =>
    ctx.apply(
      ctx.ops.projectAsk,
      { project: 'proj', to: 'operator', text: 'Restart?' },
      actor,
      'q',
    );

  function openOperatorTurn(ctx: Board) {
    return scanTransaction(ctx.store, ctx.config, async (trx) => {
      const task = await trx
        .selectFrom('task')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      return openTurn(trx, {
        task,
        reason: 'Merge it',
        handed: [],
        at: ctx.now(),
        config: ctx.config,
      });
    });
  }

  async function escalateToOperator(ctx: Board): Promise<string> {
    const blockId = await workerBlock(ctx.store);
    await ctx.apply(ctx.ops.escalate, { block: blockId }, worker, 'escalate');
    return blockId;
  }

  const operatorNotices = async (ctx: Board) =>
    (await notices(ctx)).filter((notice) => notice.role === 'operator');

  it('rings the operator session once for a question escalated to the operator', async () => {
    const ctx = await setup({ config: offBoard, column: 'qa' });
    await addSession(ctx, 'cur-1', 'cur');
    await addSession(ctx, 'ops-1', 'ops');
    const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
    await step(ctx);
    await ctx.apply(ctx.ops.escalate, { block: asked.block.id }, 'agent:cur/cur-1', 'esc');
    await step(ctx);

    expect(sessionsRung(ctx)).toEqual(['cur-1', 'ops-1']);
    const [notice] = await operatorNotices(ctx);
    expect(ctx.sent[1]?.text).toBe(
      `${KEY} block ${asked.block.id}: check board inbox operator (N${String(notice?.id)}-1)`,
    );
    await ctx.apply(ctx.ops.answer, { block: asked.block.id, text: 'Yes.' }, 'operator', 'ans');
    ctx.advance(2_000_000);
    await step(ctx);
    // The answer rings the asking worker; the operator session hears nothing more.
    expect(sessionsRung(ctx)).toEqual(['cur-1', 'ops-1', 'worker-1']);
    expect((await operatorNotices(ctx))[0]?.acked_at).not.toBeNull();
  });

  it('rings the operator session for an operator turn until it is taken', async () => {
    const ctx = await setup({ config: operatorColumnBoard });
    await addSession(ctx, 'ops-1', 'ops');
    expect((await openOperatorTurn(ctx)).role).toBe('operator');
    await step(ctx);

    const [notice] = await operatorNotices(ctx);
    expect(ctx.sent).toEqual([
      {
        session: 'ops-1',
        text: `${KEY} turn T1: check board inbox operator (N${String(notice?.id)}-1)`,
      },
    ]);
    expect(await ctx.store.db.selectFrom('operator_item').select('item_key').execute()).toEqual([
      { item_key: 'turn:1' },
    ]);
    await expect(ctx.apply(ctx.ops.ack, T1, 'agent:ops/ops-1', 'ack-t1')).resolves.toEqual({
      acked: ['T1'],
    });
    expect((await operatorNotices(ctx))[0]?.acked_at).toBe(ctx.now().toISOString());
    ctx.advance(2_000_000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);
  });

  it.each(['project-level', 'top-level'] as const)(
    'rings the %s operator session for a taskless ask, and nobody for its own ask',
    async (operator) => {
      const board = policyBoard('qa', {}, { slack: false, operator });
      const ctx = await setup({ config: board });
      await addSession(ctx, 'ops-1', 'ops');
      const { block } = await askProject(ctx, worker);
      await step(ctx);
      const [notice] = await operatorNotices(ctx);
      expect(ctx.sent).toEqual([
        {
          session: 'ops-1',
          text: `proj (project) block ${block.id}: check board inbox operator (N${String(notice?.id)}-1)`,
        },
      ]);

      const own = await setup({ config: board });
      await addSession(own, 'ops-1', 'ops');
      await askProject(own, 'agent:ops/ops-1');
      await step(own);
      expect(own.sent).toEqual([]);
      expect(await operatorNotices(own)).toEqual([]);
    },
  );

  it('keeps an operator block due and unsent while no operator session lives', async () => {
    const ctx = await setup({ config: offBoard });
    const blockId = await escalateToOperator(ctx);
    await step(ctx);
    ctx.advance(2_000_000);
    await step(ctx);

    expect(ctx.sent).toEqual([]);
    expect(await operatorNotices(ctx)).toEqual([
      expect.objectContaining({ recipient_session: null, exhausted_at: null, acked_at: null }),
    ]);
    expect(await itemKinds(ctx)).toEqual([]);
    const block = await ctx.store.db
      .selectFrom('block')
      .select('addressee_role')
      .where('id', '=', Number(blockId.slice(1)))
      .executeTakeFirstOrThrow();
    expect(block.addressee_role).toBe('operator');
  });

  it('ends three unanswered operator rings with a journal row and no item', async () => {
    const ctx = await setup({ config: offBoard });
    await addSession(ctx, 'ops-1', 'ops');
    await escalateToOperator(ctx);
    for (const pause of [0, 120_000, 300_000, 900_000]) {
      ctx.advance(pause);
      await step(ctx);
    }

    expect(sessionsRung(ctx)).toEqual(['ops-1', 'ops-1', 'ops-1']);
    const [notice] = await operatorNotices(ctx);
    expect(notice?.exhausted_at).not.toBeNull();
    expect(await journalled(ctx, 'doorbell_undelivered')).toEqual([
      { actor: 'system', payload: { doorbell: `N${String(notice?.id)}`, reason: 'unanswered' } },
    ]);
    expect(await itemKinds(ctx)).toEqual([]);
  });

  it('stops the rings when the operator session acks the block', async () => {
    const ctx = await setup({ config: offBoard });
    await addSession(ctx, 'ops-1', 'ops');
    const blockId = await escalateToOperator(ctx);
    await step(ctx);
    await expect(
      ctx.apply(ctx.ops.ack, blockAck(blockId), 'agent:ops/ops-1', 'ack-session'),
    ).resolves.toEqual({ acked: [blockId] });
    ctx.advance(2_000_000);
    await step(ctx);
    expect(sessionsRung(ctx)).toEqual(['ops-1']);
  });

  it('lets the operator token ack an operator block and an operator turn', async () => {
    const ctx = await setup({ config: offBoard });
    await addSession(ctx, 'ops-1', 'ops');
    const blockId = await escalateToOperator(ctx);
    await step(ctx);
    await expect(
      ctx.apply(ctx.ops.ack, blockAck(blockId), 'operator', 'ack-token'),
    ).resolves.toEqual({ acked: [blockId] });
    expect((await operatorNotices(ctx))[0]?.acked_at).toBe(ctx.now().toISOString());
    ctx.advance(2_000_000);
    await step(ctx);
    expect(ctx.sent).toHaveLength(1);

    const turnBoard = await setup({ config: operatorColumnBoard });
    await addSession(turnBoard, 'ops-1', 'ops');
    await openOperatorTurn(turnBoard);
    await step(turnBoard);
    await expect(
      turnBoard.apply(turnBoard.ops.ack, T1, 'operator', 'ack-token-turn'),
    ).resolves.toEqual({ acked: ['T1'] });
    expect((await operatorNotices(turnBoard))[0]?.acked_at).toBe(turnBoard.now().toISOString());
    const turn = await turnBoard.store.db
      .selectFrom('turn')
      .select('acked_by')
      .executeTakeFirstOrThrow();
    expect(turn.acked_by).toBe('operator');
  });

  it('refuses the operator token a block addressed to a worker', async () => {
    const ctx = await setup({ config: offBoard });
    const blockId = await workerBlock(ctx.store);
    await expect(
      ctx.apply(ctx.ops.ack, blockAck(blockId), 'operator', 'ack-worker-block'),
    ).rejects.toMatchObject({
      code: 'forbidden',
      hint: expect.stringContaining('T<number>') as unknown,
    });
    const denied = await ctx.store.db
      .selectFrom('event')
      .select('id')
      .where('kind', '=', 'operation_denied')
      .execute();
    expect(denied).toHaveLength(1);
  });

  it.each(['block', 'turn'] as const)(
    'writes no operator %s notification while Slack is on',
    async (kind) => {
      const ctx =
        kind === 'block'
          ? await setup({ config: policyConfig, column: 'qa' })
          : await setup({ config: policyBoard('operator') });
      await addSession(ctx, 'ops-1', 'ops');
      if (kind === 'block') {
        await addSession(ctx, 'cur-1', 'cur');
        const asked = await ctx.apply(ctx.ops.ask, { task: KEY, text: 'Q?' }, worker, 'ask');
        await ctx.apply(ctx.ops.escalate, { block: asked.block.id }, 'agent:cur/cur-1', 'esc');
      } else {
        await openOperatorTurn(ctx);
      }
      ctx.advance(2_000_000);
      await step(ctx);

      expect((await notices(ctx)).filter((n) => n.source_key.endsWith(':operator'))).toEqual([]);
      expect(sessionsRung(ctx)).not.toContain('ops-1');
    },
  );
});

describe('operator conversation doorbells', () => {
  const board = conversationConfig();
  const at = new Date(CONVERSATION_AT);
  /** A `cur` conversation opened by the operator; `session` adds a live `cur` session. */
  async function conversation(session: boolean) {
    const { store } = await conversationStore();
    stores.push(store);
    if (session) await liveSession(store, 'cur-1', 'cur');
    await startConversation(store, board, '@cur hello');
    const apply = createApply({ store, clock: { now: () => at.getTime() }, config: board });
    const follow = (text: string, n: number) =>
      scanTransaction(store, board, (trx) =>
        recordInboundBlockMessage(trx, {
          blockId: 1,
          text,
          conversationRef: 'top-1',
          messageRef: `top-1-reply-${String(n)}`,
          at: CONVERSATION_AT,
          config: board,
        }),
      );
    const rings = async () =>
      (
        await store.db
          .selectFrom('outbox')
          .select('payload')
          .where('kind', '=', 'doorbell')
          .orderBy('id')
          .execute()
      ).map((row) => JSON.parse(row.payload) as { session: string; text: string });
    const notices = () =>
      store.db
        .selectFrom('notification')
        .select(['kind', 'role', 'acked_at', 'exhausted_at'])
        .orderBy('id')
        .execute();
    const kinds = async () =>
      (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind);
    const reconcile = (when = at) => reconcileDueDoorbells(store, board, when);
    return { store, apply, follow, rings, notices, kinds, reconcile };
  }

  it('rings the addressed session again for each operator follow-up', async () => {
    const ctx = await conversation(true);
    await ctx.reconcile();
    expect((await ctx.rings()).map((ring) => ring.session)).toEqual(['cur-1']);
    const ops = createBlockMutations(board);
    await ctx.apply(ops.answer, { block: 'B1', text: 'hi' }, 'agent:cur/cur-1', 'answer');
    await ctx.follow('and more', 1);
    await ctx.reconcile();
    const rings = await ctx.rings();
    expect(rings.map((ring) => ring.session)).toEqual(['cur-1', 'cur-1']);
    expect(rings[1]?.text).toMatch(/^proj \(project\) block B1: check board inbox \(N2-1\)$/);
    expect(await ctx.kinds()).not.toContain('doorbell_undelivered');
    expect(await ctx.store.db.selectFrom('operator_item').select('kind').execute()).toEqual([]);
  });

  it('rings nobody for a message after the conversation closed', async () => {
    const ctx = await conversation(true);
    await ctx.follow('close', 1);
    await ctx.follow('late', 2);
    await ctx.reconcile();
    expect(await ctx.rings()).toEqual([]);
    expect((await ctx.notices()).map((row) => row.kind)).toEqual(['block']);
    expect((await ctx.notices())[0]?.acked_at).not.toBeNull();
  });

  it('keeps a ring due with no live session and sends it once one appears', async () => {
    const ctx = await conversation(false);
    await ctx.follow('and more', 1);
    const later = new Date(at.getTime() + DAY_MS);
    await ctx.reconcile(later);
    expect(await ctx.rings()).toEqual([]);
    expect(await ctx.notices()).toEqual([
      { kind: 'block', role: 'curator', acked_at: null, exhausted_at: null },
      { kind: 'answer', role: 'curator', acked_at: null, exhausted_at: null },
    ]);
    expect(await ctx.kinds()).not.toContain('doorbell_undelivered');
    expect(await ctx.kinds()).not.toContain('block_escalated');
    expect(
      await ctx.store.db.selectFrom('block').select(['addressee_role', 'state']).execute(),
    ).toEqual([{ addressee_role: 'curator', state: 'open' }]);
    await liveSession(ctx.store, 'cur-2', 'cur');
    await ctx.reconcile(later);
    expect((await ctx.rings()).map((ring) => ring.session)).toEqual(['cur-2', 'cur-2']);
  });

  it('rings an orchestrator-role addressee on a task held by a course check', async () => {
    const { store } = await conversationStore();
    stores.push(store);
    await liveSession(store, 'qa-1', 'qa');
    await store.db
      .insertInto('operator_item')
      .values({
        ...sampleRows.operator_item,
        item_key: 'course_check:1',
        kind: 'course_check',
        text: 'course check',
        block_id: null,
        line_outbox_id: null,
      })
      .execute();
    await startConversation(store, board, '@qa o/r#101 status?');
    expect(
      await store.db.selectFrom('block').select(['task_id', 'addressee_role']).execute(),
    ).toEqual([{ task_id: 1, addressee_role: 'worker' }]);
    await reconcileDueDoorbells(store, board, at);
    const rings = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'doorbell')
      .execute();
    expect(rings.map((row) => (JSON.parse(row.payload) as { session: string }).session)).toEqual([
      'qa-1',
    ]);
  });

  it("keeps the operator's removal ring for the addressee until a session appears", async () => {
    const ctx = await conversation(false);
    const ops = createBlockMutations(board);
    const input = { block: 'B1', mode: 'reason', reason: 'Not needed.' } as const;
    await ctx.apply(ops.unblock, input, 'operator', 'unblock');
    await ctx.reconcile();
    expect(await ctx.notices()).toEqual([
      { kind: 'block', role: 'curator', acked_at: CONVERSATION_AT, exhausted_at: null },
      { kind: 'removed', role: 'curator', acked_at: null, exhausted_at: null },
    ]);
    expect(await ctx.rings()).toEqual([]);
    expect(await ctx.kinds()).not.toContain('doorbell_undelivered');
    await liveSession(ctx.store, 'cur-1', 'cur');
    await ctx.reconcile();
    expect(await ctx.rings()).toEqual([
      expect.objectContaining({
        session: 'cur-1',
        text: expect.stringMatching(/block B1 was removed by operator/) as unknown,
      }),
    ]);
  });
});
