import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockType, RichText } from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, enqueueConversationOpen, openStore, type Store } from '../../src/index.ts';
import { reconcileItems } from '../../src/app/fromYou.ts';
import { observeGateway } from '../support/observe.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { testConfig } from '../support/config.ts';

const AT = new Date('2026-11-03T10:00:00.000Z');
/** Slack's part limit (`MAX_PART_TEXT` in gateway-slack `render.ts`): a longer body splits. */
const SLACK_PART = 2900;
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
  const fake = createFakeGateway({ profile: 'slack-like', maxTextLength: SLACK_PART });
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

type Part = { kind: 'text'; text: string } | 'link';

const ask = (block: string): Part[] => [
  { kind: 'text', text: 'Reply in ' },
  'link',
  { kind: 'text', text: ` to answer it. Close closes ${block} without an answer.` },
];
const see = (block: string): Part[] => [
  { kind: 'text', text: 'See ' },
  'link',
  { kind: 'text', text: `. Close unblocks ${block}.` },
];

describe('operator block feed line', () => {
  // Every operator block line carries a Close warning on the message that holds the Close button.
  it.each([
    { name: 'a question with its thread', type: 'needs_input', thread: true, warning: ask },
    { name: 'a dependency with its thread', type: 'dependency', thread: true, warning: see },
    { name: 'a code block with its thread', type: 'code', thread: true, warning: see },
    {
      name: 'a question too long for one Slack message',
      type: 'needs_input',
      thread: true,
      long: true,
      warning: ask,
    },
    {
      name: 'a question without a thread',
      type: 'needs_input',
      thread: false,
      warning: (block: string): Part[] => [
        { kind: 'text', text: `Close closes ${block} without an answer.` },
      ],
    },
    {
      name: 'a line queued before the upgrade, without a block type or thread',
      type: 'dependency',
      thread: false,
      old: true,
      warning: (block: string): Part[] => [
        { kind: 'text', text: `Close unblocks ${block} without an answer.` },
      ],
    },
  ] as {
    name: string;
    type: BlockType;
    thread: boolean;
    long?: boolean;
    old?: boolean;
    warning: (block: string) => Part[];
  }[])('warns what Close does on $name', async ({ type, thread, long, old, warning }) => {
    const ctx = await setup();
    const reason = long === true ? `Choose a version. ${'Which one? '.repeat(300)}` : 'Choose one';
    const blockId = await scanTransaction(ctx.store, testConfig, async (trx) => {
      const block = await trx
        .insertInto('block')
        .values({
          task_id: 1,
          type,
          reason,
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
      if (thread) {
        await enqueueConversationOpen(trx, {
          blockId: block.id,
          commentId: null,
          persona: { name: 'worker', role: 'worker' },
          at: AT,
        });
      }
      await reconcileItems(trx, testConfig, AT.getTime(), true);
      if (old === true) {
        await trx
          .updateTable('outbox')
          .set({ payload: sql<string>`json_remove(payload, '$.blockType')` })
          .where('kind', '=', 'feed.line')
          .execute();
      }
      return block.id;
    });
    const rows = await ctx.store.db
      .selectFrom('outbox')
      .select(['id', 'kind', 'parent_outbox_id'])
      .where('kind', 'in', ['conversation.open', 'feed.line'])
      .orderBy('id')
      .execute();
    const open = rows.find((row) => row.kind === 'conversation.open');
    expect(rows.find((row) => row.kind === 'feed.line')?.parent_outbox_id).toBe(open?.id ?? null);
    const item = await ctx.store.db
      .selectFrom('operator_item')
      .select(['text', 'block_id'])
      .executeTakeFirstOrThrow();
    expect(item).toEqual({ text: `o/r#101: ${reason}`, block_id: null });
    let now = AT.getTime();
    const sender = createSender({
      config: testConfig,
      store: ctx.store,
      gateway: ctx.observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => new Date(now),
      spaceIntervalMs: 0,
    });
    if (thread) {
      ctx.fake.platform.rateLimitNext(1_000);
      await sender.tick();
      expect(ctx.observed.requests.map((request) => request.target)).toEqual([
        expect.objectContaining({ kind: 'open', space: 'orchestrators' }),
      ]);
      now += 60_000;
      await sender.tick();
    }
    await sender.tick();
    const feedRequests = ctx.observed.requests.filter(
      (request) => request.target.kind === 'open' && request.target.space === 'feed',
    );
    expect(feedRequests).toHaveLength(1);
    let link: { kind: 'link'; url: string; text: string } | undefined;
    const block = `B${String(blockId)}`;
    if (thread) {
      const sent = await ctx.store.db
        .selectFrom('outbox')
        .select('external_ref')
        .where('id', '=', open?.id ?? 0)
        .executeTakeFirstOrThrow();
      const { permalink } = JSON.parse(sent.external_ref ?? '{}') as { permalink: string };
      expect(permalink).toEqual(expect.any(String));
      link = { kind: 'link', url: permalink, text: `the ${block} thread` };
    }
    const parts = warning(block);
    expect(parts.includes('link')).toBe(thread);
    const body = feedRequests[0]?.body ?? [];
    // Right under the key line, so a long reason cannot push it off the first message.
    expect(body[1]).toEqual({
      kind: 'paragraph',
      children: parts.map((part) => (part === 'link' ? link : part)),
    });
    expect(body[2]?.kind).toBe('quote');
    const words = parts.map((part) => (part === 'link' ? (link?.text ?? '') : part.text)).join('');
    // Screen readers and notifications read the message text, which leaves context blocks out.
    expect(messageText(body)).toContain(words);
    const posted = ctx.fake.platform
      .messages()
      .filter((message) => message.marker?.startsWith('feed.line:') === true);
    expect(posted.length > 1).toBe(long === true);
    const main = posted.find((message) => message.root);
    expect(main?.actions.length).toBeGreaterThan(0);
    expect(main?.text).toContain(words);
    expect(ctx.observed.violations).toEqual([]);
  });
});
