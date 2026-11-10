import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  conversationRefSchema,
  inboundEventSchema,
  interactionRefSchema,
  messageRefSchema,
  userIdSchema,
  type ActorId,
  type InboundEvent,
} from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../../cli/src/cli.ts';
import { fingerprint } from '../../src/domain/fromYou.ts';
import { registerBlockNotification } from '../../src/app/doorbells.ts';
import { raiseItem } from '../../src/app/feed.ts';
import { dispatchOperation } from '../../src/app/operations.ts';
import {
  createApiServer,
  createApply,
  createBlockMutations,
  createInbound,
  createOperationRegistry,
  createSender,
  listenApiServer,
  openStore,
  requestToken,
  tickBoard,
  type Inbound,
  type Store,
  reconcileDueDoorbells,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

const START = Date.parse('2026-11-03T10:00:00.000Z');
const KEY = 'o/r#101';
const AGENT = 'agent:web/worker-1' as const;
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
const blocks = createBlockMutations(config);
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup(options: { inbound?: boolean; worker?: boolean } = {}) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-items-')), 'board.db'));
  stores.push(store);
  let now = START;
  const clock = { now: () => now };
  const gateway = createFakeGateway({ profile: 'slack-like', start: new Date(START) });
  const sent: { session: string; text: string }[] = [];
  const iso = new Date(START).toISOString();
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
    if (options.worker !== true) return;
    await trx
      .insertInto('session_snapshot')
      .values({
        ...sampleRows.session_snapshot,
        id: 'worker-1',
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
        id: 1,
        task_id: 1,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        session_id: 'worker-1',
        role: 'worker',
        created_at: iso,
      })
      .execute();
  });
  // The getter reads `inbound` at operation time, after it is built, as the daemon does.
  const registry = createOperationRegistry({
    config,
    clock,
    completeSince: new Map(),
    ...(options.inbound === false ? {} : { reapplyInbound: () => inbound.reapply }),
  });
  const inbound: Inbound = createInbound({ store, gateway, config, clock, registry });
  const apply = createApply({ store, clock, config });
  const sender = createSender({
    store,
    gateway,
    config,
    spur: {
      send(session, text) {
        sent.push({ session, text });
        return Promise.resolve();
      },
    },
    now: () => new Date(now),
  });
  const retry = registry['item.retry'];
  const close = registry['item.close'];
  if (retry === undefined || close === undefined) throw new Error('Item handlers missing');
  return {
    store,
    gateway,
    registry,
    inbound,
    apply,
    sender,
    sent,
    clock,
    retry: (item: string, key?: string, actor: ActorId = 'operator') =>
      apply(retry, { item }, actor, key),
    close: (item: string, key?: string, actor: ActorId = 'operator') =>
      apply(close, { item }, actor, key),
    advance(ms: number) {
      now += ms;
    },
    /** Runs the daemon's doorbell job once, as it runs before a tick. */
    ring: () => reconcileDueDoorbells(store, config, new Date(now)),
    tick: () => tickBoard({ store, config, clock, completeSince: new Map() }),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function raise(
  ctx: Ctx,
  input: { key: string; kind: string; taskId?: number | null; text?: string },
): Promise<number> {
  const item = await scanTransaction(ctx.store, config, (trx) =>
    raiseItem(trx, {
      itemKey: input.key,
      kind: input.kind,
      text: input.text ?? `Item ${input.key}`,
      url: 'https://example.test/item',
      taskId: input.taskId ?? null,
      blockId: null,
      at: new Date(ctx.clock.now()),
    }),
  );
  return item.id;
}

async function item(ctx: Ctx, id: number) {
  return ctx.store.db
    .selectFrom('operator_item')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function storeEvent(ctx: Ctx, event: InboundEvent): Promise<number> {
  const id = await raise(ctx, {
    key: `inbound:failure:${event.dedupeKey}`,
    kind: 'inbound_failure',
  });
  await ctx.store.transaction(async (trx) => {
    await trx
      .updateTable('operator_item')
      .set({ inbound_event_json: JSON.stringify(inboundEventSchema.parse(event)) })
      .where('id', '=', id)
      .execute();
  });
  return id;
}

async function rows(ctx: Ctx, table: 'command' | 'event' | 'outbox' | 'dismissal') {
  return ctx.store.db.selectFrom(table).selectAll().execute();
}

function press(input: {
  key: string;
  actionId: string;
  author?: string;
  sourceSpace?: 'feed' | null;
}): InboundEvent {
  return {
    kind: 'action',
    dedupeKey: input.key,
    interaction: interactionRefSchema.parse(`interaction-${input.key}`),
    actionId: input.actionId,
    author: userIdSchema.parse(input.author ?? 'operator'),
    conversation: conversationRefSchema.parse('feed-thread'),
    message: messageRefSchema.parse('feed-line'),
    rootMessage: messageRefSchema.parse('feed-line'),
    sourceUrl: 'https://example.test/feed',
    sourceSpace: input.sourceSpace === undefined ? 'feed' : input.sourceSpace,
  };
}

/** Raise one exhausted doorbell series: three delivered, unread rings and the pause after. */
async function exhaust(ctx: Ctx, kind: 'block' | 'answer'): Promise<number> {
  if (kind === 'block') {
    await ctx.store.transaction(async (trx) => {
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
    });
  } else {
    const asked = await ctx.apply(blocks.ask, { task: KEY, text: 'Which version?' }, AGENT, 'ask');
    await ctx.apply(blocks.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
  }
  for (const pause of [0, 120_000, 300_000, 900_000]) {
    ctx.advance(pause);
    await ctx.ring();
    await ctx.sender.tick();
  }
  expect(ctx.sent).toHaveLength(3);
  const raised = await ctx.store.db
    .selectFrom('operator_item')
    .select('id')
    .where('kind', '=', kind === 'block' ? 'worker_not_reading' : 'answer_undelivered')
    .executeTakeFirstOrThrow();
  return raised.id;
}

describe('item.retry and item.close', () => {
  it('rejects wrong ID kinds and unknown items', async () => {
    const ctx = await setup();
    const deps = { store: ctx.store, clock: ctx.clock, config, registry: ctx.registry };
    for (const id of ['item.retry', 'item.close'] as const) {
      await expect(dispatchOperation(deps, id, { item: 'B1' }, 'operator')).rejects.toMatchObject({
        code: 'wrong_id_kind',
      });
      await expect(dispatchOperation(deps, id, { item: 'I99' }, 'operator')).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(await rows(ctx, 'command')).toEqual([]);
  });

  it('refuses an agent on task and board-wide items', async () => {
    const ctx = await setup();
    const taskItem = await raise(ctx, { key: 'block:1', kind: 'board_observation', taskId: 1 });
    const boardItem = await raise(ctx, { key: 'source:github', kind: 'board_observation' });
    const before = (await rows(ctx, 'event')).length;
    let calls = 0;
    for (const id of [taskItem, boardItem]) {
      for (const op of [ctx.retry, ctx.close]) {
        calls += 1;
        await expect(op(`I${String(id)}`, `agent-${String(calls)}`, AGENT)).rejects.toMatchObject({
          code: 'forbidden',
        });
        const denied = (await rows(ctx, 'event')).filter(
          (event) => event.kind === 'operation_denied',
        );
        expect(denied).toHaveLength(calls);
      }
      expect((await item(ctx, id)).cleared_at).toBeNull();
    }
    expect((await rows(ctx, 'event')).length).toBe(before + calls);
    expect(await rows(ctx, 'command')).toEqual([]);
    expect(await rows(ctx, 'dismissal')).toEqual([]);
  });

  it('requeues a failed post and delivers it on the next tick', async () => {
    const ctx = await setup();
    await ctx.apply(blocks.ask, { task: KEY, text: 'Which release?' }, AGENT, 'ask-failed');
    ctx.gateway.platform.failNextPermanently({ scope: 'message' });
    await ctx.sender.tick();
    const open = await ctx.store.db
      .selectFrom('outbox')
      .selectAll()
      .where('kind', '=', 'conversation.open')
      .executeTakeFirstOrThrow();
    expect(open.state).toBe('post_failed');
    await ctx.tick();
    const failed = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', '=', `delivery:${String(open.id)}`)
      .executeTakeFirstOrThrow();
    ctx.advance(1000);
    const result = await ctx.retry(`I${String(failed.id)}`, 'retry-post');
    expect(result).toEqual({
      item: { id: `I${String(failed.id)}`, task: null, at: failed.raised_at, summary: failed.text },
    });
    const requeued = await ctx.store.db
      .selectFrom('outbox')
      .selectAll()
      .where('id', '=', open.id)
      .executeTakeFirstOrThrow();
    expect(requeued).toMatchObject({ state: 'pending', first_attempt_at: null });
    expect((await item(ctx, failed.id)).cleared_at).toBe(new Date(ctx.clock.now()).toISOString());
    const cleared = (await rows(ctx, 'event')).filter((event) => event.kind === 'from_you_cleared');
    expect(cleared.map((event) => [event.actor, event.actor_ref])).toEqual([['operator', null]]);
    await ctx.sender.tick();
    expect(
      (
        await ctx.store.db
          .selectFrom('outbox')
          .select('state')
          .where('id', '=', open.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('done');
    await expect(ctx.retry(`I${String(failed.id)}`, 'retry-post-again')).rejects.toMatchObject({
      code: 'retry_not_applicable',
    });
  });

  it('scans a failed post again and keeps a secret unsent on retry and restart', async () => {
    const secret = ['xoxb', '123', 'abc'].join('-');
    for (const path of ['retry', 'recover'] as const) {
      const ctx = await setup();
      await ctx.apply(blocks.ask, { task: KEY, text: 'Which release?' }, AGENT, `ask-${path}`);
      ctx.gateway.platform.failNextPermanently({ scope: 'message' });
      await ctx.sender.tick();
      await ctx.tick();
      const open = await ctx.store.db
        .selectFrom('outbox')
        .selectAll()
        .where('kind', '=', 'conversation.open')
        .executeTakeFirstOrThrow();
      expect(open.state).toBe('post_failed');
      // The stored text now matches a rule, as after a scanner update.
      await ctx.store.transaction((trx) =>
        trx
          .updateTable('outbox')
          .set({ payload: open.payload.replace('Which release?', secret) })
          .where('id', '=', open.id)
          .execute(),
      );
      if (path === 'retry') {
        const failed = await ctx.store.db
          .selectFrom('operator_item')
          .select('id')
          .where('item_key', '=', `delivery:${String(open.id)}`)
          .executeTakeFirstOrThrow();
        await ctx.retry(`I${String(failed.id)}`, 'retry-secret');
        expect((await item(ctx, failed.id)).cleared_at).not.toBeNull();
      } else {
        await ctx.sender.recover();
      }
      const row = await ctx.store.db
        .selectFrom('outbox')
        .selectAll()
        .where('id', '=', open.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe('dead');
      expect(row.last_error).toMatch(/^blocked: looks like a secret/);
      const comment = await ctx.store.db
        .selectFrom('comment')
        .select('delivery_state')
        .executeTakeFirstOrThrow();
      expect(comment.delivery_state).toBe('post_blocked');
      const blocked = await ctx.store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('kind', '=', 'post_blocked')
        .executeTakeFirstOrThrow();
      expect(blocked.text).not.toContain(secret);
      ctx.advance(60_000);
      await ctx.sender.tick();
      expect(ctx.gateway.platform.messages().filter((m) => m.text.includes(secret))).toEqual([]);
    }
  });

  it('recovers a failed backlog larger than one scan transaction allows', async () => {
    const ctx = await setup();
    const secret = ['xoxb', '123', 'abc'].join('-');
    const line = (n: number, text: string) => ({
      ...sampleRows.outbox,
      id: n,
      kind: 'feed.line' as const,
      dedupe_key: `backlog:${String(n)}`,
      // Four distinct strings per row: 1101 rows exceed the 4096-string scan limit together.
      payload: JSON.stringify({
        key: `k-${String(n)}`,
        text,
        title: `title ${String(n)}`,
        persona: { name: 'board', role: 'board' },
        itemKey: `backlog:item:${String(n)}`,
      }),
      state: 'post_failed' as const,
      first_attempt_at: new Date(START).toISOString(),
    });
    await ctx.store.transaction(async (trx) => {
      const backlog = Array.from({ length: 1100 }, (_, i) => line(i + 1, `failed ${String(i)}`));
      for (let i = 0; i < backlog.length; i += 100) {
        await trx
          .insertInto('outbox')
          .values(backlog.slice(i, i + 100))
          .execute();
      }
      await trx
        .insertInto('outbox')
        .values(line(1101, `token ${secret}`))
        .execute();
    });
    await ctx.sender.recover();
    const states = await ctx.store.db
      .selectFrom('outbox')
      .select(['state', (eb) => eb.fn.countAll<number>().as('n')])
      .where('dedupe_key', 'like', 'backlog:%')
      .groupBy('state')
      .orderBy('state')
      .execute();
    expect(states).toEqual([
      { state: 'dead', n: 1 },
      { state: 'pending', n: 1100 },
    ]);
    const blocked = await ctx.store.db
      .selectFrom('outbox')
      .select('last_error')
      .where('id', '=', 1101)
      .executeTakeFirstOrThrow();
    expect(blocked.last_error).toMatch(/^blocked: looks like a secret/);
    expect(
      await ctx.store.db
        .selectFrom('operator_item')
        .select('kind')
        .where('kind', '=', 'post_blocked')
        .execute(),
    ).toHaveLength(1);
  }, 60_000);

  it('closes a failed post so no restart resends it', async () => {
    const ctx = await setup();
    await ctx.apply(blocks.ask, { task: KEY, text: 'Which release?' }, AGENT, 'ask-closed');
    ctx.gateway.platform.failNextPermanently({ scope: 'message' });
    await ctx.sender.tick();
    await ctx.tick();
    const failed = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'like', 'delivery:%')
      .executeTakeFirstOrThrow();
    const outboxId = Number(failed.item_key.slice('delivery:'.length));
    await ctx.close(`I${String(failed.id)}`, 'close-post');
    const row = await ctx.store.db
      .selectFrom('outbox')
      .selectAll()
      .where('id', '=', outboxId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      state: 'dead',
      last_error: `closed by operator (I${String(failed.id)})`,
    });
    await ctx.sender.recover();
    ctx.advance(60_000);
    await ctx.sender.tick();
    await ctx.tick();
    expect(
      (
        await ctx.store.db
          .selectFrom('outbox')
          .select('state')
          .where('id', '=', outboxId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('dead');
    expect(
      ctx.gateway.platform.messages().filter((m) => m.marker?.startsWith('conversation.open')),
    ).toEqual([]);
    expect((await item(ctx, failed.id)).cleared_at).not.toBeNull();
    await expect(ctx.retry(`I${String(failed.id)}`, 'retry-closed')).rejects.toMatchObject({
      code: 'retry_not_applicable',
    });
  });

  it('restarts an exhausted doorbell series once per key', async () => {
    for (const kind of ['block', 'answer'] as const) {
      const ctx = await setup({ worker: true });
      const id = await exhaust(ctx, kind);
      const first = await ctx.retry(`I${String(id)}`, 'retry-bell');
      expect(await ctx.retry(`I${String(id)}`, 'retry-bell')).toEqual(first);
      await expect(ctx.retry('I99', 'retry-bell')).rejects.toMatchObject({
        code: 'idempotency_key_mismatch',
      });
      expect(
        (await rows(ctx, 'command')).filter((row) => row.operation === 'item.retry'),
      ).toHaveLength(1);
      expect(
        await ctx.store.db
          .selectFrom('notification')
          .select(['rings', 'exhausted_at', 'recipient_session'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ rings: 0, exhausted_at: null, recipient_session: 'worker-1' });
      expect((await item(ctx, id)).cleared_at).not.toBeNull();
      await ctx.ring();
      await ctx.sender.tick();
      await ctx.ring();
      await ctx.sender.tick();
      expect(ctx.sent.map((entry) => entry.session)).toEqual([
        'worker-1',
        'worker-1',
        'worker-1',
        'worker-1',
      ]);
      const doorbells = await ctx.store.db
        .selectFrom('outbox')
        .select(['dedupe_key', 'state'])
        .where('kind', '=', 'doorbell')
        .orderBy('id')
        .execute();
      expect(doorbells).toEqual([
        { dedupe_key: 'doorbell:1:worker-1:1', state: 'done' },
        { dedupe_key: 'doorbell:1:worker-1:2', state: 'done' },
        { dedupe_key: 'doorbell:1:worker-1:3', state: 'done' },
        { dedupe_key: 'doorbell:1:worker-1:1:s1', state: 'done' },
      ]);
    }
  });

  it('re-applies stored message, button and command events in the retry transaction', async () => {
    const ctx = await setup();
    const root = messageRefSchema.parse('root-1');
    await ctx.store.transaction(async (trx) => {
      await trx
        .insertInto('block')
        .values({
          task_id: 1,
          type: 'needs_input',
          reason: 'Which way?',
          author: 'system',
          addressee_role: 'operator',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: new Date(START).toISOString(),
        })
        .execute();
      await trx
        .insertInto('conversation')
        .values({
          gateway: ctx.gateway.kind,
          ref: 'thread-1',
          space: 'orchestrators',
          task_id: 1,
          block_id: 1,
          purpose: 'block',
          state: 'open',
          root_message_ref: root,
          after_message_ref: null,
          created_at: new Date(START).toISOString(),
          closed_at: null,
        })
        .execute();
      await trx.updateTable('task').set({ membership: 'archived' }).where('id', '=', 1).execute();
    });
    // (a) A reply to an archived task fails; once the task is active again, retry records it.
    await ctx.inbound.sink({
      kind: 'message',
      dedupeKey: 'reply-1',
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('reply-1'),
      rootMessage: root,
      author: userIdSchema.parse('operator'),
      text: 'Go left.',
      at: new Date(START).toISOString(),
      sourceUrl: 'https://example.test/thread/reply',
    });
    const failure = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('kind', '=', 'inbound_failure')
      .executeTakeFirstOrThrow();
    await expect(ctx.retry(`I${String(failure.id)}`, 'retry-archived')).rejects.toMatchObject({
      code: 'task_archived',
    });
    await ctx.store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'active' }).where('id', '=', 1).execute(),
    );
    await ctx.retry(`I${String(failure.id)}`, 'retry-reply');
    expect(await ctx.store.db.selectFrom('comment').select(['author', 'text']).execute()).toEqual([
      { author: 'operator', text: 'Go left.' },
    ]);
    expect((await rows(ctx, 'command')).map((row) => [row.actor, row.key, row.operation])).toEqual([
      ['operator', 'reply-1', 'inbound.message'],
      ['operator', 'retry-reply', 'item.retry'],
    ]);
    expect((await item(ctx, failure.id)).cleared_at).not.toBeNull();

    // (b) A stored Close press replays under its own key, only when it passed the press gate.
    const target = await raise(ctx, { key: 'inbound:gap:x', kind: 'inbound_gap' });
    for (const [key, author, sourceSpace] of [
      ['press-intruder', 'intruder', 'feed'],
      ['press-outside', 'operator', null],
    ] as const) {
      const gated = await storeEvent(
        ctx,
        press({ key, actionId: `item:${String(target)}:close`, author, sourceSpace }),
      );
      await expect(ctx.retry(`I${String(gated)}`, `retry-${key}`)).rejects.toMatchObject({
        code: 'retry_not_applicable',
      });
      expect((await item(ctx, gated)).cleared_at).toBeNull();
      expect((await item(ctx, target)).cleared_at).toBeNull();
    }
    expect(await rows(ctx, 'dismissal')).toEqual([]);
    const pressed = await storeEvent(
      ctx,
      press({ key: 'press-close', actionId: `item:${String(target)}:close` }),
    );
    await ctx.retry(`I${String(pressed)}`, 'retry-press');
    expect((await item(ctx, target)).cleared_at).not.toBeNull();
    expect((await item(ctx, pressed)).cleared_at).not.toBeNull();
    expect((await rows(ctx, 'dismissal')).map((row) => row.item_key)).toEqual(['inbound:gap:x']);
    expect(
      (await rows(ctx, 'command'))
        .filter((row) => row.key.startsWith('press-') || row.key === 'retry-press')
        .map((row) => [row.key, row.operation]),
    ).toEqual([
      ['press-close', 'item.close'],
      ['retry-press', 'item.retry'],
    ]);

    // (c) A stored status query only clears the item.
    const query = await storeEvent(ctx, {
      kind: 'command',
      dedupeKey: 'status-1',
      interaction: interactionRefSchema.parse('status-1'),
      author: userIdSchema.parse('operator'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: {} },
      sourceUrl: 'https://example.test/command',
      sourceSpace: 'orchestrators',
    });
    await ctx.retry(`I${String(query)}`, 'retry-status');
    expect((await item(ctx, query)).cleared_at).not.toBeNull();
    expect((await rows(ctx, 'command')).some((row) => row.key === 'status-1')).toBe(false);

    // Without Slack inbound there is nothing to re-apply.
    const offline = await setup({ inbound: false });
    const stored = await storeEvent(offline, press({ key: 'press-off', actionId: 'item:1:close' }));
    await expect(offline.retry(`I${String(stored)}`, 'retry-off')).rejects.toMatchObject({
      code: 'retry_not_applicable',
      hint: expect.stringContaining('Slack inbound') as unknown,
    });
  });

  it('replays a stored token press through the token decision', async () => {
    const ctx = await setup();
    await requestToken(
      ctx.store,
      config,
      { name: 'laptop', folder: '/w', host: 'h', hash: 'a'.repeat(64) },
      new Date(START),
    );
    const request = await ctx.store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    const actionId = `token:${String(request.item_id)}:approve`;
    for (const [key, author, sourceSpace] of [
      ['token-intruder', 'intruder', 'feed'],
      ['token-outside', 'operator', null],
    ] as const) {
      const gated = await storeEvent(ctx, press({ key, actionId, author, sourceSpace }));
      await expect(ctx.retry(`I${String(gated)}`, `retry-${key}`)).rejects.toMatchObject({
        code: 'retry_not_applicable',
      });
      expect((await item(ctx, gated)).cleared_at).toBeNull();
    }
    const failure = await storeEvent(ctx, press({ key: 'token-press', actionId }));
    await ctx.retry(`I${String(failure)}`, 'retry-token');
    expect(
      await ctx.store.db.selectFrom('operator_token').select('status').executeTakeFirstOrThrow(),
    ).toEqual({ status: 'approved' });
    expect((await item(ctx, request.item_id)).cleared_at).not.toBeNull();
    expect((await item(ctx, failure)).cleared_at).not.toBeNull();
    expect(
      (await rows(ctx, 'command'))
        .filter((row) => row.key.includes('token'))
        .map((row) => [row.actor, row.key, row.operation]),
    ).toEqual([
      ['operator', 'token-press', 'token.approve'],
      ['operator', 'retry-token', 'item.retry'],
    ]);
  });

  it('refuses to retry a blocked post and points to close', async () => {
    const ctx = await setup();
    await ctx.apply(
      blocks.ask,
      { task: KEY, text: ['xoxb', '123', 'abc'].join('-') },
      AGENT,
      'ask-blocked',
    );
    const blocked = await ctx.store.db
      .selectFrom('operator_item')
      .select('id')
      .where('kind', '=', 'post_blocked')
      .executeTakeFirstOrThrow();
    const outbox = (await rows(ctx, 'outbox')).length;
    const events = (await rows(ctx, 'event')).length;
    await expect(ctx.retry(`I${String(blocked.id)}`, 'retry-blocked')).rejects.toMatchObject({
      code: 'retry_not_applicable',
      hint: expect.stringContaining('close') as unknown,
    });
    expect((await rows(ctx, 'outbox')).length).toBe(outbox);
    expect((await rows(ctx, 'event')).length).toBe(events);
    expect((await item(ctx, blocked.id)).cleared_at).toBeNull();
  });

  it('probes a transport outage now on retry and leaves the item to the sender', async () => {
    const ctx = await setup();
    await ctx.apply(blocks.ask, { task: KEY, text: 'Which release?' }, AGENT, 'ask-transport');
    const revoke = () => {
      ctx.gateway.platform.failNextPermanently({ scope: 'transport', reason: 'token_revoked' });
    };
    revoke();
    await ctx.sender.tick();
    const outage = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', '=', `transport:${ctx.gateway.kind}`)
      .executeTakeFirstOrThrow();
    const attempts = async () =>
      (
        await ctx.store.db
          .selectFrom('outbox')
          .select('attempts')
          .where('kind', '=', 'conversation.open')
          .executeTakeFirstOrThrow()
      ).attempts;
    const health = () => ctx.store.db.selectFrom('transport_health').select('reason').execute();
    const cleared = async () =>
      (await rows(ctx, 'event')).filter((event) => event.kind === 'from_you_cleared');
    ctx.advance(1000);
    await ctx.sender.tick();
    expect(await attempts()).toBe(1);

    // A retry whose probe fails again keeps the item and the row.
    const result = await ctx.retry(`I${String(outage.id)}`, 'retry-transport-1');
    expect(result.item.id).toBe(`I${String(outage.id)}`);
    revoke();
    await ctx.sender.tick();
    expect(await attempts()).toBe(2);
    expect((await item(ctx, outage.id)).cleared_at).toBeNull();
    expect(await health()).toEqual([{ reason: 'token_revoked' }]);
    expect(await cleared()).toEqual([]);

    // A retry whose probe delivers clears the row, and the sender clears the item.
    ctx.advance(1000);
    await ctx.retry(`I${String(outage.id)}`, 'retry-transport-2');
    expect((await item(ctx, outage.id)).cleared_at).toBeNull();
    await ctx.sender.tick();
    expect(await attempts()).toBe(3);
    expect(await health()).toEqual([]);
    expect((await item(ctx, outage.id)).cleared_at).not.toBeNull();
    expect(await cleared()).toHaveLength(1);
  });

  it('refuses retry on a transport item with no recorded outage', async () => {
    const ctx = await setup();
    const id = await raise(ctx, { key: 'transport:slack', kind: 'transport_health' });
    await expect(ctx.retry(`I${String(id)}`, 'retry-transport-none')).rejects.toMatchObject({
      code: 'retry_not_applicable',
    });
    expect((await item(ctx, id)).cleared_at).toBeNull();
  });

  it('refuses kinds without a retry action', async () => {
    const ctx = await setup();
    for (const [key, kind] of [
      ['operator-block:1', 'board_observation'],
      ['inbound:gap:y', 'inbound_gap'],
    ] as const) {
      const id = await raise(ctx, { key, kind, taskId: 1 });
      await expect(ctx.retry(`I${String(id)}`, `retry-${key}`)).rejects.toMatchObject({
        code: 'retry_not_applicable',
      });
      expect((await item(ctx, id)).cleared_at).toBeNull();
    }
  });

  it('refuses retry but allows close on an archived task', async () => {
    const ctx = await setup();
    const id = await raise(ctx, { key: 'block:1', kind: 'board_observation', taskId: 1 });
    await ctx.store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'archived' }).where('id', '=', 1).execute(),
    );
    await expect(ctx.retry(`I${String(id)}`, 'retry-archived')).rejects.toMatchObject({
      code: 'task_archived',
    });
    expect(await ctx.close(`I${String(id)}`, 'close-archived')).toMatchObject({
      item: { id: `I${String(id)}`, task: KEY },
    });
    expect((await item(ctx, id)).cleared_at).not.toBeNull();
  });

  it('closes with a dismissal that hides unchanged facts', async () => {
    const ctx = await setup();
    await ctx.store.transaction((trx) =>
      trx
        .insertInto('source_state')
        .values({
          ...sampleRows.source_state,
          blind_reason: 'auth',
          blind_message: 'Token expired',
        })
        .execute(),
    );
    await ctx.tick();
    const blind = await ctx.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', '=', 'source:github')
      .executeTakeFirstOrThrow();
    expect(blind.fingerprint).not.toBeNull();
    ctx.advance(1000);
    await ctx.close(`I${String(blind.id)}`, 'close-blind');
    expect(await rows(ctx, 'dismissal')).toEqual([
      {
        item_key: 'source:github',
        fingerprint: blind.fingerprint,
        dismissed_by: 'operator',
        dismissed_at: new Date(ctx.clock.now()).toISOString(),
      },
    ]);
    expect((await item(ctx, blind.id)).cleared_at).not.toBeNull();
    ctx.advance(1000);
    await ctx.tick();
    const active = () =>
      ctx.store.db
        .selectFrom('operator_item')
        .select('raise_no')
        .where('item_key', '=', 'source:github')
        .where('cleared_at', 'is', null)
        .execute();
    expect(await active()).toEqual([]);
    await ctx.store.transaction((trx) =>
      trx.updateTable('source_state').set({ blind_message: 'Token revoked' }).execute(),
    );
    await ctx.tick();
    expect(await active()).toEqual([{ raise_no: 2 }]);

    // An event-raised item has no fingerprint; close derives one from the item.
    const gap = await raise(ctx, { key: 'inbound:gap:z', kind: 'inbound_gap', text: 'repeat' });
    await ctx.close(`I${String(gap)}`, 'close-gap');
    const gapRow = await item(ctx, gap);
    const dismissal = await ctx.store.db
      .selectFrom('dismissal')
      .selectAll()
      .where('item_key', '=', 'inbound:gap:z')
      .executeTakeFirstOrThrow();
    expect(dismissal.fingerprint).toBe(
      fingerprint({
        key: 'inbound:gap:z',
        taskId: null,
        summary: 'repeat',
        factAt: null,
        source: gapRow.source,
        priority: 0,
        revision: null,
      }),
    );
    const events = (await rows(ctx, 'event')).length;
    ctx.advance(1000);
    expect(await ctx.close(`I${String(gap)}`, 'close-gap-again')).toEqual({
      item: { id: `I${String(gap)}`, task: null, at: gapRow.raised_at, summary: 'repeat' },
    });
    expect((await rows(ctx, 'event')).length).toBe(events);
    expect(
      await ctx.store.db
        .selectFrom('dismissal')
        .selectAll()
        .where('item_key', '=', 'inbound:gap:z')
        .executeTakeFirstOrThrow(),
    ).toEqual(dismissal);
  });

  it('writes the same journal event from a Slack press and the CLI', async () => {
    const ctx = await setup();
    const pressedId = await raise(ctx, { key: 'inbound:gap:a', kind: 'inbound_gap' });
    const cliId = await raise(ctx, { key: 'inbound:gap:b', kind: 'inbound_gap' });
    await ctx.gateway.start((event) => ctx.inbound.sink(event));
    await ctx.sender.tick();
    ctx.advance(1001);
    await ctx.sender.tick();
    const lines = ctx.gateway.platform.messages();
    expect(lines).toHaveLength(2);
    const line = lines[0];
    if (line === undefined) throw new Error('Missing feed line');
    await ctx.gateway.platform.inject({
      kind: 'action',
      message: line.message,
      actionId: `item:${String(pressedId)}:close`,
      author: userIdSchema.parse('operator'),
    });
    await ctx.gateway.platform.settle();
    expect((await item(ctx, pressedId)).cleared_at).not.toBeNull();

    const app = await createApiServer({
      store: ctx.store,
      config,
      port: 0,
      ready: () => true,
      clock: ctx.clock,
      lookupSession: () => Promise.resolve(null),
      verifyToken: (token) =>
        Promise.resolve(token === 'local-test-token' ? { name: 'local' } : null),
      registry: ctx.registry,
      logRequest: () => {},
    });
    try {
      await listenApiServer(app, 0);
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a port.');
      let stdout = '';
      const io: CliIo = {
        isTTY: false,
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      };
      expect(
        await runCli(['item', 'close', `I${String(cliId)}`, '--key', 'k', '--json'], {
          clientConfig: {
            address: new URL(`http://127.0.0.1:${String(address.port)}`),
            session: undefined,
            token: 'local-test-token',
            connectTimeoutMs: 2_000,
            responseTimeoutMs: 2_000,
          },
          io,
        }),
      ).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ item: { id: `I${String(cliId)}` } });
    } finally {
      await app.close();
      await ctx.gateway.stop();
    }
    const cleared = (await rows(ctx, 'event')).filter((event) => event.kind === 'from_you_cleared');
    expect(
      cleared.map((event) => [JSON.parse(event.payload) as unknown, event.actor, event.actor_ref]),
    ).toEqual([
      [{ item: `I${String(pressedId)}` }, 'operator', null],
      [{ item: `I${String(cliId)}` }, 'operator', null],
    ]);
    expect((await rows(ctx, 'command')).map((row) => [row.operation, row.actor])).toEqual([
      ['item.close', 'operator'],
      ['item.close', 'operator'],
    ]);
  });
});
