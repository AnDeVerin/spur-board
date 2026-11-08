import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESERVED_PROJECT, configSchema } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  createApply,
  createMembershipMutations,
  createObservationCore,
  getStatus,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { raiseItem } from '../../src/app/feed.ts';

const base = Date.parse('2026-11-04T12:00:00.000Z');
let now = base;
const clock = { now: () => now };
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  adapters: { github: { intervalMs: 60_000 } },
});
const source = 'github-issues:board:o/r';
const stores: Store[] = [];
function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-items-')), 'board.db'));
  stores.push(store);
  const core = createObservationCore({ store, config, clock });
  return {
    store,
    core,
    status: () => getStatus({ store, config, clock, completeSince: core.completeSince }),
  };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  now = base;
});

it('marks a fact stale only after the strict multiplier boundary, and while blind', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  const ref = (await core.context(source)).observe.tickets[0];
  if (ref === undefined) throw new Error('Missing ticket request');
  const at = new Date(now).toISOString();
  await core.observe(source, {
    batch: {
      source,
      observedAt: at,
      complete: true,
      items: [],
      entities: [{ ref, status: 'not_found' }],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [{ ref, misses: 1, gone: false }],
  });
  now += 180_000;
  expect((await status()).items[0]?.unconfirmed).toBe(false);
  now += 1;
  expect((await status()).items[0]?.unconfirmed).toBe(true);
  now = base + 1_000;
  await core.reportSourceState(source, {
    lastCompleteAt: at,
    blind: { reason: 'auth', message: 'Access rejected' },
    gone: [],
  });
  expect((await status()).items.find((item) => item.key.startsWith('lookup:'))?.unconfirmed).toBe(
    true,
  );
  now += 1_000;
  const recovered = new Date(now).toISOString();
  await core.observe(source, {
    batch: {
      source,
      observedAt: recovered,
      complete: true,
      items: [],
      entities: [{ ref, status: 'not_found' }],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: recovered, gone: [] },
    outcomes: [{ ref, misses: 2, gone: false }],
  });
  expect((await status()).items.some((item) => item.key.startsWith('source:'))).toBe(false);
});

it('clears a missing-key item on the first successful lookup', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  const ref = (await core.context(source)).observe.tickets[0];
  if (ref === undefined) throw new Error('Missing ticket request');
  const at = new Date(now).toISOString();
  await core.observe(source, {
    batch: {
      source,
      observedAt: at,
      complete: true,
      items: [],
      entities: [{ ref, status: 'no_access' }],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [{ ref, misses: 1, gone: false }],
  });
  expect((await status()).items.some((item) => item.summary.includes('no_access'))).toBe(true);
  now += 1_000;
  const later = new Date(now).toISOString();
  await core.observe(source, {
    batch: {
      source,
      observedAt: later,
      complete: true,
      items: [
        {
          kind: 'ticket',
          facts: {
            trackerId: source,
            id: 'node-9',
            key: 'o/r#9',
            title: 'Ticket',
            status: 'open',
            assignee: null,
            sprint: null,
            labels: [],
            inFilter: false,
            url: 'https://github.com/o/r/issues/9',
            updatedAt: later,
          },
        },
      ],
      entities: [{ ref, status: 'ok' }],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: later, gone: [] },
    outcomes: [{ ref, misses: 0, gone: false }],
  });
  expect((await status()).items.some((item) => item.key.startsWith('lookup:'))).toBe(false);
});

it('keeps a dismissed item hidden until the outcome fingerprint changes', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  await scanTransaction(store, config, (trx) =>
    raiseItem(trx, {
      itemKey: 'existing-operator-item',
      kind: 'test_existing',
      text: 'Existing item',
      url: 'https://example.test/item',
      taskId: null,
      blockId: null,
      at: new Date(now),
    }),
  );
  const ref = (await core.context(source)).observe.tickets[0];
  if (ref === undefined) throw new Error('Missing ticket request');
  const observeOutcome = async (outcome: 'not_found' | 'no_access') => {
    const at = new Date(now).toISOString();
    await core.observe(source, {
      batch: {
        source,
        observedAt: at,
        complete: true,
        items: [],
        entities: [{ ref, status: outcome }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [{ ref, misses: 1, gone: false }],
    });
  };
  await observeOutcome('not_found');
  const item = await store.db
    .selectFrom('operator_item')
    .selectAll()
    .where('item_key', 'like', 'lookup:%')
    .executeTakeFirstOrThrow();
  expect(item.id).toBe(2);
  expect(
    await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'feed.line').execute(),
  ).toHaveLength(2);
  const itemFingerprint = item.fingerprint;
  if (itemFingerprint === null) throw new Error('Observation item needs a fingerprint');
  await scanTransaction(store, config, async (trx) => {
    await trx
      .insertInto('dismissal')
      .values({
        item_key: item.item_key,
        fingerprint: itemFingerprint,
        dismissed_by: 'operator',
        dismissed_at: new Date(now).toISOString(),
      })
      .execute();
  });
  await tickBoard({ store, config, clock, completeSince: core.completeSince });
  expect((await status()).items.some((entry) => entry.key === item.item_key)).toBe(false);
  now += 1_000;
  await observeOutcome('not_found');
  expect((await status()).items.some((entry) => entry.key === item.item_key)).toBe(false);
  now += 1_000;
  await observeOutcome('no_access');
  expect((await status()).items.some((entry) => entry.key === item.item_key)).toBe(true);
  expect(
    (
      await store.db
        .selectFrom('operator_item')
        .select('id')
        .where('item_key', '=', item.item_key)
        .where('cleared_at', 'is', null)
        .executeTakeFirst()
    )?.id,
  ).not.toBe(item.id);
  expect(
    await store.db
      .selectFrom('event')
      .select('kind')
      .where('kind', '=', 'from_you_raised')
      .execute(),
  ).toHaveLength(3);
});

it('orders operator blocks, delivery failures, then blind sources', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  const task = await store.db.selectFrom('task').select('id').executeTakeFirstOrThrow();
  await scanTransaction(store, config, async (trx) => {
    await trx
      .insertInto('block')
      .values({
        ...sampleRows.block,
        task_id: task.id,
        state: 'open',
        author: 'agent:board/worker',
        addressee_role: 'operator',
        created_at: new Date(now).toISOString(),
      })
      .execute();
    await trx
      .insertInto('outbox')
      .values({ ...sampleRows.outbox, state: 'post_failed' })
      .execute();
  });
  await core.reportSourceState(source, {
    blind: { reason: 'auth', message: 'Access rejected' },
    gone: [],
  });
  const keys = (await status()).items.map((item) => item.key);
  expect(keys.slice(0, 3).map((key) => key.split(':')[0])).toEqual([
    'operator-block',
    'delivery',
    'source',
  ]);
});

it('clears a Jira authentication item on the first good poll', async () => {
  const jiraConfig = configSchema.parse({
    projects: [
      {
        id: 'jira-board',
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
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-jira-auth-')), 'board.db'));
  stores.push(store);
  const core = createObservationCore({ store, config: jiraConfig, clock });
  await core.reportSourceState('jira:jira-board', {
    blind: { reason: 'auth', message: 'Authentication rejected' },
    gone: [],
  });
  const status = () =>
    getStatus({ store, config: jiraConfig, clock, completeSince: core.completeSince });
  expect((await status()).items.some((item) => item.key.startsWith('source:jira:jira-board'))).toBe(
    true,
  );
  const at = new Date(now).toISOString();
  await core.observe('jira:jira-board', {
    batch: { source: 'jira:jira-board', observedAt: at, complete: true, items: [], entities: [] },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [],
  });
  expect((await status()).items.some((item) => item.key.startsWith('source:jira:jira-board'))).toBe(
    false,
  );
});

it('posts and clears a feed line for a taskless source item', async () => {
  const { store, core, status } = setup();
  await core.reportSourceState(source, {
    blind: { reason: 'auth', message: 'Access rejected' },
    gone: [],
  });
  const item = (await status()).items.find((entry) => entry.key === `source:${source}`);
  expect(item?.task).toBeNull();
  const line = await store.db
    .selectFrom('outbox')
    .selectAll()
    .where('kind', '=', 'feed.line')
    .executeTakeFirst();
  expect(line).toBeDefined();
  expect(JSON.parse(line?.payload ?? '{}')).toMatchObject({
    key: 'spur-board',
    itemId: Number(item?.id.slice(1)),
  });
  await core.reportSourceState(source, { gone: [] });
  expect((await status()).items.some((entry) => entry.key === `source:${source}`)).toBe(false);
  const edit = await store.db
    .selectFrom('outbox')
    .selectAll()
    .where('kind', '=', 'feed.line.edit')
    .executeTakeFirst();
  expect(edit?.parent_outbox_id).toBe(line?.id);
  expect(JSON.parse(edit?.payload ?? '{}')).toMatchObject({
    key: 'spur-board',
    itemKey: `source:${source}`,
  });
  expect(
    await store.db
      .selectFrom('event')
      .select(['kind', 'project', 'task_id'])
      .where('kind', 'in', ['from_you_raised', 'from_you_cleared'])
      .orderBy('id')
      .execute(),
  ).toEqual([
    { kind: 'from_you_raised', project: RESERVED_PROJECT, task_id: null },
    { kind: 'from_you_cleared', project: RESERVED_PROJECT, task_id: null },
  ]);
});

it('keeps failed feed lines and edits actionable without recursively feeding them', async () => {
  const { store, core, status } = setup();
  await scanTransaction(store, config, async (trx) => {
    for (const [id, kind] of [
      [1, 'feed.line'],
      [2, 'feed.line.edit'],
      [3, 'conversation.reply'],
    ] as const)
      await trx
        .insertInto('outbox')
        .values({
          ...sampleRows.outbox,
          id,
          kind,
          dedupe_key: `failed:${String(id)}`,
          state: 'post_failed',
          parent_outbox_id: kind === 'feed.line.edit' ? 1 : null,
        })
        .execute();
  });
  await tickBoard({ store, config, clock, completeSince: core.completeSince });
  expect((await status()).items.map((item) => item.key)).toEqual([
    'delivery:1',
    'delivery:2',
    'delivery:3',
  ]);
  const firstLines = await store.db
    .selectFrom('outbox')
    .select('id')
    .where('kind', '=', 'feed.line')
    .execute();
  expect(firstLines).toHaveLength(2);
  const ordinaryLine = firstLines.find((line) => line.id !== 1);
  expect(ordinaryLine).toBeDefined();
  expect(
    await store.db
      .selectFrom('operator_item')
      .select(['item_key', 'line_outbox_id'])
      .orderBy('item_key')
      .execute(),
  ).toEqual([
    { item_key: 'delivery:1', line_outbox_id: null },
    { item_key: 'delivery:2', line_outbox_id: null },
    { item_key: 'delivery:3', line_outbox_id: ordinaryLine?.id },
  ]);
  await scanTransaction(store, config, (trx) =>
    trx
      .updateTable('outbox')
      .set({ state: 'post_failed' })
      .where('id', '=', ordinaryLine?.id ?? -1)
      .execute(),
  );
  for (let tick = 0; tick < 2; tick++) {
    now += 1_000;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    expect(
      await store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute(),
    ).toHaveLength(2);
  }
  expect((await status()).items.map((item) => item.key)).toContain(
    `delivery:${String(ordinaryLine?.id)}`,
  );
});
