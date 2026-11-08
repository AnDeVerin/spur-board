import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actorIdSchema, configSchema, type Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createApply,
  createBlockMutations,
  enqueueConversationClose,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';
import { taskUrl } from '../../src/app/board-utils.ts';
import { reconcileDoorbells, recordRingDelivery } from '../../src/app/doorbells.ts';
import { raiseItem } from '../../src/app/feed.ts';
import { enqueueFeedEdit } from '../../src/app/outbox.ts';
import { scanSecret, scanTransaction } from '../../src/app/secrets.ts';
import type { SenderOptions } from '../../src/app/sender.ts';
import type { Row } from '../../src/store/schema.ts';
import { sampleRows } from '../store/sample-rows.ts';

const KEY = 'o/r#101';
const AT = new Date('2026-11-03T10:00:00.000Z');
const AUTHOR = 'agent:web/worker-1';
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'web', role: 'worker' }],
      columns: [
        { id: 'todo', orchestrator: 'none' },
        { id: 'ready-for-dev', orchestrator: 'none' },
        { id: 'dev', orchestrator: 'none' },
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
const ops = createBlockMutations(config);
const stores: Store[] = [];

function samples() {
  return [
    { name: 'Slack', token: ['xoxb', '123', 'abc'].join('-'), rule: 'slack' },
    { name: 'GitHub', token: ['ghp', 'A'.repeat(36)].join('_'), rule: 'github' },
    { name: 'AWS', token: ['AWS_SECRET_ACCESS_KEY', 'B'.repeat(40)].join('='), rule: 'aws' },
    {
      name: 'private key',
      token: [
        '-----BEGIN PRIVATE KEY-----',
        `MI${'C'.repeat(118)}`,
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      rule: 'privatekey',
    },
  ];
}

async function setup(options: { config?: Config; task?: Partial<Row<'task'>> } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'core-secrets-')), 'board.db');
  const store = openStore(file);
  stores.push(store);
  await store.transaction(async (trx) => {
    await trx
      .insertInto('task')
      .values({
        ...sampleRows.task,
        key: KEY,
        project: 'proj',
        membership: 'active',
        archive_reason: null,
        column: 'qa',
        ...options.task,
      })
      .execute();
    await trx
      .insertInto('link')
      .values({
        ...sampleRows.link,
        session_id: 'worker-1',
        role: 'worker',
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
      })
      .execute();
  });
  return {
    store,
    file,
    apply: createApply({
      store,
      clock: { now: () => AT.getTime() },
      config: options.config ?? config,
    }),
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('gateway secret scan', () => {
  it('links the blocked notice of a Jira task to its Jira issue', async () => {
    const jiraConfig = configSchema.parse({
      projects: [
        {
          id: 'proj',
          tracker: {
            type: 'jira',
            baseUrl: 'https://jira.example.test',
            jql: 'project = PROJ',
            doneStatuses: ['Done'],
            readyStatuses: ['Ready'],
            projectKeys: ['PROJ'],
          },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'web', role: 'worker' }],
          columns: [
            { id: 'todo', orchestrator: 'none' },
            { id: 'ready-for-dev', orchestrator: 'none' },
            { id: 'dev', orchestrator: 'none' },
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
    const jiraOps = createBlockMutations(jiraConfig);
    const { store, apply } = await setup({
      config: jiraConfig,
      task: { key: 'PROJ-7', tracker_kind: 'jira', tracker_id: '7' },
    });
    const token = ['xoxb', '123', 'abc'].join('-');
    await apply(
      jiraOps.ask,
      { task: 'PROJ-7', text: `Please inspect ${token}` },
      AUTHOR,
      'ask-jira',
    );
    const url = 'https://jira.example.test/browse/PROJ-7';
    const items = await store.db.selectFrom('operator_item').selectAll().execute();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('post_blocked');
    expect(items[0]?.url).toBe(url);
    expect(JSON.stringify(items)).not.toContain('github.com');
    const lines = await store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'feed.line')
      .execute();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]?.payload ?? '{}')).toMatchObject({ url });
    expect(lines[0]?.payload).not.toContain('github.com');
  });

  it('requires config at the URL, doorbell, scan and sender boundaries', () => {
    expectTypeOf<Parameters<typeof taskUrl>[1]>().toEqualTypeOf<Config>();
    expectTypeOf<Parameters<typeof reconcileDoorbells>[2]>().toEqualTypeOf<Config>();
    expectTypeOf<Parameters<typeof recordRingDelivery>[5]>().toEqualTypeOf<Config>();
    expectTypeOf<Parameters<typeof scanTransaction>[1]>().toEqualTypeOf<Config>();
    expectTypeOf<SenderOptions['config']>().toEqualTypeOf<Config>();
  });

  it('does not let pasted lint directives suppress a secret match', async () => {
    const { store, apply } = await setup();
    const token = ['xoxb', '123', 'abc'].join('-');
    const text = ['<!-- secretlint-disable -->', token, '<!-- secretlint-enable -->'].join('\n');
    expect(await scanSecret(text)).toContain('slack');
    await apply(ops.ask, { task: KEY, text }, AUTHOR, 'ask-with-directive');
    expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([
      { kind: 'feed.line' },
    ]);
  });

  it.each(samples())(
    'blocks $name in a question before outbox insertion',
    async ({ token, rule }) => {
      const { store, apply } = await setup();
      expect(await scanSecret(token)).toContain(rule);
      const asked = await apply(
        ops.ask,
        { task: KEY, text: `Please inspect ${token}` },
        AUTHOR,
        'ask-1',
      );
      expect(asked.block.state).toBe('open');
      const outbox = await store.db.selectFrom('outbox').select(['kind', 'payload']).execute();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.kind).toBe('feed.line');
      expect(outbox[0]?.payload).toContain(KEY);
      expect(outbox[0]?.payload).toContain(rule);
      expect(outbox[0]?.payload).not.toContain(token);
      expect(JSON.parse(outbox[0]?.payload ?? '{}')).toMatchObject({
        url: 'https://github.com/o/r/issues/101',
      });
      const comments = await store.db
        .selectFrom('comment')
        .select(['text', 'delivery_state'])
        .execute();
      expect(comments).toEqual([
        { text: `Please inspect ${token}`, delivery_state: 'post_blocked' },
      ]);
      const items = await store.db.selectFrom('operator_item').selectAll().execute();
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toContain(rule);
      expect(items[0]?.url).toBe('https://github.com/o/r/issues/101');
      expect(items[0]?.line_outbox_id).not.toBeNull();
      expect(JSON.stringify(items)).not.toContain(token);
      const raised = await store.db
        .selectFrom('event')
        .select('payload')
        .where('kind', '=', 'from_you_raised')
        .execute();
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toContain(rule);
      expect(JSON.stringify(raised)).not.toContain(token);
      await tickBoard({
        store,
        config,
        clock: { now: () => AT.getTime() },
        completeSince: new Map(),
      });
      expect(await store.db.selectFrom('operator_item').select('id').execute()).toHaveLength(1);
    },
  );

  it('rejects an attempted matching insert and retains no row after reopening', async () => {
    const { store, file, apply } = await setup();
    const token = ['xoxb', '123', 'abc'].join('-');
    await sql
      .raw(
        `CREATE TRIGGER reject_secret BEFORE INSERT ON outbox WHEN instr(NEW.payload, '${token}') > 0 BEGIN SELECT RAISE(ABORT, 'attempted secret insert'); END`,
      )
      .execute(store.db);
    await apply(ops.ask, { task: KEY, text: token }, AUTHOR, 'ask-1');
    expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([
      { kind: 'feed.line' },
    ]);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openStore(file);
    stores.push(reopened);
    expect(await reopened.db.selectFrom('outbox').select('kind').execute()).toEqual([
      { kind: 'feed.line' },
    ]);
  });

  it('queues clean text unchanged and lets a blocked question be answered', async () => {
    const { store, apply } = await setup();
    await apply(ops.ask, { task: KEY, text: 'Which version?' }, AUTHOR, 'clean-ask');
    const rows = await store.db.selectFrom('outbox').select('payload').execute();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ text: 'Which version?' });
    const blocked = await apply(
      ops.ask,
      { task: KEY, text: ['xoxb', '123', 'abc'].join('-') },
      AUTHOR,
      'blocked-ask',
    );
    const answered = await apply(
      ops.answer,
      { block: blocked.block.id, text: 'Handled locally.' },
      'operator',
      'answer-1',
    );
    expect(answered.block.state).toBe('unblocked');
  });

  it('accepts 128 distinct clean feed lines in one operation', async () => {
    const { store } = await setup();
    const transaction = vi.spyOn(store, 'transaction');
    await scanTransaction(store, config, async (trx) => {
      for (let i = 0; i < 128; i += 1) {
        await raiseItem(trx, {
          itemKey: `review:${String(i)}`,
          kind: 'review_required',
          text: `Review item ${String(i)}`,
          url: 'https://github.com/o/r/issues/101',
          taskId: 1,
          blockId: null,
          at: AT,
        });
      }
    });
    const rows = await store.db.selectFrom('outbox').select('id').execute();
    expect(rows).toHaveLength(128);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('blocks a secret-bearing reply while retaining the clean root', async () => {
    const { store, apply } = await setup();
    const root = await apply(ops.ask, { task: KEY, text: 'Which version?' }, AUTHOR, 'ask-1');
    await tickBoard({
      store,
      config,
      clock: { now: () => AT.getTime() },
      completeSince: new Map(),
    });
    const originalItem = await store.db
      .selectFrom('operator_item')
      .select(['id', 'cleared_at'])
      .where('item_key', '=', 'operator-block:1')
      .executeTakeFirstOrThrow();
    expect(originalItem.cleared_at).toBeNull();
    const token = ['ghp', 'A'.repeat(36)].join('_');
    await apply(ops.add, { task: KEY, block: root.block.id, text: token }, AUTHOR, 'reply-1');
    await tickBoard({
      store,
      config,
      clock: { now: () => AT.getTime() },
      completeSince: new Map(),
    });
    expect(
      await store.db
        .selectFrom('operator_item')
        .select('cleared_at')
        .where('id', '=', originalItem.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ cleared_at: null });
    const rows = await store.db.selectFrom('outbox').select('kind').execute();
    expect(rows).toEqual([
      { kind: 'conversation.open' },
      { kind: 'feed.line' },
      { kind: 'feed.line' },
    ]);
    const comments = await store.db
      .selectFrom('comment')
      .select(['delivery_state'])
      .orderBy('id')
      .execute();
    expect(comments).toEqual([{ delivery_state: 'pending' }, { delivery_state: 'post_blocked' }]);
    expect(await store.db.selectFrom('operator_item').select('id').execute()).toHaveLength(2);
  });

  it('blocks feed lines, close lines, and edit text at the common guard', async () => {
    const { store, apply } = await setup();
    const token = ['xoxb', '123', 'abc'].join('-');
    const root = await apply(ops.ask, { task: KEY, text: 'Which version?' }, AUTHOR, 'ask-1');
    await scanTransaction(store, config, (trx) =>
      enqueueConversationClose(trx, {
        blockId: Number(root.block.id.slice(1)),
        outcome: 'done',
        actor: actorIdSchema.parse(`agent:${token}/s1`),
        at: AT,
      }),
    );
    expect(
      (await store.db.selectFrom('outbox').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['conversation.open', 'feed.line']);

    const blockedItem = await scanTransaction(store, config, (trx) =>
      raiseItem(trx, {
        itemKey: 'secret-feed',
        kind: 'review_required',
        text: token,
        url: 'https://github.com/o/r/issues/101',
        taskId: 1,
        blockId: null,
        at: AT,
      }),
    );
    expect(blockedItem.line_outbox_id).toBeNull();
    expect(
      (await store.db.selectFrom('outbox').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['conversation.open', 'feed.line', 'feed.line']);

    const cleanItem = await scanTransaction(store, config, (trx) =>
      raiseItem(trx, {
        itemKey: 'clean-feed',
        kind: 'review_required',
        text: 'Review clean item',
        url: 'https://github.com/o/r/issues/101',
        taskId: 1,
        blockId: null,
        at: AT,
      }),
    );
    if (cleanItem.line_outbox_id === null) throw new Error('Expected clean feed line');
    await scanTransaction(store, config, (trx) =>
      enqueueFeedEdit(trx, {
        itemKey: cleanItem.item_key,
        raise: cleanItem.raise_no,
        lineId: cleanItem.line_outbox_id ?? 0,
        key: token,
        taskId: 1,
        summary: 'Review clean item',
        url: '',
        by: 'system',
        at: AT,
      }),
    );
    expect(
      (await store.db.selectFrom('outbox').select('kind').execute()).map((row) => row.kind),
    ).toEqual(['conversation.open', 'feed.line', 'feed.line', 'feed.line', 'feed.line']);
    const notices = await store.db
      .selectFrom('operator_item')
      .select(['kind', 'text'])
      .where('kind', '=', 'post_blocked')
      .execute();
    expect(notices).toHaveLength(3);
    expect(JSON.stringify(notices)).not.toContain(token);
  });
});
