import { scanTransaction } from '../../src/app/secrets.ts';
import {
  clearItem as clearOperatorItem,
  raiseItem as raiseOperatorItem,
} from '../../src/app/feed.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESERVED_PROJECT,
  configSchema,
  ERRORS,
  OPERATIONS,
  conversationRefSchema,
  interactionRefSchema,
  messageRefSchema,
  userIdSchema,
  type ActorId,
  type Gateway,
  type InboundEvent,
} from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInbound,
  createSender,
  enqueueConversationOpen,
  getOperatorItem,
  openStore,
  purgeExpiredCommands,
  type OperationRegistry,
  type Store,
  reconcileDueDoorbells,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import {
  purgeEndedTokenRequests,
  requestToken,
  verifyOperatorToken,
} from '../../src/app/tokens.ts';
import { renderBody } from '../../src/app/outbox.ts';
import { renderedLength } from '../support/rendered.ts';
import { sql } from 'kysely';

const DAY_MS = 86_400_000;
const now = Date.parse('2026-11-03T10:00:00.000Z');
const DAY = 86_400_000;
const at = new Date(now).toISOString();
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
const stores: Store[] = [];
function emptyStatus() {
  return {
    tasks: [],
    items: [],
    unlinkedPrs: [],
    unlinkedSessions: [],
    hiddenUnlinkedPrs: 0,
    hiddenUnlinkedSessions: 0,
    sources: [],
    warmingUp: true,
    spurUnavailable: null,
    hostLoad: null,
    transport: [],
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup(author: ActorId = 'system') {
  const file = join(mkdtempSync(join(tmpdir(), 'core-inbound-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  const gateway = createFakeGateway({ profile: 'slack-like', start: new Date(now) });
  const conversation = conversationRefSchema.parse('thread-1');
  const root = messageRefSchema.parse('root-1');
  await scanTransaction(store, config, async (trx) => {
    await trx
      .insertInto('task')
      .values({
        project: 'proj',
        tracker_kind: 'github-issues',
        tracker_id: '101',
        key: 'o/r#101',
        membership: 'active',
        archive_reason: null,
        column: 'dev',
        shadow_column: null,
        created_at: at,
      })
      .execute();
    await trx
      .insertInto('block')
      .values({
        task_id: 1,
        type: 'needs_input',
        reason: 'Which way?',
        author,
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
      .execute();
    await trx
      .insertInto('conversation')
      .values({
        gateway: gateway.kind,
        ref: conversation,
        space: 'orchestrators',
        task_id: 1,
        block_id: 1,
        purpose: 'block',
        state: 'open',
        root_message_ref: root,
        after_message_ref: null,
        created_at: at,
        closed_at: null,
      })
      .execute();
  });
  return {
    store,
    file,
    gateway,
    conversation,
    root,
    inbound: createInbound({ store, gateway, config, clock: { now: () => now } }),
  };
}

function message(input: {
  conversation: string;
  root: string;
  key?: string;
  author?: string;
  ref?: string;
  text?: string;
}): Extract<InboundEvent, { kind: 'message' }> {
  return {
    kind: 'message',
    dedupeKey: input.key ?? 'message-1',
    conversation: conversationRefSchema.parse(input.conversation),
    message: messageRefSchema.parse(input.ref ?? 'reply-1'),
    rootMessage: messageRefSchema.parse(input.root),
    sourceUrl: 'https://example.test/thread/reply',
    author: userIdSchema.parse(input.author ?? 'operator'),
    text: input.text ?? 'Yes',
    at,
  };
}

describe('inbound apply', () => {
  it('answers only its block once and keeps later replies as clarifications', async () => {
    const { store, inbound } = await setup();
    const first = message({ conversation: 'thread-1', root: 'root-1' });
    await inbound.sink(first);
    await inbound.sink(first);
    await inbound.sink(
      message({
        conversation: 'thread-1',
        root: 'root-1',
        key: 'message-2',
        ref: 'reply-2',
        text: 'More detail',
      }),
    );
    expect(
      await store.db.selectFrom('comment').select(['text', 'conversation_ref']).execute(),
    ).toEqual([
      { text: 'Yes', conversation_ref: 'thread-1' },
      { text: 'More detail', conversation_ref: 'thread-1' },
    ]);
    expect(
      await store.db
        .selectFrom('block')
        .select(['state', 'outcome'])
        .where('id', '=', 1)
        .executeTakeFirst(),
    ).toEqual({ state: 'unblocked', outcome: 'done' });
    expect(
      await store.db
        .selectFrom('conversation')
        .select(['state', 'after_message_ref'])
        .where('ref', '=', 'thread-1')
        .executeTakeFirst(),
    ).toEqual({ state: 'closed', after_message_ref: 'reply-2' });
    expect(
      await store.db
        .selectFrom('outbox')
        .select('kind')
        .where('kind', '=', 'conversation.close')
        .execute(),
    ).toHaveLength(1);
  });

  it('journals non-operator input without changing the block', async () => {
    const { store, inbound } = await setup();
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1', author: 'another' }));
    expect(await store.db.selectFrom('comment').select('id').execute()).toEqual([]);
    expect(await store.db.selectFrom('event').select('kind').execute()).toEqual([
      { kind: 'operation_denied' },
    ]);
    expect(
      await store.db.selectFrom('block').select('state').where('id', '=', 1).executeTakeFirst(),
    ).toEqual({ state: 'open' });
  });

  it('lets only the configured feed user decide a token and replays duplicate delivery', async () => {
    const { store, gateway } = await setup();
    await requestToken(
      store,
      config,
      { name: 'desk', folder: 'workspace/desk', host: 'local', hash: 'a'.repeat(64) },
      new Date(now),
    );
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    const line = await store.db.selectFrom('outbox').select('payload').executeTakeFirstOrThrow();
    expect(line.payload).toContain(`token:${String(row.item_id)}:approve`);
    expect(line.payload).toContain(`token:${String(row.item_id)}:deny`);
    const responses: string[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          expect(options.private).toBe(true);
          responses.push(
            body[0]?.kind === 'paragraph'
              ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
              : '',
          );
          return Promise.resolve('sent' as const);
        },
      },
    });
    const action = (author: string, dedupeKey: string, sourceSpace: 'feed' | 'orchestrators') => ({
      kind: 'action' as const,
      dedupeKey,
      interaction: interactionRefSchema.parse(`interaction-${dedupeKey}`),
      actionId: `token:${String(row.item_id)}:approve`,
      author: userIdSchema.parse(author),
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('root-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/board',
      sourceSpace,
    });
    await inbound.sink(action('another', 'foreign', 'feed'));
    expect(await store.db.selectFrom('operator_token').select('status').executeTakeFirst()).toEqual(
      { status: 'pending' },
    );
    await inbound.sink(action('operator', 'wrong-space', 'orchestrators'));
    expect(await store.db.selectFrom('operator_token').select('status').executeTakeFirst()).toEqual(
      { status: 'pending' },
    );
    await inbound.sink(action('operator', 'approved', 'feed'));
    await inbound.sink(action('operator', 'approved', 'feed'));
    expect(await store.db.selectFrom('operator_token').select('status').executeTakeFirst()).toEqual(
      { status: 'approved' },
    );
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_approved')
        .execute(),
    ).toHaveLength(1);
    expect(
      await store.db
        .selectFrom('event')
        .select(['kind', 'request_id'])
        .where('kind', 'in', ['token_requested', 'token_approved', 'operation_denied'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { kind: 'token_requested', request_id: null },
      { kind: 'operation_denied', request_id: 'foreign' },
      { kind: 'token_approved', request_id: 'approved' },
    ]);
    expect(responses).toEqual(['not allowed', 'not allowed', 'desk: approved', 'desk: approved']);
  });

  it('answers a press on a purged token request with not found, records no failure and no command', async () => {
    const { store, gateway } = await setup();
    await requestToken(
      store,
      config,
      { name: 'desk', folder: 'workspace/desk', host: 'local', hash: 'a'.repeat(64) },
      new Date(now),
    );
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    let t = now;
    const responses: string[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => t },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          expect(options.private).toBe(true);
          responses.push(
            body[0]?.kind === 'paragraph'
              ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
              : '',
          );
          return Promise.resolve('sent' as const);
        },
      },
    });
    const action = (decision: 'approve' | 'deny', dedupeKey: string) => ({
      kind: 'action' as const,
      dedupeKey,
      interaction: interactionRefSchema.parse(`interaction-${dedupeKey}`),
      actionId: `token:${String(row.item_id)}:${decision}`,
      author: userIdSchema.parse('operator'),
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('root-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/board',
      sourceSpace: 'feed' as const,
    });
    await inbound.sink(action('deny', 'denied'));
    expect(await store.db.selectFrom('operator_token').select('status').executeTakeFirst()).toEqual(
      { status: 'denied' },
    );
    expect(await purgeEndedTokenRequests(store, new Date(now + 7 * DAY_MS + 1))).toBe(1);

    t = now + 7 * DAY_MS + 2;
    await inbound.sink(action('approve', 'stale'));

    expect(responses.at(-1)).toBe('Token request was not found.');
    expect(
      await store.db
        .selectFrom('operator_item')
        .select('item_key')
        .where('item_key', 'like', 'inbound:failure:%')
        .execute(),
    ).toEqual([]);
    expect(
      (await store.db.selectFrom('command').select('key').orderBy('key').execute()).map(
        (command) => command.key,
      ),
    ).toEqual(['denied']);
    expect(
      (
        await store.db
          .selectFrom('event')
          .select('kind')
          .where('kind', 'like', 'token_%')
          .orderBy('id')
          .execute()
      ).map((event) => event.kind),
    ).toEqual(['token_requested', 'token_denied']);
    expect(await store.db.selectFrom('operator_token').select('id').execute()).toEqual([]);
  });

  it('journals unknown conversations and privately denies non-operator commands and buttons', async () => {
    const { store, gateway } = await setup();
    const responses: { text: string; private: boolean }[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          responses.push({
            text:
              body[0]?.kind === 'paragraph'
                ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
                : '',
            private: options.private,
          });
          return Promise.resolve('sent' as const);
        },
      },
    });
    await inbound.sink(message({ conversation: 'unknown', root: 'unknown-root' }));
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'foreign-command',
      interaction: interactionRefSchema.parse('interaction-1'),
      author: userIdSchema.parse('another'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: {} },
      sourceUrl: 'https://example.test/board',
      sourceSpace: 'orchestrators',
    });
    await inbound.sink({
      kind: 'action',
      dedupeKey: 'foreign-action',
      interaction: interactionRefSchema.parse('interaction-2'),
      actionId: 'item.close:I1',
      author: userIdSchema.parse('another'),
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('root-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/board',
      sourceSpace: 'feed',
    });
    expect(
      await store.db
        .selectFrom('event')
        .select(['kind', 'project', 'task_id', 'actor', 'request_id'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      {
        kind: 'inbound_skipped',
        project: RESERVED_PROJECT,
        task_id: null,
        actor: 'operator',
        request_id: 'message-1',
      },
      {
        kind: 'operation_denied',
        project: RESERVED_PROJECT,
        task_id: null,
        actor: 'system',
        request_id: 'foreign-command',
      },
      {
        kind: 'operation_denied',
        project: 'proj',
        task_id: 1,
        actor: 'system',
        request_id: 'foreign-action',
      },
    ]);
    const skipped = await store.db
      .selectFrom('event')
      .select('payload')
      .where('kind', '=', 'inbound_skipped')
      .executeTakeFirstOrThrow();
    const skippedPayload = JSON.parse(skipped.payload) as Record<string, unknown>;
    expect(skippedPayload).toMatchObject({
      gateway: gateway.kind,
      reason: 'Unknown board conversation.',
    });
    expect(skippedPayload).not.toHaveProperty('operation');
    expect(await store.db.selectFrom('comment').select('id').execute()).toEqual([]);
    expect(
      await store.db.selectFrom('block').select('state').where('id', '=', 1).executeTakeFirst(),
    ).toEqual({ state: 'open' });
    expect(responses).toEqual([
      { text: 'not allowed', private: true },
      { text: 'not allowed', private: true },
    ]);
  });

  it('privately denies operator interactions outside their configured board spaces', async () => {
    const { store, gateway } = await setup();
    const responses: { text: string; private: boolean }[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          responses.push({
            text:
              body[0]?.kind === 'paragraph'
                ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
                : '',
            private: options.private,
          });
          return Promise.resolve('sent' as const);
        },
      },
    });
    await inbound.sink({ kind: 'gap', dedupeKey: 'gap-for-space' });
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'wrong-command',
      interaction: interactionRefSchema.parse('wrong-command'),
      author: userIdSchema.parse('operator'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: {} },
      sourceUrl: 'https://example.test/other',
      sourceSpace: null,
    });
    for (const space of [null, 'orchestrators'] as const) {
      await inbound.sink({
        kind: 'action',
        dedupeKey: `wrong-action-${String(space)}`,
        interaction: interactionRefSchema.parse(`wrong-action-${String(space)}`),
        actionId: 'item.close:I1',
        author: userIdSchema.parse('operator'),
        conversation: conversationRefSchema.parse('thread-1'),
        message: messageRefSchema.parse('root-1'),
        rootMessage: messageRefSchema.parse('root-1'),
        sourceUrl: 'https://example.test/other',
        sourceSpace: space,
      });
    }
    expect((await getOperatorItem(store, 1))?.cleared_at).toBeNull();
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'operation_denied')
        .execute(),
    ).toHaveLength(1);
    expect(responses).toEqual([
      { text: 'not available yet', private: true },
      { text: 'not allowed', private: true },
      { text: 'not available yet', private: true },
    ]);
  });

  it('registers a second thread with a recovery cutoff before downtime replies', async () => {
    const { store, gateway } = await setup();
    const later = now + 60 * 60 * 1000;
    let recoverySince: Date | undefined;
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => later },
      gateway: {
        ...gateway,
        recover(options) {
          recoverySince = options.since;
          return gateway.recover(options);
        },
      },
    });
    await scanTransaction(store, config, async (trx) => {
      await trx
        .updateTable('conversation')
        .set({ created_at: new Date(later).toISOString() })
        .where('ref', '=', 'thread-1')
        .execute();
      await trx
        .insertInto('comment')
        .values({
          task_id: 1,
          block_id: 1,
          author: 'system',
          text: 'Which way?',
          conversation_ref: null,
          message_ref: null,
          acked_revision: null,
          created_at: at,
          delivery_state: null,
        })
        .execute();
      await enqueueConversationOpen(trx, {
        blockId: 1,
        commentId: 1,
        persona: { name: 'board', role: 'board' },
        at: new Date(now),
      });
    });
    const open = await store.db
      .selectFrom('outbox')
      .select('dedupe_key')
      .where('kind', '=', 'conversation.open')
      .executeTakeFirstOrThrow();
    const second = message({ conversation: 'thread-2', root: 'root-2', key: 'second-thread' });
    await inbound.sink({ ...second, originKey: open.dedupe_key });
    await inbound.recover();
    expect(recoverySince?.toISOString()).toBe(at);
    expect(
      await store.db
        .selectFrom('conversation')
        .select(['ref', 'block_id', 'created_at'])
        .orderBy('ref')
        .execute(),
    ).toEqual([
      { ref: 'thread-1', block_id: 1, created_at: new Date(later).toISOString() },
      { ref: 'thread-2', block_id: 1, created_at: at },
    ]);
    expect(
      await store.db
        .selectFrom('comment')
        .select(['text', 'conversation_ref'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { text: 'Which way?', conversation_ref: null },
      { text: 'Yes', conversation_ref: 'thread-2' },
    ]);
    expect(
      await store.db
        .selectFrom('block')
        .select(['state', 'outcome'])
        .where('id', '=', 1)
        .executeTakeFirst(),
    ).toEqual({ state: 'unblocked', outcome: 'done' });
  });

  it('records operator edits and journal-only deletion', async () => {
    const { store, inbound } = await setup();
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    await inbound.sink({
      ...message({ conversation: 'thread-1', root: 'root-1', key: 'edit-1' }),
      kind: 'message_edited',
      text: 'Revised',
    });
    await inbound.sink({
      kind: 'message_deleted',
      dedupeKey: 'delete-1',
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('reply-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/thread/reply',
    });
    expect(
      await store.db.selectFrom('comment').select(['text', 'revision']).executeTakeFirst(),
    ).toEqual({ text: 'Revised', revision: 2 });
    expect(
      (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind),
    ).toContain('comment_deleted');
    await scanTransaction(store, config, (trx) =>
      trx
        .insertInto('comment')
        .values({
          task_id: 1,
          block_id: 1,
          author: 'system',
          text: 'System note',
          conversation_ref: 'thread-1',
          message_ref: 'system-message',
          acked_revision: null,
          created_at: at,
          delivery_state: null,
        })
        .execute(),
    );
    for (const [key, ref] of [
      ['delete-unknown', 'unknown-message'],
      ['delete-system', 'system-message'],
    ] as const) {
      await inbound.sink({
        kind: 'message_deleted',
        dedupeKey: key,
        conversation: conversationRefSchema.parse('thread-1'),
        message: messageRefSchema.parse(ref),
        rootMessage: messageRefSchema.parse('root-1'),
        sourceUrl: 'https://example.test/thread/reply',
      });
    }
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'comment_deleted')
        .execute(),
    ).toHaveLength(1);
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'operation_denied')
        .execute(),
    ).toHaveLength(0);
    const skipped = await store.db
      .selectFrom('event')
      .select(['project', 'task_id', 'actor', 'payload'])
      .where('kind', '=', 'inbound_skipped')
      .orderBy('id')
      .execute();
    expect(skipped.map(({ project, task_id, actor }) => ({ project, task_id, actor }))).toEqual([
      { project: 'proj', task_id: 1, actor: 'system' },
      { project: 'proj', task_id: 1, actor: 'system' },
    ]);
    for (const row of skipped) {
      expect(JSON.parse(row.payload)).toMatchObject({
        reason: 'Original operator comment not found.',
      });
    }
    expect(
      await store.db
        .selectFrom('comment')
        .select(['text', 'revision'])
        .where('message_ref', '=', 'system-message')
        .executeTakeFirst(),
    ).toEqual({ text: 'System note', revision: 1 });
  });

  it('creates a linked fallback item and feed line when author is unavailable', async () => {
    const { store, inbound } = await setup();
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    const item = await getOperatorItem(store, 1);
    expect(item).toMatchObject({
      kind: 'answer_author_unavailable',
      text: 'Answer author unavailable',
      url: 'https://example.test/thread/reply',
      task_id: 1,
    });
    expect(item?.inbound_event_json).toBeNull();
    expect(
      await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'feed.line').execute(),
    ).toHaveLength(1);
    expect(
      (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind),
    ).toContain('doorbell_undelivered');
  });

  it('rolls back a failed handler and stores a linked retry item before resolving', async () => {
    const { store, inbound, gateway } = await setup();
    await scanTransaction(store, config, (trx) =>
      trx.updateTable('task').set({ membership: 'archived' }).where('id', '=', 1).execute(),
    );
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    expect(await store.db.selectFrom('comment').select('id').execute()).toEqual([]);
    const item = await getOperatorItem(store, 1);
    expect(item).toMatchObject({
      kind: 'inbound_failure',
      text: 'Slack message not processed',
      url: 'https://example.test/thread/reply',
      cleared_at: null,
    });
    expect(JSON.parse(item?.inbound_event_json ?? '{}')).toMatchObject({
      kind: 'message',
      dedupeKey: 'message-1',
    });
    expect(
      (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['inbound_failed', 'from_you_raised']);
    expect(
      (await store.db.selectFrom('outbox').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['feed.line']);
    expect(await store.db.selectFrom('command').select('key').execute()).toEqual([]);
    const sender = createSender({
      config,
      store,
      gateway,
      spur: { send: () => Promise.resolve() },
      now: () => new Date(now),
    });
    await sender.tick();
    expect(gateway.platform.messages().map((entry) => entry.text)).toEqual([
      'o/r#101\n\nSlack message not processed',
    ]);
    const feed = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(feed.payload)).toMatchObject({
      title: 'o/r#101: Slack message not processed',
      url: 'https://example.test/thread/reply',
    });
    expect(
      await store.db
        .selectFrom('outbox')
        .select('state')
        .where('kind', '=', 'feed.line')
        .executeTakeFirst(),
    ).toEqual({ state: 'done' });
  });

  it('allows an operator command from any source and privately reports unavailable handlers', async () => {
    const { store, gateway } = await setup();
    const responses: { text: string; private: boolean }[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          responses.push({
            text:
              body[0]?.kind === 'paragraph'
                ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
                : '',
            private: options.private,
          });
          return Promise.resolve('sent' as const);
        },
      },
    });
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'command-anywhere',
      interaction: interactionRefSchema.parse('command-anywhere'),
      author: userIdSchema.parse('operator'),
      text: 'task o/r#101 history',
      command: { kind: 'query', id: 'task.history', input: { task: 'o/r#101' } },
      sourceUrl: 'https://example.test/other',
    });
    await inbound.sink({
      kind: 'action',
      dedupeKey: 'button-board',
      interaction: interactionRefSchema.parse('button-board'),
      actionId: 'item:1:close',
      author: userIdSchema.parse('operator'),
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('root-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/board',
      sourceSpace: 'feed',
    });
    expect(responses).toEqual([
      { text: 'not available yet', private: true },
      { text: 'not available yet', private: true },
    ]);
    expect(await store.db.selectFrom('command').select('key').execute()).toEqual([]);
  });

  it('dispatches installed command and button handlers through the catalog boundary', async () => {
    const { store, gateway } = await setup();
    const responses: string[] = [];
    const boardTarget = {
      kind: 'found' as const,
      value: { project: 'proj', task: null, block: null, workers: [] },
    };
    const registry: OperationRegistry = {
      'status.get': {
        id: 'status.get',
        resolveTargets: () => Promise.resolve([boardTarget]),
        run: () => Promise.resolve(emptyStatus()),
      },
      'item.close': {
        id: 'item.close',
        resolveTargets: () => Promise.resolve([boardTarget]),
        run: (_trx, input) =>
          Promise.resolve({ item: { id: input.item, task: null, at, summary: 'Closed' } }),
      },
      'item.retry': {
        id: 'item.retry',
        resolveTargets: () => Promise.resolve([boardTarget]),
        run: (_trx, input) =>
          Promise.resolve({ item: { id: input.item, task: null, at, summary: 'Retry' } }),
      },
    };
    const inbound = createInbound({
      store,
      config,
      registry,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          expect(options.private).toBe(true);
          responses.push(
            body[0]?.kind === 'paragraph'
              ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
              : '',
          );
          return Promise.resolve('sent' as const);
        },
      },
    });
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'catalog-status',
      interaction: interactionRefSchema.parse('catalog-status'),
      author: userIdSchema.parse('operator'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: {} },
      sourceUrl: 'https://example.test/other',
    });
    const button: InboundEvent = {
      kind: 'action',
      dedupeKey: 'catalog-close',
      interaction: interactionRefSchema.parse('catalog-close'),
      actionId: 'item:1:close',
      author: userIdSchema.parse('operator'),
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('root-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/board',
      sourceSpace: 'feed',
    };
    await inbound.sink(button);
    await inbound.sink(button);
    await inbound.sink({
      ...button,
      dedupeKey: 'catalog-retry',
      interaction: interactionRefSchema.parse('catalog-retry'),
      actionId: 'item:1:retry',
    });
    expect(responses).toEqual([
      'Board status: 0 tasks, 0 items needing attention.',
      'Closed I1.',
      'Closed I1.',
      'Retry started for I1.',
    ]);
    expect(responses.slice(1).some((text) => text.includes('{'))).toBe(false);
    expect(await store.db.selectFrom('command').select(['operation', 'key']).execute()).toEqual([
      { operation: 'item.close', key: 'catalog-close' },
      { operation: 'item.retry', key: 'catalog-retry' },
    ]);
  });

  it('journals another command name once without dispatching or responding', async () => {
    const { store, gateway } = await setup();
    const selectedConfig = configSchema.parse({
      ...config,
      slack: { ...config.slack, command: '/ops' },
    });
    const run = vi.fn(() => Promise.resolve(emptyStatus()));
    const respond = vi.fn(() => Promise.resolve('sent' as const));
    const registry: OperationRegistry = {
      'status.get': {
        id: 'status.get',
        resolveTargets: () =>
          Promise.resolve([
            { kind: 'found', value: { project: 'proj', task: null, block: null, workers: [] } },
          ]),
        run,
      },
    };
    const inbound = createInbound({
      store,
      config: selectedConfig,
      registry,
      clock: { now: () => now },
      gateway: { ...gateway, respond },
    });
    const wrong: InboundEvent = {
      kind: 'command',
      name: '/other',
      dedupeKey: 'wrong-command',
      interaction: interactionRefSchema.parse('wrong-command'),
      author: userIdSchema.parse('operator'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: {} },
      sourceUrl: 'https://example.test/command',
    };
    await inbound.sink(wrong);
    await inbound.sink(wrong);
    expect(run).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    const denied = await store.db
      .selectFrom('event')
      .select(['kind', 'payload'])
      .where('kind', '=', 'operation_denied')
      .execute();
    expect(denied).toHaveLength(1);
    expect(JSON.parse(denied[0]?.payload ?? '{}')).toMatchObject({
      reason: 'Command name does not match the configured command.',
    });
    await inbound.sink({ ...wrong, name: '/ops', dedupeKey: 'selected-command' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('renders task comments as quotes and dated history as private English text', async () => {
    const { store, gateway } = await setup();
    const [plain, explained] = OPERATIONS[1].examples;
    if (explained === undefined) throw new Error('Missing the task.get why example');
    const replies: {
      body: Parameters<typeof gateway.respond>[1];
      private: boolean;
      cliHint: string | undefined;
    }[] = [];
    const target = {
      kind: 'found' as const,
      value: { project: 'proj', task: null, block: null, workers: [] },
    };
    const registry: OperationRegistry = {
      'task.get': {
        id: 'task.get',
        resolveTargets: () => Promise.resolve([target]),
        run: (_trx, input) => Promise.resolve((input.why === true ? explained : plain).output),
      },
      'task.history': {
        id: 'task.history',
        resolveTargets: () => Promise.resolve([target]),
        run: () => Promise.resolve(OPERATIONS[2].examples[0].output),
      },
    };
    const inbound = createInbound({
      store,
      config,
      registry,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_ref, body, options) {
          replies.push({ body, private: options.private, cliHint: options.cliHint });
          return Promise.resolve('sent' as const);
        },
      },
    });
    for (const [id, text, input, key] of [
      ['task.get', 'task PROJ-123', { task: 'PROJ-123' }, 'get'],
      ['task.history', 'task PROJ-123 history', { task: 'PROJ-123' }, 'history'],
      ['task.get', 'task PROJ-123 why', { task: 'PROJ-123', why: true }, 'why'],
    ] as const) {
      await inbound.sink({
        kind: 'command',
        dedupeKey: key,
        interaction: interactionRefSchema.parse(key),
        author: userIdSchema.parse('operator'),
        text,
        command: { kind: 'query', id, input },
        sourceUrl: 'https://example.test/command',
      });
    }
    expect(replies.map((reply) => reply.private)).toEqual([true, true, true]);
    expect(replies.map((reply) => reply.cliHint)).toEqual([
      'board task PROJ-123',
      'board task history PROJ-123',
      'board task PROJ-123 --why',
    ]);
    expect(JSON.stringify(replies[2]?.body)).toContain('Task PROJ-123 is in review.');
    expect(JSON.stringify(replies[2]?.body)).toContain('review_on_head failed (no_review_on_head)');
    expect(replies[0]?.body).toContainEqual({
      kind: 'quote',
      children: [{ kind: 'text', text: 'Target v2.' }],
    });
    expect(JSON.stringify(replies[1]?.body)).toContain('2026-01-05T09:30:00.000Z');
    expect(JSON.stringify(replies[1]?.body)).toContain('Added to Dev.');
  });

  it('redacts detected text in a private task reply and keeps the surrounding status', async () => {
    const { store, gateway } = await setup();
    const token = ['xoxb', '123', 'abc'].join('-');
    const secondToken = ['xoxb', '456', 'def'].join('-');
    const operation = OPERATIONS.find((entry) => entry.id === 'task.get');
    if (operation === undefined) throw new Error('task.get is missing from the catalog');
    const example = operation.output.parse(operation.examples[0].output);
    const output = {
      ...example,
      blocks: example.blocks.map((block) => ({ ...block, reason: `Which ${token} target?` })),
      comments: example.comments.map((comment) => ({
        ...comment,
        text: `Use ${token} and ${secondToken} for the check.`,
      })),
    };
    const replies: Parameters<typeof gateway.respond>[1][] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      registry: {
        'task.get': {
          id: 'task.get',
          resolveTargets: () =>
            Promise.resolve([
              { kind: 'found', value: { project: 'proj', task: null, block: null, workers: [] } },
            ]),
          run: () => Promise.resolve(output),
        },
      },
      gateway: {
        ...gateway,
        respond(_ref, body) {
          replies.push(body);
          return Promise.resolve('sent' as const);
        },
      },
    });
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'redacted-task',
      interaction: interactionRefSchema.parse('redacted-task'),
      author: userIdSchema.parse('operator'),
      text: 'task PROJ-123',
      command: { kind: 'query', id: 'task.get', input: { task: 'PROJ-123' } },
      sourceUrl: 'https://example.test/command',
    });

    const marker = '[redacted: @secretlint/secretlint-rule-slack]';
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContainEqual({
      kind: 'quote',
      children: [{ kind: 'text', text: `Which ${marker} target?` }],
    });
    expect(replies[0]).toContainEqual({
      kind: 'quote',
      children: [{ kind: 'text', text: `Use ${marker} and ${marker} for the check.` }],
    });
    expect(JSON.stringify(replies[0])).not.toContain(token);
    expect(JSON.stringify(replies[0])).not.toContain(secondToken);
    expect(JSON.stringify(replies[0])).toContain('Task PROJ-123:');
  });

  it('uses catalog not_found copy and never runs a denied command', async () => {
    const { store, gateway } = await setup();
    const run = vi.fn(() => Promise.resolve(OPERATIONS[1].examples[0].output));
    const responses: string[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      registry: {
        'task.get': {
          id: 'task.get',
          resolveTargets: () => Promise.resolve([{ kind: 'missing' }]),
          run,
        },
      },
      gateway: {
        ...gateway,
        respond(_ref, body, options) {
          expect(options.private).toBe(true);
          responses.push(JSON.stringify(body));
          return Promise.resolve('sent' as const);
        },
      },
    });
    const command: Extract<InboundEvent, { kind: 'command' }> = {
      kind: 'command',
      dedupeKey: 'missing-task',
      interaction: interactionRefSchema.parse('missing-task'),
      author: userIdSchema.parse('operator'),
      text: 'task MISSING-1',
      command: { kind: 'query', id: 'task.get', input: { task: 'MISSING-1' } },
      sourceUrl: 'https://example.test/command',
    };
    await inbound.sink(command);
    expect(responses[0]).toContain(ERRORS.not_found.message);
    expect(responses[0]).toContain(ERRORS.not_found.hint);
    const deniedCommand: Extract<InboundEvent, { kind: 'command' }> = {
      ...command,
      dedupeKey: 'denied-command',
      author: userIdSchema.parse('another'),
    };
    await inbound.sink(deniedCommand);
    await inbound.sink(deniedCommand);
    expect(responses[1]).toContain('not allowed');
    expect(responses[2]).toContain('not allowed');
    expect(run).not.toHaveBeenCalled();
    const deniedEvents = await store.db
      .selectFrom('event')
      .select(['kind', 'project', 'payload'])
      .where('kind', '=', 'operation_denied')
      .execute();
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.project).toBe(RESERVED_PROJECT);
    expect(JSON.parse(deniedEvents[0]?.payload ?? '{}')).toMatchObject({
      operation: 'inbound.command',
      platformUser: 'another',
    });
    expect(
      await store.db
        .selectFrom('command')
        .select(['key', 'operation'])
        .where('key', '=', deniedCommand.dedupeKey)
        .execute(),
    ).toEqual([{ key: 'denied-command', operation: 'task.get' }]);
  });

  it('journals a denied command under the project its task names', async () => {
    const { store, inbound } = await setup();
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'denied-task-command',
      interaction: interactionRefSchema.parse('denied-task-command'),
      author: userIdSchema.parse('another'),
      text: 'task o/r#5',
      command: { kind: 'query', id: 'task.get', input: { task: 'o/r#5' } },
      sourceUrl: 'https://example.test/command',
    });
    expect(
      await store.db.selectFrom('event').select(['kind', 'project', 'task_id', 'actor']).execute(),
    ).toEqual([{ kind: 'operation_denied', project: 'proj', task_id: null, actor: 'system' }]);
  });

  it('returns private usage without dispatching a malformed command', async () => {
    const { store, gateway } = await setup();
    const run = vi.fn(() => Promise.resolve(emptyStatus()));
    const resolveTargets = vi.fn(() => Promise.resolve([]));
    const responses: string[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      registry: {
        'status.get': { id: 'status.get', resolveTargets, run },
      },
      gateway: {
        ...gateway,
        respond(_ref, body, options) {
          expect(options.private).toBe(true);
          responses.push(JSON.stringify(body));
          return Promise.resolve('sent' as const);
        },
      },
    });
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'usage',
      interaction: interactionRefSchema.parse('usage'),
      author: userIdSchema.parse('operator'),
      text: 'unknown',
      command: {
        kind: 'usage',
        text: 'Usage:\n/board status\n/board task <KEY>\n/board task <KEY> history',
      },
      sourceUrl: 'https://example.test/command',
    });
    expect(responses[0]).toContain('/board task <KEY> history');
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'forged-input',
      interaction: interactionRefSchema.parse('forged-input'),
      author: userIdSchema.parse('operator'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: { item: 'I1' } },
      sourceUrl: 'https://example.test/command',
    });
    expect(responses[1]).toContain('not allowed');
    expect(resolveTargets).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('records an installed interaction failure before acknowledging and retries its stored event', async () => {
    const { store, gateway } = await setup();
    let fail = true;
    const responses: string[] = [];
    const eventsAtResponse: string[][] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      registry: {
        'status.get': {
          id: 'status.get',
          resolveTargets: () =>
            Promise.resolve([
              { kind: 'found', value: { project: 'proj', task: null, block: null, workers: [] } },
            ]),
          run: () =>
            fail ? Promise.reject(new Error('handler failed')) : Promise.resolve(emptyStatus()),
        },
      },
      gateway: {
        ...gateway,
        async respond(_interaction, body) {
          eventsAtResponse.push(
            (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind),
          );
          responses.push(
            body[0]?.kind === 'paragraph'
              ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
              : '',
          );
          return 'sent' as const;
        },
      },
    });
    await inbound.sink({
      kind: 'command',
      dedupeKey: 'failed-status',
      interaction: interactionRefSchema.parse('failed-status'),
      author: userIdSchema.parse('operator'),
      text: 'status',
      command: { kind: 'query', id: 'status.get', input: {} },
      sourceUrl: 'https://example.test/command',
    });
    expect(responses).toEqual(['not available yet']);
    expect(eventsAtResponse).toEqual([['inbound_failed', 'from_you_raised']]);
    expect(
      await store.db.selectFrom('event').select(['kind', 'request_id']).orderBy('id').execute(),
    ).toEqual([
      { kind: 'inbound_failed', request_id: 'failed-status' },
      { kind: 'from_you_raised', request_id: 'failed-status' },
    ]);
    const item = await getOperatorItem(store, 1);
    expect(item).toMatchObject({
      kind: 'inbound_failure',
      task_id: null,
      url: 'https://example.test/command',
    });
    expect(JSON.parse(item?.inbound_event_json ?? '{}')).toMatchObject({
      kind: 'command',
      dedupeKey: 'failed-status',
    });
    const feed = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(feed.payload)).toMatchObject({
      key: 'spur-board',
      title: 'spur-board: Slack message not processed',
    });
    const legacy = JSON.parse(item?.inbound_event_json ?? '{}') as Record<string, unknown>;
    delete legacy.command;
    legacy.name = '/other';
    await store.db
      .updateTable('operator_item')
      .set({ inbound_event_json: JSON.stringify(legacy) })
      .where('id', '=', 1)
      .execute();
    fail = false;
    await expect(inbound.retryStored(1)).rejects.toMatchObject({ code: 'retry_not_applicable' });
    expect((await getOperatorItem(store, 1))?.cleared_at).toBeNull();
    expect(await store.db.selectFrom('command').select('key').execute()).toEqual([]);

    delete legacy.name;
    await store.db
      .updateTable('operator_item')
      .set({ inbound_event_json: JSON.stringify(legacy) })
      .where('id', '=', 1)
      .execute();
    await inbound.retryStored(1);
    expect((await getOperatorItem(store, 1))?.cleared_at).not.toBeNull();
    expect(
      await store.db
        .selectFrom('outbox')
        .select('kind')
        .where('kind', '=', 'feed.line.edit')
        .execute(),
    ).toHaveLength(1);
  });

  it('raises one item per affected gap even when scans use new event keys', async () => {
    const { store, inbound } = await setup();
    const conversation = conversationRefSchema.parse('thread-1');
    await inbound.sink({ kind: 'gap', dedupeKey: 'gap-a', conversation });
    await inbound.sink({ kind: 'gap', dedupeKey: 'gap-b', conversation });
    await inbound.sink({ kind: 'gap', dedupeKey: 'gateway-gap-a' });
    await inbound.sink({ kind: 'gap', dedupeKey: 'gateway-gap-b' });
    const first = await store.db
      .selectFrom('operator_item')
      .select(['id', 'item_key', 'text'])
      .orderBy('id')
      .execute();
    expect(first).toHaveLength(2);
    expect(first.map((item) => item.text)).toEqual(['repeat your answer', 'repeat your answer']);
    expect(
      await store.db.selectFrom('operator_item').select('kind').orderBy('id').execute(),
    ).toEqual([{ kind: 'inbound_gap' }, { kind: 'inbound_gap' }]);
    expect(first[0]?.item_key).not.toBe(first[1]?.item_key);
    expect(
      await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'feed.line').execute(),
    ).toHaveLength(2);
    const boardLine = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('dedupe_key', 'like', 'feed.line:inbound:gap:%')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(boardLine.payload)).toMatchObject({
      key: 'spur-board',
      title: 'spur-board: repeat your answer',
    });
    await scanTransaction(store, config, (trx) => clearOperatorItem(trx, 2, new Date(at)));
    expect(
      await store.db
        .selectFrom('outbox')
        .select('kind')
        .where('kind', '=', 'feed.line.edit')
        .execute(),
    ).toHaveLength(1);
    await scanTransaction(store, config, (trx) => clearOperatorItem(trx, 1, new Date(at)));
    await inbound.sink({ kind: 'gap', dedupeKey: 'gap-c', conversation });
    await inbound.sink({ kind: 'gap', dedupeKey: 'gap-d', conversation });
    const later = await store.db
      .selectFrom('operator_item')
      .select(['item_key', 'cleared_at'])
      .orderBy('id')
      .execute();
    expect(later).toHaveLength(3);
    expect(later[0]?.cleared_at).not.toBeNull();
    expect(later[2]?.cleared_at).toBeNull();
    expect(later[2]?.item_key).toBe(first[0]?.item_key);
    expect(
      await store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute(),
    ).toHaveLength(3);
  });

  it('registers a content-free worker answer notification for a live author', async () => {
    const { store, inbound, gateway } = await setup('agent:proj/sess-1');
    await scanTransaction(store, config, (trx) =>
      trx
        .insertInto('session_snapshot')
        .values({
          id: 'sess-1',
          spur_project: 'proj',
          branch: 'work',
          pr: null,
          raw_state: 'running',
          state: 'running',
          first_seen: at,
          last_seen: at,
          ended_at: null,
          end_reason: null,
          detail: '{}',
          source: 'spur',
          observed_at: at,
        })
        .execute(),
    );
    const secret = ['xoxb', '123', 'abc'].join('-');
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1', text: secret }));
    expect(
      await store.db
        .selectFrom('notification')
        .select(['kind', 'comment_id', 'author_session'])
        .execute(),
    ).toEqual([{ kind: 'answer', comment_id: 1, author_session: 'sess-1' }]);
    const sends: { session: string; text: string }[] = [];
    const sender = createSender({
      store,
      gateway,
      config,
      now: () => new Date(now),
      spur: {
        send: (session, text) => {
          sends.push({ session, text });
          return Promise.resolve();
        },
      },
    });
    await reconcileDueDoorbells(store, config, new Date(now));
    await sender.tick();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.session).toBe('sess-1');
    expect(sends[0]?.text).toContain('check board inbox');
    expect(sends[0]?.text).not.toContain(secret);
    expect(
      (await store.db.selectFrom('outbox').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['conversation.close', 'doorbell']);
    const doorbell = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'doorbell')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(doorbell.payload)).toMatchObject({ session: 'sess-1' });
    expect(doorbell.payload).not.toContain(secret);
    expect(await store.db.selectFrom('operator_item').select('id').execute()).toEqual([]);
  });

  it('rings a non-worker author through a content-free answer notification', async () => {
    const { store, gateway } = await setup('agent:proj/sess-1');
    const operatorConfig = configSchema.parse({
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        spurProjects: [...project.spurProjects, { name: 'proj', role: 'operator' }],
      })),
    });
    const inbound = createInbound({
      store,
      gateway,
      config: operatorConfig,
      clock: { now: () => now },
    });
    await scanTransaction(store, config, (trx) =>
      trx
        .insertInto('session_snapshot')
        .values({ ...sampleRows.session_snapshot, id: 'sess-1', ended_at: null })
        .execute(),
    );
    const secret = ['xoxb', '123', 'abc'].join('-');
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1', text: secret }));
    expect(
      await store.db
        .selectFrom('notification')
        .select(['kind', 'role', 'author_session'])
        .execute(),
    ).toEqual([{ kind: 'answer', role: 'operator', author_session: 'sess-1' }]);
    expect(await store.db.selectFrom('operator_item').select('id').execute()).toEqual([]);
    await reconcileDueDoorbells(store, operatorConfig, new Date(now));
    const doorbell = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'doorbell')
      .executeTakeFirstOrThrow();
    const pointer = 'o/r#101 block B1: check board inbox (N1-1)';
    expect(JSON.parse(doorbell.payload)).toMatchObject({ session: 'sess-1', text: pointer });
    expect(doorbell.payload).not.toContain(secret);
    const sends: string[] = [];
    const sender = createSender({
      store,
      gateway,
      config: operatorConfig,
      spur: {
        send: (_session, text) => {
          sends.push(text);
          return Promise.resolve();
        },
      },
      now: () => new Date(now),
    });
    await sender.tick();
    expect(sends).toEqual([pointer]);
  });

  it('holds a Slack answer to a curator until a curator session appears, and rings its edit', async () => {
    const { store, gateway } = await setup('agent:cur/cur-1');
    const curatorConfig = configSchema.parse({
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        spurProjects: [...project.spurProjects, { name: 'cur', role: 'curator' }],
      })),
    });
    const inbound = createInbound({
      store,
      gateway,
      config: curatorConfig,
      clock: { now: () => now },
    });
    const sends: string[] = [];
    const sender = createSender({
      store,
      gateway,
      config: curatorConfig,
      now: () => new Date(now),
      spur: {
        send: (session) => {
          sends.push(session);
          return Promise.resolve();
        },
      },
    });
    const ring = async () => {
      await reconcileDueDoorbells(store, curatorConfig, new Date(now));
      await sender.tick();
    };
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    expect(
      await store.db
        .selectFrom('notification')
        .select(['kind', 'role', 'author_session'])
        .execute(),
    ).toEqual([{ kind: 'answer', role: 'curator', author_session: 'cur-1' }]);
    expect(await store.db.selectFrom('operator_item').select('kind').execute()).toEqual([
      { kind: 'answer_author_unavailable' },
    ]);
    await ring();
    expect(sends).toEqual([]);
    expect(
      await store.db.selectFrom('notification').select(['rings', 'exhausted_at']).execute(),
    ).toEqual([{ rings: 0, exhausted_at: null }]);
    await scanTransaction(store, curatorConfig, (trx) =>
      trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'cur-2',
          spur_project: 'cur',
          ended_at: null,
          end_reason: null,
          absent_since: null,
        })
        .execute(),
    );
    await ring();
    expect(sends).toEqual(['cur-2']);
    await store.transaction((trx) =>
      trx.updateTable('comment').set({ acked_revision: 1 }).execute(),
    );
    await inbound.sink({
      ...message({ conversation: 'thread-1', root: 'root-1', key: 'edit-1' }),
      kind: 'message_edited',
      text: 'Revised',
    });
    await ring();
    expect(sends).toEqual(['cur-2', 'cur-2']);
    expect(await store.db.selectFrom('operator_item').select('kind').execute()).toEqual([
      { kind: 'answer_author_unavailable' },
    ]);
  });

  it('keeps an ended author answer pending until a replacement worker arrives', async () => {
    const { store, inbound, gateway } = await setup('agent:proj/sess-1');
    await scanTransaction(store, config, (trx) =>
      trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'sess-1',
          ended_at: at,
        })
        .execute(),
    );
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    expect(
      await store.db
        .selectFrom('notification')
        .select(['kind', 'author_session', 'recipient_session'])
        .execute(),
    ).toEqual([{ kind: 'answer', author_session: 'sess-1', recipient_session: null }]);
    expect(
      await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'doorbell').execute(),
    ).toEqual([]);
    expect(await getOperatorItem(store, 1)).toMatchObject({
      text: 'Answer author unavailable',
      url: 'https://example.test/thread/reply',
    });
    const undelivered = await store.db
      .selectFrom('event')
      .select('payload')
      .where('kind', '=', 'doorbell_undelivered')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(undelivered.payload)).toMatchObject({
      reason: 'author session is unavailable',
    });
    const sends: string[] = [];
    const sender = createSender({
      store,
      gateway,
      config,
      now: () => new Date(now),
      spur: {
        send: (session) => {
          sends.push(session);
          return Promise.resolve();
        },
      },
    });
    await reconcileDueDoorbells(store, config, new Date(now));
    await sender.tick();
    expect(sends).toEqual([]);
    await store.transaction(async (trx) => {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          id: 'sess-2',
          ended_at: null,
          end_reason: null,
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'sess-2',
          role: 'worker',
        })
        .execute();
    });
    await reconcileDueDoorbells(store, config, new Date(now));
    await sender.tick();
    expect(sends).toEqual(['sess-2']);
  });

  it('rings a live linked worker when the original author session ended', async () => {
    const { store, inbound, gateway } = await setup('agent:proj/sess-1');
    await store.transaction(async (trx) => {
      await trx
        .insertInto('session_snapshot')
        .values([
          { ...sampleRows.session_snapshot, id: 'sess-1', ended_at: at },
          { ...sampleRows.session_snapshot, id: 'sess-2', ended_at: null, end_reason: null },
        ])
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'sess-2',
          role: 'worker',
        })
        .execute();
    });
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    expect(
      await store.db.selectFrom('notification').select(['kind', 'author_session']).execute(),
    ).toEqual([{ kind: 'answer', author_session: 'sess-1' }]);
    const sends: string[] = [];
    const sender = createSender({
      store,
      gateway,
      config,
      now: () => new Date(now),
      spur: {
        send: (session) => {
          sends.push(session);
          return Promise.resolve();
        },
      },
    });
    await reconcileDueDoorbells(store, config, new Date(now));
    await sender.tick();
    expect(sends).toEqual(['sess-2']);
    expect(await store.db.selectFrom('operator_item').select('id').execute()).toEqual([]);
  });

  it('recovers a downtime reply and edit after store reopen without a second comment', async () => {
    const { store, file, gateway } = await setup();
    const result = await gateway.deliver({
      key: 'root-open',
      maybeSent: false,
      target: { kind: 'open', space: 'orchestrators', title: 'question' },
      persona: { name: 'board', role: 'board' },
      body: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'Question' }] }],
    });
    if (result.status !== 'delivered' || result.conversation === undefined)
      throw new Error('Expected root delivery');
    await scanTransaction(store, config, (trx) =>
      trx
        .updateTable('conversation')
        .set({
          ref: result.conversation,
          root_message_ref: result.message,
        })
        .where('ref', '=', 'thread-1')
        .execute(),
    );
    const posted = await gateway.platform.inject({
      kind: 'message',
      conversation: result.conversation,
      author: userIdSchema.parse('operator'),
      text: 'Answer',
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openStore(file);
    stores.push(reopened);
    const inbound = createInbound({ store: reopened, gateway, config, clock: { now: () => now } });
    await inbound.recover();
    expect(await reopened.db.selectFrom('comment').select('text').execute()).toEqual([
      { text: 'Answer' },
    ]);
    if (posted.message === undefined) throw new Error('Expected message');
    gateway.platform.advance(1000);
    await gateway.platform.inject({
      kind: 'edit',
      message: posted.message,
      text: 'Updated answer',
    });
    await inbound.recover();
    expect(await reopened.db.selectFrom('comment').select(['text', 'revision']).execute()).toEqual([
      { text: 'Updated answer', revision: 2 },
    ]);
    expect(await reopened.db.selectFrom('comment').select('id').execute()).toHaveLength(1);
  });

  it('applies a distinct edit in the same millisecond and skips its replay', async () => {
    const { store, inbound } = await setup();
    const edit = (key: string, text: string) => ({
      ...message({ conversation: 'thread-1', root: 'root-1', key }),
      kind: 'message_edited' as const,
      text,
      at: new Date(now + 1000).toISOString(),
    });
    const comment = () => store.db.selectFrom('comment').select(['text', 'revision']).execute();
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    await inbound.sink(edit('edit-a', 'First edit'));
    await inbound.sink(edit('edit-b', 'Second edit'));
    expect(await comment()).toEqual([{ text: 'Second edit', revision: 3 }]);
    await purgeExpiredCommands(store, { now: () => now + 8 * DAY }, 7);
    await inbound.sink(edit('edit-b', 'Second edit'));
    expect(await comment()).toEqual([{ text: 'Second edit', revision: 3 }]);
    expect(await store.db.selectFrom('command').select('key').execute()).toEqual([]);
  });

  it('skips a replayed edit or deletion after its command key expired', async () => {
    const { store, inbound } = await setup();
    const purge = () => purgeExpiredCommands(store, { now: () => now + 8 * DAY }, 7);
    const edit = (key: string, editedAt: string, text: string) => ({
      ...message({ conversation: 'thread-1', root: 'root-1', key }),
      kind: 'message_edited' as const,
      text,
      at: editedAt,
    });
    const deletion = {
      kind: 'message_deleted' as const,
      dedupeKey: 'd',
      conversation: conversationRefSchema.parse('thread-1'),
      message: messageRefSchema.parse('reply-1'),
      rootMessage: messageRefSchema.parse('root-1'),
      sourceUrl: 'https://example.test/thread/reply',
    };
    const e1 = edit('e1', new Date(now + 1000).toISOString(), 'First edit');
    const e2 = edit('e2', new Date(now + 2000).toISOString(), 'Second edit');
    const e3 = edit('e3', new Date(now + 3000).toISOString(), 'Third edit');
    const snapshot = async () => ({
      event: await store.db.selectFrom('event').selectAll().orderBy('id').execute(),
      comment: await store.db
        .selectFrom('comment')
        .select(['id', 'text', 'revision'])
        .orderBy('id')
        .execute(),
      operator_item: await store.db.selectFrom('operator_item').selectAll().orderBy('id').execute(),
      notification: await store.db.selectFrom('notification').selectAll().orderBy('id').execute(),
      outbox: await store.db.selectFrom('outbox').selectAll().orderBy('id').execute(),
    });
    const commands = () => store.db.selectFrom('command').select('key').execute();
    const kinds = async (kind: string) =>
      (await store.db.selectFrom('event').select('kind').where('kind', '=', kind).execute()).length;

    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1' }));
    await inbound.sink(e1);
    await inbound.sink(e2);
    expect(await store.db.selectFrom('comment').select(['text', 'revision']).execute()).toEqual([
      { text: 'Second edit', revision: 3 },
    ]);

    const applied = await snapshot();
    await purge();
    await inbound.sink(e2);
    await inbound.sink({ ...e2, at: '2026-11-03T10:00:02Z' });
    await inbound.sink(e1);
    expect(await snapshot()).toEqual(applied);
    expect(await commands()).toEqual([]);

    await inbound.sink(e3);
    expect(await store.db.selectFrom('comment').select(['text', 'revision']).execute()).toEqual([
      { text: 'Third edit', revision: 4 },
    ]);
    expect(await kinds('comment_edited')).toBe(3);

    await scanTransaction(store, config, (trx) =>
      trx.updateTable('task').set({ membership: 'archived' }).where('id', '=', 1).execute(),
    );
    const archived = await snapshot();
    await purge();
    await inbound.sink(e3);
    await inbound.sink(e1);
    expect(await snapshot()).toEqual(archived);
    expect(await kinds('inbound_failed')).toBe(0);

    await inbound.sink(deletion);
    expect(await kinds('comment_deleted')).toBe(1);

    const deleted = await snapshot();
    await purge();
    await inbound.sink(deletion);
    await inbound.sink(e3);
    expect(await snapshot()).toEqual(deleted);
    expect(await kinds('comment_deleted')).toBe(1);
    expect(await commands()).toEqual([]);
  });

  it('applies a live event between recovery slices', async () => {
    const { store, gateway } = await setup();
    await addSecondConversation(store, gateway.kind);
    const gates = new Map([
      ['thread-1', Promise.withResolvers<undefined>()],
      ['thread-2', Promise.withResolvers<undefined>()],
    ]);
    const release = (ref: string) => gates.get(ref)?.resolve(undefined);
    const calls: string[] = [];
    const inbound = recoveringInbound(store, gateway, (request) => {
      const ref = request.conversations[0]?.ref ?? '';
      calls.push(ref);
      return (async function* () {
        await gates.get(ref)?.promise;
        yield* gateway.recover(request);
      })();
    });
    let scanned = false;
    const scanning = inbound.recover().then(() => {
      scanned = true;
    });
    try {
      await settleUntil(() => calls.includes('thread-1'));
      let sunk = false;
      const sinking = inbound
        .sink(message({ conversation: 'thread-3', root: 'root-3', key: 'live-3' }))
        .then(() => {
          sunk = true;
        });
      release('thread-1');
      await settleUntil(() => sunk);
      await sinking;
      expect(
        await store.db
          .selectFrom('event')
          .select('kind')
          .where('kind', '=', 'inbound_skipped')
          .execute(),
      ).toHaveLength(1);
      expect(scanned).toBe(false);
      await settleUntil(() => calls.length === 2);
      expect(calls).toEqual(['thread-1', 'thread-2']);
    } finally {
      release('thread-1');
      release('thread-2');
      await scanning;
    }
  });

  it("applies a conversation's recovered events before its live event", async () => {
    const { store, gateway } = await setup();
    await addSecondConversation(store, gateway.kind);
    const gate = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const inbound = recoveringInbound(store, gateway, (request) => {
      const ref = request.conversations[0]?.ref ?? '';
      calls.push(ref);
      return (async function* () {
        if (ref === 'thread-1') await gate.promise;
        if (ref === 'thread-2') {
          yield message({
            conversation: 'thread-2',
            root: 'root-2',
            key: 'missed-2',
            ref: 'missed-2',
            text: 'Missed',
          });
        }
      })();
    });
    const scanning = inbound.recover();
    try {
      await settleUntil(() => calls.includes('thread-1'));
      const sinking = inbound.sink(
        message({
          conversation: 'thread-2',
          root: 'root-2',
          key: 'live-2',
          ref: 'live-2',
          text: 'Live',
        }),
      );
      gate.resolve(undefined);
      await sinking;
      await scanning;
    } finally {
      gate.resolve(undefined);
    }
    expect(
      (
        await store.db
          .selectFrom('comment')
          .select('text')
          .where('block_id', '=', 2)
          .orderBy('id')
          .execute()
      ).map((row) => row.text),
    ).toEqual(['Missed', 'Live']);
    expect(calls).toEqual(['thread-1', 'thread-2']);
  });

  it('rereads an already read conversation before its live event after a second connection up', async () => {
    const { store, gateway } = await setup();
    await addSecondConversation(store, gateway.kind);
    const gate = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const inbound = recoveringInbound(store, gateway, (request) => {
      const conversation = request.conversations[0];
      const ref = conversation?.ref ?? '';
      calls.push(ref);
      const reread = ref === 'thread-1' && calls.filter((call) => call === ref).length > 1;
      return (async function* () {
        if (ref === 'thread-2' && calls.length === 2) await gate.promise;
        // Like Slack, a read after a cursor returns only later messages.
        if (reread && conversation?.after === undefined) {
          yield message({
            conversation: 'thread-1',
            root: 'root-1',
            key: 'missed-1',
            ref: 'missed-1',
            text: 'Missed',
          });
        }
      })();
    });
    const up = (key: string) => inbound.sink({ kind: 'connection', dedupeKey: key, state: 'up' });
    const first = up('up-1');
    let second: Promise<void> | undefined;
    try {
      await settleUntil(() => calls.length === 2);
      second = up('up-2');
      const sinking = inbound.sink(
        message({
          conversation: 'thread-1',
          root: 'root-1',
          key: 'live-1',
          ref: 'live-1',
          text: 'Live',
        }),
      );
      gate.resolve(undefined);
      await sinking;
      await first;
      await second;
    } finally {
      gate.resolve(undefined);
    }
    expect(
      (
        await store.db
          .selectFrom('comment')
          .select('text')
          .where('block_id', '=', 1)
          .orderBy('id')
          .execute()
      ).map((row) => row.text),
    ).toEqual(['Missed', 'Live']);
    expect(calls).toEqual(['thread-1', 'thread-2', 'thread-1', 'thread-2']);
  });

  it('starts a new scan for a request made just after the last slice ends', async () => {
    const { store, gateway } = await setup();
    let calls = 0;
    let delay = 0;
    const seconds: Promise<void>[] = [];
    const inbound = recoveringInbound(store, gateway, (request) => {
      calls += 1;
      const schedule = calls % 2 === 1;
      return (async function* () {
        yield* gateway.recover(request);
        if (!schedule) return;
        // Request again a set number of microtasks after the first scan's last read ends.
        void (async () => {
          for (let tick = 0; tick < delay; tick += 1) await Promise.resolve();
          seconds.push(inbound.recover());
        })();
      })();
    });
    for (delay = 0; delay < 30; delay += 1) {
      const before = calls;
      await inbound.recover();
      await settleUntil(() => seconds.length > delay);
      await seconds[delay];
      expect({ delay, calls: calls - before }).toEqual({ delay, calls: 2 });
    }
  });

  it('aborts the recovery signal on stop and scans nothing after', async () => {
    const { store, gateway } = await setup();
    const signals: AbortSignal[] = [];
    const inbound = recoveringInbound(store, gateway, (request) => {
      const signal = request.signal;
      if (signal === undefined) throw new Error('Expected a recovery signal');
      signals.push(signal);
      return (async function* () {
        await abortOf(signal);
        yield* gateway.recover({ conversations: [], since: new Date(now) });
      })();
    });
    const scanning = inbound.recover();
    await settleUntil(() => signals.length === 1);
    await inbound.stop();
    expect(signals[0]?.aborted).toBe(true);
    await inbound.stop();
    await scanning;
    await inbound.recover();
    expect(signals).toHaveLength(1);
  });

  it.each(['button', 'retryStored', 'retrying'] as const)(
    "reads a retried reply's thread before re-applying it during a scan (%s)",
    async (via) => {
      const { store, gateway } = await setup();
      await addSecondConversation(store, gateway.kind);
      const stored = message({ conversation: 'thread-2', root: 'root-2', key: 'failed-2' });
      const failure = await scanTransaction(store, config, async (trx) => {
        const item = await raiseOperatorItem(trx, {
          itemKey: 'inbound:failed-2',
          kind: 'inbound_failure',
          text: 'Slack message not processed',
          url: '',
          taskId: 1,
          blockId: null,
          at: new Date(now),
        });
        await trx
          .updateTable('operator_item')
          .set({ inbound_event_json: JSON.stringify(stored) })
          .where('id', '=', item.id)
          .execute();
        return item.id;
      });
      const gate = Promise.withResolvers<undefined>();
      const calls: string[] = [];
      const inbound = recoveringInbound(store, gateway, (request) => {
        const ref = request.conversations[0]?.ref ?? '';
        calls.push(ref);
        return (async function* () {
          if (ref === 'thread-1') await gate.promise;
        })();
      });
      const scanning = inbound.recover();
      try {
        await settleUntil(() => calls.includes('thread-1'));
        const retrying =
          via === 'button'
            ? inbound.sink({
                kind: 'action',
                dedupeKey: 'retry-press',
                interaction: interactionRefSchema.parse('interaction-retry'),
                actionId: `item:${String(failure)}:retry`,
                author: userIdSchema.parse('operator'),
                conversation: conversationRefSchema.parse('feed-1'),
                message: messageRefSchema.parse('feed-line-1'),
                rootMessage: messageRefSchema.parse('feed-line-1'),
                sourceUrl: 'https://example.test/feed',
                sourceSpace: 'feed',
              })
            : via === 'retryStored'
              ? inbound.retryStored(failure)
              : inbound.retrying(`I${String(failure)}`, () => Promise.resolve());
        gate.resolve(undefined);
        await retrying.catch(() => undefined);
        // The stored reply's thread was read before the retry, not after it.
        expect(calls).toEqual(['thread-1', 'thread-2']);
        await scanning;
      } finally {
        gate.resolve(undefined);
      }
      expect(calls).toEqual(['thread-1', 'thread-2']);
    },
  );

  it('applies no buffered recovered event after stop', async () => {
    const { store, gateway } = await setup();
    let yielded = 0;
    const inbound = recoveringInbound(store, gateway, (request) => {
      const signal = request.signal;
      if (signal === undefined) throw new Error('Expected a recovery signal');
      return (async function* () {
        // Like a gateway yielding history it loaded before the abort, without checking it.
        yielded += 1;
        yield message({ conversation: 'thread-1', root: 'root-1', key: 'first', ref: 'first' });
        await abortOf(signal);
        yielded += 1;
        yield message({
          conversation: 'thread-1',
          root: 'root-1',
          key: 'second',
          ref: 'second',
          text: 'Later',
        });
      })();
    });
    const scanning = inbound.recover();
    await settleUntil(() => yielded === 1);
    await inbound.stop();
    await scanning;
    expect(yielded).toBe(2);
    expect(
      await store.db
        .selectFrom('comment')
        .select('text')
        .where('conversation_ref', '=', 'thread-1')
        .orderBy('id')
        .execute(),
    ).toEqual([{ text: 'Yes' }]);
  });

  it('raises a gap for an unread conversation when a live event arrives after stop', async () => {
    const { store, gateway } = await setup();
    await addSecondConversation(store, gateway.kind);
    const calls: string[] = [];
    const inbound = recoveringInbound(store, gateway, (request) => {
      const signal = request.signal;
      if (signal === undefined) throw new Error('Expected a recovery signal');
      calls.push(request.conversations[0]?.ref ?? '');
      return (async function* () {
        await abortOf(signal);
        yield* gateway.recover({ conversations: [], since: new Date(now) });
      })();
    });
    const scanning = inbound.recover();
    await settleUntil(() => calls.includes('thread-1'));
    await inbound.stop();
    await scanning;
    await inbound.sink(
      message({ conversation: 'thread-2', root: 'root-2', key: 'live-2', ref: 'live-2' }),
    );
    expect(calls).toEqual(['thread-1']);
    const scope = createHash('sha256')
      .update(JSON.stringify([gateway.kind, 'thread-2']))
      .digest('hex');
    expect(
      await store.db
        .selectFrom('operator_item')
        .select(['kind', 'item_key'])
        .where('kind', '=', 'inbound_gap')
        .execute(),
    ).toEqual([{ kind: 'inbound_gap', item_key: `inbound:gap:${scope}` }]);
    expect(
      await store.db
        .selectFrom('comment')
        .select('text')
        .where('conversation_ref', '=', 'thread-2')
        .execute(),
    ).toEqual([{ text: 'Yes' }]);
  });
});

/** Block 2 on task 1 with its own open conversation, created after `thread-1`. */
async function addSecondConversation(store: Store, gateway: string): Promise<void> {
  const created = new Date(now + 1000).toISOString();
  await scanTransaction(store, config, async (trx) => {
    await trx
      .insertInto('block')
      .values({
        task_id: 1,
        type: 'needs_input',
        reason: 'Which other way?',
        author: 'system',
        addressee_role: 'operator',
        target_column: null,
        state: 'open',
        outcome: null,
        outcome_reason: null,
        repeat_of: null,
        unblocked_by: null,
        unblocked_at: null,
        created_at: created,
      })
      .execute();
    await trx
      .insertInto('conversation')
      .values({
        gateway,
        ref: 'thread-2',
        space: 'orchestrators',
        task_id: 1,
        block_id: 2,
        purpose: 'block',
        state: 'open',
        root_message_ref: 'root-2',
        after_message_ref: null,
        created_at: created,
        closed_at: null,
      })
      .execute();
  });
}

/** The test's inbound with `recover` replaced on its fake gateway. */
function recoveringInbound(store: Store, gateway: Gateway, recover: Gateway['recover']) {
  return createInbound({
    store,
    config,
    clock: { now: () => now },
    gateway: { ...gateway, recover },
  });
}

/** Lets queued work run until `done` holds; throws instead of hanging when it never does. */
async function settleUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition not reached');
}

function abortOf(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => {
      resolve();
    });
  });
}

describe('anomaly block', () => {
  it('closes an anomaly block on an operator reply without an author-unavailable item', async () => {
    const { store, inbound } = await setup();
    const ledger = await scanTransaction(store, config, (trx) =>
      raiseOperatorItem(trx, {
        itemKey: 'pr-closed:1',
        kind: 'anomaly',
        text: 'o/r#101: PR closed',
        url: 'https://github.com/o/r/issues/101',
        taskId: 1,
        blockId: 1,
        at: new Date(now),
        fingerprint: 'closed-pr',
      }),
    );
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1', text: 'Dropped it' }));
    expect(
      await store.db
        .selectFrom('block')
        .select(['state', 'outcome', 'unblocked_by'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'unblocked', outcome: 'done', unblocked_by: 'operator' });
    expect(
      await store.db.selectFrom('operator_item').select(['id', 'kind', 'cleared_at']).execute(),
    ).toEqual([{ id: ledger.id, kind: 'anomaly', cleared_at: at }]);
    expect(
      await store.db.selectFrom('dismissal').select(['item_key', 'fingerprint']).execute(),
    ).toEqual([{ item_key: 'pr-closed:1', fingerprint: 'closed-pr' }]);
    expect(
      await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'feed.line').execute(),
    ).toEqual([]);
    expect(
      (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind),
    ).not.toContain('doorbell_undelivered');
  });
});

describe('operator token revoke from the gateway', () => {
  const secret = (name: string) => `example-${name}-token-value`;

  async function tokenBoard() {
    const { store, gateway } = await setup();
    const responses: string[] = [];
    const inbound = createInbound({
      store,
      config,
      clock: { now: () => now },
      gateway: {
        ...gateway,
        respond(_interaction, body, options) {
          expect(options.private).toBe(true);
          responses.push(
            body[0]?.kind === 'paragraph'
              ? body[0].children.map((part) => (part.kind === 'text' ? part.text : '')).join('')
              : '',
          );
          return Promise.resolve('sent' as const);
        },
      },
    });
    const request = async (name: string, requestedAt = now) => {
      await requestToken(
        store,
        config,
        {
          name,
          folder: `workspace/${name}`,
          host: 'local',
          hash: createHash('sha256').update(secret(name)).digest('hex'),
        },
        new Date(requestedAt),
      );
      const row = await store.db
        .selectFrom('operator_token')
        .select('item_id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      return row.item_id;
    };
    const press = (
      actionId: string,
      dedupeKey: string,
      author = 'operator',
      sourceSpace: 'feed' | 'orchestrators' = 'feed',
    ): InboundEvent => ({
      kind: 'action',
      dedupeKey,
      interaction: interactionRefSchema.parse(`interaction-${dedupeKey}`),
      actionId,
      author: userIdSchema.parse(author),
      conversation: conversationRefSchema.parse('feed-thread'),
      message: messageRefSchema.parse('feed-line'),
      rootMessage: messageRefSchema.parse('feed-line'),
      sourceUrl: 'https://example.test/board',
      sourceSpace,
    });
    const tokens = (dedupeKey: string, author = 'operator'): InboundEvent => ({
      kind: 'command',
      dedupeKey,
      interaction: interactionRefSchema.parse(`interaction-${dedupeKey}`),
      author: userIdSchema.parse(author),
      text: 'tokens',
      command: { kind: 'query', id: 'token.list', input: {} },
      sourceUrl: 'https://example.test/command',
    });
    const outboxKeys = async () =>
      (await store.db.selectFrom('outbox').select('dedupe_key').orderBy('id').execute()).map(
        (row) => row.dedupe_key,
      );
    const status = async (name: string) =>
      (
        await store.db
          .selectFrom('operator_token')
          .select('status')
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
      ).status;
    const events = async (kind: string) =>
      store.db.selectFrom('event').select('request_id').where('kind', '=', kind).execute();
    return { store, inbound, responses, request, press, tokens, outboxKeys, status, events };
  }

  it('revokes a token from its card as the operator', async () => {
    const { store, inbound, responses, request, press, status } = await tokenBoard();
    const item = await request('desk');
    await inbound.sink(press(`token:${String(item)}:approve`, 'approve-1'));
    expect(await verifyOperatorToken(store, secret('desk'), new Date(now), () => {})).toEqual({
      name: 'desk',
    });
    await inbound.sink(press(`token:${String(item)}:revoke`, 'revoke-1'));
    expect(await status('desk')).toBe('revoked');
    expect(await verifyOperatorToken(store, secret('desk'), new Date(now), () => {})).toBeNull();
    expect(
      await store.db
        .selectFrom('command')
        .select(['actor', 'key', 'operation'])
        .where('key', '=', 'revoke-1')
        .execute(),
    ).toEqual([{ actor: 'operator', key: 'revoke-1', operation: 'token.revoke' }]);
    const card = await store.db
      .selectFrom('outbox')
      .select('id')
      .where('dedupe_key', '=', `feed.line.edit:token-card:${String(item)}`)
      .executeTakeFirstOrThrow();
    expect(
      await store.db
        .selectFrom('outbox')
        .select('parent_outbox_id')
        .where('dedupe_key', '=', `feed.line.edit:token-card:${String(item)}:revoked`)
        .execute(),
    ).toEqual([{ parent_outbox_id: card.id }]);
    expect(responses).toEqual(['desk: approved', 'desk: revoked']);
  });

  it('adds nothing for a replayed or repeated Revoke click', async () => {
    const { inbound, responses, request, press, outboxKeys, events } = await tokenBoard();
    const item = await request('desk');
    await inbound.sink(press(`token:${String(item)}:approve`, 'approve-1'));
    await inbound.sink(press(`token:${String(item)}:revoke`, 'revoke-1'));
    const keys = await outboxKeys();
    expect(keys.filter((key) => key.startsWith('feed.line:token-revoked:'))).toHaveLength(1);
    await inbound.sink(press(`token:${String(item)}:revoke`, 'revoke-1'));
    expect(await outboxKeys()).toEqual(keys);
    await inbound.sink(press(`token:${String(item)}:revoke`, 'revoke-2'));
    expect(await outboxKeys()).toEqual(keys);
    expect(responses).toEqual([
      'desk: approved',
      'desk: revoked',
      'desk: revoked',
      'desk: revoked',
    ]);
    expect(await events('token_revoked')).toHaveLength(1);
  });

  it('refuses a Revoke click by anyone but the operator with no side effects', async () => {
    const { inbound, responses, request, press, outboxKeys, status, events } = await tokenBoard();
    const item = await request('desk');
    await inbound.sink(press(`token:${String(item)}:approve`, 'approve-1'));
    const keys = await outboxKeys();
    await inbound.sink(press(`token:${String(item)}:revoke`, 'foreign', 'another'));
    await inbound.sink(
      press(`token:${String(item)}:revoke`, 'wrong-space', 'operator', 'orchestrators'),
    );
    expect(await status('desk')).toBe('approved');
    expect(await outboxKeys()).toEqual(keys);
    expect(await events('operation_denied')).toEqual([{ request_id: 'foreign' }]);
    expect(await events('token_revoked')).toEqual([]);
    expect(responses).toEqual(['desk: approved', 'not allowed', 'not allowed']);
  });

  it('refuses a Revoke click on an expired request with no side effects', async () => {
    const { inbound, responses, request, press, outboxKeys, status, events } = await tokenBoard();
    const item = await request('old', now - 20 * 60 * 1000);
    const keys = await outboxKeys();
    await inbound.sink(press(`token:${String(item)}:revoke`, 'revoke-old'));
    expect(await status('old')).toBe('pending');
    expect(await outboxKeys()).toEqual(keys);
    expect(await events('token_revoked')).toEqual([]);
    expect(responses).toEqual(['old: request already ended']);
  });

  it('refuses a Revoke click on a denied request with no side effects', async () => {
    const { inbound, responses, request, press, outboxKeys, status, events } = await tokenBoard();
    const item = await request('desk');
    await inbound.sink(press(`token:${String(item)}:deny`, 'deny-1'));
    const keys = await outboxKeys();
    await inbound.sink(press(`token:${String(item)}:revoke`, 'revoke-1'));
    expect(await status('desk')).toBe('denied');
    expect(await outboxKeys()).toEqual(keys);
    expect(await events('token_revoked')).toEqual([]);
    expect(responses).toEqual(['desk: denied', 'desk: request already ended']);
  });

  it('posts the active tokens with Revoke buttons for /board tokens once per command', async () => {
    const { store, inbound, responses, request, press, tokens, outboxKeys } = await tokenBoard();
    await request('old', now - 20 * 60 * 1000);
    const desk = await request('desk');
    const lab = await request('lab');
    await inbound.sink(press(`token:${String(desk)}:approve`, 'approve-1'));
    await inbound.sink(tokens('list-1'));
    await inbound.sink(tokens('list-1'));
    const lists = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('dedupe_key', 'like', 'feed.line:token-list:%')
      .execute();
    expect(lists).toHaveLength(1);
    expect(await outboxKeys()).toContain('feed.line:token-list:list-1');
    const payload = JSON.parse(lists[0]?.payload ?? '{}') as {
      text: string;
      actions: { id: string; label: string; confirm: string }[];
    };
    expect(payload.text).toBe('desk (approved), workspace/desk\nlab (pending), workspace/lab');
    expect(payload.actions).toEqual([
      {
        id: `token:${String(desk)}:revoke`,
        label: 'Revoke desk',
        confirm: 'Revoke operator token desk? Calls with it fail at once.',
      },
      {
        id: `token:${String(lab)}:revoke`,
        label: 'Revoke lab',
        confirm: 'Revoke operator token lab? Calls with it fail at once.',
      },
    ]);
    expect(responses.slice(1)).toEqual([
      'Posted 2 operator tokens to the feed.',
      'Posted 2 operator tokens to the feed.',
    ]);
    await inbound.sink(press(`token:${String(lab)}:revoke`, 'revoke-lab'));
    expect(
      await store.db
        .selectFrom('operator_token')
        .select('status')
        .where('name', '=', 'lab')
        .execute(),
    ).toEqual([{ status: 'revoked' }]);
  });

  it('refuses /board tokens from anyone but the operator', async () => {
    const { store, inbound, responses, request, tokens, events } = await tokenBoard();
    await request('desk');
    await inbound.sink(tokens('list-foreign', 'another'));
    expect(
      await store.db
        .selectFrom('outbox')
        .select('id')
        .where('dedupe_key', 'like', 'feed.line:token-list:%')
        .execute(),
    ).toEqual([]);
    expect(await events('operation_denied')).toEqual([{ request_id: 'list-foreign' }]);
    expect(responses).toEqual(['not allowed']);
  });

  it('answers /board tokens with no active tokens privately and posts nothing', async () => {
    const { store, inbound, responses, tokens } = await tokenBoard();
    await inbound.sink(tokens('list-empty'));
    expect(await store.db.selectFrom('outbox').select('id').execute()).toEqual([]);
    expect(responses).toEqual(['No active operator tokens.']);
  });

  it('names one listed token in the singular', async () => {
    const { inbound, responses, request, tokens } = await tokenBoard();
    await request('desk');
    await inbound.sink(tokens('list-one'));
    expect(responses).toEqual(['Posted 1 operator token to the feed.']);
  });

  async function approvedTokens(store: Store, count: number, folder: string) {
    await scanTransaction(store, config, async (trx) => {
      for (let i = 1; i <= count; i++) {
        const item = await raiseOperatorItem(trx, {
          itemKey: `token:t${String(i)}`,
          kind: 'token_request',
          text: `Approve t${String(i)}?`,
          url: '',
          taskId: null,
          blockId: null,
          at: new Date(now),
        });
        await trx
          .insertInto('operator_token')
          .values({
            name: `t${String(i)}`,
            hash: createHash('sha256').update(String(i)).digest('hex'),
            folder,
            host: 'local',
            status: 'approved',
            requested_at: at,
            expires_at: at,
            decided_at: at,
            item_id: item.id,
          })
          .execute();
      }
    });
  }

  async function listPayload(store: Store, key: string) {
    const list = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('dedupe_key', '=', `feed.line:token-list:${key}`)
      .executeTakeFirstOrThrow();
    return JSON.parse(list.payload) as { text: string; actions: unknown[] };
  }

  it('lists and puts Revoke buttons on the first 20 tokens and counts the rest', async () => {
    const { store, inbound, responses, tokens } = await tokenBoard();
    await approvedTokens(store, 21, 'workspace');
    await inbound.sink(tokens('list-long'));
    const payload = await listPayload(store, 'list-long');
    expect(payload.actions).toHaveLength(20);
    const lines = payload.text.split('\n');
    expect(lines).toHaveLength(21);
    expect(lines.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => `t${String(i + 1)} (approved), workspace`),
    );
    expect(lines[20]).toBe('1 more: `board token list`');
    expect(responses).toEqual(['Posted 21 operator tokens to the feed.']);
  });

  it('keeps a list of tokens with all-escaped folders within one 2900-character part', async () => {
    const { store, inbound, responses, tokens } = await tokenBoard();
    await approvedTokens(store, 20, '&'.repeat(1024));
    await inbound.sink(tokens('list-escaped'));
    const payload = await listPayload(store, 'list-escaped');
    const lines = payload.text.split('\n');
    const shown = lines.length - 1;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(20);
    expect(payload.actions).toHaveLength(shown);
    expect(lines.at(-1)).toBe(`${String(20 - shown)} more: \`board token list\``);
    expect(renderedLength(renderBody('spur-board', payload.text))).toBeLessThanOrEqual(2900);
    expect(responses).toEqual(['Posted 20 operator tokens to the feed.']);
  });

  it('retries a failed /board tokens from its item and posts the list once', async () => {
    const { store, inbound, responses, request, tokens } = await tokenBoard();
    await request('desk');
    await sql`CREATE TRIGGER fail_token_list BEFORE INSERT ON outbox
      WHEN NEW.dedupe_key LIKE 'feed.line:token-list:%'
      BEGIN SELECT RAISE(ABORT, 'token list failed'); END`.execute(store.db);
    await inbound.sink(tokens('list-1'));
    expect(responses).toEqual(['not available yet']);
    const item = await store.db
      .selectFrom('operator_item')
      .select(['id', 'inbound_event_json'])
      .where('kind', '=', 'inbound_failure')
      .executeTakeFirstOrThrow();
    const listRows = () =>
      store.db
        .selectFrom('outbox')
        .select('id')
        .where('dedupe_key', '=', 'feed.line:token-list:list-1')
        .execute();
    expect(await listRows()).toEqual([]);
    await sql`DROP TRIGGER fail_token_list`.execute(store.db);

    const stored = item.inbound_event_json ?? '{}';
    const foreign = { ...(JSON.parse(stored) as Record<string, unknown>), author: 'another' };
    await store.db
      .updateTable('operator_item')
      .set({ inbound_event_json: JSON.stringify(foreign) })
      .where('id', '=', item.id)
      .execute();
    await expect(inbound.retryStored(item.id)).rejects.toMatchObject({
      code: 'retry_not_applicable',
    });
    expect(await listRows()).toEqual([]);

    await store.db
      .updateTable('operator_item')
      .set({ inbound_event_json: stored })
      .where('id', '=', item.id)
      .execute();
    await inbound.retryStored(item.id);
    expect(await listRows()).toHaveLength(1);
    expect((await getOperatorItem(store, item.id))?.cleared_at).not.toBeNull();
    await expect(inbound.retryStored(item.id)).rejects.toMatchObject({
      code: 'retry_not_applicable',
    });
    await inbound.sink(tokens('list-1'));
    expect(await listRows()).toHaveLength(1);
  });
});
