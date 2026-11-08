import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import type { Config, Gateway } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, enqueueConversationOpen, openStore, type Store } from '../../src/index.ts';
import { clearItem, raiseItem } from '../../src/app/feed.ts';
import { observeGateway } from '../support/observe.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { testConfig } from '../support/config.ts';

const AT = new Date('2026-11-03T10:00:00.000Z');
const KEY = 'o/r#101';
const URL = 'https://github.com/o/r/issues/101';
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup(config: Config = testConfig) {
  const file = join(mkdtempSync(join(tmpdir(), 'core-feed-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  await scanTransaction(store, testConfig, (trx) =>
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
    config,
    store,
    gateway: observed.gateway,
    spur: { send: () => Promise.resolve() },
    now: () => AT,
    spaceIntervalMs: 0,
  });
  return { store, file, fake, observed, sender };
}

const TEXT = 'worker worker-1 is not reading block B1 on o/r#101';

async function raise(
  store: Store,
  kind = 'worker_not_reading',
  itemKey = 'worker:B1',
  text = TEXT,
) {
  return scanTransaction(store, testConfig, (trx) =>
    raiseItem(trx, {
      itemKey,
      kind,
      text,
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
    await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT));
    await ctx.sender.tick();
    expect(ctx.observed.requests[1]).toMatchObject({ target: { kind: 'edit' } });
    expect(ctx.observed.requests[1]?.body).toEqual([
      { kind: 'paragraph', children: [{ kind: 'link', url: URL, text: KEY }] },
      { kind: 'quote', children: [{ kind: 'strike', text: TEXT }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: '✓ Resolved: condition ended' }] },
    ]);
    expect(ctx.observed.requests[1]?.actions).toBeUndefined();
    expect(ctx.observed.violations).toEqual([]);
  });

  it.each([
    ['UTC', '10:00'],
    ['Europe/Berlin', '11:00'],
  ])('names the operator and the time in %s when the operator closes it', async (tz, time) => {
    const ctx = await setup({ ...testConfig, digest: { ...testConfig.digest, tz } });
    const item = await raise(ctx.store);
    await ctx.sender.tick();
    await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT, 'operator'));
    await ctx.sender.tick();
    expect(ctx.observed.requests[1]?.body.at(-1)).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: '✓ Resolved by ' },
        { kind: 'mention', user: 'operator' },
        { kind: 'text', text: ` at ${time}` },
      ],
    });
  });

  it.each(['worker_not_reading', 'review_required'])(
    'edits a cleared %s line to the same resolved shape',
    async (kind) => {
      const ctx = await setup();
      const item = await raise(ctx.store, kind, `${kind}:1`);
      await ctx.sender.tick();
      await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT));
      await ctx.sender.tick();
      expect(ctx.observed.requests[1]).toMatchObject({ target: { kind: 'edit' } });
      expect(ctx.observed.requests[1]?.body).toEqual([
        { kind: 'paragraph', children: [{ kind: 'link', url: URL, text: KEY }] },
        { kind: 'quote', children: [{ kind: 'strike', text: TEXT }] },
        { kind: 'paragraph', children: [{ kind: 'text', text: '✓ Resolved: condition ended' }] },
      ]);
      expect(ctx.observed.requests[1]?.actions).toBeUndefined();
    },
  );

  it('caps a long summary in the edit so it stays one part', async () => {
    const ctx = await setup();
    const item = await raise(ctx.store, 'worker_not_reading', 'worker:long', 'x'.repeat(3000));
    await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT));
    const edit = await ctx.store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line.edit')
      .executeTakeFirstOrThrow();
    const { text } = JSON.parse(edit.payload) as { text: string };
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('…')).toBe(true);
  });

  it('names the agent session and the time when an agent closes it', async () => {
    const ctx = await setup();
    const item = await raise(ctx.store);
    await ctx.sender.tick();
    await scanTransaction(ctx.store, testConfig, (trx) =>
      clearItem(trx, item.id, AT, 'agent:proj/worker-1'),
    );
    await ctx.sender.tick();
    expect(ctx.observed.requests[1]?.body.at(-1)).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: '✓ Resolved by ' },
        { kind: 'text', text: 'proj/worker-1' },
        { kind: 'text', text: ' at 10:00' },
      ],
    });
  });

  it('caps a long summary by code points so an emoji at the cut stays whole', async () => {
    const ctx = await setup();
    const long = `${'x'.repeat(498)}😀${'y'.repeat(100)}`;
    const item = await raise(ctx.store, 'worker_not_reading', 'worker:emoji', long);
    await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT));
    const edit = await ctx.store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line.edit')
      .executeTakeFirstOrThrow();
    const { text } = JSON.parse(edit.payload) as { text: string };
    expect(text).toBe(`${'x'.repeat(498)}😀…`);
  });

  it('cancels a line cleared before delivery and does not duplicate after restart', async () => {
    const ctx = await setup();
    const item = await raise(ctx.store);
    await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT));
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
      config: testConfig,
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

  it.each([
    ['a doorbell kind', 'worker_not_reading', 'worker_not_reading:block:1', ['retry', 'close']],
    ['an inbound failure', 'inbound_failure', 'inbound:failure:x', ['retry', 'close']],
    ['a failed post', 'board_observation', 'delivery:7', ['retry', 'close']],
    ['a blocked post', 'post_blocked', 'secret-post:abc', ['close']],
    ['another observation', 'board_observation', 'block:1', ['close']],
    ['an inbound gap', 'inbound_gap', 'inbound:gap:x', ['close']],
    ['a token request', 'token_request', 'token:1', ['approve', 'deny', 'close']],
  ])('gives %s line its item buttons', async (_name, kind, itemKey, verbs) => {
    const ctx = await setup();
    const item = await raise(ctx.store, kind, itemKey);
    const line = await ctx.store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line')
      .executeTakeFirstOrThrow();
    const actions = (JSON.parse(line.payload) as { actions: { id: string }[] }).actions;
    expect(actions.map((action) => action.id)).toEqual(
      verbs.map((verb) =>
        verb === 'approve' || verb === 'deny'
          ? `token:${String(item.id)}:${verb}`
          : `item:${String(item.id)}:${verb}`,
      ),
    );
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
    await scanTransaction(ctx.store, testConfig, async (trx) => {
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
      config: testConfig,
      store: ctx.store,
      gateway,
      spur: { send: () => Promise.resolve() },
      now: () => AT,
      spaceIntervalMs: 0,
    });
    const tick = sender.tick();
    await arrived;
    await scanTransaction(ctx.store, testConfig, (trx) => clearItem(trx, item.id, AT));
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
    await scanTransaction(ctx.store, testConfig, async (trx) => {
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
