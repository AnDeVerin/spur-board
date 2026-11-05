import { scanTransaction } from '../../src/app/secrets.ts';
import { clearItem as clearOperatorItem } from '../../src/app/feed.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  ERRORS,
  OPERATIONS,
  conversationRefSchema,
  interactionRefSchema,
  messageRefSchema,
  userIdSchema,
  type ActorId,
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
  type OperationRegistry,
  type Store,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { requestToken } from '../../src/app/tokens.ts';

const now = Date.parse('2026-11-03T10:00:00.000Z');
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
    sources: [],
    warmingUp: true,
    spurUnavailable: null,
    hostLoad: null,
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
  await scanTransaction(store, async (trx) => {
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
    expect(responses).toEqual(['not allowed', 'not allowed', 'desk: approved', 'desk: approved']);
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
      (await store.db.selectFrom('event').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['operation_denied', 'operation_denied', 'operation_denied']);
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
    await scanTransaction(store, async (trx) => {
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
    await scanTransaction(store, (trx) =>
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
    ).toHaveLength(2);
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
    await scanTransaction(store, (trx) =>
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
    expect(responses).toEqual([
      'Board status: 0 tasks, 0 items needing attention.',
      JSON.stringify({ item: { id: 'I1', task: null, at, summary: 'Closed' } }),
      JSON.stringify({ item: { id: 'I1', task: null, at, summary: 'Closed' } }),
    ]);
    expect(await store.db.selectFrom('command').select(['operation', 'key']).execute()).toEqual([
      { operation: 'item.close', key: 'catalog-close' },
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
        run: () => Promise.resolve(OPERATIONS[1].examples[0].output),
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
    for (const [id, text] of [
      ['task.get', 'task PROJ-123'],
      ['task.history', 'task PROJ-123 history'],
    ] as const) {
      await inbound.sink({
        kind: 'command',
        dedupeKey: id,
        interaction: interactionRefSchema.parse(id),
        author: userIdSchema.parse('operator'),
        text,
        command: { kind: 'query', id, input: { task: 'PROJ-123' } },
        sourceUrl: 'https://example.test/command',
      });
    }
    expect(replies.map((reply) => reply.private)).toEqual([true, true]);
    expect(replies.map((reply) => reply.cliHint)).toEqual([
      'board task PROJ-123',
      'board task history PROJ-123',
    ]);
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
      .select(['kind', 'payload'])
      .where('kind', '=', 'operation_denied')
      .execute();
    expect(deniedEvents).toHaveLength(1);
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
      key: 'board',
      title: 'board: Slack message not processed',
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
      key: 'board',
      title: 'board: repeat your answer',
    });
    await scanTransaction(store, (trx) => clearOperatorItem(trx, 2, new Date(at)));
    expect(
      await store.db
        .selectFrom('outbox')
        .select('kind')
        .where('kind', '=', 'feed.line.edit')
        .execute(),
    ).toHaveLength(1);
    await scanTransaction(store, (trx) => clearOperatorItem(trx, 1, new Date(at)));
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
    await scanTransaction(store, (trx) =>
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

  it('rings a non-worker author with a content-free task pointer', async () => {
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
    await scanTransaction(store, (trx) =>
      trx
        .insertInto('session_snapshot')
        .values({ ...sampleRows.session_snapshot, id: 'sess-1', ended_at: null })
        .execute(),
    );
    const secret = ['xoxb', '123', 'abc'].join('-');
    await inbound.sink(message({ conversation: 'thread-1', root: 'root-1', text: secret }));
    const doorbell = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'doorbell')
      .executeTakeFirstOrThrow();
    const pointer = 'Answer for o/r#101 block B1; read board task o/r#101';
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

  it('keeps an ended author answer pending until a replacement worker arrives', async () => {
    const { store, inbound, gateway } = await setup('agent:proj/sess-1');
    await scanTransaction(store, (trx) =>
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
    await scanTransaction(store, (trx) =>
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
});
