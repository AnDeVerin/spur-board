import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  OPERATIONS,
  type PrFacts,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createMembershipMutations,
  createObservationCore,
  getStatus,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';

const at = '2026-11-04T12:00:00.000Z';
let now = Date.parse(at);
const clock = { now: () => now };
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  health: { hostLoad: { sessions: 2 } },
});
const source = 'github-issues:board:o/r';
const stores: Store[] = [];
function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-observe-')), 'board.db'));
  stores.push(store);
  return {
    store,
    core: createObservationCore({ store, config, clock }),
    apply: createApply({ store, config, clock }),
    mutations: createMembershipMutations(config),
  };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  now = Date.parse(at);
});

function fact(key = 'o/r#9'): TicketFacts {
  return {
    trackerId: source,
    id: 'node-9',
    key,
    title: 'A ticket',
    status: 'open',
    assignee: null,
    sprint: null,
    labels: ['board'],
    inFilter: false,
    url: 'https://github.com/o/r/issues/9',
    updatedAt: at,
  };
}
function prFact(headSha = 'a'.repeat(40)): PrFacts {
  return {
    repo: 'o/r',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'o/r#9 work',
    author: 'worker',
    headSha,
    headBranch: 'o/r#9-work',
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: ['o/r#9'],
    updatedAt: at,
  };
}
function sessionFact(id: string, links: Record<string, string> = {}, ended = false): SessionFacts {
  return {
    id,
    spurProject: 'worker',
    branch: 'o/r#9-work',
    pr: null,
    links,
    lifecycle: ended ? 'completed' : 'running',
    health: 'working',
    healthSince: at,
    lastActivityAt: null,
    endedAt: ended ? at : null,
    endReason: ended ? 'complete' : null,
  };
}

describe('accepted observation', () => {
  it('adds an unseen key immediately and binds stable facts on the next batch', async () => {
    const { store, core, apply, mutations } = setup();
    const added = await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    expect(added.task.key).toBe('o/r#9');
    expect(
      (await store.db.selectFrom('task').select('tracker_id').executeTakeFirst())?.tracker_id,
    ).toBeNull();
    const context = await core.context(source);
    expect(context.observe.tickets).toEqual([{ kind: 'ticket', trackerId: source, key: 'o/r#9' }]);
    const ref = context.observe.tickets[0];
    if (ref === undefined) throw new Error('Missing pending ticket request');
    const ticket = fact();
    await core.observe(source, {
      batch: {
        source,
        observedAt: at,
        complete: true,
        items: [{ kind: 'ticket', facts: ticket }],
        entities: [{ ref, status: 'ok' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    const tasks = await store.db.selectFrom('task').selectAll().execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.tracker_id).toBe('node-9');
    const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
    expect(status.tasks[0]?.ticket?.title).toBe('A ticket');
    const operation = OPERATIONS.find((entry) => entry.id === 'status.get');
    if (operation === undefined) throw new Error('Missing status operation');
    expect(operation.output.safeParse(status).success).toBe(true);
  });

  it('retains a pending key and raises a key-specific item on not_found', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const ref = (await core.context(source)).observe.tickets[0];
    if (ref === undefined) throw new Error('Missing pending ticket request');
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
    const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
    expect(status.tasks).toHaveLength(1);
    expect(status.items.map((item) => item.summary)).toContain('o/r#9: tracker returned not_found');
  });

  it('journals changed PR facts once and replay includes the latest linked facts', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const source = 'github:board:o/r';
    const observe = async (facts: PrFacts) =>
      core.observe(source, {
        batch: {
          source,
          observedAt: new Date(now).toISOString(),
          complete: true,
          items: [{ kind: 'pr', facts }],
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: new Date(now).toISOString(), gone: [] },
        outcomes: [],
      });
    await observe(prFact());
    const first = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'pr_facts_changed')
      .execute();
    expect(first).toHaveLength(1);
    now += 1_000;
    await observe(prFact());
    expect(
      await store.db
        .selectFrom('event')
        .selectAll()
        .where('kind', '=', 'pr_facts_changed')
        .execute(),
    ).toHaveLength(1);
    now += 1_000;
    await observe(prFact('b'.repeat(40)));
    const events = await store.db
      .selectFrom('event')
      .selectAll()
      .where('task_id', '=', first[0]?.task_id ?? -1)
      .orderBy('id')
      .execute();
    expect(events.filter((event) => event.kind === 'head_moved')).toHaveLength(1);
    const facts = events
      .filter((event) => event.kind === 'pr_facts_changed')
      .map((event) => JSON.parse(event.payload) as { facts: PrFacts });
    expect(facts.at(-1)?.facts.headSha).toBe('b'.repeat(40));
  });

  it('links an explicit worker first, keeps reviewer as other, and omits ended sessions from context', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const worker = sessionFact('worker-1', { 'board-worker': 'https://github.com/o/r/issues/9' });
    const reviewer = sessionFact('reviewer-1');
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          { kind: 'session', facts: reviewer },
          { kind: 'session', facts: worker },
        ],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    expect(
      await store.db
        .selectFrom('link')
        .select(['session_id', 'role'])
        .where('entity', '=', 'session')
        .orderBy('session_id')
        .execute(),
    ).toEqual([
      { session_id: 'reviewer-1', role: 'other' },
      { session_id: 'worker-1', role: 'worker' },
    ]);
    now += 1_000;
    const later = new Date(now).toISOString();
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: later,
        complete: true,
        items: [{ kind: 'session', facts: sessionFact('worker-1', worker.links, true) }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: later, gone: [] },
      outcomes: [],
    });
    expect((await core.context('spur')).observe.sessions).toEqual([
      { kind: 'session', id: 'reviewer-1' },
    ]);
    await core.reportSourceState('spur', {
      lastCompleteAt: later,
      blind: { reason: 'auth', message: 'Access rejected' },
      gone: [],
    });
    const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
    expect(status.spurUnavailable).toBe('Spur unavailable: Access rejected');
  });

  it('leaves simultaneous unmarked branch candidates unlinked', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          { kind: 'session', facts: sessionFact('candidate-a') },
          { kind: 'session', facts: sessionFact('candidate-b') },
        ],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    expect(await store.db.selectFrom('link').select('id').execute()).toEqual([]);
  });

  it('links a worker branch that equals the linked PR head even without a key in the branch', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await core.observe('github:board:o/r', {
      batch: {
        source: 'github:board:o/r',
        observedAt: at,
        complete: true,
        items: [
          {
            kind: 'pr',
            facts: {
              ...prFact(),
              headBranch: 'feature-no-key',
            },
          },
        ],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          { kind: 'session', facts: { ...sessionFact('worker-1'), branch: 'feature-no-key' } },
        ],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    expect(
      await store.db
        .selectFrom('link')
        .select(['session_id', 'role'])
        .where('entity', '=', 'session')
        .execute(),
    ).toEqual([{ session_id: 'worker-1', role: 'worker' }]);
  });

  it('persists a host-load episode across a new core instance and a tick', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const worker = {
      ...sessionFact('worker-1', { 'board-worker': 'https://github.com/o/r/issues/9' }),
      health: 'error' as const,
    };
    const other = {
      ...sessionFact('reviewer-1', { 'board-other': 'https://github.com/o/r/issues/9' }),
      health: 'error' as const,
    };
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          { kind: 'session', facts: worker },
          { kind: 'session', facts: other },
        ],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    const first = await store.db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', 'host_load_episode')
      .executeTakeFirst();
    expect(first?.value).not.toBe('null');
    const restarted = createObservationCore({ store, config, clock });
    now += 1_000;
    await tickBoard({ store, config, clock, completeSince: restarted.completeSince });
    const status = await getStatus({
      store,
      config,
      clock,
      completeSince: restarted.completeSince,
    });
    expect(status.hostLoad).toBe('Host under load');
    expect(status.warmingUp).toBe(true);
  });

  it('raises a linked worker health item on a tick even with no PR', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const worker = {
      ...sessionFact('worker-1', { 'board-worker': 'https://github.com/o/r/issues/9' }),
      health: 'needs_input' as const,
    };
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [{ kind: 'session', facts: worker }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    now += config.health.needsInputAfterMs;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
    expect(status.items.some((item) => item.key.includes('needs_input'))).toBe(true);
  });

  it('raises a recovered and recurring health incident with a new item identity', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const link = { 'board-worker': 'https://github.com/o/r/issues/9' };
    const poll = async (health: SessionFacts['health'], since: string) => {
      const observedAt = new Date(now).toISOString();
      await core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt,
          complete: true,
          items: [
            {
              kind: 'session',
              facts: { ...sessionFact('worker-1', link), health, healthSince: since },
            },
          ],
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: observedAt, gone: [] },
        outcomes: [],
      });
    };
    await poll('needs_input', at);
    now += config.health.needsInputAfterMs;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    const first = await store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'like', 'health:%')
      .where('cleared_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (first.fingerprint === null) throw new Error('Health item needs a fingerprint');
    await store.transaction((trx) =>
      trx
        .insertInto('dismissal')
        .values({
          item_key: first.item_key,
          fingerprint: first.fingerprint ?? '',
          dismissed_by: 'operator',
          dismissed_at: new Date(now).toISOString(),
        })
        .execute(),
    );
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    const status = () => getStatus({ store, config, clock, completeSince: core.completeSince });
    expect((await status()).items.some((item) => item.key === first.item_key)).toBe(false);
    now += 1_000;
    await poll('working', new Date(now).toISOString());
    now += 1_000;
    await poll('needs_input', new Date(now).toISOString());
    now += config.health.needsInputAfterMs;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    const recurring = (await status()).items.find((item) => item.key === first.item_key);
    expect(recurring).toBeDefined();
    expect(recurring?.id).not.toBe(`I${String(first.id)}`);
  });

  it('keeps a confirmed vanished-worker item across ticks until new Spur evidence changes it', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const link = { 'board-worker': 'https://github.com/o/r/issues/9' };
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [{ kind: 'session', facts: sessionFact('worker-1', link) }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    now += 1_000;
    const later = new Date(now).toISOString();
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: later,
        complete: true,
        items: [{ kind: 'session', facts: sessionFact('worker-1', link, true) }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: later, gone: [] },
      outcomes: [],
    });
    const status = () => getStatus({ store, config, clock, completeSince: core.completeSince });
    expect((await status()).items.some((item) => item.key.includes('worker_vanished'))).toBe(true);
    now += 60_000;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    expect((await status()).items.some((item) => item.key.includes('worker_vanished'))).toBe(true);
    const newest = new Date(now).toISOString();
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: newest,
        complete: true,
        items: [{ kind: 'session', facts: sessionFact('worker-2', link) }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: newest, gone: [] },
      outcomes: [],
    });
    expect((await status()).items.some((item) => item.key.includes('worker_vanished'))).toBe(false);
  });

  it('rolls back source state when an accepted batch cannot be stored', async () => {
    const { store, core } = setup();
    await expect(
      core.observe(source, {
        batch: {
          source,
          observedAt: at,
          complete: true,
          items: [{ kind: 'ticket', facts: { ...fact(), trackerId: 'other' } }],
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: at, gone: [] },
        outcomes: [],
      }),
    ).rejects.toThrow('unconfigured tracker');
    expect(await store.db.selectFrom('source_state').selectAll().execute()).toEqual([]);
    expect(core.completeSince.has(source)).toBe(false);
  });

  it('journals a distinct unknown Spur value once across core instances', async () => {
    const { store, core } = setup();
    await core.notice('unknown_state', 'future-value');
    await createObservationCore({ store, config, clock }).notice('unknown_state', 'future-value');
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'spur_unknown_state')
        .execute(),
    ).toHaveLength(1);
  });

  it('replays the latest linked ticket, PR, and session facts from one task history', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const ref = (await core.context(source)).observe.tickets[0];
    if (ref === undefined) throw new Error('Missing ticket request');
    await core.observe(source, {
      batch: {
        source,
        observedAt: at,
        complete: true,
        items: [{ kind: 'ticket', facts: fact() }],
        entities: [{ ref, status: 'ok' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    await core.observe('github:board:o/r', {
      batch: {
        source: 'github:board:o/r',
        observedAt: at,
        complete: true,
        items: [{ kind: 'pr', facts: prFact() }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          {
            kind: 'session',
            facts: sessionFact('worker-1', { 'board-worker': 'https://github.com/o/r/issues/9' }),
          },
        ],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    const task = await store.db
      .selectFrom('task')
      .select('id')
      .where('key', '=', 'o/r#9')
      .executeTakeFirstOrThrow();
    const events = await store.db
      .selectFrom('event')
      .select(['kind', 'payload'])
      .where('task_id', '=', task.id)
      .orderBy('id')
      .execute();
    const latest = new Map(
      events
        .filter((event) => event.kind.endsWith('_facts_changed'))
        .map((event) => [event.kind, JSON.parse(event.payload) as { facts: unknown }]),
    );
    expect(latest.get('ticket_facts_changed')?.facts).toMatchObject({ key: 'o/r#9' });
    expect(latest.get('pr_facts_changed')?.facts).toMatchObject({ number: 7 });
    expect(latest.get('session_facts_changed')?.facts).toMatchObject({ id: 'worker-1' });
  });

  it('keeps old ticket facts and marks access unconfirmed on an incomplete batch', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const pending = (await core.context(source)).observe.tickets[0];
    if (pending === undefined) throw new Error('Missing ticket request');
    await core.observe(source, {
      batch: {
        source,
        observedAt: at,
        complete: true,
        items: [{ kind: 'ticket', facts: fact() }],
        entities: [{ ref: pending, status: 'ok' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    const known = (await core.context(source)).observe.tickets[0];
    if (known === undefined) throw new Error('Missing known ticket request');
    now += 1_000;
    await core.observe(source, {
      batch: {
        source,
        observedAt: new Date(now).toISOString(),
        complete: false,
        items: [],
        entities: [{ ref: known, status: 'no_access' }],
      },
      effectiveComplete: false,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [{ ref: known, misses: 0, gone: false }],
    });
    const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
    expect(status.tasks[0]?.ticket?.title).toBe('A ticket');
    expect(status.items.find((item) => item.key.startsWith('lookup:'))?.summary).toContain(
      'no_access',
    );
    expect(status.items.find((item) => item.key.startsWith('lookup:'))?.unconfirmed).toBe(true);
  });

  it('transfers a pending include to the existing stable ticket instead of duplicating active tasks', async () => {
    const { store, core, apply, mutations } = setup();
    await core.observe(source, {
      batch: {
        source,
        observedAt: at,
        complete: true,
        items: [{ kind: 'ticket', facts: { ...fact('o/r#8'), inFilter: true } }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const ref = (await core.context(source)).observe.tickets[0];
    if (ref === undefined) throw new Error('Missing pending ticket request');
    now += 1_000;
    const later = new Date(now).toISOString();
    await core.observe(source, {
      batch: {
        source,
        observedAt: later,
        complete: true,
        items: [{ kind: 'ticket', facts: fact('o/r#9') }],
        entities: [{ ref, status: 'ok' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: later, gone: [] },
      outcomes: [],
    });
    const tasks = await store.db.selectFrom('task').selectAll().orderBy('id').execute();
    expect(tasks).toHaveLength(2);
    expect(tasks.filter((task) => task.membership === 'active')).toHaveLength(1);
    expect(tasks.find((task) => task.membership === 'active')).toMatchObject({
      key: 'o/r#9',
      tracker_id: 'node-9',
      manual_include: 1,
    });
  });
});
