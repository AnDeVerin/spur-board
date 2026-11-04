import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
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
    .selectFrom('from_you_item')
    .selectAll()
    .where('item_key', 'like', 'lookup:%')
    .executeTakeFirstOrThrow();
  await store.transaction(async (trx) => {
    await trx
      .insertInto('dismissal')
      .values({
        item_key: item.item_key,
        fingerprint: item.fingerprint,
        dismissed_by: 'operator',
        dismissed_at: new Date(now).toISOString(),
      })
      .execute();
  });
  await tickBoard({ store, config, clock });
  expect((await status()).items.some((entry) => entry.key === item.item_key)).toBe(false);
  now += 1_000;
  await observeOutcome('not_found');
  expect((await status()).items.some((entry) => entry.key === item.item_key)).toBe(false);
  now += 1_000;
  await observeOutcome('no_access');
  expect((await status()).items.some((entry) => entry.key === item.item_key)).toBe(true);
});

it('orders operator blocks, delivery failures, then blind sources', async () => {
  const { store, core, status } = setup();
  await createApply({ store, config, clock })(
    createMembershipMutations(config).add,
    { task: 'o/r#9' },
    'operator',
  );
  const task = await store.db.selectFrom('task').select('id').executeTakeFirstOrThrow();
  await store.transaction(async (trx) => {
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
