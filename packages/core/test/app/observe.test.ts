import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  OPERATIONS,
  RESERVED_PROJECT,
  type Batch,
  type PrFacts,
  type SourceCursor,
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
import { taskPr } from '../../src/app/board-utils.ts';
import { createLinkMutations } from '../../src/app/links.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { createBlockMutations } from '../../src/app/blocks.ts';
import {
  reconcileDoorbells,
  recordRingDelivery,
  ringUndelivered,
} from '../../src/app/doorbells.ts';
import { closeTurns, openTurn } from '../../src/app/turns.ts';

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
function setup(testConfig = config) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-observe-')), 'board.db'));
  stores.push(store);
  return {
    store,
    core: createObservationCore({ store, config: testConfig, clock }),
    apply: createApply({ store, config: testConfig, clock }),
    mutations: createMembershipMutations(testConfig),
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
    const status = await getStatus(
      { store, config, clock, completeSince: core.completeSince },
      { detail: true },
    );
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
      outcomes: [{ ref, misses: 3, gone: true }],
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
    const add = await store.db
      .selectFrom('command')
      .select('key')
      .where('operation', '=', 'task.add')
      .executeTakeFirstOrThrow();
    expect(events.filter((event) => event.kind === 'task_added')).toMatchObject([
      { request_id: add.key },
    ]);
    const observed = events.filter(
      (event) => event.kind === 'pr_facts_changed' || event.kind === 'head_moved',
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.map((event) => event.request_id)).toEqual(observed.map(() => null));
  });

  it('rewrites stored legacy review requests with kind and id', async () => {
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
    await observe({ ...prFact(), reviewRequests: [{ reviewer: 'carol', asCodeOwner: true }] });
    now += 1_000;
    const current = [{ kind: 'user' as const, id: 'carol', asCodeOwner: true }];
    await observe({ ...prFact(), reviewRequests: current });
    const snapshot = await store.db
      .selectFrom('pr_snapshot')
      .select('detail')
      .executeTakeFirstOrThrow();
    expect((JSON.parse(snapshot.detail) as PrFacts).reviewRequests).toEqual(current);
    expect(
      await store.db
        .selectFrom('event')
        .selectAll()
        .where('kind', '=', 'pr_facts_changed')
        .execute(),
    ).toHaveLength(2);
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

  it('requests curator sessions by id and ends one Spur no longer knows', async () => {
    const curated = configSchema.parse({
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        spurProjects: [...project.spurProjects, { name: 'cur', role: 'curator' }],
      })),
    });
    const { store, core } = setup(curated);
    const curatorFact = { ...sessionFact('cur-1'), spurProject: 'cur', branch: null };
    const observe = (
      items: SessionFacts[],
      entities: { ref: { kind: 'session'; id: string }; status: 'ok' | 'not_found' }[],
    ) =>
      core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt: new Date(now).toISOString(),
          complete: true,
          items: items.map((facts) => ({ kind: 'session' as const, facts })),
          entities,
        },
        effectiveComplete: true,
        state: { lastCompleteAt: new Date(now).toISOString(), gone: [] },
        outcomes: [],
      });
    await observe([curatorFact, sessionFact('worker-9')], []);
    expect((await core.context('spur')).observe.sessions).toEqual([
      { kind: 'session', id: 'cur-1' },
    ]);
    now += 1_000;
    await observe([], [{ ref: { kind: 'session', id: 'cur-1' }, status: 'not_found' }]);
    expect(
      await store.db
        .selectFrom('session_snapshot')
        .select(['ended_at', 'end_reason'])
        .where('id', '=', 'cur-1')
        .executeTakeFirst(),
    ).toEqual({ ended_at: new Date(now).toISOString(), end_reason: 'vanished' });
    expect((await core.context('spur')).observe.sessions).toEqual([]);
  });

  it('hides an unlinked session gone from complete Spur lists for over 7 days until it is listed again', async () => {
    const { store, core } = setup();
    const poll = async (sessions: readonly string[]) => {
      const observedAt = new Date(now).toISOString();
      await core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt,
          complete: true,
          items: sessions.map((id) => ({ kind: 'session' as const, facts: sessionFact(id) })),
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: observedAt, gone: [] },
        outcomes: [],
      });
    };
    const status = () => getStatus({ store, config, clock, completeSince: core.completeSince });
    await poll(['idle-1', 'live-1']);
    now += 60_000;
    await poll(['live-1']);
    now += 8 * 24 * 60 * 60 * 1000;
    const hidden = await status();
    expect(hidden.unlinkedSessions.map((session) => session.id)).toEqual(['live-1']);
    expect(hidden.hiddenUnlinkedSessions).toBe(1);
    await poll(['idle-1', 'live-1']);
    const listed = await status();
    expect(listed.unlinkedSessions.map((session) => session.id).sort()).toEqual([
      'idle-1',
      'live-1',
    ]);
    expect(listed.hiddenUnlinkedSessions).toBe(0);
  });

  it('ages an unlinked session from the first complete Spur poll that omits it, not from its last listing', async () => {
    const { store, core } = setup();
    const poll = async (sessions: readonly string[]) => {
      const observedAt = new Date(now).toISOString();
      await core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt,
          complete: true,
          items: sessions.map((id) => ({ kind: 'session' as const, facts: sessionFact(id) })),
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: observedAt, gone: [] },
        outcomes: [],
      });
    };
    const status = () => getStatus({ store, config, clock, completeSince: core.completeSince });
    const absentSince = async () =>
      (
        await store.db
          .selectFrom('session_snapshot')
          .select('absent_since')
          .where('id', '=', 'idle-1')
          .executeTakeFirstOrThrow()
      ).absent_since;
    await poll(['idle-1', 'live-1']);
    // An 8-day polling outage, then the first recovered complete poll omits idle-1.
    now += 8 * 24 * 60 * 60 * 1000;
    const recovered = new Date(now).toISOString();
    await poll(['live-1']);
    expect(await absentSince()).toBe(recovered);
    const fresh = await status();
    expect(fresh.unlinkedSessions.map((session) => session.id).sort()).toEqual([
      'idle-1',
      'live-1',
    ]);
    expect(fresh.hiddenUnlinkedSessions).toBe(0);
    now += 7 * 24 * 60 * 60 * 1000 + 60_000;
    await poll(['live-1']);
    expect(await absentSince()).toBe(recovered);
    const hidden = await status();
    expect(hidden.unlinkedSessions.map((session) => session.id)).toEqual(['live-1']);
    expect(hidden.hiddenUnlinkedSessions).toBe(1);
    await poll(['idle-1', 'live-1']);
    expect(await absentSince()).toBeNull();
    expect((await status()).hiddenUnlinkedSessions).toBe(0);
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

  it('links a worker session through its pr link to the issue task as other off the PR head, and not an operator-role session', async () => {
    const withOps = {
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        spurProjects: [...project.spurProjects, { name: 'ops', role: 'operator' as const }],
      })),
    };
    const { store, core, apply, mutations } = setup(withOps);
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
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
    const pr = { repo: 'o/r', number: 7 };
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          {
            kind: 'session',
            facts: { ...sessionFact('ops-1'), spurProject: 'ops', branch: 'unrelated', pr },
          },
          { kind: 'session', facts: { ...sessionFact('worker-1'), branch: 'unrelated', pr } },
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
    ).toEqual([{ session_id: 'worker-1', role: 'other' }]);
  });

  it('does not link a curator session through its pr field or a task branch', async () => {
    const withCurator = {
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        spurProjects: [...project.spurProjects, { name: 'cur', role: 'curator' as const }],
      })),
    };
    const { store, core, apply, mutations } = setup(withCurator);
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
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
    const pr = { repo: 'o/r', number: 7 };
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt: at,
        complete: true,
        items: [
          {
            kind: 'session',
            facts: { ...sessionFact('cur-1'), spurProject: 'cur', branch: 'unrelated', pr },
          },
          {
            kind: 'session',
            facts: { ...sessionFact('cur-2'), spurProject: 'cur', branch: 'o/r#9-retry' },
          },
          { kind: 'session', facts: { ...sessionFact('worker-1'), branch: 'unrelated', pr } },
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
    ).toEqual([{ session_id: 'worker-1', role: 'other' }]);
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

  describe('pr field of a worker session', () => {
    const pr = { repo: 'o/r', number: 7 };
    async function sessionLinks(headBranch: string, sessions: SessionFacts[]) {
      const { store, core, apply, mutations } = setup();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      await core.observe('github:board:o/r', {
        batch: {
          source: 'github:board:o/r',
          observedAt: at,
          complete: true,
          items: [{ kind: 'pr', facts: { ...prFact(), headBranch } }],
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
          items: sessions.map((facts) => ({ kind: 'session' as const, facts })),
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: at, gone: [] },
        outcomes: [],
      });
      return store.db
        .selectFrom('link')
        .select(['session_id', 'role', 'source'])
        .where('entity', '=', 'session')
        .orderBy('session_id')
        .execute();
    }

    it('links a session whose branch differs from the PR head as other when the task has no worker', async () => {
      expect(
        await sessionLinks('feature-no-key', [
          { ...sessionFact('reviewer-1'), branch: 'review-7', pr },
        ]),
      ).toEqual([{ session_id: 'reviewer-1', role: 'other', source: 'branch' }]);
    });

    it('links a session whose branch equals the PR head as worker even when the branch is shared', async () => {
      expect(
        await sessionLinks('feature-no-key', [
          { ...sessionFact('worker-1'), branch: 'feature-no-key', pr },
          { ...sessionFact('worker-2'), branch: 'feature-no-key', pr },
        ]),
      ).toEqual([
        { session_id: 'worker-1', role: 'worker', source: 'branch' },
        { session_id: 'worker-2', role: 'other', source: 'branch' },
      ]);
    });

    it('keeps the branch key rule ahead of a pr field off the PR head', async () => {
      expect(
        await sessionLinks('feature-no-key', [
          { ...sessionFact('worker-1'), branch: 'o/r#9-retry', pr },
        ]),
      ).toEqual([{ session_id: 'worker-1', role: 'worker', source: 'branch' }]);
    });

    it('keeps the label rule ahead of a pr field on the PR head', async () => {
      expect(
        await sessionLinks('feature-no-key', [
          {
            ...sessionFact('label-1', { 'board-other': 'https://github.com/o/r/issues/9' }),
            branch: 'feature-no-key',
            pr,
          },
        ]),
      ).toEqual([{ session_id: 'label-1', role: 'other', source: 'spawn_link' }]);
    });
  });

  describe('task key in a worker branch', () => {
    const jiraConfig = configSchema.parse({
      projects: [
        {
          id: 'web',
          tracker: {
            type: 'jira',
            baseUrl: 'https://jira.example.test',
            jql: 'project = WEBDEV',
            doneStatuses: ['Done'],
            readyStatuses: ['Ready'],
            projectKeys: ['WEBDEV'],
          },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'worker', role: 'worker' }],
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    async function linkedKeys(keys: string[], branch: string) {
      const { store, core, apply, mutations } = setup(jiraConfig);
      for (const key of keys) await apply(mutations.add, { task: key }, 'operator');
      await core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt: at,
          complete: true,
          items: [{ kind: 'session', facts: { ...sessionFact('worker-1'), branch } }],
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: at, gone: [] },
        outcomes: [],
      });
      return (
        await store.db
          .selectFrom('link')
          .innerJoin('task', 'task.id', 'link.task_id')
          .select('task.key')
          .where('link.entity', '=', 'session')
          .execute()
      ).map((row) => row.key);
    }

    it('matches the key in any letter case', async () => {
      expect(await linkedKeys(['WEBDEV-5698'], 'claude-webdev-5698')).toEqual(['WEBDEV-5698']);
    });

    it('does not match a key that is a prefix of a longer number', async () => {
      expect(await linkedKeys(['WEBDEV-56'], 'claude-WEBDEV-5698')).toEqual([]);
    });

    it('does not match a key preceded by a letter or digit', async () => {
      expect(await linkedKeys(['WEBDEV-56'], 'claude-XWEBDEV-56')).toEqual([]);
    });

    it('links only the task whose whole key is in the branch', async () => {
      expect(await linkedKeys(['WEBDEV-56', 'WEBDEV-5698'], 'claude-WEBDEV-5698-fix')).toEqual([
        'WEBDEV-5698',
      ]);
    });
  });

  it('persists a host-load episode across a new core instance and a tick', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    // Host load used to raise an item; one left active from before is cleared.
    const old = await store.db
      .insertInto('operator_item')
      .values({
        item_key: 'host-load',
        raise_no: 1,
        kind: 'board_observation',
        text: 'Host under load',
        url: 'https://github.com',
        task_id: null,
        block_id: null,
        raised_at: at,
        cleared_at: null,
        line_outbox_id: null,
        inbound_event_json: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
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
    const hostItems = await store.db
      .selectFrom('operator_item')
      .select(['id', 'cleared_at'])
      .where('item_key', '=', 'host-load')
      .execute();
    expect(hostItems).toEqual([{ id: old.id, cleared_at: expect.any(String) as string }]);
    expect(status.items.some((item) => item.key === 'host-load')).toBe(false);
    expect(
      await store.db
        .selectFrom('outbox')
        .select('id')
        .where('dedupe_key', 'like', 'feed.line:host-load:%')
        .execute(),
    ).toEqual([]);
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

  it('keeps a confirmed ended-worker item across ticks until new Spur evidence changes it', async () => {
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
    expect((await status()).items.some((item) => item.key.endsWith(':worker_completed'))).toBe(
      true,
    );
    now += 60_000;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    expect((await status()).items.some((item) => item.key.endsWith(':worker_completed'))).toBe(
      true,
    );
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
    expect((await status()).items.some((item) => item.key.endsWith(':worker_completed'))).toBe(
      false,
    );
  });

  const observeSpur = async (
    core: ReturnType<typeof setup>['core'],
    items: SessionFacts[],
    entities: { ref: { kind: 'session'; id: string }; status: 'ok' | 'not_found' }[] = [],
  ) => {
    const observedAt = new Date(now).toISOString();
    await core.observe('spur', {
      batch: {
        source: 'spur',
        observedAt,
        complete: true,
        items: items.map((facts) => ({ kind: 'session' as const, facts })),
        entities,
      },
      effectiveComplete: true,
      state: { lastCompleteAt: observedAt, gone: [] },
      outcomes: [],
    });
  };
  const workerLink = { 'board-worker': 'https://github.com/o/r/issues/9' };
  const healthLines = (store: Store) =>
    store.db
      .selectFrom('outbox')
      .select('id')
      .where('kind', '=', 'feed.line')
      .where('dedupe_key', 'like', 'feed.line:health:%')
      .execute();

  it.each([
    {
      reason: 'complete',
      kind: 'worker_completed',
      text: 'o/r#9: worker ended (completed), no PR (worker-1)',
      itemKind: 'anomaly',
      lines: 0,
      blocks: 1,
    },
    {
      reason: 'kill',
      kind: 'worker_killed',
      text: 'o/r#9: worker ended (killed), no PR (worker-1)',
      itemKind: 'worker_ended',
      lines: 0,
      blocks: 0,
    },
    {
      reason: 'vanished',
      kind: 'worker_vanished',
      text: 'o/r#9: worker vanished, no PR (worker-1)',
      itemKind: 'board_observation',
      lines: 1,
      blocks: 0,
    },
  ] as const)(
    'names a $reason worker end in the item and posts $lines feed lines',
    async ({ reason, kind, text, itemKind, lines, blocks }) => {
      const { store, core, apply, mutations } = setup();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      await observeSpur(core, [sessionFact('worker-1', workerLink)]);
      now += 1_000;
      if (reason === 'vanished')
        await observeSpur(
          core,
          [],
          [{ ref: { kind: 'session', id: 'worker-1' }, status: 'not_found' }],
        );
      else
        await observeSpur(core, [
          {
            ...sessionFact('worker-1', workerLink, true),
            endReason: reason,
            lifecycle: reason === 'kill' ? 'killed' : 'completed',
          },
        ]);
      const items = await store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('item_key', 'like', 'health:%')
        .where('cleared_at', 'is', null)
        .execute();
      expect(items.map((item) => [item.item_key.split(':').at(-1), item.text])).toEqual([
        [kind, text],
      ]);
      expect(items[0]?.kind).toBe(itemKind);
      expect(items[0]?.line_outbox_id === null).toBe(lines === 0);
      expect(await healthLines(store)).toHaveLength(lines);
      const open = await store.db
        .selectFrom('block')
        .select(['id', 'author', 'addressee_role'])
        .where('state', '=', 'open')
        .execute();
      expect(open).toHaveLength(blocks);
      expect(items[0]?.block_id ?? null).toBe(open[0]?.id ?? null);
      expect(
        await store.db
          .selectFrom('event')
          .select('id')
          .where('kind', '=', 'from_you_raised')
          .where('payload', 'like', `%"I${String(items[0]?.id)}"%`)
          .execute(),
      ).toHaveLength(1);
    },
  );

  it('re-raises a pre-upgrade completed-worker item under anomaly', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await observeSpur(core, [sessionFact('worker-1', workerLink)]);
    const task = await store.db.selectFrom('task').select('id').executeTakeFirstOrThrow();
    const key = `health:${String(task.id)}:worker-1:worker_completed`;
    // Before ledger items existed, the completed-worker item was a worker_ended row, no block.
    const old = await store.db
      .insertInto('operator_item')
      .values({
        item_key: key,
        raise_no: 1,
        kind: 'worker_ended',
        text: 'o/r#9: worker ended (completed), no PR (worker-1)',
        url: 'https://github.com/o/r/issues/9',
        task_id: task.id,
        block_id: null,
        raised_at: at,
        cleared_at: null,
        line_outbox_id: null,
        fingerprint: null,
        inbound_event_json: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    now += 1_000;
    await observeSpur(core, [sessionFact('worker-1', workerLink, true)]);
    now += 1_000;
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    const blocks = await store.db
      .selectFrom('block')
      .select(['id', 'author', 'addressee_role', 'state'])
      .execute();
    expect(blocks).toEqual([
      {
        id: expect.any(Number) as number,
        author: 'system',
        addressee_role: 'operator',
        state: 'open',
      },
    ]);
    expect(
      await store.db
        .selectFrom('operator_item')
        .select(['id', 'kind', 'raise_no', 'block_id', 'cleared_at', 'line_outbox_id'])
        .where('item_key', '=', key)
        .orderBy('raise_no')
        .execute(),
    ).toEqual([
      {
        id: old.id,
        kind: 'worker_ended',
        raise_no: 1,
        block_id: null,
        // Cleared by the ended-worker poll, one second before the tick.
        cleared_at: new Date(now - 1_000).toISOString(),
        line_outbox_id: null,
      },
      {
        id: expect.any(Number) as number,
        kind: 'anomaly',
        raise_no: 2,
        block_id: blocks[0]?.id,
        cleared_at: null,
        line_outbox_id: null,
      },
    ]);
    expect(
      await store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute(),
    ).toEqual([]);
  });

  it('clears an open pre-upgrade vanished item for a killed worker and raises it without a line', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await observeSpur(core, [sessionFact('worker-1', workerLink)]);
    const task = await store.db.selectFrom('task').select('id').executeTakeFirstOrThrow();
    const oldKey = `health:${String(task.id)}:worker-1:worker_vanished`;
    const line = await store.db
      .insertInto('outbox')
      .values({
        kind: 'feed.line',
        dedupe_key: `feed.line:${oldKey}:1`,
        payload: '{}',
        state: 'done',
        next_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const old = await store.db
      .insertInto('operator_item')
      .values({
        item_key: oldKey,
        raise_no: 1,
        kind: 'board_observation',
        text: 'o/r#9: worker vanished (worker-1)',
        url: 'https://github.com/o/r/issues/9',
        task_id: task.id,
        block_id: null,
        raised_at: at,
        cleared_at: null,
        line_outbox_id: line.id,
        inbound_event_json: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    now += 1_000;
    await observeSpur(core, [
      { ...sessionFact('worker-1', workerLink, true), endReason: 'kill', lifecycle: 'killed' },
    ]);
    const items = await store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'like', 'health:%')
      .orderBy('id')
      .execute();
    expect(items.map((item) => [item.id, item.item_key, item.cleared_at !== null])).toEqual([
      [old.id, oldKey, true],
      [items[1]?.id, `health:${String(task.id)}:worker-1:worker_killed`, false],
    ]);
    expect(items[1]?.line_outbox_id).toBeNull();
    expect((await healthLines(store)).map((row) => row.id)).toEqual([line.id]);
    expect(
      await store.db
        .selectFrom('outbox')
        .select('parent_outbox_id')
        .where('kind', '=', 'feed.line.edit')
        .execute(),
    ).toEqual([{ parent_outbox_id: line.id }]);
  });

  async function restartWithVanishedItem() {
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
    const items = () =>
      store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('item_key', 'like', 'health:%:worker-1:worker_completed')
        .execute();
    const counts = async () => ({
      raised: (
        await store.db
          .selectFrom('event')
          .select('id')
          .where('kind', '=', 'from_you_raised')
          .execute()
      ).length,
      cleared: (
        await store.db
          .selectFrom('event')
          .select('payload')
          .where('kind', '=', 'from_you_cleared')
          .execute()
      ).map((event) => event.payload),
      feed: (
        await store.db
          .selectFrom('outbox')
          .select('id')
          .where('kind', 'in', ['feed.line', 'feed.line.edit'])
          .execute()
      ).length,
    });
    const [item] = await items();
    if (item === undefined) throw new Error('Missing vanished-worker item');
    expect(item.cleared_at).toBeNull();
    const before = await counts();

    const restarted = createObservationCore({ store, config, clock });
    now += 60_000;
    await tickBoard({ store, config, clock, completeSince: restarted.completeSince });
    await restarted.reportSourceState('spur', { lastCompleteAt: later, gone: [] });
    expect(await items()).toEqual([item]);
    expect(await counts()).toEqual(before);
    return { store, restarted, link, item, items, counts, before };
  }

  it("keeps a vanished-worker item across a restart when Spur's first complete poll omits the ended worker", async () => {
    const { store, restarted, item, items, counts, before } = await restartWithVanishedItem();
    const ended = await store.db
      .selectFrom('session_snapshot')
      .select('ended_at')
      .where('id', '=', 'worker-1')
      .executeTakeFirstOrThrow();
    now += 60_000;
    const observedAt = new Date(now).toISOString();
    await restarted.observe('spur', {
      batch: { source: 'spur', observedAt, complete: true, items: [], entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: observedAt, gone: [] },
      outcomes: [],
    });
    expect(restarted.completeSince.has('spur')).toBe(true);
    expect(
      await store.db
        .selectFrom('session_snapshot')
        .select(['absent_since', 'ended_at'])
        .where('id', '=', 'worker-1')
        .executeTakeFirstOrThrow(),
    ).toEqual({ absent_since: observedAt, ended_at: ended.ended_at });
    expect(await items()).toEqual([item]);
    expect(await counts()).toEqual(before);
  });

  it('clears a vanished-worker item once when a replacement worker appeared while the daemon was down', async () => {
    const { restarted, link, item, items, counts, before } = await restartWithVanishedItem();
    now += 60_000;
    const observedAt = new Date(now).toISOString();
    await restarted.observe('spur', {
      batch: {
        source: 'spur',
        observedAt,
        complete: true,
        items: [{ kind: 'session', facts: sessionFact('worker-2', link) }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: observedAt, gone: [] },
      outcomes: [],
    });
    expect((await items()).filter((row) => row.cleared_at === null)).toEqual([]);
    const after = await counts();
    expect(
      after.cleared.filter((payload) => payload.includes(`"I${String(item.id)}"`)),
    ).toHaveLength(1);
    expect(after.raised).toBe(before.raised);
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
        .select(['kind', 'project'])
        .where('kind', '=', 'spur_unknown_state')
        .execute(),
    ).toEqual([{ kind: 'spur_unknown_state', project: RESERVED_PROJECT }]);
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

  it('journals a queue-only session change without moving, archiving or flagging the task', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const linked = sessionFact('worker-1', { 'board-worker': 'https://github.com/o/r/issues/9' });
    const queued: SessionFacts = { ...linked, queuedRings: [{ notification: 1, ring: 1 }] };
    const before = await store.db
      .selectFrom('task')
      .select(['column', 'membership', 'archive_reason'])
      .where('key', '=', 'o/r#9')
      .executeTakeFirstOrThrow();
    const details: unknown[] = [];
    for (const facts of [linked, queued, linked]) {
      now += 15_000;
      const observedAt = new Date(now).toISOString();
      await core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt,
          complete: true,
          items: [{ kind: 'session', facts }],
          entities: [],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: observedAt, gone: [] },
        outcomes: [],
      });
      const row = await store.db
        .selectFrom('session_snapshot')
        .select('detail')
        .where('id', '=', 'worker-1')
        .executeTakeFirstOrThrow();
      details.push(JSON.parse(row.detail));
    }
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    expect(details).toEqual([linked, queued, linked]);
    const kinds = (await store.db.selectFrom('event').select('kind').orderBy('id').execute()).map(
      (event) => event.kind,
    );
    expect(kinds.filter((kind) => kind === 'session_facts_changed')).toHaveLength(3);
    expect(kinds).not.toContain('task_archived');
    expect(await store.db.selectFrom('operator_item').selectAll().execute()).toEqual([]);
    expect(
      await store.db
        .selectFrom('task')
        .select(['column', 'membership', 'archive_reason'])
        .where('key', '=', 'o/r#9')
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });

  it('replays the PR and session facts of a manually linked task from its own events', async () => {
    const { store, core, apply, mutations } = setup();
    const links = createLinkMutations(config);
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const merged: PrFacts = {
      ...prFact(),
      title: 'Unrelated work',
      headBranch: 'unrelated',
      ticketKeys: [],
      state: 'merged',
    };
    const loose: SessionFacts = { ...sessionFact('worker-2'), branch: 'unrelated' };
    for (const [sourceId, item] of [
      ['github:board:o/r', { kind: 'pr', facts: merged }],
      ['spur', { kind: 'session', facts: loose }],
    ] as const) {
      await core.observe(sourceId, {
        batch: { source: sourceId, observedAt: at, complete: true, items: [item], entities: [] },
        effectiveComplete: true,
        state: { lastCompleteAt: at, gone: [] },
        outcomes: [],
      });
    }
    await apply(
      links.add,
      { mode: 'pr', task: 'o/r#9', pr: merged.url, reason: 'Earlier work.' },
      'operator',
    );
    await apply(
      links.add,
      { mode: 'session', task: 'o/r#9', session: 'worker-2', reason: 'Started early.' },
      'operator',
    );
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
    let pr: unknown;
    let session: unknown;
    for (const event of events) {
      const payload = JSON.parse(event.payload) as { entity?: string; facts?: unknown };
      if (event.kind === 'pr_facts_changed') pr = payload.facts;
      if (event.kind === 'session_facts_changed') session = payload.facts;
      if (event.kind === 'link_added' && payload.facts !== undefined) {
        if (payload.entity === 'pr') pr = payload.facts;
        if (payload.entity === 'session') session = payload.facts;
      }
    }
    const prRow = await store.db
      .selectFrom('pr_snapshot')
      .select('detail')
      .executeTakeFirstOrThrow();
    const sessionRow = await store.db
      .selectFrom('session_snapshot')
      .select('detail')
      .executeTakeFirstOrThrow();
    expect(pr).toEqual(JSON.parse(prRow.detail));
    expect(pr).toEqual(merged);
    expect(session).toEqual(JSON.parse(sessionRow.detail));
    expect(session).toEqual(loose);
  });

  it('keeps old ticket facts and raises no lookup item on an incomplete batch', async () => {
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
    const status = await getStatus(
      { store, config, clock, completeSince: core.completeSince },
      { detail: true },
    );
    expect(status.tasks[0]?.ticket?.title).toBe('A ticket');
    expect(status.items.some((item) => item.key.startsWith('lookup:'))).toBe(false);
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
    const ref = (await core.context(source)).observe.tickets.find((entry) => entry.key === 'o/r#9');
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

  it('closes the turns of a merged pending task', async () => {
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
    const pending = await store.db
      .selectFrom('task')
      .selectAll()
      .where('key', '=', 'o/r#9')
      .executeTakeFirstOrThrow();
    await scanTransaction(store, config, (trx) =>
      openTurn(trx, { task: pending, reason: 'Pick it up', handed: [], at: new Date(now), config }),
    );
    const ref = (await core.context(source)).observe.tickets.find((entry) => entry.key === 'o/r#9');
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

    const archived = await store.db
      .selectFrom('task')
      .select('membership')
      .where('id', '=', pending.id)
      .executeTakeFirst();
    expect(archived).toEqual({ membership: 'archived' });
    expect(await store.db.selectFrom('turn').selectAll().execute()).toEqual([
      expect.objectContaining({ task_id: pending.id, closed_reason: 'archived', closed_at: later }),
    ]);
    expect(
      await store.db
        .selectFrom('turn')
        .select('id')
        .where('task_id', '=', pending.id)
        .where('closed_at', 'is', null)
        .execute(),
    ).toEqual([]);
  });

  it('passes each PR the newest feedback handed over', async () => {
    const { store, core, apply, mutations } = setup();
    const github = 'github:board:o/r';
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await store.db
      .insertInto('link')
      .values({
        task_id: 1,
        entity: 'pr',
        repo: 'O/R',
        number: 5,
        pr_state: 'active',
        pr_open: 1,
        session_id: null,
        role: null,
        source: 'manual',
        ticket_key: null,
        created_at: at,
      })
      .execute();
    expect('feedbackCursors' in (await core.context(github))).toBe(false);

    const entry = (number: number, kind: 'comment' | 'review', id: string, postedAt: string) => ({
      repo: 'o/r',
      number,
      kind,
      id,
      postedAt,
    });
    const turn = { task_id: 1, column: 'todo' as const, epoch: 0, role: 'operator' as const };
    // The older turn is closed (one unclosed turn per task) and handed the newest entry.
    await store.db
      .insertInto('turn')
      .values([
        {
          ...turn,
          seq: 1,
          reason: 'first',
          handed: JSON.stringify([
            entry(5, 'comment', 'c-new', '2026-11-04T11:00:00Z'),
            entry(6, 'comment', 'c-unlinked', '2026-11-04T11:30:00Z'),
          ]),
          acked_by: null,
          acked_at: null,
          closed_at: at,
          closed_reason: 'moved',
          created_at: at,
        },
        {
          ...turn,
          seq: 2,
          reason: 'second',
          handed: JSON.stringify([
            entry(5, 'review', 'r-old', '2026-11-04T10:00:00Z'),
            entry(5, 'comment', 'c-0', '2026-11-04T11:00:00.000Z'),
          ]),
          acked_by: null,
          acked_at: null,
          closed_at: null,
          closed_reason: null,
          created_at: at,
        },
      ])
      .execute();

    const context = await core.context(github);

    expect(context.observe.prs).toEqual([{ kind: 'pr', repo: 'O/R', number: 5 }]);
    expect(context.feedbackCursors).toEqual([
      {
        ref: { kind: 'pr', repo: 'O/R', number: 5 },
        id: 'c-new',
        postedAt: '2026-11-04T11:00:00Z',
      },
    ]);
    expect('feedbackCursors' in (await core.context(source))).toBe(false);
  });
});

describe('held comment history (A10)', () => {
  const github = 'github:board:o/r';
  const ref = { kind: 'pr' as const, repo: 'o/r', number: 7 };
  const comment = (id: string) => ({
    kind: 'comment' as const,
    id,
    author: { login: 'reviewer', type: 'user' as const },
    postedAt: at,
  });
  const resume = (value: string) => value as SourceCursor;
  async function observePr(
    core: ReturnType<typeof setup>['core'],
    item: Extract<Batch['items'][number], { kind: 'pr' }>,
  ) {
    await core.observe(github, {
      batch: { source: github, observedAt: at, complete: true, items: [item], entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
  }
  async function linkedSetup() {
    const env = setup();
    await env.apply(env.mutations.add, { task: 'o/r#9' }, 'operator');
    return env;
  }

  it('holds the comment history a PR item asks for and passes it back on the next poll', async () => {
    const { core } = await linkedSetup();
    expect('continuations' in (await core.context(github))).toBe(false);
    const feedback = [comment('c-1'), comment('c-2')];
    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback, feedbackComplete: false },
      continuation: { resume: resume('p1') },
    });

    expect((await core.context(github)).continuations).toEqual([{ ref, resume: 'p1', feedback }]);

    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback: [comment('c-0'), ...feedback], feedbackComplete: true },
      continuation: { resume: null },
    });
    expect((await core.context(github)).continuations).toEqual([
      { ref, resume: null, feedback: [comment('c-0'), ...feedback] },
    ]);
  });

  it('keeps the held history when an item states nothing and drops it on null', async () => {
    const { store, core } = await linkedSetup();
    const feedback = [comment('c-1')];
    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback, feedbackComplete: false },
      continuation: { resume: resume('p1') },
    });
    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact('b'.repeat(40)), feedback: [comment('c-9')], feedbackComplete: false },
    });
    expect((await core.context(github)).continuations).toEqual([{ ref, resume: 'p1', feedback }]);

    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback, feedbackComplete: true },
      continuation: null,
    });
    expect('continuations' in (await core.context(github))).toBe(false);
    expect(await store.db.selectFrom('pr_continuation').selectAll().execute()).toEqual([]);
  });

  it('drops the held history of a PR with no unbanned link', async () => {
    const unlinked = setup();
    await observePr(unlinked.core, {
      kind: 'pr',
      facts: { ...prFact(), headBranch: 'unrelated', title: 'unrelated', ticketKeys: [] },
      continuation: { resume: resume('p1') },
    });
    expect(await unlinked.store.db.selectFrom('pr_continuation').selectAll().execute()).toEqual([]);

    const { store, core } = await linkedSetup();
    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback: [comment('c-1')] },
      continuation: { resume: resume('p1') },
    });
    expect(await store.db.selectFrom('pr_continuation').select('ref_key').execute()).toEqual([
      { ref_key: 'pr:o/r#7' },
    ]);
    await store.db.updateTable('link').set({ banned: 1 }).where('entity', '=', 'pr').execute();
    await core.observe(github, {
      batch: { source: github, observedAt: at, complete: true, items: [], entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    expect(await store.db.selectFrom('pr_continuation').selectAll().execute()).toEqual([]);
  });

  it('skips an unreadable held history row', async () => {
    const { store, core, apply, mutations } = await linkedSetup();
    await apply(mutations.add, { task: 'o/r#10' }, 'operator');
    await apply(mutations.add, { task: 'o/r#11' }, 'operator');
    const feedback = [comment('c-1')];
    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback },
      continuation: { resume: resume('p1') },
    });
    const link = {
      entity: 'pr' as const,
      repo: 'o/r',
      pr_state: 'active' as const,
      pr_open: 1 as const,
      session_id: null,
      role: null,
      source: 'manual' as const,
      ticket_key: null,
      created_at: at,
    };
    await store.db
      .insertInto('link')
      .values([
        { ...link, task_id: 2, number: 5 },
        { ...link, task_id: 3, number: 6 },
      ])
      .execute();
    await store.db
      .insertInto('pr_continuation')
      .values([
        { source: github, ref_key: 'pr:o/r#5', resume: 'p5', feedback: 'not json' },
        { source: github, ref_key: 'pr:o/r#6', resume: 'p6', feedback: '[{"kind":"poll"}]' },
      ])
      .execute();

    expect((await core.context(github)).continuations).toEqual([{ ref, resume: 'p1', feedback }]);
  });
});

describe('a clock that moves during the transaction', () => {
  // The real clock moves between scan passes; an item cleared with a fresh time on each pass
  // would never pass the gateway scan and the whole transaction would fail.
  function movingSetup() {
    const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-observe-')), 'board.db'));
    stores.push(store);
    let ms = Date.parse(at);
    const moving = { now: () => (ms += 7) };
    return { store, core: createObservationCore({ store, config, clock: moving }) };
  }
  const blind = { reason: 'stale', message: 'No complete observation' } as const;
  async function blindItem(store: Store) {
    return store.db
      .selectFrom('operator_item')
      .select(['cleared_at', 'line_outbox_id'])
      .where('item_key', '=', 'source:spur')
      .executeTakeFirstOrThrow();
  }
  async function edits(store: Store) {
    return store.db
      .selectFrom('outbox')
      .select('id')
      .where('kind', '=', 'feed.line.edit')
      .execute();
  }

  it('clears a blind item with a feed line from a source report', async () => {
    const { store, core } = movingSetup();
    await core.reportSourceState('spur', { blind, gone: [] });
    expect((await blindItem(store)).line_outbox_id).not.toBeNull();
    await core.reportSourceState('spur', { lastCompleteAt: at, gone: [] });
    expect((await blindItem(store)).cleared_at).not.toBeNull();
    expect(await edits(store)).toHaveLength(1);
  });

  it('clears a blind item with a feed line from an accepted observation', async () => {
    const { store, core } = movingSetup();
    await core.reportSourceState('spur', { blind, gone: [] });
    await core.observe('spur', {
      batch: { source: 'spur', observedAt: at, complete: true, items: [], entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    expect((await blindItem(store)).cleared_at).not.toBeNull();
    expect(await edits(store)).toHaveLength(1);
    expect(
      await store.db.selectFrom('source_state').select('last_complete_at').executeTakeFirst(),
    ).toEqual({ last_complete_at: at });
  });

  it('records a stale blind source again and opens its item with a new line after a report cleared it', async () => {
    const { store, core } = movingSetup();
    await core.reportSourceState('spur', { blind, gone: [] });
    const first = (await blindItem(store)).line_outbox_id;
    await core.reportSourceState('spur', { lastCompleteAt: at, gone: [] });
    await core.reportSourceState('spur', { blind, gone: [] });
    expect(
      await store.db.selectFrom('source_state').select('blind_reason').executeTakeFirst(),
    ).toEqual({ blind_reason: 'stale' });
    const open = await store.db
      .selectFrom('operator_item')
      .select('line_outbox_id')
      .where('item_key', '=', 'source:spur')
      .where('cleared_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(open.line_outbox_id).not.toBeNull();
    expect(open.line_outbox_id).not.toBe(first);
  });
});

describe('anomaly blocks', () => {
  const link = { 'board-worker': 'https://github.com/o/r/issues/9' };
  const github = 'github:board:o/r';
  const IDLE = config.health.idleInDevAfterMs;
  const iso = () => new Date(now).toISOString();
  type Items = Parameters<ReturnType<typeof setup>['core']['observe']>[1]['batch']['items'];

  async function board(testConfig = config, key = 'o/r#9') {
    const ctx = setup(testConfig);
    await ctx.apply(ctx.mutations.add, { task: key }, 'operator');
    const task = await ctx.store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow();
    return { ...ctx, task, config: testConfig };
  }
  type Board = Awaited<ReturnType<typeof board>>;

  async function poll(b: Board, src: string, items: Items, lastCompleteAt = iso()) {
    await b.core.observe(src, {
      batch: { source: src, observedAt: iso(), complete: true, items, entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt, gone: [] },
      outcomes: [],
    });
  }
  const spur = (b: Board, facts: SessionFacts[]) =>
    poll(
      b,
      'spur',
      facts.map((entry) => ({ kind: 'session' as const, facts: entry })),
    );
  const prs = (b: Board, facts: PrFacts[], lastCompleteAt = iso()) =>
    poll(
      b,
      github,
      facts.map((entry) => ({ kind: 'pr' as const, facts: entry })),
      lastCompleteAt,
    );
  const session = (
    id: string,
    health: SessionFacts['health'],
    changes: Partial<SessionFacts> = {},
  ): SessionFacts => ({ ...sessionFact(id, link), health, healthSince: iso(), ...changes });
  const killed = (id: string): SessionFacts => ({
    ...sessionFact(id, link, true),
    endedAt: iso(),
    endReason: 'kill',
    lifecycle: 'killed',
  });
  const pr = (number: number, state: PrFacts['state']): PrFacts => ({
    ...prFact(),
    number,
    url: `https://github.com/o/r/pull/${String(number)}`,
    state,
  });
  const tick = (b: Board) =>
    tickBoard({ store: b.store, config: b.config, clock, completeSince: b.core.completeSince });

  async function surface(b: Board) {
    const outbox = async (kind: string) =>
      (await b.store.db.selectFrom('outbox').select('id').where('kind', '=', kind).execute())
        .length;
    return {
      blocks: await b.store.db.selectFrom('block').selectAll().orderBy('id').execute(),
      items: await b.store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('kind', '=', 'anomaly')
        .orderBy('id')
        .execute(),
      opens: await outbox('conversation.open'),
      closes: await outbox('conversation.close'),
      lines: await outbox('feed.line'),
    };
  }
  /** The open system blocks with their active ledger item keys, without the task id. */
  async function openLedger(b: Board) {
    const { blocks, items } = await surface(b);
    return blocks
      .filter((block) => block.state === 'open' && block.author === 'system')
      .map((block) => {
        const item = items.find(
          (entry) => entry.block_id === block.id && entry.cleared_at === null,
        );
        // Task-scoped keys lose their task id; a stuck-turn key keeps its turn id.
        return (
          item?.item_key.replace(
            new RegExp(`^(health|pr-closed|ticket-closed):${String(b.task.id)}(?=:|$)`),
            '$1',
          ) ?? null
        );
      });
  }

  /** A worker turn of the task taken by `session` at the current time. */
  function heldTurn(b: Board, session = 'worker-1') {
    return b.store.transaction((trx) =>
      trx
        .insertInto('turn')
        .values({
          task_id: b.task.id,
          column: b.task.column,
          epoch: b.task.column_epoch,
          seq: 1,
          role: 'worker',
          reason: 'Pick it up',
          handed: '[]',
          acked_by: `agent:worker/${session}`,
          acked_at: iso(),
          closed_at: null,
          closed_reason: null,
          created_at: iso(),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  const closeTurn = (b: Board) =>
    scanTransaction(b.store, b.config, (trx) =>
      closeTurns(trx, { taskId: b.task.id, reason: 'moved', at: new Date(now) }),
    );
  const reminders = (b: Board) =>
    b.store.db.selectFrom('notification').selectAll().where('kind', '=', 'turn_reminder').execute();
  /** Hands the due reminder to the sender and returns its notification and outbox row. */
  async function sendReminder(b: Board) {
    await scanTransaction(b.store, b.config, (trx) =>
      reconcileDoorbells(trx, new Date(now), b.config),
    );
    const [reminder] = await reminders(b);
    if (reminder?.last_outbox_id == null) throw new Error('Missing reminder ring');
    return { reminder, outboxId: reminder.last_outbox_id };
  }

  it('opens one block for a session in error and closes it on recovery', async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'error')]);
    now += config.health.errorAfterMs;
    await tick(b);
    let state = await surface(b);
    expect(state.blocks).toEqual([
      expect.objectContaining({
        author: 'system',
        addressee_role: 'operator',
        type: 'needs_input',
        state: 'open',
        reason: 'stuck worker (worker-1)',
      }),
    ]);
    expect(state.items).toEqual([
      expect.objectContaining({
        item_key: `health:${String(b.task.id)}:worker-1:stuck_worker`,
        block_id: state.blocks[0]?.id,
        cleared_at: null,
        line_outbox_id: null,
      }),
    ]);
    expect([state.opens, state.closes, state.lines]).toEqual([1, 0, 0]);
    now += 1_000;
    await tick(b);
    expect(await surface(b)).toEqual(state);

    now += 1_000;
    await spur(b, [session('worker-1', 'working')]);
    state = await surface(b);
    expect(state.blocks).toEqual([
      expect.objectContaining({
        state: 'unblocked',
        outcome: 'withdrawn',
        outcome_reason: 'condition ended',
        unblocked_by: 'system',
      }),
    ]);
    expect(state.items.map((item) => item.cleared_at)).toEqual([iso()]);
    expect([state.opens, state.closes, state.lines]).toEqual([1, 1, 0]);
    expect(await b.store.db.selectFrom('dismissal').select('item_key').execute()).toEqual([]);
  });

  it('keeps an error block open through a host-load episode', async () => {
    const b = await board();
    const other = { 'board-other': 'https://github.com/o/r/issues/9' };
    await spur(b, [session('worker-1', 'error')]);
    now += config.health.errorAfterMs;
    await tick(b);
    expect(await openLedger(b)).toEqual(['health:worker-1:stuck_worker']);
    now += 1_000;
    await spur(b, [
      session('worker-1', 'error', { healthSince: at }),
      { ...sessionFact('reviewer-1', other), health: 'error', healthSince: iso() },
      { ...sessionFact('reviewer-2', other), health: 'error', healthSince: iso() },
    ]);
    now += 1_000;
    await tick(b);
    expect(
      (await getStatus({ store: b.store, config, clock, completeSince: b.core.completeSince }))
        .hostLoad,
    ).toBe('Host under load');
    expect(await openLedger(b)).toEqual(['health:worker-1:stuck_worker']);
    expect((await surface(b)).closes).toBe(0);
  });

  it("withdraws a recovered session's error block during a host-load episode", async () => {
    const b = await board();
    const other = { 'board-other': 'https://github.com/o/r/issues/9' };
    await spur(b, [session('worker-1', 'error')]);
    now += config.health.errorAfterMs;
    await tick(b);
    expect(await openLedger(b)).toEqual(['health:worker-1:stuck_worker']);
    now += 1_000;
    await spur(b, [
      session('worker-1', 'working'),
      { ...sessionFact('reviewer-1', other), health: 'error', healthSince: iso() },
      { ...sessionFact('reviewer-2', other), health: 'error', healthSince: iso() },
    ]);
    const recovered = iso();
    now += 1_000;
    await tick(b);
    expect(
      (await getStatus({ store: b.store, config, clock, completeSince: b.core.completeSince }))
        .hostLoad,
    ).toBe('Host under load');
    const state = await surface(b);
    expect(await openLedger(b)).toEqual([]);
    expect(state.blocks.map((block) => [block.state, block.outcome, block.unblocked_by])).toEqual([
      ['unblocked', 'withdrawn', 'system'],
    ]);
    expect(state.items.map((item) => item.cleared_at)).toEqual([recovered]);
    expect(state.closes).toBe(1);
  });

  it('opens a block for needs input without a board question', async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'needs_input')]);
    now += config.health.needsInputAfterMs;
    await tick(b);
    expect(await openLedger(b)).toEqual(['health:worker-1:needs_input']);
    expect((await surface(b)).lines).toBe(0);
  });

  it('keeps the needs-input item while the session has an open question', async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'needs_input')]);
    await b.apply(
      createBlockMutations(config).ask,
      { task: 'o/r#9', text: 'Which API?' },
      'agent:worker/worker-1',
      'ask-1',
    );
    now += config.health.needsInputAfterMs;
    await tick(b);
    const state = await surface(b);
    expect(state.blocks.map((block) => block.author)).toEqual(['agent:worker/worker-1']);
    expect(state.items).toEqual([]);
    expect(
      await b.store.db
        .selectFrom('operator_item')
        .select(['kind', 'block_id'])
        .where('item_key', 'like', 'health:%:needs_input')
        .where('cleared_at', 'is', null)
        .execute(),
    ).toEqual([{ kind: 'board_observation', block_id: null }]);
  });

  it('opens a block for a PR closed without merge until another PR is linked', async () => {
    const b = await board();
    await prs(b, [pr(7, 'closed')]);
    let state = await surface(b);
    expect(await openLedger(b)).toEqual(['pr-closed']);
    expect(state.blocks[0]?.reason).toBe(
      'linked pull request o/r#7 closed without merge, no open PR',
    );
    expect(state.items[0]?.source).toBe(github);
    expect([state.opens, state.lines]).toEqual([1, 0]);
    now += 1_000;
    await prs(b, [pr(7, 'closed'), pr(8, 'open')]);
    state = await surface(b);
    expect(await openLedger(b)).toEqual([]);
    expect(state.blocks).toEqual([
      expect.objectContaining({ state: 'unblocked', outcome: 'withdrawn', unblocked_by: 'system' }),
    ]);
    expect(state.items.map((item) => item.cleared_at)).toEqual([iso()]);

    const beside = await board();
    await prs(beside, [pr(7, 'closed'), pr(8, 'open')]);
    expect((await surface(beside)).blocks).toEqual([]);
  });

  it('replaces the block when the closed-PR revision changes', async () => {
    const b = await board();
    await prs(b, [pr(7, 'closed')]);
    const [first] = (await surface(b)).items;
    now += 1_000;
    await prs(b, [pr(7, 'closed'), pr(8, 'closed')]);
    const state = await surface(b);
    expect(state.blocks.map((block) => [block.state, block.outcome, block.unblocked_by])).toEqual([
      ['unblocked', 'withdrawn', 'system'],
      ['open', null, null],
    ]);
    expect(state.items.map((item) => [item.id, item.block_id, item.cleared_at])).toEqual([
      [first?.id, state.blocks[0]?.id, iso()],
      [expect.any(Number), state.blocks[1]?.id, null],
    ]);
    expect(state.blocks[1]?.reason).toBe(
      'linked pull request o/r#7, o/r#8 closed without merge, no open PR',
    );
  });

  it('keeps an operator-closed anomaly block closed until its revision changes', async () => {
    const b = await board();
    await prs(b, [pr(7, 'closed')]);
    const [block] = (await surface(b)).blocks;
    if (block === undefined) throw new Error('Missing closed-PR block');
    now += 1_000;
    await b.apply(
      createBlockMutations(config).unblock,
      { mode: 'reason', block: `B${String(block.id)}`, reason: 'Abandoned on purpose.' },
      'operator',
    );
    const [item] = (await surface(b)).items;
    expect(item?.cleared_at).toBe(iso());
    expect(await b.store.db.selectFrom('dismissal').selectAll().execute()).toEqual([
      expect.objectContaining({
        item_key: item?.item_key,
        fingerprint: item?.fingerprint,
        dismissed_by: 'operator',
      }),
    ]);
    now += 1_000;
    await prs(b, [pr(7, 'closed')]);
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).blocks).toHaveLength(1);
    now += 1_000;
    await prs(b, [pr(7, 'closed'), pr(8, 'closed')]);
    expect(await openLedger(b)).toEqual(['pr-closed']);
  });

  it('re-arms a dismissed PR-closed block when the same PR is reopened and closed again', async () => {
    const b = await board();
    await prs(b, [pr(7, 'closed')]);
    const [block] = (await surface(b)).blocks;
    if (block === undefined) throw new Error('Missing closed-PR block');
    now += 1_000;
    await b.apply(
      createBlockMutations(config).unblock,
      { mode: 'reason', block: `B${String(block.id)}`, reason: 'Abandoned on purpose.' },
      'operator',
    );
    now += 1_000;
    await prs(b, [{ ...pr(7, 'open'), updatedAt: iso() }]);
    expect(await openLedger(b)).toEqual([]);
    now += 1_000;
    await prs(b, [{ ...pr(7, 'closed'), updatedAt: iso() }]);
    expect(await openLedger(b)).toEqual(['pr-closed']);
    const { blocks } = await surface(b);
    expect(blocks.map((entry) => [entry.state, entry.unblocked_by])).toEqual([
      ['unblocked', 'operator'],
      ['open', null],
    ]);
  });

  it('keeps a dismissed PR-closed block quiet when the closed PR is edited', async () => {
    const b = await board();
    await prs(b, [pr(7, 'closed')]);
    const [block] = (await surface(b)).blocks;
    if (block === undefined) throw new Error('Missing closed-PR block');
    now += 1_000;
    await b.apply(
      createBlockMutations(config).unblock,
      { mode: 'reason', block: `B${String(block.id)}`, reason: 'Abandoned on purpose.' },
      'operator',
    );
    now += 1_000;
    await prs(b, [{ ...pr(7, 'closed'), title: 'o/r#9 work, renamed', updatedAt: iso() }]);
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).blocks).toHaveLength(1);
  });

  it('keeps one PR-closed block and its dismissal when two projects share the repository', async () => {
    const shared = configSchema.parse({
      projects: [
        {
          id: 'board',
          tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'worker', role: 'worker' }],
        },
        {
          id: 'web',
          tracker: {
            type: 'jira',
            baseUrl: 'https://jira.example.test',
            jql: 'project = WEBDEV',
            doneStatuses: ['Done'],
            readyStatuses: ['Ready'],
            projectKeys: ['WEBDEV'],
          },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'web-worker', role: 'worker' }],
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
      health: { hostLoad: { sessions: 2 } },
    });
    const b = await board(shared);
    const closed = [{ kind: 'pr' as const, facts: pr(7, 'closed') }];
    const both = async () => {
      now += 1_000;
      await poll(b, 'github:web:o/r', closed);
      now += 1_000;
      await poll(b, github, closed);
      await tick(b);
    };
    await poll(b, github, closed);
    expect(await openLedger(b)).toEqual(['pr-closed']);
    await both();
    await both();
    let state = await surface(b);
    expect(await openLedger(b)).toEqual(['pr-closed']);
    expect(state.blocks).toHaveLength(1);
    expect(state.items).toHaveLength(1);
    expect([state.opens, state.closes]).toEqual([1, 0]);
    const [block] = state.blocks;
    if (block === undefined) throw new Error('Missing closed-PR block');
    now += 1_000;
    await b.apply(
      createBlockMutations(shared).unblock,
      { mode: 'reason', block: `B${String(block.id)}`, reason: 'Abandoned on purpose.' },
      'operator',
    );
    const dismissed = await surface(b);
    await both();
    await both();
    state = await surface(b);
    expect(await openLedger(b)).toEqual([]);
    expect(state.blocks).toHaveLength(1);
    expect(state.items).toHaveLength(1);
    expect([state.opens, state.closes]).toEqual([dismissed.opens, dismissed.closes]);
  });

  it('opens a block for a ticket closed while work is live, not for one closed by its merge', async () => {
    async function closedTicket(prFacts: PrFacts[]) {
      const b = await board();
      const ref = (await b.core.context(source)).observe.tickets[0];
      if (ref === undefined) throw new Error('Missing ticket request');
      const ticket = (status: string) =>
        b.core.observe(source, {
          batch: {
            source,
            observedAt: iso(),
            complete: true,
            items: [{ kind: 'ticket', facts: { ...fact(), status, updatedAt: iso() } }],
            entities: [{ ref, status: 'ok' }],
          },
          effectiveComplete: true,
          state: { lastCompleteAt: iso(), gone: [] },
          outcomes: [],
        });
      await ticket('open');
      await spur(b, [session('worker-1', 'working')]);
      if (prFacts.length > 0) await prs(b, prFacts);
      now += 1_000;
      const closedAt = iso();
      await ticket('closed');
      return { b, closedAt };
    }
    const live = await closedTicket([]);
    expect(await openLedger(live.b)).toEqual([]);
    now += 1_000;
    await prs(live.b, [], new Date(Date.parse(live.closedAt) - 1).toISOString());
    expect(await openLedger(live.b)).toEqual([]);
    now += 1_000;
    await prs(live.b, []);
    expect(await openLedger(live.b)).toEqual(['ticket-closed']);
    expect((await surface(live.b)).lines).toBe(0);

    const merged = await closedTicket([pr(7, 'merged')]);
    expect(await openLedger(merged.b)).toEqual([]);
    now += 1_000;
    await prs(merged.b, [pr(7, 'merged')]);
    await tick(merged.b);
    expect((await surface(merged.b)).blocks).toEqual([]);
  });

  it('keeps a ticket-closed block open while GitHub is blind', async () => {
    const b = await board();
    const ref = (await b.core.context(source)).observe.tickets[0];
    if (ref === undefined) throw new Error('Missing ticket request');
    const ticket = (status: string) =>
      b.core.observe(source, {
        batch: {
          source,
          observedAt: iso(),
          complete: true,
          items: [{ kind: 'ticket', facts: { ...fact(), status, updatedAt: iso() } }],
          entities: [{ ref, status: 'ok' }],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: iso(), gone: [] },
        outcomes: [],
      });
    await ticket('open');
    await spur(b, [session('worker-1', 'working')]);
    now += 1_000;
    await ticket('closed');
    now += 1_000;
    await prs(b, []);
    expect(await openLedger(b)).toEqual(['ticket-closed']);

    now += 1_000;
    await b.core.reportSourceState(github, {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'GitHub stopped answering' },
      gone: [],
    });
    await tick(b);
    let state = await surface(b);
    expect(await openLedger(b)).toEqual(['ticket-closed']);
    expect(state.items.map((item) => item.cleared_at)).toEqual([null]);
    expect([state.opens, state.closes]).toEqual([1, 0]);

    now += 1_000;
    await prs(b, []);
    state = await surface(b);
    expect(await openLedger(b)).toEqual(['ticket-closed']);
    expect(state.blocks).toHaveLength(1);
    expect([state.opens, state.closes]).toEqual([1, 0]);

    now += 1_000;
    await prs(b, [pr(7, 'merged')]);
    state = await surface(b);
    expect(await openLedger(b)).toEqual([]);
    expect(state.blocks).toEqual([
      expect.objectContaining({ state: 'unblocked', outcome: 'withdrawn', unblocked_by: 'system' }),
    ]);
    expect(state.items.map((item) => item.cleared_at)).toEqual([iso()]);
  });

  it('keeps a dismissed ticket-closed block quiet when the closed ticket is edited, and re-arms it after a reopen', async () => {
    const b = await board();
    const ref = (await b.core.context(source)).observe.tickets[0];
    if (ref === undefined) throw new Error('Missing ticket request');
    const ticket = (status: string) =>
      b.core.observe(source, {
        batch: {
          source,
          observedAt: iso(),
          complete: true,
          items: [{ kind: 'ticket', facts: { ...fact(), status, updatedAt: iso() } }],
          entities: [{ ref, status: 'ok' }],
        },
        effectiveComplete: true,
        state: { lastCompleteAt: iso(), gone: [] },
        outcomes: [],
      });
    await ticket('open');
    await spur(b, [session('worker-1', 'working')]);
    now += 1_000;
    await ticket('closed');
    now += 1_000;
    await prs(b, []);
    const [block] = (await surface(b)).blocks;
    if (block === undefined) throw new Error('Missing ticket-closed block');
    now += 1_000;
    await b.apply(
      createBlockMutations(config).unblock,
      { mode: 'reason', block: `B${String(block.id)}`, reason: 'Closed on purpose.' },
      'operator',
    );

    now += 1_000;
    await ticket('closed');
    now += 1_000;
    await prs(b, []);
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).blocks).toHaveLength(1);

    now += 1_000;
    await ticket('open');
    now += 1_000;
    await prs(b, []);
    expect(await openLedger(b)).toEqual([]);
    now += 1_000;
    await ticket('closed');
    now += 1_000;
    await prs(b, []);
    expect(await openLedger(b)).toEqual(['ticket-closed']);
    expect((await surface(b)).blocks.map((entry) => [entry.state, entry.unblocked_by])).toEqual([
      ['unblocked', 'operator'],
      ['open', null],
    ]);
  });

  it('skips the filter item for a done Jira ticket with live work and keeps it beside a merged PR', async () => {
    const jira = configSchema.parse({
      projects: [
        {
          id: 'web',
          tracker: {
            type: 'jira',
            baseUrl: 'https://jira.example.test',
            jql: 'project = WEBDEV',
            doneStatuses: ['Done'],
            readyStatuses: ['Ready'],
            projectKeys: ['WEBDEV'],
          },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'worker', role: 'worker' }],
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    const jiraSource = 'jira:web';
    const repo = 'github:web:o/r';
    const ticket = (status: string, inFilter: boolean): TicketFacts => ({
      trackerId: jiraSource,
      id: '10001',
      key: 'WEBDEV-1',
      title: 'A ticket',
      status,
      assignee: null,
      sprint: null,
      labels: [],
      inFilter,
      url: 'https://jira.example.test/browse/WEBDEV-1',
      updatedAt: iso(),
    });
    async function doneTicket(merged: boolean) {
      const { store, core } = setup(jira);
      const observe = (src: string, items: Items, lastCompleteAt = iso()) =>
        core.observe(src, {
          batch: { source: src, observedAt: iso(), complete: true, items, entities: [] },
          effectiveComplete: true,
          state: { lastCompleteAt, gone: [] },
          outcomes: [],
        });
      const prs = merged
        ? [
            {
              kind: 'pr' as const,
              facts: {
                ...prFact(),
                state: 'merged' as const,
                title: 'WEBDEV-1 work',
                headBranch: 'WEBDEV-1-work',
                ticketKeys: ['WEBDEV-1'],
              },
            },
          ]
        : [];
      await observe(jiraSource, [{ kind: 'ticket', facts: ticket('In Progress', true) }]);
      await observe('spur', [
        { kind: 'session', facts: { ...sessionFact('worker-1'), branch: 'WEBDEV-1-work' } },
      ]);
      await observe(repo, prs);
      now += 1_000;
      const closedAt = iso();
      await observe(jiraSource, [{ kind: 'ticket', facts: ticket('Done', false) }]);
      const filter = async () => ({
        membership: (await store.db.selectFrom('task').select('membership').executeTakeFirst())
          ?.membership,
        filter: (
          await store.db
            .selectFrom('operator_item')
            .select('kind')
            .where('item_key', 'like', 'filter:%')
            .execute()
        ).map((item) => item.kind),
        lines: (
          await store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute()
        ).length,
        blocks: (await store.db.selectFrom('block').select('author').execute()).map(
          (block) => block.author,
        ),
      });
      const beforePoll = await filter();
      now += 1_000;
      await observe(repo, prs, new Date(Date.parse(closedAt) + 500).toISOString());
      return { beforePoll, afterPoll: await filter() };
    }
    expect(await doneTicket(false)).toEqual({
      beforePoll: { membership: 'out_of_filter', filter: [], lines: 0, blocks: [] },
      afterPoll: { membership: 'out_of_filter', filter: [], lines: 0, blocks: ['system'] },
    });
    expect(await doneTicket(true)).toEqual({
      beforePoll: {
        membership: 'out_of_filter',
        filter: ['board_observation'],
        lines: 1,
        blocks: [],
      },
      afterPoll: {
        membership: 'out_of_filter',
        filter: ['board_observation'],
        lines: 1,
        blocks: [],
      },
    });
  });

  it('opens a block for a worker killed during its open turn', async () => {
    async function lost() {
      const b = await board();
      await prs(b, [pr(7, 'open')]);
      await spur(b, [session('worker-1', 'working')]);
      await heldTurn(b);
      now += 1_000;
      await spur(b, [killed('worker-1')]);
      expect(await openLedger(b)).toEqual(['health:worker-1:worker_lost']);
      expect((await surface(b)).blocks[0]?.reason).toBe(
        'worker ended during its open turn (worker-1)',
      );
      return b;
    }
    const closed = await lost();
    now += 1_000;
    await closeTurn(closed);
    await tick(closed);
    expect(await openLedger(closed)).toEqual([]);
    expect((await surface(closed)).blocks.map((block) => block.outcome)).toEqual(['withdrawn']);

    const replaced = await lost();
    now += 1_000;
    await spur(replaced, [killed('worker-1'), session('worker-2', 'working')]);
    expect(await openLedger(replaced)).toEqual([]);
    expect((await surface(replaced)).blocks.map((block) => block.outcome)).toEqual(['withdrawn']);
  });

  it('opens a stuck-turn block a threshold after the reminder and closes it with the turn', async () => {
    const b = await board();
    await prs(b, [pr(7, 'open')]);
    await spur(b, [session('worker-1', 'waiting')]);
    const turn = await heldTurn(b);
    now += IDLE;
    await tick(b);
    expect(await reminders(b)).toEqual([
      expect.objectContaining({
        source_key: `turn:${String(turn.id)}:reminder:worker-1:${String(turn.acked_at)}`,
      }),
    ]);
    expect(await openLedger(b)).toEqual([]);
    const { reminder } = await sendReminder(b);
    await scanTransaction(b.store, b.config, (trx) =>
      recordRingDelivery(trx, reminder.id, 1, 'worker-1', new Date(now), b.config),
    );
    now += IDLE - 1;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    now += 1;
    await tick(b);
    expect(await openLedger(b)).toEqual([`stuck-turn:${String(turn.id)}`]);
    const state = await surface(b);
    expect(state.blocks[0]?.reason).toBe(
      `turn T${String(turn.id)} taken by worker-1 has no submit or question`,
    );
    expect(state.items[0]?.source).toBe('spur');
    expect(state.lines).toBe(0);
    expect(await reminders(b)).toHaveLength(1);

    now += 1_000;
    await closeTurn(b);
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).blocks.map((block) => block.outcome)).toEqual(['withdrawn']);
  });

  it('opens it at once after an undelivered reminder', async () => {
    const b = await board();
    await prs(b, [pr(7, 'open')]);
    await spur(b, [session('worker-1', 'waiting')]);
    const turn = await heldTurn(b);
    now += IDLE;
    await tick(b);
    const { reminder, outboxId } = await sendReminder(b);
    now += 1_000;
    await scanTransaction(b.store, b.config, (trx) =>
      ringUndelivered(trx, {
        notificationId: reminder.id,
        outboxId,
        dedupeKey: 'unused',
        session: 'worker-1',
        reason: 'rejected',
        at: new Date(now),
        config: b.config,
      }),
    );
    expect((await reminders(b))[0]?.exhausted_at).toBe(iso());
    await tick(b);
    expect(await openLedger(b)).toEqual([`stuck-turn:${String(turn.id)}`]);
    // The undelivered reminder raises no worker_not_reading or answer_undelivered item.
    expect(
      await b.store.db
        .selectFrom('operator_item')
        .select(['kind', 'item_key'])
        .where('task_id', '=', b.task.id)
        .execute(),
    ).toEqual([{ kind: 'anomaly', item_key: `stuck-turn:${String(turn.id)}` }]);
  });

  it('waits a fresh quiet period after an answered question before reopening a stuck-turn block for a failed reminder', async () => {
    const b = await board();
    const blocks = createBlockMutations(b.config);
    await prs(b, [pr(7, 'open')]);
    await spur(b, [session('worker-1', 'waiting')]);
    const turn = await heldTurn(b);
    now += IDLE;
    await tick(b);
    const { reminder, outboxId } = await sendReminder(b);
    now += 1_000;
    await scanTransaction(b.store, b.config, (trx) =>
      ringUndelivered(trx, {
        notificationId: reminder.id,
        outboxId,
        dedupeKey: 'unused',
        session: 'worker-1',
        reason: 'rejected',
        at: new Date(now),
        config: b.config,
      }),
    );
    await tick(b);
    expect(await openLedger(b)).toEqual([`stuck-turn:${String(turn.id)}`]);

    now += 1_000;
    const asked = await b.apply(
      blocks.ask,
      { task: 'o/r#9', text: 'Which API?' },
      'agent:worker/worker-1',
      'ask-1',
    );
    await tick(b);
    expect(await openLedger(b)).toEqual([]);

    now += 1_000;
    await b.apply(
      blocks.answer,
      { block: asked.block.id, text: 'Use v2.' },
      'operator',
      'answer-1',
    );
    now += 1;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    now += IDLE - 2;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    now += 1;
    await tick(b);
    expect(await openLedger(b)).toEqual([`stuck-turn:${String(turn.id)}`]);
    expect(
      (await surface(b)).blocks
        .filter((block) => block.author === 'system')
        .map((block) => block.outcome),
    ).toEqual(['withdrawn', null]);
  });

  it('opens no stuck-turn block for a lost worker', async () => {
    const b = await board();
    await prs(b, [pr(7, 'open')]);
    await spur(b, [session('worker-1', 'waiting')]);
    await heldTurn(b);
    now += 1_000;
    await spur(b, [killed('worker-1')]);
    now += IDLE * 2;
    await tick(b);
    expect(await openLedger(b)).toEqual(['health:worker-1:worker_lost']);
    expect(await reminders(b)).toEqual([]);
  });

  it('holds open Spur-derived blocks while Spur is blind', async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'error'), session('worker-2', 'waiting')]);
    const turn = await heldTurn(b, 'worker-2');
    now += IDLE;
    await tick(b);
    const { reminder, outboxId } = await sendReminder(b);
    await scanTransaction(b.store, b.config, (trx) =>
      ringUndelivered(trx, {
        notificationId: reminder.id,
        outboxId,
        dedupeKey: 'unused',
        session: 'worker-2',
        reason: 'rejected',
        at: new Date(now),
        config: b.config,
      }),
    );
    await tick(b);
    const held = [`stuck-turn:${String(turn.id)}`, 'health:worker-1:stuck_worker'].sort();
    expect((await openLedger(b)).sort()).toEqual(held);
    now += 1_000;
    await b.core.reportSourceState('spur', {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'Spur stopped answering' },
      gone: [],
    });
    expect(
      await b.store.db
        .selectFrom('source_state')
        .select('blind_reason')
        .where('source', '=', 'spur')
        .executeTakeFirstOrThrow(),
    ).toEqual({ blind_reason: 'stale' });
    now += IDLE;
    await tick(b);
    expect((await openLedger(b)).sort()).toEqual(held);
    expect((await surface(b)).closes).toBe(0);
  });

  it("withdraws a session's anomaly block when its link is removed while Spur is blind", async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'error')]);
    now += IDLE;
    await tick(b);
    expect(await openLedger(b)).toEqual(['health:worker-1:stuck_worker']);
    now += 1_000;
    await b.core.reportSourceState('spur', {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'Spur stopped answering' },
      gone: [],
    });
    await b.apply(
      createLinkMutations(b.config).remove,
      { mode: 'session', task: 'o/r#9', session: 'worker-1', reason: 'Wrong task.' },
      'operator',
    );
    await tick(b);
    const { blocks, items } = await surface(b);
    expect(blocks.map((block) => [block.state, block.outcome, block.unblocked_by])).toEqual([
      ['unblocked', 'withdrawn', 'system'],
    ]);
    expect(items.map((item) => item.cleared_at !== null)).toEqual([true]);
  });

  it("withdraws a stuck-turn block when its holder's link is removed while Spur is blind", async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'waiting')]);
    const turn = await heldTurn(b);
    now += IDLE;
    await tick(b);
    const { reminder, outboxId } = await sendReminder(b);
    await scanTransaction(b.store, b.config, (trx) =>
      ringUndelivered(trx, {
        notificationId: reminder.id,
        outboxId,
        dedupeKey: 'unused',
        session: 'worker-1',
        reason: 'rejected',
        at: new Date(now),
        config: b.config,
      }),
    );
    await tick(b);
    expect(await openLedger(b)).toEqual([`stuck-turn:${String(turn.id)}`]);
    now += 1_000;
    await b.core.reportSourceState('spur', {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'Spur stopped answering' },
      gone: [],
    });
    await b.apply(
      createLinkMutations(b.config).remove,
      { mode: 'session', task: 'o/r#9', session: 'worker-1', reason: 'Wrong task.' },
      'operator',
    );
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).items.map((item) => item.cleared_at !== null)).toEqual([true]);
  });

  it("keeps a stuck-turn block closed after Spur recovers when its holder's link was removed", async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'waiting')]);
    const turn = await heldTurn(b);
    now += IDLE;
    await tick(b);
    const { reminder, outboxId } = await sendReminder(b);
    await scanTransaction(b.store, b.config, (trx) =>
      ringUndelivered(trx, {
        notificationId: reminder.id,
        outboxId,
        dedupeKey: 'unused',
        session: 'worker-1',
        reason: 'rejected',
        at: new Date(now),
        config: b.config,
      }),
    );
    await tick(b);
    expect(await openLedger(b)).toEqual([`stuck-turn:${String(turn.id)}`]);
    now += 1_000;
    await b.core.reportSourceState('spur', {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'Spur stopped answering' },
      gone: [],
    });
    await b.apply(
      createLinkMutations(b.config).remove,
      { mode: 'session', task: 'o/r#9', session: 'worker-1', reason: 'Wrong task.' },
      'operator',
    );
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    now += 1_000;
    await spur(b, [session('worker-1', 'waiting')]);
    now += IDLE;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).items.map((item) => item.cleared_at !== null)).toEqual([true]);
  });
  describe('reopen floor', () => {
    const ticket = (b: Board, status: string) =>
      poll(b, source, [{ kind: 'ticket', facts: { ...fact(), inFilter: true, status } }]);
    const task = (b: Board) => b.store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow();
    /** The numbers of the PR links a reopen hid, in link id order. */
    async function hidden(b: Board) {
      const rows = await b.store.db
        .selectFrom('link')
        .select('number')
        .where('entity', '=', 'pr')
        .where('reopen_hidden_at', 'is not', null)
        .orderBy('id')
        .execute();
      return rows.map((row) => row.number);
    }
    /** PR #7 merged, then the ticket closed and reopened. */
    async function reopened(b: Board) {
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      await ticket(b, 'closed');
      await ticket(b, 'open');
    }

    it('sets the reopen floor when a ticket reopens after a merge', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      await ticket(b, 'closed');
      expect(await hidden(b)).toEqual([]);

      await ticket(b, 'open');
      expect(await hidden(b)).toEqual([7]);
    });

    it('keeps a reopened task with only its old merged PR out of terminal', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      expect((await task(b)).terminal_at).not.toBeNull();

      await ticket(b, 'closed');
      await ticket(b, 'open');
      expect((await task(b)).terminal_at).toBeNull();
    });

    it('keeps a follow-up PR open before the reopen above the floor, so its merge is terminal', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      await ticket(b, 'closed');
      await prs(b, [pr(7, 'merged'), pr(8, 'open')]);
      await ticket(b, 'open');
      expect(await hidden(b)).toEqual([7]);

      await prs(b, [pr(7, 'merged'), pr(8, 'merged')]);
      expect((await task(b)).terminal_at).toBe(iso());
      expect(await taskPr(b.store.db, (await task(b)).id)).toMatchObject({ number: 8 });
    });

    it('keeps a follow-up PR open at the reopen counting when a later link was closed', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      await ticket(b, 'closed');
      await prs(b, [pr(7, 'merged'), pr(8, 'open')]);
      await prs(b, [pr(7, 'merged'), pr(8, 'open'), pr(9, 'open')]);
      await prs(b, [pr(7, 'merged'), pr(8, 'open'), pr(9, 'closed')]);
      expect(
        (
          await b.store.db
            .selectFrom('link')
            .select('number')
            .where('entity', '=', 'pr')
            .orderBy('id')
            .execute()
        ).map((row) => row.number),
      ).toEqual([7, 8, 9]);
      await ticket(b, 'open');
      expect(await hidden(b)).toEqual([7, 9]);
      expect((await task(b)).terminal_at).toBeNull();

      await prs(b, [pr(7, 'merged'), pr(8, 'merged'), pr(9, 'closed')]);
      expect((await task(b)).terminal_at).toBe(iso());
      expect(await taskPr(b.store.db, (await task(b)).id)).toMatchObject({ number: 8 });
    });

    it('counts a hidden PR again once it reopens, so its later merge is terminal', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged'), pr(9, 'open')]);
      await prs(b, [pr(7, 'merged'), pr(9, 'closed')]);
      await ticket(b, 'closed');
      await ticket(b, 'open');
      expect(await hidden(b)).toEqual([7, 9]);

      await prs(b, [pr(7, 'merged'), pr(9, 'open')]);
      expect(await hidden(b)).toEqual([7]);

      await prs(b, [pr(7, 'merged'), pr(9, 'merged')]);
      expect((await task(b)).terminal_at).toBe(iso());
      expect(await taskPr(b.store.db, (await task(b)).id)).toMatchObject({ number: 9 });
    });

    it('keeps a merged task without a floor terminal', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      await ticket(b, 'open');
      expect((await task(b)).terminal_at).toBe(iso());
      expect(await hidden(b)).toEqual([]);
    });

    it('opens the pr-closed operator block for a reopened task whose new PR closed unmerged', async () => {
      const b = await board();
      await reopened(b);
      await prs(b, [pr(7, 'merged'), pr(8, 'open')]);
      expect(await openLedger(b)).toEqual([]);

      await prs(b, [pr(7, 'merged'), pr(8, 'closed')]);
      expect(await openLedger(b)).toEqual(['pr-closed']);
      expect((await surface(b)).blocks[0]?.reason).toBe(
        'linked pull request o/r#8 closed without merge, no open PR',
      );
    });

    it('flags a worker that ended on a reopened task with only its old merged PR', async () => {
      const b = await board();
      await reopened(b);
      await spur(b, [sessionFact('worker-1', link, true)]);
      expect(await openLedger(b)).toEqual(['health:worker-1:worker_completed']);

      const merged = await board();
      await ticket(merged, 'open');
      await prs(merged, [pr(7, 'merged')]);
      await spur(merged, [sessionFact('worker-1', link, true)]);
      expect(await openLedger(merged)).toEqual([]);
    });
  });
});
