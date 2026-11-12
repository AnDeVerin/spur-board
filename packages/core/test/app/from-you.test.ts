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
  OUTBOX_KINDS,
  tickBoard,
  type Store,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { raiseItem } from '../../src/app/feed.ts';
import { enqueueFeedLine } from '../../src/app/outbox.ts';

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
    outcomes: [{ ref, misses: 3, gone: true }],
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
    outcomes: [{ ref, misses: 4, gone: true }],
  });
  expect((await status()).items.some((item) => item.key.startsWith('source:'))).toBe(false);
});

type EntityRef = Parameters<
  ReturnType<typeof setup>['core']['observe']
>[1]['outcomes'][number]['ref'];

/** One complete poll of `observedSource` that answers `ref` with `status` after `misses`. */
async function observeMiss(
  core: ReturnType<typeof setup>['core'],
  observedSource: string,
  ref: EntityRef,
  status: 'not_found' | 'no_access',
  misses: number,
) {
  const at = new Date(now).toISOString();
  await core.observe(observedSource, {
    batch: {
      source: observedSource,
      observedAt: at,
      complete: true,
      items: [],
      entities: [{ ref, status }],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [{ ref, misses, gone: misses >= 3 }],
  });
}

it('raises a ticket lookup item only once the runner marks it gone and clears it on the first successful lookup', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  const ref = (await core.context(source)).observe.tickets[0];
  if (ref === undefined) throw new Error('Missing ticket request');
  const lookup = async () => (await status()).items.find((item) => item.key.startsWith('lookup:'));
  for (const misses of [1, 2]) {
    await observeMiss(core, source, ref, 'no_access', misses);
    expect(await lookup()).toBeUndefined();
    now += 1_000;
  }
  await observeMiss(core, source, ref, 'no_access', 3);
  const gone = await lookup();
  expect(gone?.summary).toContain('no_access');
  expect(gone?.unconfirmed).toBe(true);
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
  expect(await lookup()).toBeUndefined();
});

it('raises a filter ticket lookup item only once the runner marks it gone', async () => {
  const { core, status } = setup();
  const at = new Date(now).toISOString();
  await core.observe(source, {
    batch: {
      source,
      observedAt: at,
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
            labels: ['board'],
            inFilter: true,
            url: 'https://github.com/o/r/issues/9',
            updatedAt: at,
          },
        },
      ],
      entities: [],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [],
  });
  const ref = (await core.context(source)).observe.tickets[0];
  if (ref === undefined) throw new Error('Missing ticket request');
  const lookup = async () => (await status()).items.find((item) => item.key.startsWith('lookup:'));
  for (const misses of [1, 2]) {
    now += 1_000;
    await observeMiss(core, source, ref, 'not_found', misses);
    expect(await lookup()).toBeUndefined();
  }
  now += 1_000;
  await observeMiss(core, source, ref, 'not_found', 3);
  expect((await lookup())?.summary).toContain('o/r#9: tracker returned not_found');
});

it('raises a linked PR item only once the runner marks it gone', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  const task = await store.db.selectFrom('task').select('id').executeTakeFirstOrThrow();
  await scanTransaction(store, config, (trx) =>
    trx
      .insertInto('link')
      .values({ ...sampleRows.link, task_id: task.id, repo: 'o/r', number: 5 })
      .execute(),
  );
  const prSource = 'github:board:o/r';
  const ref = { kind: 'pr' as const, repo: 'o/r', number: 5 };
  const key = `pr-outcome:${String(task.id)}:o/r#5`;
  const item = async () => (await status()).items.find((entry) => entry.key === key);
  await observeMiss(core, prSource, ref, 'not_found', 1);
  expect(await item()).toBeUndefined();
  now += 1_000;
  await observeMiss(core, prSource, ref, 'no_access', 2);
  expect(await item()).toBeUndefined();
  now += 1_000;
  await observeMiss(core, prSource, ref, 'not_found', 3);
  expect((await item())?.summary).toContain('o/r#9: linked pull request not_found');
  now += 1_000;
  const later = new Date(now).toISOString();
  await core.observe(prSource, {
    batch: {
      source: prSource,
      observedAt: later,
      complete: true,
      items: [],
      entities: [{ ref, status: 'ok' }],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: later, gone: [] },
    outcomes: [{ ref, misses: 0, gone: false }],
  });
  expect(await item()).toBeUndefined();
});

it('keeps a stale tracker source quiet and raises auth blindness', async () => {
  const { store, core, status } = setup();
  const lines = () =>
    store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute();
  const stale = { reason: 'stale', message: 'No complete observation' } as const;
  await core.reportSourceState(source, { blind: stale, gone: [] });
  let current = await status();
  expect(current.items.some((item) => item.key === `source:${source}`)).toBe(false);
  expect(current.sources.find((entry) => entry.source === source)?.blindReason).toBe('stale');
  expect(await lines()).toEqual([]);

  now += 1_000;
  await core.reportSourceState(source, {
    blind: { reason: 'auth', message: 'Access rejected' },
    gone: [],
  });
  const auth = await store.db
    .selectFrom('operator_item')
    .select(['priority', 'line_outbox_id'])
    .where('item_key', '=', `source:${source}`)
    .where('cleared_at', 'is', null)
    .executeTakeFirstOrThrow();
  expect(auth.priority).toBe(2);
  expect(auth.line_outbox_id).not.toBeNull();

  now += 1_000;
  await core.reportSourceState('spur', { blind: stale, gone: [] });
  current = await status();
  expect(current.items.some((item) => item.key === 'source:spur')).toBe(true);
  expect(current.spurUnavailable).toBe('Spur unavailable: No complete observation');
  const spur = await store.db
    .selectFrom('operator_item')
    .select('line_outbox_id')
    .where('item_key', '=', 'source:spur')
    .executeTakeFirstOrThrow();
  expect(spur.line_outbox_id).not.toBeNull();
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
      kind: 'inbound_gap',
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
      outcomes: [{ ref, misses: 3, gone: true }],
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

it('raises a failed delivery item of every outbox kind with no feed line', async () => {
  const { store, core, status } = setup();
  const lineId = OUTBOX_KINDS.indexOf('feed.line') + 1;
  await scanTransaction(store, config, async (trx) => {
    for (const [index, kind] of OUTBOX_KINDS.entries())
      await trx
        .insertInto('outbox')
        .values({
          ...sampleRows.outbox,
          id: index + 1,
          kind,
          dedupe_key: `failed:${String(index + 1)}`,
          state: 'post_failed',
          parent_outbox_id: kind === 'feed.line.edit' ? lineId : null,
        })
        .execute();
  });
  const keys = OUTBOX_KINDS.map((_kind, index) => `delivery:${String(index + 1)}`);
  for (const ticks of [1, 2]) {
    for (let tick = 0; tick < ticks; tick++) {
      now += 1_000;
      await tickBoard({ store, config, clock, completeSince: core.completeSince });
    }
    expect((await status()).items.map((item) => item.key)).toEqual(keys);
    expect(
      await store.db
        .selectFrom('operator_item')
        .select(['item_key', 'kind', 'line_outbox_id'])
        .orderBy('item_key')
        .execute(),
    ).toEqual(keys.map((key) => ({ item_key: key, kind: 'post_failed', line_outbox_id: null })));
    expect(
      await store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute(),
    ).toEqual([{ id: lineId }]);
  }
});

it('re-raises a pre-upgrade delivery item under post_failed', async () => {
  const { store, core } = setup();
  await scanTransaction(store, config, (trx) =>
    trx
      .insertInto('outbox')
      .values({ ...sampleRows.outbox, kind: 'conversation.reply', state: 'post_failed' })
      .execute(),
  );
  await tickBoard({ store, config, clock, completeSince: core.completeSince });
  // Before this kind existed, a failed post was a board observation with a feed line.
  const old = await store.db
    .selectFrom('operator_item')
    .selectAll()
    .where('item_key', '=', 'delivery:1')
    .executeTakeFirstOrThrow();
  const oldLine = await scanTransaction(store, config, (trx) =>
    enqueueFeedLine(trx, {
      itemId: old.id,
      itemKey: old.item_key,
      raise: old.raise_no,
      key: 'spur-board',
      text: old.text,
      title: `spur-board: ${old.text}`,
      url: old.url,
      taskId: null,
      at: new Date(now),
    }),
  );
  await scanTransaction(store, config, (trx) =>
    trx
      .updateTable('operator_item')
      .set({ kind: 'board_observation', line_outbox_id: oldLine })
      .where('id', '=', old.id)
      .execute(),
  );
  now += 1_000;
  await tickBoard({ store, config, clock, completeSince: core.completeSince });
  const items = await store.db
    .selectFrom('operator_item')
    .select(['id', 'kind', 'raise_no', 'cleared_at', 'line_outbox_id'])
    .where('item_key', '=', 'delivery:1')
    .orderBy('raise_no')
    .execute();
  expect(items).toEqual([
    {
      id: old.id,
      kind: 'board_observation',
      raise_no: 1,
      cleared_at: new Date(now).toISOString(),
      line_outbox_id: oldLine,
    },
    {
      id: expect.any(Number) as number,
      kind: 'post_failed',
      raise_no: 2,
      cleared_at: null,
      line_outbox_id: null,
    },
  ]);
  expect(
    await store.db
      .selectFrom('outbox')
      .select('parent_outbox_id')
      .where('kind', '=', 'feed.line.edit')
      .execute(),
  ).toEqual([{ parent_outbox_id: oldLine }]);
});
