import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import type { Gateway } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, enqueueConversationOpen, openStore, type Store } from '../../src/index.ts';
import { clearItem, raiseItem } from '../../src/app/feed.ts';
import { observeGateway } from '../support/observe.ts';
import { sampleRows } from '../store/sample-rows.ts';

const AT = new Date('2026-11-03T10:00:00.000Z');
const KEY = 'o/r#101';
const URL = 'https://github.com/o/r/issues/101';
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'core-feed-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  await store.transaction((trx) =>
    trx
      .insertInto('task')
      .values({
        ...sampleRows.task,
        key: KEY,
        project: 'proj',
        membership: 'active',
        archive_reason: null,
      })
      .execute(),
  );
  const fake = createFakeGateway({ profile: 'slack-like' });
  const observed = observeGateway(fake, file);
  const sender = createSender({
    store,
    gateway: observed.gateway,
    spur: { send: () => Promise.resolve() },
    now: () => AT,
    spaceIntervalMs: 0,
  });
  return { store, file, fake, observed, sender };
}

async function raise(store: Store, kind = 'worker_not_reading', itemKey = 'worker:B1') {
  return store.transaction((trx) =>
    raiseItem(trx, {
      itemKey,
      kind,
      text: 'worker worker-1 is not reading block B1 on o/r#101',
      url: URL,
      taskId: 1,
      blockId: null,
      at: AT,
    }),
  );
}

describe('operator item feed', () => {
  it('writes one linked line with actions and edits it to cleared', async () => {
    const ctx = await setup();
    const item = await raise(ctx.store);
    expect(await raise(ctx.store)).toMatchObject({ id: item.id, raise_no: 1 });
    await ctx.sender.tick();
    expect(ctx.observed.requests).toHaveLength(1);
    expect(ctx.observed.requests[0]).toMatchObject({
      target: { kind: 'open', space: 'feed' },
      actions: [
        { id: `item:${String(item.id)}:retry`, label: 'Retry' },
        { id: `item:${String(item.id)}:close`, label: 'Close' },
      ],
    });
    expect(ctx.observed.requests[0]?.body).toContainEqual({
      kind: 'paragraph',
      children: [{ kind: 'link', url: URL, text: KEY }],
    });
    expect(JSON.stringify(ctx.observed.requests[0]?.body)).not.toContain('mention');
    await ctx.store.transaction((trx) => clearItem(trx, item.id, AT));
    await ctx.sender.tick();
    expect(ctx.observed.requests[1]).toMatchObject({ target: { kind: 'edit' } });
    expect(JSON.stringify(ctx.observed.requests[1]?.body)).toContain('✓ cleared');
    expect(ctx.observed.violations).toEqual([]);
  });

  it('cancels a line cleared before delivery and does not duplicate after restart', async () => {
    const ctx = await setup();
    const item = await raise(ctx.store);
    await ctx.store.transaction((trx) => clearItem(trx, item.id, AT));
    await ctx.sender.tick();
    expect(ctx.observed.requests).toEqual([]);
    const rows = await ctx.store.db.selectFrom('outbox').select(['kind', 'state']).execute();
    expect(rows).toEqual([
      { kind: 'feed.line', state: 'dead' },
      { kind: 'feed.line.edit', state: 'dead' },
    ]);

    const second = await raise(ctx.store, 'review_required', 'review:1');
    await ctx.sender.tick();
    await ctx.store.close();
    const reopened = openStore(ctx.file);
    stores.push(reopened);
    expect(await raise(reopened, 'review_required', 'review:1')).toMatchObject({
      id: second.id,
      raise_no: 1,
    });
    const resumed = createSender({
      store: reopened,
      gateway: ctx.observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => AT,
      spaceIntervalMs: 0,
    });
    await resumed.recover();
    await resumed.tick();
    expect(ctx.observed.requests).toHaveLength(1);
  });

  it.each(['post_failed', 'answer_undelivered', 'transport_health'])(
    'does not enqueue a feed line for %s',
    async (kind) => {
      const ctx = await setup();
      await raise(ctx.store, kind, `failure:${kind}`);
      expect(await ctx.store.db.selectFrom('outbox').select('id').execute()).toEqual([]);
    },
  );

  it('cancels a claimed line when its item clears before send start', async () => {
    const ctx = await setup();
    await ctx.store.transaction(async (trx) => {
      const block = await trx
        .insertInto('block')
        .values({
          task_id: 1,
          type: 'needs_input',
          reason: 'Choose a version',
          author: 'agent:proj/worker-1',
          addressee_role: 'operator',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: AT.toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await enqueueConversationOpen(trx, {
        blockId: block.id,
        commentId: null,
        persona: { name: 'worker', role: 'worker' },
        at: AT,
      });
    });
    const item = await raise(ctx.store);
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway: Gateway = {
      ...ctx.observed.gateway,
      async deliver(request) {
        if (request.target.kind === 'open' && request.target.space === 'orchestrators') {
          entered();
          await held;
        }
        return ctx.observed.gateway.deliver(request);
      },
    };
    const sender = createSender({
      store: ctx.store,
      gateway,
      spur: { send: () => Promise.resolve() },
      now: () => AT,
      spaceIntervalMs: 0,
    });
    const tick = sender.tick();
    await arrived;
    await ctx.store.transaction((trx) => clearItem(trx, item.id, AT));
    release();
    await tick;
    expect(ctx.observed.requests).toHaveLength(1);
    expect(ctx.observed.requests[0]?.target).toMatchObject({
      kind: 'open',
      space: 'orchestrators',
    });
    expect(
      await ctx.store.db
        .selectFrom('outbox')
        .select(['kind', 'state'])
        .where('kind', 'in', ['feed.line', 'feed.line.edit'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { kind: 'feed.line', state: 'dead' },
      { kind: 'feed.line.edit', state: 'dead' },
    ]);
  });

  it('recovers an uncertain line and then edits it after the item clears', async () => {
    const ctx = await setup();
    const item = await raise(ctx.store);
    await ctx.store.transaction(async (trx) => {
      await trx
        .updateTable('outbox')
        .set({ uncertain: 1 })
        .where('id', '=', item.line_outbox_id)
        .execute();
      await clearItem(trx, item.id, AT);
    });
    await ctx.sender.tick();
    await ctx.sender.tick();
    expect(ctx.observed.requests.map((request) => request.target.kind)).toEqual(['open', 'edit']);
    expect(ctx.observed.requests[0]?.maybeSent).toBe(true);
  });
});
