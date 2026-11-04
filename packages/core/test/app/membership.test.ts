import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type TicketFacts } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  createApply,
  createMembershipMutations,
  createObservationCore,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';

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
});
const source = 'github-issues:board:o/r';
const github = 'github:board:o/r';
const stores: Store[] = [];
function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-membership-')), 'board.db'));
  stores.push(store);
  return { store, core: createObservationCore({ store, config, clock }) };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  now = base;
});
function fact(inFilter: boolean, status = 'open'): TicketFacts {
  return {
    trackerId: source,
    id: 'node-9',
    key: 'o/r#9',
    title: 'Ticket',
    status,
    assignee: null,
    sprint: null,
    labels: ['board'],
    inFilter,
    url: 'https://github.com/o/r/issues/9',
    updatedAt: new Date(now).toISOString(),
  };
}
async function ticketPoll(
  core: ReturnType<typeof createObservationCore>,
  inFilter: boolean,
  status = 'open',
) {
  const at = new Date(now).toISOString();
  const item = fact(inFilter, status);
  await core.observe(source, {
    batch: {
      source,
      observedAt: at,
      complete: true,
      items: [{ kind: 'ticket', facts: item }],
      entities: [],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [],
  });
}
async function emptyPoll(core: ReturnType<typeof createObservationCore>, id: string) {
  const at = new Date(now).toISOString();
  await core.observe(id, {
    batch: { source: id, observedAt: at, complete: true, items: [], entities: [] },
    effectiveComplete: true,
    state: { lastCompleteAt: at, gone: [] },
    outcomes: [],
  });
}

it('archives filter loss only after a later complete poll from every required source', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true);
  now += 1_000;
  await emptyPoll(core, source);
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('active');
  now += 1_000;
  await emptyPoll(core, 'spur');
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('active');
  now += 1_000;
  await emptyPoll(core, github);
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('active');
  now += 1_000;
  await emptyPoll(core, source);
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('archived');
});

it('archives terminal tasks on the next UTC Saturday and does not revive them', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true, 'closed');
  now = Date.parse('2026-11-07T00:00:00.000Z');
  await tickBoard({ store, config, clock });
  expect(
    await store.db.selectFrom('task').select(['membership', 'archive_reason']).executeTakeFirst(),
  ).toMatchObject({ membership: 'archived', archive_reason: 'done' });
  now += 60_000;
  await ticketPoll(core, true, 'open');
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('archived');
});

it('catches a Saturday archive slot after downtime', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true, 'closed');
  now = Date.parse('2026-11-09T09:00:00.000Z');
  await tickBoard({ store, config, clock });
  const task = await store.db
    .selectFrom('task')
    .select(['membership', 'archive_slot_at'])
    .executeTakeFirst();
  expect(task).toMatchObject({
    membership: 'archived',
    archive_slot_at: '2026-11-07T00:00:00.000Z',
  });
  await tickBoard({ store, config, clock });
  expect(
    await store.db.selectFrom('event').select('id').where('kind', '=', 'task_archived').execute(),
  ).toHaveLength(1);
});

it('does not mark a done ticket terminal while its linked PR is open', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true, 'closed');
  const at = new Date(now).toISOString();
  await core.observe(github, {
    batch: {
      source: github,
      observedAt: at,
      complete: true,
      items: [
        {
          kind: 'pr',
          facts: {
            repo: 'o/r',
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            title: 'o/r#9 work',
            author: 'worker',
            headSha: 'a'.repeat(40),
            headBranch: 'o/r#9-work',
            state: 'open',
            draft: false,
            mergeable: 'unknown',
            mergeState: 'unknown',
            requiredChecks: [],
            checks: [],
            reviews: [],
            reviewThreads: [],
            reviewRequests: [],
            ticketKeys: ['o/r#9'],
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
  expect(
    (await store.db.selectFrom('task').select('terminal_at').executeTakeFirst())?.terminal_at,
  ).toBeNull();
  now = Date.parse('2026-11-07T00:00:00.000Z');
  await tickBoard({ store, config, clock });
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('active');
});

it('manual archive excludes filter discovery until task.add clears it', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true);
  const apply = createApply({ store, config, clock });
  const mutations = createMembershipMutations(config);
  await apply(mutations.archive, { task: 'o/r#9' }, 'operator');
  now += 1_000;
  await ticketPoll(core, true);
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('archived');
  await apply(mutations.add, { task: 'o/r#9' }, 'operator');
  expect(
    await store.db.selectFrom('task').select(['membership', 'manual_exclude']).executeTakeFirst(),
  ).toMatchObject({ membership: 'active', manual_exclude: 0 });
});

it('does not use a poll started before the task changed to prove absence', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true);
  now += 2_000;
  const changed = new Date(now).toISOString();
  await store.transaction(async (trx) => {
    await trx
      .updateTable('task')
      .set({ last_change_at: changed })
      .where('key', '=', 'o/r#9')
      .execute();
  });
  await core.observe(source, {
    batch: {
      source,
      observedAt: new Date(base + 1_000).toISOString(),
      complete: true,
      items: [],
      entities: [],
    },
    effectiveComplete: true,
    state: { lastCompleteAt: new Date(base + 1_000).toISOString(), gone: [] },
    outcomes: [],
  });
  now += 1_000;
  await emptyPoll(core, github);
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('active');
});

it('does not infer filter loss from a partial tracker listing', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true);
  now += 1_000;
  await core.observe(source, {
    batch: {
      source,
      observedAt: new Date(now).toISOString(),
      complete: false,
      items: [],
      entities: [],
    },
    effectiveComplete: false,
    state: { lastCompleteAt: new Date(base).toISOString(), gone: [] },
    outcomes: [],
  });
  now += 1_000;
  await emptyPoll(core, github);
  const task = await store.db.selectFrom('task').select('membership').executeTakeFirst();
  expect(task?.membership).toBe('active');
});

it('retains filter loss with an open linked PR and raises an item', async () => {
  const { store, core } = setup();
  await ticketPoll(core, true);
  const task = await store.db.selectFrom('task').select('id').executeTakeFirstOrThrow();
  await store.transaction(async (trx) => {
    await trx
      .insertInto('pr_snapshot')
      .values({
        repo: 'o/r',
        number: 7,
        head_sha: 'a'.repeat(40),
        head_branch: 'work',
        state: 'open',
        draft: 0,
        mergeable: null,
        merge_state: null,
        detail: '{}',
        source: github,
        observed_at: new Date(now).toISOString(),
      })
      .execute();
    await trx
      .insertInto('link')
      .values({
        task_id: task.id,
        entity: 'pr',
        repo: 'o/r',
        number: 7,
        pr_state: 'active',
        session_id: null,
        role: null,
        source: 'manual',
        banned: 0,
        created_at: new Date(now).toISOString(),
      })
      .execute();
  });
  now += 1_000;
  await emptyPoll(core, source);
  now += 1_000;
  await emptyPoll(core, github);
  now += 1_000;
  await emptyPoll(core, source);
  expect(
    (await store.db.selectFrom('task').select('membership').executeTakeFirst())?.membership,
  ).toBe('out_of_filter');
  expect(
    (
      await store.db.selectFrom('from_you_item').select('summary').where('active', '=', 1).execute()
    ).some((item) => item.summary.includes('left the tracker filter')),
  ).toBe(true);
});
