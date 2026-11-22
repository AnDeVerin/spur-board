import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RichText } from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, enqueueConversationOpen, openStore, type Store } from '../../src/index.ts';
import { reconcileItems } from '../../src/app/fromYou.ts';
import { observeGateway } from '../support/observe.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { testConfig } from '../support/config.ts';

const AT = new Date('2026-11-03T10:00:00.000Z');
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'core-feed-block-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  await scanTransaction(store, testConfig, (trx) =>
    trx
      .insertInto('task')
      .values({
        ...sampleRows.task,
        key: 'o/r#101',
        project: 'proj',
        membership: 'active',
        archive_reason: null,
      })
      .execute(),
  );
  const fake = createFakeGateway({ profile: 'slack-like' });
  const observed = observeGateway(fake, file);
  return { store, fake, observed };
}

/**
 * A message's accessible text: Slack moves trailing context blocks out of the top-level `text`
 * that screen readers and notifications read (`splitContext` in gateway-slack `render.ts`).
 */
function messageText(body: RichText): string {
  let end = body.length;
  while (end > 0 && body[end - 1]?.kind === 'context') end--;
  return body
    .slice(0, end)
    .map((block) =>
      block.kind === 'code_block'
        ? block.text
        : block.children.map((part) => (part.kind === 'mention' ? part.user : part.text)).join(''),
    )
    .join('\n\n');
}

describe('operator block feed line', () => {
  it.each([
    {
      type: 'needs_input' as const,
      hint: (block: string) => [
        { kind: 'text', text: 'Reply in ' },
        'link',
        { kind: 'text', text: ` to answer it. Close closes ${block} without an answer.` },
      ],
    },
    {
      type: 'dependency' as const,
      hint: (block: string) => [
        { kind: 'text', text: 'See ' },
        'link',
        { kind: 'text', text: `. Close unblocks ${block}.` },
      ],
    },
    {
      type: 'code' as const,
      hint: (block: string) => [
        { kind: 'text', text: 'See ' },
        'link',
        { kind: 'text', text: `. Close unblocks ${block}.` },
      ],
    },
  ])(
    'holds a $type operator block line until its thread is out and links it',
    async ({ type, hint }) => {
      const ctx = await setup();
      const blockId = await scanTransaction(ctx.store, testConfig, async (trx) => {
        const block = await trx
          .insertInto('block')
          .values({
            task_id: 1,
            type,
            reason: 'Choose a version',
            author: 'agent:web/worker-1',
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
        await reconcileItems(trx, testConfig, AT.getTime(), true);
        return block.id;
      });
      const rows = await ctx.store.db
        .selectFrom('outbox')
        .select(['id', 'kind', 'parent_outbox_id'])
        .where('kind', 'in', ['conversation.open', 'feed.line'])
        .orderBy('id')
        .execute();
      const open = rows.find((row) => row.kind === 'conversation.open');
      expect(rows.find((row) => row.kind === 'feed.line')?.parent_outbox_id).toBe(open?.id);
      let now = AT.getTime();
      const sender = createSender({
        config: testConfig,
        store: ctx.store,
        gateway: ctx.observed.gateway,
        spur: { send: () => Promise.resolve() },
        now: () => new Date(now),
        spaceIntervalMs: 0,
      });
      ctx.fake.platform.rateLimitNext(1_000);
      await sender.tick();
      expect(ctx.observed.requests.map((request) => request.target)).toEqual([
        expect.objectContaining({ kind: 'open', space: 'orchestrators' }),
      ]);
      now += 60_000;
      await sender.tick();
      await sender.tick();
      expect(ctx.observed.requests.map((request) => request.target)).toEqual([
        expect.objectContaining({ kind: 'open', space: 'orchestrators' }),
        expect.objectContaining({ kind: 'open', space: 'orchestrators' }),
        expect.objectContaining({ kind: 'open', space: 'feed' }),
      ]);
      const thread = await ctx.store.db
        .selectFrom('outbox')
        .select('external_ref')
        .where('id', '=', open?.id ?? 0)
        .executeTakeFirstOrThrow();
      const { permalink } = JSON.parse(thread.external_ref ?? '{}') as { permalink: string };
      expect(permalink).toEqual(expect.any(String));
      const block = `B${String(blockId)}`;
      const link = { kind: 'link', url: permalink, text: `the ${block} thread` };
      const body = ctx.observed.requests[2]?.body ?? [];
      // Screen readers and notifications read the message text, which leaves context blocks out.
      const words = hint(block)
        .map((part) => (typeof part === 'string' ? link.text : part.text))
        .join('');
      expect(messageText(body)).toContain(words);
      expect(body.at(-1)).toEqual({
        kind: 'paragraph',
        children: hint(block).map((part) => (part === 'link' ? link : part)),
      });
      expect(ctx.observed.violations).toEqual([]);
    },
  );
});
