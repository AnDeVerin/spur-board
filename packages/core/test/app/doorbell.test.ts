import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createBlockMutations,
  createSender,
  openStore,
  type Store,
} from '../../src/index.ts';
import { registerBlockNotification } from '../../src/app/doorbells.ts';
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
  options: { author?: 'waiting' | 'ended'; replacement?: boolean; tester?: boolean } = {},
) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-doorbell-')), 'board.db'));
  stores.push(store);
  let now = START;
  let failNext = false;
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
  const apply = createApply({ store, clock: { now: () => now }, config });
  const sender = createSender({
    store,
    config,
    spur: {
      send(session, text) {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('spur send failed'));
        }
        sent.push({ session, text });
        return Promise.resolve();
      },
    },
    now: () => new Date(now),
  });
  return {
    store,
    apply,
    sender,
    sent,
    advance(ms: number) {
      now += ms;
    },
    failNext() {
      failNext = true;
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
  it('rings the live author for an answer, then a replacement worker if the author ended', async () => {
    const live = await setup({ replacement: true, tester: true });
    const asked = await live.apply(
      ops.ask,
      { task: KEY, text: 'Which version?' },
      'agent:web/worker-1',
      'ask-live',
    );
    await live.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator');
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
    await ctx.sender.tick();
    expect(ctx.sent.map((entry) => entry.session)).toEqual(['worker-2']);
  });

  it('pauses while working, then raises one worker refusal after three distinct unanswered rings', async () => {
    const ctx = await setup();
    const blockId = await workerBlock(ctx.store);
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
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(1);
    await ctx.store.transaction((trx) =>
      trx
        .updateTable('session_snapshot')
        .set({ state: 'waiting' })
        .where('id', '=', 'worker-1')
        .execute(),
    );
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(300_000);
    await ctx.sender.tick();
    expect(ctx.sent).toHaveLength(3);
    expect(new Set(ctx.sent.map((entry) => entry.text)).size).toBe(3);
    ctx.advance(900_000);
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
      await ctx.sender.tick();
    }
    expect(ctx.sent).toHaveLength(3);
    ctx.advance(900_000);
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
  });

  it('does not count a transport retry as another semantic ring', async () => {
    const ctx = await setup();
    await workerBlock(ctx.store);
    ctx.failNext();
    await ctx.sender.tick();
    expect(
      await ctx.store.db.selectFrom('notification').select('rings').executeTakeFirst(),
    ).toEqual({ rings: 0 });
    ctx.advance(1000);
    await ctx.sender.tick();
    expect(
      await ctx.store.db.selectFrom('notification').select('rings').executeTakeFirst(),
    ).toEqual({ rings: 1 });
    expect(
      await ctx.store.db.selectFrom('outbox').select(['attempts', 'state']).executeTakeFirst(),
    ).toEqual({ attempts: 2, state: 'done' });
    expect(ctx.sent).toHaveLength(1);
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
});
