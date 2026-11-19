import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  eventPayloadSchemas,
  OPERATIONS,
  RESERVED_PROJECT,
  unknownSessionHealthSchema,
  type Batch,
  type ColumnId,
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
  createOperationRegistry,
  createQuery,
  createSender,
  getStatus,
  openStore,
  tickBoard,
  type Store,
} from '../../src/index.ts';
import { taskPr } from '../../src/app/board-utils.ts';
import { readInput } from '../../src/app/dispatch.ts';
import { createLinkMutations } from '../../src/app/links.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { createBlockMutations, openSystemBlock } from '../../src/app/blocks.ts';
import {
  reconcileDoorbells,
  recordRingDelivery,
  ringUndelivered,
} from '../../src/app/doorbells.ts';
import { closeTurns, openTurn, takeTurn } from '../../src/app/turns.ts';
import { dismissItem, raiseItem } from '../../src/app/feed.ts';

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

/** A complete GitHub poll that starts now, so a missing PR counts from this moment. */
async function pollGithub(core: ReturnType<typeof setup>['core']) {
  const observedAt = new Date(now).toISOString();
  await core.observe('github:board:o/r', {
    batch: { source: 'github:board:o/r', observedAt, complete: true, items: [], entities: [] },
    effectiveComplete: true,
    state: { lastCompleteAt: observedAt, gone: [] },
    outcomes: [],
  });
}

describe('accepted observation', () => {
  it.each(['ticket', 'pr', 'session'] as const)(
    'persists timestamp-only %s refreshes without changing journal rows or task time',
    async (kind) => {
      const { store, core, apply, mutations } = setup();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      const initial = {
        ticket: { kind: 'ticket', facts: fact() },
        pr: { kind: 'pr', facts: prFact() },
        session: { kind: 'session', facts: sessionFact('worker-1') },
      } as const;
      const observationSource =
        kind === 'ticket' ? source : kind === 'pr' ? 'github:board:o/r' : 'spur';
      const observe = (item: Batch['items'][number]) => {
        const observedAt = new Date(now).toISOString();
        return core.observe(observationSource, {
          batch: {
            source: observationSource,
            observedAt,
            complete: false,
            items: [item],
            entities: [],
          },
          effectiveComplete: false,
          state: { gone: [] },
          outcomes: [],
        });
      };
      const snapshot = () =>
        store.db.selectFrom(`${kind}_snapshot`).selectAll().executeTakeFirstOrThrow();
      await observe(initial[kind]);
      const journal = await store.db.selectFrom('event').selectAll().orderBy('id').execute();
      const task = await store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow();
      for (let cycle = 0; cycle < 2; cycle++) {
        now += 1_000;
        const timestamp = new Date(now).toISOString();
        const refreshed =
          kind === 'session'
            ? { kind, facts: { ...initial.session.facts, lastActivityAt: timestamp } }
            : kind === 'pr'
              ? { kind, facts: { ...initial.pr.facts, updatedAt: timestamp } }
              : { kind, facts: { ...initial.ticket.facts, updatedAt: timestamp } };
        await observe(refreshed);
        const row = await snapshot();
        expect(JSON.parse(row.detail)).toEqual(refreshed.facts);
        expect(row.observed_at).toBe(timestamp);
        expect(row.source).toBe(observationSource);
        expect(await store.db.selectFrom('event').selectAll().orderBy('id').execute()).toEqual(
          journal,
        );
        expect(
          (await store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow()).last_change_at,
        ).toBe(task.last_change_at);
      }
      now += 1_000;
      const timestamp = new Date(now).toISOString();
      const changed =
        kind === 'session'
          ? {
              kind,
              facts: { ...initial.session.facts, lastActivityAt: timestamp, branch: 'new-branch' },
            }
          : kind === 'pr'
            ? { kind, facts: { ...initial.pr.facts, updatedAt: timestamp, title: 'New title' } }
            : {
                kind,
                facts: { ...initial.ticket.facts, updatedAt: timestamp, title: 'New title' },
              };
      await observe(changed);
      const events = await store.db
        .selectFrom('event')
        .selectAll()
        .where('kind', '=', `${kind}_facts_changed`)
        .orderBy('id')
        .execute();
      expect(events).toHaveLength(2);
      expect(JSON.parse(events.at(-1)?.payload ?? '{}')).toEqual({ facts: changed.facts });
      expect(
        (await store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow()).last_change_at,
      ).toBe(timestamp);
    },
  );

  it.each(['health', 'healthSince'] as const)('journals a session %s change', async (field) => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const observe = (facts: SessionFacts) =>
      core.observe('spur', {
        batch: {
          source: 'spur',
          observedAt: new Date(now).toISOString(),
          complete: false,
          items: [{ kind: 'session', facts }],
          entities: [],
        },
        effectiveComplete: false,
        state: { gone: [] },
        outcomes: [],
      });
    await observe(sessionFact('worker-1'));
    now += 1_000;
    const timestamp = new Date(now).toISOString();
    const facts = {
      ...sessionFact('worker-1'),
      lastActivityAt: timestamp,
      ...(field === 'health' ? { health: 'waiting' as const } : { healthSince: timestamp }),
    };
    await observe(facts);
    const events = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'session_facts_changed')
      .orderBy('id')
      .execute();
    expect(events).toHaveLength(2);
    expect(JSON.parse(events.at(-1)?.payload ?? '{}')).toEqual({ facts });
    expect(
      (await store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow()).last_change_at,
    ).toBe(timestamp);
  });

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

  it('links a Jira /browse/ session link and skips one whose key starts with a digit or has over 15 digits', async () => {
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
    const { store, core } = setup(jira);
    const observe = (src: string, items: Batch['items']) =>
      core.observe(src, {
        batch: { source: src, observedAt: at, complete: true, items, entities: [] },
        effectiveComplete: true,
        state: { lastCompleteAt: at, gone: [] },
        outcomes: [],
      });
    const browse = (key: string) => `https://jira.example.test/browse/${key}`;
    await observe('jira:web', [
      {
        kind: 'ticket',
        facts: {
          ...fact('WEBDEV-1'),
          trackerId: 'jira:web',
          id: '10001',
          status: 'In Progress',
          labels: [],
          inFilter: true,
          url: browse('WEBDEV-1'),
        },
      },
      {
        kind: 'ticket',
        facts: {
          ...fact('WEBDEV-123456789012345'),
          trackerId: 'jira:web',
          id: '10002',
          status: 'In Progress',
          labels: [],
          inFilter: true,
          url: browse('WEBDEV-123456789012345'),
        },
      },
    ]);
    await observe('spur', [
      {
        kind: 'session',
        facts: sessionFact('other-1', {
          'board-worker': browse('9WEB-1'),
          'board-other': browse('WEBDEV-1'),
        }),
      },
      {
        kind: 'session',
        facts: sessionFact('other-2', {
          'board-worker': browse('WEBDEV-1234567890123456'),
          'board-other': browse('WEBDEV-1'),
        }),
      },
      { kind: 'session', facts: sessionFact('worker-1', { 'board-worker': browse('WEBDEV-1') }) },
      {
        kind: 'session',
        facts: sessionFact('worker-2', { 'board-worker': browse('WEBDEV-123456789012345') }),
      },
    ]);
    expect(
      await store.db
        .selectFrom('link')
        .select(['session_id', 'role', 'source'])
        .where('entity', '=', 'session')
        .orderBy('session_id')
        .execute(),
    ).toEqual([
      { session_id: 'other-1', role: 'other', source: 'spawn_link' },
      { session_id: 'other-2', role: 'other', source: 'spawn_link' },
      { session_id: 'worker-1', role: 'worker', source: 'spawn_link' },
      { session_id: 'worker-2', role: 'worker', source: 'spawn_link' },
    ]);
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

  it.each(['curator', 'orchestrator'] as const)(
    'requests unlinked %s sessions by id and ends one Spur no longer knows',
    async (role) => {
      const curated = configSchema.parse({
        ...config,
        projects: config.projects.map((project) => ({
          ...project,
          spurProjects: [...project.spurProjects, { name: 'cur', role }],
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
    },
  );

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

  it.each(['curator', 'orchestrator'] as const)(
    'does not link a %s session through its pr field or a task branch',
    async (role) => {
      const withCurator = {
        ...config,
        projects: config.projects.map((project) => ({
          ...project,
          spurProjects: [...project.spurProjects, { name: 'cur', role }],
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
            {
              kind: 'session',
              facts: {
                ...sessionFact('cur-3'),
                spurProject: 'cur',
                branch: prFact().headBranch,
                pr,
              },
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
    },
  );

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
    await pollGithub(core);
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
  /** A complete Spur poll that reports worker-1 ended for `reason`. */
  const observeEnded = (
    core: ReturnType<typeof setup>['core'],
    reason: 'complete' | 'kill' | 'vanished',
  ) =>
    reason === 'vanished'
      ? observeSpur(core, [], [{ ref: { kind: 'session', id: 'worker-1' }, status: 'not_found' }])
      : observeSpur(core, [
          {
            ...sessionFact('worker-1', workerLink, true),
            endReason: reason,
            lifecycle: reason === 'kill' ? 'killed' : 'completed',
          },
        ]);
  const observeTicket = (core: ReturnType<typeof setup>['core'], status: string) => {
    const observedAt = new Date(now).toISOString();
    return core.observe(source, {
      batch: {
        source,
        observedAt,
        complete: true,
        items: [{ kind: 'ticket', facts: { ...fact(), status } }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: observedAt, gone: [] },
      outcomes: [],
    });
  };

  it.each([
    {
      reason: 'complete',
      kind: 'worker_completed',
      text: 'o/r#9: worker ended (completed), no PR (worker-1)',
      itemKind: 'anomaly',
      lines: 0,
      blocks: 1,
      row: 'ended (completed)',
    },
    {
      reason: 'kill',
      kind: 'worker_killed',
      text: 'o/r#9: worker ended (killed), no PR (worker-1)',
      itemKind: 'worker_ended',
      lines: 1,
      blocks: 0,
      row: 'ended (killed)',
    },
    {
      reason: 'vanished',
      kind: 'worker_vanished',
      text: 'o/r#9: worker vanished, no PR (worker-1)',
      itemKind: 'board_observation',
      lines: 1,
      blocks: 0,
      row: 'ended (vanished)',
    },
  ] as const)(
    'names a $reason worker end in the item and posts $lines feed lines',
    async ({ reason, kind, text, itemKind, lines, blocks, row }) => {
      const { store, core, apply, mutations } = setup();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      await observeSpur(core, [sessionFact('worker-1', workerLink)]);
      now += 1_000;
      await observeEnded(core, reason);
      await pollGithub(core);
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
      const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
      expect(status.tasks[0]?.state.split('; ').at(-1)).toBe(`sessions 1 ${row}`);
      const states = await store.db
        .selectFrom('event')
        .select('payload')
        .where('kind', '=', 'session_state_changed')
        .execute();
      expect(
        states
          .map(({ payload }) =>
            eventPayloadSchemas.session_state_changed.parse(JSON.parse(payload)),
          )
          .filter(({ from, to }) => from === to),
      ).toEqual([]);
      const registry = createOperationRegistry({
        config,
        clock,
        completeSince: core.completeSince,
      });
      const { events } = await createQuery({ store, config, clock })(
        registry['task.history'],
        { task: 'o/r#9' },
        'operator',
      );
      if (reason === 'vanished')
        expect(events.map(({ summary }) => summary)).toContain(
          'Session worker-1: ended (vanished)',
        );

      // Each complete Spur poll confirms the ended worker again; only the fact time moves.
      const item = items[0];
      if (item === undefined) throw new Error('Missing ended-worker item');
      const statusItem = async () =>
        (await getStatus({ store, config, clock, completeSince: core.completeSince })).items.find(
          (entry) => entry.key === item.item_key,
        );
      now += 60_000;
      await observeEnded(core, reason);
      await pollGithub(core);
      const confirmed = await statusItem();
      expect(confirmed).toMatchObject({
        id: `I${String(item.id)}`,
        unconfirmed: false,
        factAt: new Date(now).toISOString(),
      });
      expect(confirmed?.summary).not.toContain('(not confirmed');
      expect(await healthLines(store)).toHaveLength(lines);
      now += 60_000;
      await tickBoard({ store, config, clock, completeSince: core.completeSince });
      expect(await statusItem()).toMatchObject({ unconfirmed: true });

      // A done ticket ends the item; a reopened one raises it again.
      await observeTicket(core, 'closed');
      const cleared = await store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow();
      expect(cleared.cleared_at).not.toBeNull();
      if (item.block_id !== null)
        expect(
          await store.db
            .selectFrom('block')
            .select(['state', 'outcome'])
            .where('id', '=', item.block_id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'unblocked', outcome: 'withdrawn' });
      const edits = await store.db
        .selectFrom('outbox')
        .select('parent_outbox_id')
        .where('kind', '=', 'feed.line.edit')
        .execute();
      expect(edits).toEqual(
        item.line_outbox_id === null ? [] : [{ parent_outbox_id: item.line_outbox_id }],
      );
      now += 1_000;
      await observeTicket(core, 'open');
      expect(
        await store.db
          .selectFrom('operator_item')
          .select(['item_key', 'raise_no'])
          .where('item_key', '=', item.item_key)
          .where('cleared_at', 'is', null)
          .execute(),
      ).toEqual([{ item_key: item.item_key, raise_no: 2 }]);
    },
  );

  it.each(['complete', 'kill', 'vanished'] as const)(
    'keeps a held %s worker item open with its fact time until the window marks it not confirmed',
    async (reason) => {
      const { store, core, apply, mutations } = setup();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      await observeSpur(core, [sessionFact('worker-1', workerLink)]);
      now += 1_000;
      await observeEnded(core, reason);
      await pollGithub(core);
      const open = () =>
        store.db
          .selectFrom('operator_item')
          .selectAll()
          .where('item_key', 'like', 'health:%')
          .where('cleared_at', 'is', null)
          .execute();
      const [item] = await open();
      if (item === undefined) throw new Error('Missing ended-worker item');
      await core.reportSourceState('github:board:o/r', {
        blind: { reason: 'auth', message: 'Access rejected' },
        gone: [],
      });
      now += 60_000;
      await observeEnded(core, reason);
      expect(await open()).toEqual([item]);
      const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
      expect(status.items.find((entry) => entry.key === item.item_key)).toMatchObject({
        factAt: item.fact_at,
        unconfirmed: true,
      });
    },
  );

  it('holds a completed-worker block while Spur is blind until its ticket is done', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await observeSpur(core, [sessionFact('worker-1', workerLink)]);
    now += 1_000;
    await observeEnded(core, 'complete');
    await pollGithub(core);
    const item = await store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'like', 'health:%:worker-1:worker_completed')
      .executeTakeFirstOrThrow();
    expect(item.block_id).not.toBeNull();
    const state = async () => ({
      cleared:
        (
          await store.db
            .selectFrom('operator_item')
            .select('cleared_at')
            .where('id', '=', item.id)
            .executeTakeFirstOrThrow()
        ).cleared_at !== null,
      block: await store.db
        .selectFrom('block')
        .select(['state', 'outcome'])
        .where('id', '=', item.block_id ?? -1)
        .executeTakeFirstOrThrow(),
    });
    now += 1_000;
    await core.reportSourceState('spur', {
      lastCompleteAt: new Date(now).toISOString(),
      blind: { reason: 'stale', message: 'Spur stopped answering' },
      gone: [],
    });
    now += 1_000;
    await observeTicket(core, 'open');
    await tickBoard({ store, config, clock, completeSince: core.completeSince });
    expect(await state()).toEqual({ cleared: false, block: { state: 'open', outcome: null } });
    now += 1_000;
    await observeTicket(core, 'closed');
    expect(await state()).toEqual({
      cleared: true,
      block: { state: 'unblocked', outcome: 'withdrawn' },
    });
  });

  it.each([
    {
      signal: 'a listed killed lifecycle',
      polls: [[{ lifecycle: 'killed' }]],
      row: 'ended (killed)',
    },
    {
      signal: 'absence from a complete poll',
      polls: [[{}], []],
      row: 'ended (gone)',
    },
    {
      signal: 'a listed stopped lifecycle',
      polls: [
        [{ lifecycle: 'stopped', health: 'stopped' }],
        [{ lifecycle: 'stopped', health: 'stopped' }],
      ],
      row: 'stopped',
    },
    {
      signal: 'a listed paused lifecycle',
      polls: [[{ lifecycle: 'paused', health: 'stopped' }]],
      row: 'stopped',
    },
  ] as const satisfies readonly {
    signal: string;
    polls: readonly (readonly Partial<SessionFacts>[])[];
    row: string;
  }[])(
    'counts a linked session by what the board knows of its end: $signal',
    async ({ polls, row }) => {
      const { store, core, apply, mutations } = setup();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      for (const poll of polls) {
        await observeSpur(
          core,
          poll.map((patch) => ({ ...sessionFact('worker-1', workerLink), ...patch })),
        );
        now += 1_000;
      }
      const status = await getStatus({ store, config, clock, completeSince: core.completeSince });
      expect(status.tasks[0]?.sessionCount).toBe(1);
      expect(status.tasks[0]?.state.split('; ').at(-1)).toBe(`sessions 1 ${row}`);
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
    await pollGithub(core);
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

  it('clears an open pre-upgrade vanished item for a killed worker and raises it with one line', async () => {
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
    await pollGithub(core);
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
    expect(items[1]?.line_outbox_id).not.toBeNull();
    expect((await healthLines(store)).map((row) => row.id)).toEqual([
      line.id,
      items[1]?.line_outbox_id,
    ]);
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
    await pollGithub(core);
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
    // The complete Spur poll confirms the ended worker again and moves only the fact time.
    expect(await items()).toEqual([{ ...item, fact_at: observedAt }]);
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
    const links = createLinkMutations(config, {
      prPoller: () => () =>
        Promise.resolve({
          ok: true,
          value: { status: 'ok', facts: prFact(), observedAt: at },
        }),
    });
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

  describe('PRs of archived tasks', () => {
    const github = 'github:board:o/r';
    const pr = (number: number) => ({ kind: 'pr' as const, repo: 'o/r', number });
    /** The polled PR numbers in ascending order; `linkedPrs` promises no order. */
    async function polled(core: ReturnType<typeof setup>['core']) {
      const { prs } = (await core.context(github)).observe;
      return [...prs].sort((left, right) => left.number - right.number);
    }
    async function linkPrs(
      store: Store,
      links: readonly { task: number; number: number; state?: 'active' | 'conflict' }[],
    ): Promise<void> {
      await store.db
        .insertInto('link')
        .values(
          links.map((link) => ({
            task_id: link.task,
            entity: 'pr' as const,
            repo: 'o/r',
            number: link.number,
            pr_state: link.state ?? 'active',
            pr_open: 1 as const,
            session_id: null,
            role: null,
            source: 'manual' as const,
            ticket_key: null,
            created_at: at,
          })),
        )
        .execute();
    }
    async function archivedSetup() {
      const env = setup();
      await env.apply(env.mutations.add, { task: 'o/r#9' }, 'operator');
      await env.apply(env.mutations.add, { task: 'o/r#10' }, 'operator');
      await linkPrs(env.store, [
        { task: 1, number: 5 },
        { task: 2, number: 6 },
        { task: 1, number: 8, state: 'conflict' },
        { task: 2, number: 8, state: 'conflict' },
      ]);
      await env.apply(env.mutations.archive, { task: 'o/r#10' }, 'operator');
      return env;
    }

    it('leaves out a PR linked only to archived tasks and keeps one also linked to an active task', async () => {
      const { core } = await archivedSetup();

      expect(await polled(core)).toEqual([pr(5), pr(8)]);
    });

    it('polls the PR of a restored task again on the next context', async () => {
      const { core, apply, mutations } = await archivedSetup();
      await apply(mutations.add, { task: 'o/r#10' }, 'operator');

      expect(await polled(core)).toEqual([pr(5), pr(6), pr(8)]);
    });

    it('keeps the PR of an out-of-filter task', async () => {
      const { store, core } = await archivedSetup();
      await store.db
        .updateTable('task')
        .set({ membership: 'out_of_filter' })
        .where('id', '=', 1)
        .execute();

      expect(await polled(core)).toEqual([pr(5), pr(8)]);
    });

    it('links no discovered PR of an archived task, with or without its earlier link', async () => {
      for (const linked of [false, true]) {
        const { store, core, apply, mutations } = setup();
        await apply(mutations.add, { task: 'o/r#9' }, 'operator');
        if (linked) await linkPrs(store, [{ task: 1, number: 7 }]);
        await apply(mutations.archive, { task: 'o/r#9' }, 'operator');
        const before = await store.db
          .selectFrom('event')
          .select(({ fn }) => fn.max('id').as('id'))
          .executeTakeFirstOrThrow();
        const links = await store.db.selectFrom('link').selectAll().execute();

        await core.observe(github, {
          batch: {
            source: github,
            observedAt: at,
            complete: true,
            items: [{ kind: 'pr', facts: { ...prFact(), headBranch: 'o/r#9-work' } }],
            entities: [],
          },
          effectiveComplete: true,
          state: { lastCompleteAt: at, gone: [] },
          outcomes: [],
        });

        expect(await store.db.selectFrom('link').selectAll().execute()).toEqual(links);
        expect(await store.db.selectFrom('task').select(['key', 'membership']).execute()).toEqual([
          { key: 'o/r#9', membership: 'archived' },
        ]);
        const added = await store.db
          .selectFrom('event')
          .select('kind')
          .where('id', '>', before.id)
          .where('kind', 'in', ['link_added', 'task_added'])
          .execute();
        expect(added).toEqual([]);
      }
    });
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

  it('drops the held history of a PR whose only link is on an archived task', async () => {
    const { store, core, apply, mutations } = await linkedSetup();
    await observePr(core, {
      kind: 'pr',
      facts: { ...prFact(), feedback: [comment('c-1')] },
      continuation: { resume: resume('p1') },
    });
    expect(await store.db.selectFrom('pr_continuation').select('ref_key').execute()).toEqual([
      { ref_key: 'pr:o/r#7' },
    ]);
    await apply(mutations.archive, { task: 'o/r#9' }, 'operator');

    await core.observe(github, {
      batch: { source: github, observedAt: at, complete: true, items: [], entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });

    expect(await store.db.selectFrom('pr_continuation').selectAll().execute()).toEqual([]);
    expect('continuations' in (await core.context(github))).toBe(false);
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
    // These cases advance health clocks without a live poll timer. Isolate their health
    // boundaries with a long source window; expiry cases select a shorter poll interval.
    const fixtureConfig = configSchema.parse({
      ...testConfig,
      thresholds: { ...testConfig.thresholds, staleMultiplier: 1000 },
    });
    const ctx = setup(fixtureConfig);
    await ctx.apply(ctx.mutations.add, { task: key }, 'operator');
    const task = await ctx.store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow();
    return { ...ctx, task, config: fixtureConfig };
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
  const completed = (id: string): SessionFacts => ({
    ...sessionFact(id, link, true),
    endedAt: iso(),
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

  /** A worker turn of the task in `column` taken by `session` at the current time. */
  function heldTurn(b: Board, session = 'worker-1', column: ColumnId = b.task.column) {
    return b.store.transaction((trx) =>
      trx
        .insertInto('turn')
        .values({
          task_id: b.task.id,
          column,
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

  it.each(['needs_input', 'error', 'rate_limited', 'stopped'] as const)(
    'times an open-turn executor in %s from its health episode',
    async (health) => {
      const b = await board();
      await spur(b, [
        session('worker-1', health, { lifecycle: health === 'stopped' ? 'stopped' : 'running' }),
      ]);
      const turn = await heldTurn(b);
      now += 600_000 - 1;
      await tick(b);
      expect(await openLedger(b)).toEqual([]);
      now += 1;
      await tick(b);
      const state = await surface(b);
      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toEqual(
        expect.objectContaining({
          state: 'open',
          author: 'system',
          addressee_role: 'operator',
          type: 'needs_input',
        }),
      );
      expect(state.blocks[0]?.reason).toContain(`turn T${String(turn.id)}`);
      expect(state.blocks[0]?.reason).toContain(`worker-1 remains ${health} since ${at}`);
      expect(state.blocks[0]?.reason).toContain('600000 ms');
      if (health === 'rate_limited')
        expect(state.blocks[0]?.reason).toContain('quota name unavailable');
      now += 60_000;
      await tick(b);
      expect((await surface(b)).blocks).toEqual(state.blocks);
      await closeTurn(b);
      await tick(b);
      expect(
        (await surface(b)).items.filter(
          (item) => item.item_key.startsWith('turn-stall:') && item.cleared_at === null,
        ),
      ).toEqual([]);
      expect((await surface(b)).blocks[0]?.outcome).toBe('withdrawn');
    },
  );

  it('mirrors the open stall block in status.get turn.stalledSince', async () => {
    const b = await board();
    const turnOf = async () =>
      (
        await getStatus({
          store: b.store,
          config: b.config,
          clock,
          completeSince: b.core.completeSince,
        })
      ).tasks[0]?.turn;
    await spur(b, [session('worker-1', 'working')]);
    await heldTurn(b);
    await tick(b);
    expect((await turnOf())?.stalledSince).toBeNull();
    const since = iso();
    await spur(b, [session('worker-1', 'needs_input')]);
    now += b.config.health.turnStallAfterMs - 1;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await turnOf())?.stalledSince).toBeNull();
    now += 1;
    await tick(b);
    expect(await openLedger(b)).toHaveLength(1);
    expect((await turnOf())?.stalledSince).toBe(since);
    await spur(b, [session('worker-1', 'working')]);
    await tick(b);
    expect((await turnOf())?.stalledSince).toBeNull();
    await closeTurn(b);
    await tick(b);
    expect(await turnOf()).toBeNull();
  });

  it.each(
    (['needs_input', 'error', 'rate_limited', 'stopped'] as const).flatMap((health) =>
      [
        'same core',
        'new core',
        'status before snapshot',
        'startup poll first',
        'startup tick first',
        'startup status first',
        'unpublished tick first',
        'unpublished poll first',
      ].map((gap) => ({ health, gap })),
    ),
  )('restarts unproven $health continuity after $gap', async ({ health, gap }) => {
    const b = await board(
      gap.startsWith('unpublished ')
        ? configSchema.parse({
            ...config,
            adapters: {
              ...config.adapters,
              spur: { ...config.adapters.spur, intervalMs: 2000 },
            },
          })
        : config,
    );
    const original = session('worker-1', health, {
      lifecycle: health === 'stopped' ? 'stopped' : 'running',
    });
    await spur(b, [original]);
    await heldTurn(b);
    now += 300_000;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    if (!gap.startsWith('startup ') && !gap.startsWith('unpublished '))
      await b.core.reportSourceState('spur', {
        lastCompleteAt: iso(),
        blind: { reason: 'stale', message: 'Offline' },
        gone: [],
      });
    now += 3_600_000;
    const resumed =
      gap === 'new core' || gap.startsWith('startup ')
        ? { ...b, core: createObservationCore({ store: b.store, config: b.config, clock }) }
        : b;
    if (gap === 'startup status first')
      await resumed.core.reportSourceState('spur', { lastCompleteAt: iso(), gone: [] });
    if (gap !== 'startup poll first' && gap !== 'unpublished poll first') await tick(resumed);
    expect(await openLedger(b)).toEqual([]);
    if (gap === 'status before snapshot') {
      await resumed.core.reportSourceState('spur', { lastCompleteAt: iso(), gone: [] });
      await tick(resumed);
      expect(await openLedger(b)).toEqual([]);
    }
    await spur(resumed, [original]);
    expect(await openLedger(b)).toEqual([]);
    now += config.health.turnStallAfterMs - 1;
    await spur(resumed, [original]);
    await tick(resumed);
    expect(await openLedger(b)).toEqual([]);
    now += 1;
    await tick(resumed);
    const opened = await surface(b);
    expect(opened.blocks).toHaveLength(1);
    expect(opened.blocks[0]?.state).toBe('open');
    expect(opened.blocks[0]?.reason).toContain('elapsed 600000 ms');
    const holding = gap.startsWith('startup ')
      ? { ...resumed, core: createObservationCore({ store: b.store, config: b.config, clock }) }
      : resumed;
    if (!gap.startsWith('startup ') && !gap.startsWith('unpublished '))
      await holding.core.reportSourceState('spur', {
        lastCompleteAt: iso(),
        blind: { reason: 'stale', message: 'Offline again' },
        gone: [],
      });
    now += 3_600_000;
    if (gap === 'startup status first')
      await holding.core.reportSourceState('spur', { lastCompleteAt: iso(), gone: [] });
    if (gap !== 'startup poll first' && gap !== 'unpublished poll first') await tick(holding);
    expect((await surface(b)).blocks).toEqual(opened.blocks);
    await spur(holding, [original]);
    expect((await surface(b)).blocks).toEqual(opened.blocks);
  });

  it.each([
    'same executor',
    'different curator',
    'healthy replacement curator',
    'ended curator',
    'claimed curator ended',
    'healthy handover',
  ] as const)('routes stalled curator-column turns with %s', async (recipient) => {
    const cfg = configSchema.parse({
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        columns: project.columns.map((column) => ({
          ...column,
          orchestrator: recipient === 'different curator' ? 'reviewer' : 'curator',
        })),
        spurProjects: [
          ...project.spurProjects,
          { name: 'curator', role: 'curator' },
          { name: 'reviewer', role: 'orchestrator' },
        ],
      })),
    });
    const b = await board(cfg);
    const project = recipient === 'different curator' ? 'reviewer' : 'curator';
    const executor = session('executor', 'needs_input', {
      spurProject: project,
      links: {},
      branch: null,
    });
    await spur(b, [executor]);
    const turn = await heldTurn(b, 'executor');
    await b.store.db
      .updateTable('turn')
      .set({ role: `orchestrator:${b.task.column}`, acked_by: `agent:${project}/executor` })
      .where('id', '=', turn.id)
      .execute();
    now += 1;
    if (recipient !== 'same executor')
      await spur(b, [
        executor,
        session('healthy-curator', 'waiting', {
          spurProject: 'curator',
          links: {},
          branch: null,
        }),
      ]);
    now += cfg.health.turnStallAfterMs;
    await tick(b);
    const { blocks } = await surface(b);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.addressee_role).toBe(recipient === 'same executor' ? 'operator' : 'curator');
    expect(
      await b.store.db
        .selectFrom('notification')
        .select('role')
        .where('block_id', '=', blocks[0]?.id ?? -1)
        .execute(),
    ).toEqual(recipient === 'same executor' ? [] : [expect.objectContaining({ role: 'curator' })]);
    expect((await surface(b)).opens).toBe(recipient === 'same executor' ? 1 : 0);
    if (['ended curator', 'claimed curator ended', 'healthy handover'].includes(recipient)) {
      await scanTransaction(b.store, b.config, (trx) =>
        reconcileDoorbells(trx, new Date(now), b.config),
      );
      const queued = await b.store.db
        .selectFrom('outbox')
        .selectAll()
        .where('kind', '=', 'doorbell')
        .executeTakeFirstOrThrow();
      if (recipient === 'claimed curator ended')
        await b.store.db
          .updateTable('outbox')
          .set({ state: 'in_flight', attempts: 1, attempt_started: 0 })
          .where('id', '=', queued.id)
          .execute();
      now += 1;
      await spur(b, [
        executor,
        session('healthy-curator', 'waiting', {
          spurProject: 'curator',
          links: {},
          branch: null,
          lifecycle: 'completed',
          endedAt: iso(),
          endReason: 'complete',
        }),
        ...(recipient === 'healthy handover'
          ? [
              session('next-curator', 'waiting', {
                spurProject: 'curator',
                links: {},
                branch: null,
              }),
            ]
          : []),
      ]);
      const [after] = (await surface(b)).blocks;
      expect(after?.id).toBe(blocks[0]?.id);
      expect(after?.reason).toBe(blocks[0]?.reason);
      expect(after?.state).toBe('open');
      expect(after?.addressee_role).toBe(recipient === 'healthy handover' ? 'curator' : 'operator');
      const sent: string[] = [];
      const sender = createSender({
        store: b.store,
        config: b.config,
        now: () => new Date(now),
        spur: {
          send(id) {
            sent.push(id);
            return Promise.resolve();
          },
        },
      });
      await sender.recover();
      await sender.tick();
      expect(sent).not.toContain('executor');
      expect(sent).not.toContain('healthy-curator');
      expect(
        await b.store.db
          .selectFrom('outbox')
          .select('state')
          .where('id', '=', queued.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'dead' });
    }
  });

  it.each(['worker', 'linked orchestrator', 'unlinked orchestrator'] as const)(
    'diagnoses taken and untaken %s executors in every unhealthy state',
    async (kind) => {
      for (const taken of [false, true])
        for (const health of ['needs_input', 'error', 'rate_limited', 'stopped'] as const) {
          const cfg = configSchema.parse({
            ...config,
            projects: config.projects.map((project) => ({
              ...project,
              columns: project.columns.map((column) => ({
                ...column,
                orchestrator: kind === 'worker' ? 'none' : 'reviewer',
              })),
              spurProjects: [...project.spurProjects, { name: 'reviewer', role: 'orchestrator' }],
            })),
          });
          const b = await board(cfg);
          const fact = session('executor', health, {
            lifecycle: health === 'stopped' ? 'stopped' : 'running',
            spurProject: kind === 'worker' ? 'worker' : 'reviewer',
            links:
              kind === 'unlinked orchestrator'
                ? {}
                : kind === 'worker'
                  ? link
                  : { 'board-other': 'https://github.com/o/r/issues/9' },
          });
          await spur(b, [fact]);
          const links = await b.store.db
            .selectFrom('link')
            .select('id')
            .where('session_id', '=', fact.id)
            .execute();
          expect(links).toHaveLength(kind === 'unlinked orchestrator' ? 0 : 1);
          const turn = await heldTurn(b, 'executor');
          await b.store.db
            .updateTable('turn')
            .set({
              role: kind === 'worker' ? 'worker' : `orchestrator:${b.task.column}`,
              acked_by: taken ? `agent:${fact.spurProject}/executor` : null,
              acked_at: taken ? iso() : null,
            })
            .where('id', '=', turn.id)
            .execute();
          now += cfg.health.turnStallAfterMs - 1;
          await tick(b);
          expect(
            (await surface(b)).items.filter((item) => item.item_key.startsWith('turn-stall:')),
          ).toEqual([]);
          now += 1;
          await tick(b);
          const state = await surface(b);
          expect(
            state.items.filter(
              (item) => item.item_key.startsWith('turn-stall:') && item.cleared_at === null,
            ),
          ).toHaveLength(1);
          expect(
            state.blocks.filter((block) => block.state === 'open' && block.author === 'system'),
          ).toHaveLength(1);
        }
    },
  );

  it('freezes reset and question evidence across polls, restarts, and manual dismissal', async () => {
    const b = await board();
    const reset = '2099-01-01T00:00:00.000Z';
    const stalled = session('worker-1', 'rate_limited', { rateLimitResetAt: reset });
    await spur(b, [stalled]);
    await heldTurn(b);
    for (const [actor, key] of [
      ['agent:worker/worker-1', 'same'],
      ['agent:worker/worker-1', 'same-again'],
      ['agent:worker/worker-1', 'other-author'],
      ['agent:worker/worker-1', 'other-task'],
    ] as const)
      await b.apply(createBlockMutations(config).ask, { task: b.task.key, text: key }, actor, key);
    const questions = (await surface(b)).blocks;
    await b.store.db
      .updateTable('block')
      .set({ author: 'agent:worker/unrelated' })
      .where('id', '=', questions[2]?.id ?? -1)
      .execute();
    await b.apply(b.mutations.add, { task: 'o/r#10' }, 'operator');
    const otherTask = await b.store.db
      .selectFrom('task')
      .select('id')
      .where('key', '=', 'o/r#10')
      .executeTakeFirstOrThrow();
    await b.store.db
      .updateTable('block')
      .set({ task_id: otherTask.id })
      .where('id', '=', questions[3]?.id ?? -1)
      .execute();
    now += config.health.turnStallAfterMs;
    await tick(b);
    const first = (await surface(b)).blocks.find((block) => block.author === 'system');
    if (first === undefined) throw new Error('Missing stall block');
    expect(first.reason).toContain(reset);
    expect(first.reason).toContain(`open executor questions: B${String(questions[0]?.id)}`);
    expect(first.reason).toContain(`B${String(questions[1]?.id)}`);
    expect(first.reason).not.toContain(`B${String(questions[2]?.id)}`);
    expect(first.reason).not.toContain(`B${String(questions[3]?.id)}`);
    now += 60_000;
    const restarted = {
      ...b,
      core: createObservationCore({ store: b.store, config: b.config, clock }),
    };
    await spur(restarted, [{ ...stalled, rateLimitResetAt: '2099-02-01T00:00:00.000Z' }]);
    expect((await surface(b)).blocks.find((block) => block.author === 'system')).toEqual(first);
    await b.apply(
      createBlockMutations(config).unblock,
      { mode: 'reason', block: `B${String(first.id)}`, reason: 'Handled' },
      'operator',
    );
    await tick(restarted);
    expect((await surface(b)).blocks.filter((block) => block.author === 'system')).toHaveLength(1);
    expect(
      (await surface(b)).items.filter(
        (item) => item.item_key.startsWith('turn-stall:') && item.cleared_at === null,
      ),
    ).toEqual([]);
    expect((await surface(b)).blocks[0]?.state).toBe('open');
  });

  it('uses a custom threshold and never restarts its clock on acknowledgement', async () => {
    const cfg = configSchema.parse({
      ...config,
      health: { ...config.health, turnStallAfterMs: 300_000 },
    });
    const b = await board(cfg);
    await spur(b, [session('worker-1', 'error')]);
    const turn = await heldTurn(b);
    await b.store.db
      .updateTable('turn')
      .set({ acked_by: null, acked_at: null })
      .where('id', '=', turn.id)
      .execute();
    now += 299_999;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    await b.store.db
      .updateTable('turn')
      .set({ acked_by: 'agent:worker/worker-1', acked_at: iso() })
      .where('id', '=', turn.id)
      .execute();
    now += 1;
    await tick(b);
    expect((await surface(b)).blocks).toHaveLength(1);
  });

  it.each(['older health', 'new health'] as const)(
    'starts at the later turn/state timestamp with %s',
    async (kind) => {
      const b = await board();
      const turnStart = now;
      await spur(b, [
        session('worker-1', 'rate_limited', { healthSince: new Date(now - 600_000).toISOString() }),
      ]);
      await heldTurn(b);
      let start = turnStart;
      if (kind === 'new health') {
        now += 100_000;
        start = now;
        await spur(b, [session('worker-1', 'needs_input')]);
      }
      now = start + config.health.turnStallAfterMs - 1;
      await tick(b);
      expect(await openLedger(b)).toEqual([]);
      now += 1;
      await tick(b);
      expect((await surface(b)).blocks).toHaveLength(1);
    },
  );

  it('prefers an eligible replacement over an untaken stopped worker', async () => {
    const b = await board();
    const old = session('worker-1', 'stopped', { lifecycle: 'stopped' });
    await spur(b, [old]);
    const turn = await heldTurn(b);
    await b.store.db
      .updateTable('turn')
      .set({ acked_at: null, acked_by: null })
      .where('id', '=', turn.id)
      .execute();
    now += config.health.turnStallAfterMs;
    await tick(b);
    expect((await surface(b)).blocks).toHaveLength(1);
    now += 1;
    await spur(b, [old, session('worker-2', 'working')]);
    await b.store.db
      .updateTable('link')
      .set({ role: 'worker' })
      .where('session_id', '=', 'worker-2')
      .execute();
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect((await surface(b)).blocks[0]?.outcome).toBe('withdrawn');
  });

  it('withdraws on state change and recovery, and waits for each new episode', async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'error')]);
    await heldTurn(b);
    now += 60_000;
    await spur(b, [session('worker-1', 'working')]);
    now += config.health.turnStallAfterMs;
    await tick(b);
    expect((await surface(b)).blocks).toEqual([]);
    await spur(b, [session('worker-1', 'needs_input')]);
    now += config.health.turnStallAfterMs;
    await tick(b);
    expect((await surface(b)).blocks).toHaveLength(1);
    await spur(b, [session('worker-1', 'rate_limited')]);
    expect(await openLedger(b)).toEqual([]);
    now += config.health.turnStallAfterMs - 1;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    now += 1;
    await tick(b);
    expect((await surface(b)).blocks).toHaveLength(2);
    await spur(b, [session('worker-1', 'working')]);
    expect(await openLedger(b)).toEqual([]);
  });

  it.each(['replacement', 'removed', 'archived', 'closed'] as const)(
    'withdraws a stalled turn on %s even during Spur blindness',
    async (end) => {
      const b = await board();
      await spur(b, [session('worker-1', 'rate_limited')]);
      const turn = await heldTurn(b);
      now += config.health.turnStallAfterMs;
      await b.core.reportSourceState('spur', {
        lastCompleteAt: iso(),
        blind: { reason: 'stale', message: 'Offline' },
        gone: [],
      });
      await tick(b);
      expect((await surface(b)).blocks).toEqual([]);
      await spur(b, [session('worker-1', 'rate_limited', { healthSince: at })]);
      expect((await surface(b)).blocks).toEqual([]);
      now += config.health.turnStallAfterMs;
      await tick(b);
      expect((await surface(b)).blocks).toHaveLength(1);
      await b.core.reportSourceState('spur', {
        lastCompleteAt: iso(),
        blind: { reason: 'stale', message: 'Offline' },
        gone: [],
      });
      now += 60_000;
      await tick(b);
      expect((await surface(b)).blocks[0]?.state).toBe('open');
      if (end === 'replacement')
        await b.store.db
          .updateTable('turn')
          .set({ acked_by: 'agent:worker/replacement' })
          .where('id', '=', turn.id)
          .execute();
      if (end === 'removed')
        await b.store.db
          .updateTable('link')
          .set({ banned: 1 })
          .where('session_id', '=', 'worker-1')
          .execute();
      if (end === 'archived')
        await b.store.db
          .updateTable('task')
          .set({ membership: 'archived' })
          .where('id', '=', b.task.id)
          .execute();
      if (end === 'closed') await closeTurn(b);
      await tick(b);
      expect(await openLedger(b)).toEqual([]);
      expect((await surface(b)).blocks[0]?.outcome).toBe('withdrawn');
    },
  );

  it.each(['operator', 'missing', 'unknown', 'ended'] as const)(
    'does not diagnose %s executors',
    async (kind) => {
      const b = await board();
      await spur(b, [
        session(
          'worker-1',
          kind === 'unknown' ? unknownSessionHealthSchema.parse('new-state') : 'rate_limited',
          kind === 'ended' ? { endedAt: at, lifecycle: 'completed', endReason: 'complete' } : {},
        ),
      ]);
      const turn = await heldTurn(b, kind === 'missing' ? 'missing' : 'worker-1');
      if (kind === 'operator')
        await b.store.db
          .updateTable('turn')
          .set({ role: 'operator', acked_by: 'operator' })
          .where('id', '=', turn.id)
          .execute();
      now += config.health.turnStallAfterMs;
      await tick(b);
      expect(
        (await surface(b)).items.filter((item) => item.item_key.startsWith('turn-stall:')),
      ).toEqual([]);
    },
  );

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

  describe('a merged PR beside a ticket changed after the merge', () => {
    const interval = config.adapters.githubIssues.intervalMs;
    /** A hand-added task and its ticket, observed by key as the tracker requests it. */
    async function split() {
      const b = await board();
      const ref = (await b.core.context(source)).observe.tickets[0];
      if (ref === undefined) throw new Error('Missing ticket request');
      const ticket = (status: string, updatedAt = iso()) =>
        b.core.observe(source, {
          batch: {
            source,
            observedAt: iso(),
            complete: true,
            items: [{ kind: 'ticket', facts: { ...fact(), status, updatedAt } }],
            entities: [{ ref, status: 'ok' }],
          },
          effectiveComplete: true,
          state: { lastCompleteAt: iso(), gone: [] },
          outcomes: [],
        });
      const healthItems = async () =>
        (
          await b.store.db
            .selectFrom('operator_item')
            .selectAll()
            .where('item_key', 'like', 'health:%')
            .execute()
        ).map((item) => [item.item_key.split(':').at(-1), item.text, item.cleared_at]);
      return { b, ticket, healthItems };
    }

    it('raises the worker-end item naming the merged PR once the ticket changed after the merge', async () => {
      const { b, ticket, healthItems } = await split();
      const before = iso();
      await spur(b, [session('worker-1', 'working')]);
      now += 1_000;
      const merged = { ...pr(7, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [merged]);
      await ticket('open', before);
      now += 1_000;
      await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
      now += 1_000;
      await prs(b, [merged]);
      expect(await healthItems()).toEqual([]);

      now += interval;
      await ticket('open');
      const text = 'o/r#9: worker ended (completed); PR o/r#7 merged, ticket reopened (worker-1)';
      expect(await healthItems()).toEqual([['worker_completed', text, null]]);

      now += 1_000;
      await ticket('closed');
      expect(await healthItems()).toEqual([['worker_completed', text, expect.any(String)]]);
    });

    it('keeps the reopened worker-end item across non-done status changes, and its dismissal', async () => {
      const { b, ticket } = await split();
      await spur(b, [session('worker-1', 'working')]);
      await prs(b, [pr(7, 'merged')]);
      await ticket('open');
      now += 1_000;
      await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
      now += 1_000;
      await prs(b, [pr(7, 'merged')]);
      now += interval;
      await ticket('open');
      const items = () =>
        b.store.db
          .selectFrom('operator_item')
          .selectAll()
          .where('item_key', 'like', 'health:%')
          .execute();
      const [raised] = await items();
      if (raised === undefined) throw new Error('Missing worker-end item');
      expect(raised.cleared_at).toBeNull();

      // Any other non-done status, as a Jira workflow moves through.
      now += 1_000;
      await ticket('in review');
      expect(await items()).toEqual([raised]);

      now += 1_000;
      await b.store.transaction((trx) => dismissItem(trx, raised, 'operator', new Date(now)));
      now += 1_000;
      await ticket('in progress');
      const after = await items();
      expect(after.map((item) => [item.id, item.fingerprint, item.cleared_at === null])).toEqual([
        [raised.id, raised.fingerprint, false],
      ]);
    });

    it.each([
      'unlinked after dismissal',
      'dismissed before the upgrade',
      'ended again after dismissal',
    ] as const)('keeps the dismissal of a worker-end item off its shown text: %s', async (row) => {
      const { b, ticket } = await split();
      /** The worker-end items not cleared or dismissed, by text. */
      const shown = async () =>
        (
          await b.store.db
            .selectFrom('operator_item')
            .select('text')
            .where('item_key', 'like', 'health:%')
            .where('cleared_at', 'is', null)
            .execute()
        ).map((item) => item.text);
      await spur(b, [session('worker-1', 'working')]);
      await ticket('open', iso());
      now += 1_000;
      const merged = { ...pr(7, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [merged]);
      now += 1_000;
      await ticket('open');
      now += 1_000;
      const endedAt = iso();
      if (row === 'dismissed before the upgrade') {
        // The dismissal an earlier version stored for the same exit, hashed from its text.
        const key = `health:${String(b.task.id)}:worker-1:worker_completed`;
        const text = 'o/r#9: worker ended (completed), no PR (worker-1)';
        await b.store.db
          .insertInto('dismissal')
          .values({
            item_key: key,
            fingerprint: createHash('sha256')
              .update(JSON.stringify([key, text, 'spur', endedAt]))
              .digest('hex'),
            dismissed_by: 'operator',
            dismissed_at: endedAt,
          })
          .execute();
      }
      await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt }]);
      now += 1_000;
      await prs(b, [merged]);
      if (row === 'dismissed before the upgrade') {
        expect(await shown()).toEqual([]);
        expect(await openLedger(b)).toEqual([]);
        return;
      }
      expect(await openLedger(b)).toEqual(['health:worker-1:worker_completed']);
      const item = await b.store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('item_key', 'like', 'health:%')
        .executeTakeFirstOrThrow();
      expect(item.text).toBe(
        'o/r#9: worker ended (completed); PR o/r#7 merged, ticket reopened (worker-1)',
      );
      await b.store.transaction((trx) => dismissItem(trx, item, 'operator', new Date(now)));
      expect(await shown()).toEqual([]);
      now += 1_000;
      if (row === 'unlinked after dismissal') {
        await b.apply(
          createLinkMutations(b.config).remove,
          {
            mode: 'pr',
            task: b.task.key,
            pr: 'https://github.com/o/r/pull/7',
            reason: 'Other ticket.',
          },
          'operator',
        );
        now += 1_000;
        await prs(b, [merged]);
        expect(await shown()).toEqual([]);
      } else {
        await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
        now += 1_000;
        await prs(b, [merged]);
        expect(await shown()).toEqual([
          'o/r#9: worker ended (completed); PR o/r#7 merged, ticket reopened (worker-1)',
        ]);
      }
    });

    it('raises no worker-end item while the ticket is untouched since the merge, up to done', async () => {
      const { b, ticket, healthItems } = await split();
      const before = iso();
      await spur(b, [session('worker-1', 'working')]);
      await ticket('open', before);
      now += 1_000;
      const merged = { ...pr(7, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [merged]);
      now += 1_000;
      await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
      now += 1_000;
      await prs(b, [merged]);
      expect(await healthItems()).toEqual([]);

      // The operator moves the ticket to done minutes after the worker ended.
      now += interval;
      await ticket('open', before);
      await prs(b, [merged]);
      expect(await healthItems()).toEqual([]);
      now += 3 * 60_000;
      await ticket('closed');
      await prs(b, [merged]);
      expect(await healthItems()).toEqual([]);
    });

    it('judges the same merged PR as the dispatcher when the first-linked PR merges last', async () => {
      const { b, ticket, healthItems } = await split();
      await spur(b, [session('worker-1', 'working')]);
      await prs(b, [pr(7, 'open')]);
      now += 1_000;
      // #7 closes, follow-up #8 is linked after it and merges, then #7 reopens and merges last.
      await prs(b, [pr(7, 'closed')]);
      now += 1_000;
      await prs(b, [pr(7, 'closed'), pr(8, 'open')]);
      now += 1_000;
      const eight = { ...pr(8, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [pr(7, 'closed'), eight]);
      now += 1_000;
      await ticket('open');
      now += 1_000;
      await prs(b, [pr(7, 'open'), eight]);
      now += 1_000;
      const seven = { ...pr(7, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [seven, eight]);
      now += 1_000;
      await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
      now += 1_000;
      await prs(b, [seven, eight]);
      // The ticket changed after #8 merged, before #7: both judge #8, the newest link.
      const project = b.config.projects[0];
      if (project === undefined) throw new Error('missing project');
      const read = await b.store.transaction(async (trx) => {
        const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
        return readInput(trx, task, project, 'on', () => false, b.config, {
          at: new Date(now),
          complete: new Map(),
        });
      });
      expect(read?.mergedOpen).toEqual({ repo: 'o/r', number: 8 });
      expect(await healthItems()).toEqual([
        [
          'worker_completed',
          'o/r#9: worker ended (completed); PR o/r#8 merged, ticket reopened (worker-1)',
          null,
        ],
      ]);
    });

    /** Link histories: each ends with the PR facts its last poll reports. */
    const histories = {
      /** #7 merged. */
      merged: async (b: Board) => {
        const seven = { ...pr(7, 'merged'), updatedAt: iso(), mergedAt: iso() };
        await prs(b, [seven]);
        return [seven];
      },
      /** #7 merged, then follow-up #8 linked and closed unmerged. */
      followUpClosed: async (b: Board) => {
        const seven = { ...pr(7, 'merged'), updatedAt: iso(), mergedAt: iso() };
        await prs(b, [seven]);
        now += 1_000;
        await prs(b, [seven, pr(8, 'open')]);
        now += 1_000;
        const eight = { ...pr(8, 'closed'), updatedAt: iso(), closedAt: iso() };
        await prs(b, [seven, eight]);
        return [seven, eight];
      },
      /** Active #7 closed unmerged, then #8, linked as a conflict while #7 was open, merged. */
      conflictMerged: async (b: Board) => {
        await prs(b, [pr(7, 'open')]);
        now += 1_000;
        await prs(b, [pr(7, 'open'), pr(8, 'open')]);
        now += 1_000;
        const seven = { ...pr(7, 'closed'), updatedAt: iso(), closedAt: iso() };
        await prs(b, [seven, pr(8, 'open')]);
        now += 1_000;
        const eight = { ...pr(8, 'merged'), updatedAt: iso(), mergedAt: iso() };
        await prs(b, [seven, eight]);
        return [seven, eight];
      },
    };
    const UNCONFIRMED = { pr: 'merged', mergedOpen: null, unconfirmed: true };
    it.each([
      ['merged', 'untouched', [], UNCONFIRMED],
      [
        'merged',
        'changed',
        ['health:worker-1:worker_completed'],
        { pr: null, mergedOpen: 7, unconfirmed: false },
      ],
      ['merged', 'done', [], { pr: 'merged', mergedOpen: null, unconfirmed: false }],
      [
        'followUpClosed',
        'untouched',
        ['pr-closed', 'health:worker-1:worker_completed'],
        UNCONFIRMED,
      ],
      ['followUpClosed', 'done', [], { pr: 'merged', mergedOpen: null, unconfirmed: false }],
      [
        'conflictMerged',
        'untouched',
        ['pr-closed', 'health:worker-1:worker_completed'],
        { pr: 'closed', mergedOpen: null, unconfirmed: false },
      ],
    ] as const)(
      'agrees with the dispatcher on which merged PR counts: %s, ticket %s',
      async (history, change, ledger, outcome) => {
        const { b, ticket } = await split();
        const before = iso();
        await spur(b, [session('worker-1', 'working')]);
        await ticket('open', before);
        now += 1_000;
        const last = await histories[history](b);
        now += 1_000;
        if (change === 'untouched') await ticket('open', before);
        else await ticket(change === 'done' ? 'closed' : 'open');
        now += 1_000;
        await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
        now += 1_000;
        await prs(b, last);
        expect(await openLedger(b)).toEqual(ledger);
        const project = b.config.projects[0];
        if (project === undefined) throw new Error('missing project');
        const read = await b.store.transaction(async (trx) => {
          const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
          return readInput(trx, task, project, 'on', () => false, b.config, {
            at: new Date(now),
            complete: new Map(),
          });
        });
        expect({
          pr: read?.input.facts.pr?.state ?? null,
          mergedOpen: read?.mergedOpen?.number ?? null,
          unconfirmed: read?.ticketUnconfirmed,
        }).toEqual(outcome);
      },
    );

    it('opens the PR-closed block for an unmerged follow-up beside a merged PR while the ticket is seen open', async () => {
      const { b, ticket } = await split();
      await prs(b, [pr(7, 'merged')]);
      now += interval;
      await ticket('open');
      now += 1_000;
      await prs(b, [pr(7, 'merged'), pr(8, 'closed')]);
      expect(await openLedger(b)).toEqual(['pr-closed']);
      expect((await surface(b)).blocks[0]?.reason).toBe(
        'linked pull request o/r#8 closed without merge, no open PR',
      );
    });

    it('opens no PR-closed block for a closed PR superseded by a later merge while the ticket is seen open', async () => {
      const { b, ticket } = await split();
      const closedAt = iso();
      await prs(b, [pr(7, 'closed')]);
      now += 1_000;
      const merged = { ...pr(8, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [{ ...pr(7, 'closed'), updatedAt: closedAt }, merged]);
      now += interval;
      await ticket('open');
      now += 1_000;
      await prs(b, [{ ...pr(7, 'closed'), updatedAt: closedAt }, merged]);
      expect(await openLedger(b)).toEqual([]);
    });

    it('opens no PR-closed block for a superseded closed PR edited after the later merge', async () => {
      const { b, ticket } = await split();
      const closedAt = iso();
      await prs(b, [{ ...pr(7, 'closed'), closedAt }]);
      now += 1_000;
      const merged = { ...pr(8, 'merged'), updatedAt: iso(), mergedAt: iso() };
      await prs(b, [{ ...pr(7, 'closed'), updatedAt: closedAt, closedAt }, merged]);
      now += interval;
      await ticket('open');
      now += 1_000;
      await prs(b, [{ ...pr(7, 'closed'), updatedAt: iso(), closedAt }, merged]);
      expect(await openLedger(b)).toEqual([]);
    });
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

  const blindGithub = (b: Board) =>
    b.core.reportSourceState(github, {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'GitHub stopped answering' },
      gone: [],
    });

  it.each([
    {
      reason: 'complete',
      kind: 'worker_completed',
      text: 'o/r#9: worker ended (completed), no PR (worker-1)',
      ledger: ['health:worker-1:worker_completed'],
    },
    {
      reason: 'kill',
      kind: 'worker_killed',
      text: 'o/r#9: worker ended (killed), no PR (worker-1)',
      ledger: [],
    },
    {
      reason: 'vanished',
      kind: 'worker_vanished',
      text: 'o/r#9: worker vanished, no PR (worker-1)',
      ledger: [],
    },
  ] as const)(
    'holds a $reason worker-end item while GitHub has no complete poll since the end, then decides on the first one',
    async ({ reason, kind, text, ledger }) => {
      const healthItems = async (b: Board) =>
        (
          await b.store.db
            .selectFrom('operator_item')
            .selectAll()
            .where('item_key', 'like', 'health:%')
            .execute()
        ).map((item) => [item.item_key.split(':').at(-1), item.text, item.cleared_at]);
      const raised = async (b: Board) =>
        (
          await b.store.db
            .selectFrom('event')
            .select('id')
            .where('kind', '=', 'from_you_raised')
            .execute()
        ).length;
      /** A board whose GitHub completed a poll before the worker ends, then `before` runs. */
      async function ended(before: (b: Board) => Promise<void>) {
        const b = await board();
        await spur(b, [session('worker-1', 'working')]);
        await prs(b, []);
        now += 1_000;
        await before(b);
        now += 1_000;
        if (reason === 'vanished')
          await b.core.observe('spur', {
            batch: {
              source: 'spur',
              observedAt: iso(),
              complete: true,
              items: [],
              entities: [{ ref: { kind: 'session', id: 'worker-1' }, status: 'not_found' }],
            },
            effectiveComplete: true,
            state: { lastCompleteAt: iso(), gone: [] },
            outcomes: [],
          });
        else
          await spur(b, [
            {
              ...sessionFact('worker-1', link, true),
              endedAt: iso(),
              endReason: reason,
              lifecycle: reason === 'kill' ? 'killed' : 'completed',
            },
          ]);
        return { b, raisedBefore: await raised(b), endedAt: now };
      }
      async function quiet(b: Board, raisedBefore: number) {
        expect(await healthItems(b)).toEqual([]);
        expect(await openLedger(b)).toEqual([]);
        expect((await surface(b)).lines).toBe(0);
        expect(await raised(b)).toBe(raisedBefore);
        now += 1_000;
        await tick(b);
        expect(await healthItems(b)).toEqual([]);
        expect(await openLedger(b)).toEqual([]);
        expect((await surface(b)).lines).toBe(0);
        expect(await raised(b)).toBe(raisedBefore);
      }

      const blind = await ended(blindGithub);
      await quiet(blind.b, blind.raisedBefore);
      now += 1_000;
      await prs(blind.b, [pr(7, 'open')]);
      await quiet(blind.b, blind.raisedBefore);

      const lagging = await ended(async () => {});
      await quiet(lagging.b, lagging.raisedBefore);
      now += 1_000;
      await prs(lagging.b, [], new Date(lagging.endedAt - 1).toISOString());
      await quiet(lagging.b, lagging.raisedBefore);
      now += 1_000;
      await prs(lagging.b, [pr(7, 'merged')]);
      await quiet(lagging.b, lagging.raisedBefore);

      const none = await ended(blindGithub);
      await quiet(none.b, none.raisedBefore);
      now += 1_000;
      await prs(none.b, []);
      expect(await healthItems(none.b)).toEqual([[kind, text, null]]);
      expect(await openLedger(none.b)).toEqual(ledger);
      expect(await raised(none.b)).toBe(none.raisedBefore + 1);
      now += 1_000;
      await tick(none.b);
      expect(await healthItems(none.b)).toEqual([[kind, text, null]]);
      expect(await openLedger(none.b)).toEqual(ledger);
    },
  );

  it('holds a PR-closed block until every repo completed a poll since the close, and drops it for a replacement', async () => {
    const closedPr = (): PrFacts => ({ ...pr(7, 'closed'), updatedAt: iso() });
    const reason = 'linked pull request o/r#7 closed without merge, no open PR';

    const one = await board();
    const closed = closedPr();
    await prs(one, [closed], new Date(now - 1).toISOString());
    expect(await openLedger(one)).toEqual([]);
    now += 1_000;
    await blindGithub(one);
    await tick(one);
    expect(await openLedger(one)).toEqual([]);
    now += 1_000;
    await prs(one, [closed]);
    expect(await openLedger(one)).toEqual(['pr-closed']);
    expect((await surface(one)).blocks.map((block) => block.reason)).toEqual([reason]);

    const twoRepos = configSchema.parse({
      ...config,
      projects: config.projects.map((project) => ({ ...project, repos: ['o/r', 'o/s'] })),
    });
    const two = await board(twoRepos);
    await poll(two, 'github:board:o/s', []);
    now += 1_000;
    const late = closedPr();
    await prs(two, [late]);
    expect(await openLedger(two)).toEqual([]);
    now += 1_000;
    await prs(two, [late]);
    await tick(two);
    expect(await openLedger(two)).toEqual([]);
    now += 1_000;
    await poll(two, 'github:board:o/s', []);
    expect(await openLedger(two)).toEqual(['pr-closed']);
    expect((await surface(two)).blocks.map((block) => block.reason)).toEqual([reason]);

    const replaced = await board();
    const gone = closedPr();
    await prs(replaced, [gone], new Date(now - 1).toISOString());
    now += 1_000;
    await prs(replaced, [gone, pr(8, 'open')]);
    await tick(replaced);
    expect(await openLedger(replaced)).toEqual([]);
    expect((await surface(replaced)).blocks).toEqual([]);
  });

  it('keeps an open worker-completed block and a PR-closed block while GitHub turns blind', async () => {
    const b = await board();
    await spur(b, [session('worker-1', 'working')]);
    now += 1_000;
    await spur(b, [{ ...sessionFact('worker-1', link, true), endedAt: iso() }]);
    now += 1_000;
    await prs(b, [pr(7, 'closed')]);
    const open = ['health:worker-1:worker_completed', 'pr-closed'];
    expect((await openLedger(b)).sort()).toEqual(open);
    now += 1_000;
    await blindGithub(b);
    now += 1_000;
    await tick(b);
    const state = await surface(b);
    expect((await openLedger(b)).sort()).toEqual(open);
    expect(state.items.map((item) => item.cleared_at)).toEqual([null, null]);
    expect([state.opens, state.closes]).toEqual([2, 0]);
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

  const endedItems = (b: Board) =>
    b.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('kind', '=', 'worker_ended')
      .where('cleared_at', 'is', null)
      .execute();

  it.each(['complete', 'kill', 'vanished', 'unknown'] as const)(
    'raises worker_ended for a %s holder with an open PR, without closing its turn',
    async (endReason) => {
      const b = await board();
      b.task.column = 'dev';
      await b.store.db
        .updateTable('task')
        .set({ column: 'dev' })
        .where('id', '=', b.task.id)
        .execute();
      await prs(b, [pr(7, 'open')]);
      await spur(b, [session('worker-1', 'working')]);
      const turn = await heldTurn(b);
      now += 1_000;
      const ended = { ...completed('worker-1'), endReason };
      await spur(b, [ended]);
      for (const elapsed of [0, 1_799_999, 1, 1]) {
        now += elapsed;
        await tick(b);
        expect(await endedItems(b)).toMatchObject([
          {
            item_key: `ended-turn:${String(turn.id)}:worker-1`,
            task_id: b.task.id,
            block_id: null,
            kind: 'worker_ended',
          },
        ]);
        expect(await openLedger(b)).toEqual([]);
        expect(
          await b.store.db
            .selectFrom('turn')
            .select('closed_at')
            .where('id', '=', turn.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ closed_at: null });
      }
      const registry = createOperationRegistry({
        config: b.config,
        clock,
        completeSince: b.core.completeSince,
      });
      const query = createQuery({ store: b.store, config: b.config, clock });
      expect((await query(registry['inbox.operator'], {}, 'operator')).items).toContainEqual(
        expect.objectContaining({
          kind: 'worker_ended',
          severity: 'attention',
          task: b.task.key,
          action: 'start a new worker for the task, or archive the task',
        }),
      );
      expect((await surface(b)).lines).toBe(1);
      // A complete Spur poll confirms the ended holder again and moves only the fact time.
      const [before] = await endedItems(b);
      now += 1_000;
      await spur(b, [ended]);
      expect(await endedItems(b)).toMatchObject([{ id: before?.id, fact_at: iso() }]);
      expect((await surface(b)).lines).toBe(1);
    },
  );

  it('withdraws legacy ended-holder blocks while blind, with an idempotent replacement reason', async () => {
    const b = await board();
    await prs(b, [pr(7, 'open')]);
    await spur(b, [session('worker-1', 'working')]);
    const turn = await heldTurn(b);
    // Seed persisted ledger-backed rows produced before the ended-holder policy changed.
    const unrelated = await b.apply(
      createBlockMutations(b.config).create,
      { task: b.task.key, type: 'external', reason: 'Keep this question' },
      'operator',
    );
    const keys = [
      `stuck-turn:${String(turn.id)}`,
      `health:${String(b.task.id)}:worker-1:worker_lost`,
    ];
    await scanTransaction(b.store, b.config, async (trx) => {
      await openSystemBlock(trx, {
        task: b.task,
        reason: 'unrelated-system',
        at: iso(),
        config: b.config,
      });
      for (const key of keys) {
        const block = await openSystemBlock(trx, {
          task: b.task,
          reason: key,
          at: iso(),
          config: b.config,
        });
        await raiseItem(trx, {
          itemKey: key,
          kind: 'anomaly',
          taskId: b.task.id,
          blockId: block.id,
          text: key,
          url: 'https://github.com/o/r/issues/9',
          at: new Date(now),
          source: 'spur',
        });
      }
    });
    // Persist accepted ended facts, then reconcile without a fresh Spur observation.
    const end = completed('worker-1');
    await b.store.db
      .updateTable('session_snapshot')
      .set({ ended_at: end.endedAt, detail: JSON.stringify(end) })
      .where('id', '=', end.id)
      .execute();
    await b.core.reportSourceState('spur', {
      lastCompleteAt: iso(),
      blind: { reason: 'stale', message: 'Spur stopped answering' },
      gone: [],
    });
    await tick(b);
    const legacy = await b.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'in', keys)
      .execute();
    expect(legacy.every((item) => item.cleared_at !== null)).toBe(true);
    const blocks = (await surface(b)).blocks;
    for (const item of legacy)
      expect(blocks.find((block) => block.id === item.block_id)).toMatchObject({
        outcome: 'withdrawn',
        outcome_reason: `turn T${String(turn.id)} holder worker-1 ended; start a replacement worker or archive the task`,
      });
    expect(blocks.find((block) => block.id === Number(unrelated.block.id.slice(1)))?.state).toBe(
      'open',
    );
    expect(blocks.find((block) => block.reason === 'unrelated-system')?.state).toBe('open');
    expect(await endedItems(b)).toHaveLength(1);
    const events = await b.store.db.selectFrom('event').selectAll().execute();
    const items = await b.store.db.selectFrom('operator_item').selectAll().execute();
    await tick(b);
    expect(await b.store.db.selectFrom('event').selectAll().execute()).toEqual(events);
    expect(await b.store.db.selectFrom('operator_item').selectAll().execute()).toEqual(items);
  });

  it('retains the ended-holder item until actual replacement or closure', async () => {
    async function lost() {
      const b = await board();
      await prs(b, [pr(7, 'open')]);
      await spur(b, [session('worker-1', 'working')]);
      await heldTurn(b);
      now += 1_000;
      await spur(b, [killed('worker-1')]);
      expect(await openLedger(b)).toEqual([]);
      expect(await endedItems(b)).toHaveLength(1);
      return b;
    }
    const closed = await lost();
    now += 1_000;
    await closeTurn(closed);
    await tick(closed);
    expect(await openLedger(closed)).toEqual([]);
    expect(await endedItems(closed)).toEqual([]);

    const replaced = await lost();
    now += 1_000;
    await spur(replaced, [killed('worker-1'), session('worker-2', 'working')]);
    expect(await openLedger(replaced)).toEqual([]);
    expect(await endedItems(replaced)).toHaveLength(1);
    await replaced.apply(
      createLinkMutations(replaced.config).remove,
      {
        mode: 'session',
        task: replaced.task.key,
        session: 'worker-1',
        reason: 'Replace ended holder',
      },
      'operator',
    );
    await tick(replaced);
    expect(await endedItems(replaced)).toHaveLength(1);
    const oldTurn = await replaced.store.db
      .selectFrom('turn')
      .selectAll()
      .where('closed_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(
      await scanTransaction(replaced.store, replaced.config, (trx) =>
        takeTurn(trx, {
          turnId: oldTurn.id,
          actor: 'agent:worker/worker-2',
          at: new Date(now),
          config: replaced.config,
        }),
      ),
    ).toBe(false);
    await spur(replaced, [
      killed('worker-1'),
      session('worker-2', 'working'),
      session('worker-3', 'working'),
    ]);
    await closeTurn(replaced);
    await scanTransaction(replaced.store, replaced.config, async (trx) => {
      const turn = await openTurn(trx, {
        task: replaced.task,
        reason: 'Replacement',
        handed: [],
        at: new Date(now),
        config: replaced.config,
      });
      expect(
        await takeTurn(trx, {
          turnId: turn.id,
          actor: 'agent:worker/worker-3',
          at: new Date(now),
          config: replaced.config,
        }),
      ).toBe(true);
    });
    await tick(replaced);
    expect(await endedItems(replaced)).toEqual([]);
  });

  it.each(['archive', 'column', 'epoch'] as const)(
    'clears an ended-holder item on %s departure',
    async (departure) => {
      const b = await board();
      await prs(b, [pr(7, 'open')]);
      await spur(b, [session('worker-1', 'working')]);
      await heldTurn(b);
      await spur(b, [completed('worker-1')]);
      expect(await endedItems(b)).toHaveLength(1);
      await b.store.db
        .updateTable('task')
        .set(
          departure === 'archive'
            ? { membership: 'archived' }
            : departure === 'column'
              ? { column: 'review' }
              : { column_epoch: b.task.column_epoch + 1 },
        )
        .where('id', '=', b.task.id)
        .execute();
      await tick(b);
      expect(await endedItems(b)).toEqual([]);
    },
  );

  it('finds an unlinked orchestrator holder and validates its project identity', async () => {
    const b = await board();
    await prs(b, [pr(7, 'open')]);
    await spur(b, [session('worker-1', 'working', { links: {}, spurProject: 'conductor' })]);
    const turn = await heldTurn(b);
    await b.store.db
      .updateTable('turn')
      .set({ role: 'orchestrator:review', acked_by: 'agent:wrong/worker-1' })
      .where('id', '=', turn.id)
      .execute();
    await spur(b, [
      { ...completed('worker-1'), spurProject: 'conductor', links: {}, endReason: 'unknown' },
    ]);
    await tick(b);
    expect(await endedItems(b)).toEqual([]);
    await b.store.db
      .updateTable('turn')
      .set({ acked_by: 'agent:conductor/worker-1' })
      .where('id', '=', turn.id)
      .execute();
    await tick(b);
    expect(await endedItems(b)).toHaveLength(1);
    expect(
      await b.store.db
        .selectFrom('link')
        .select('id')
        .where('session_id', '=', 'worker-1')
        .execute(),
    ).toEqual([]);
  });

  it.each(['delivered', 'exhausted'] as const)(
    'suppresses quiet escalation after an ended holder has a %s reminder',
    async (delivery) => {
      const b = await board();
      await prs(b, [pr(7, 'open')]);
      await spur(b, [session('worker-1', 'waiting')]);
      await heldTurn(b);
      now += IDLE;
      await tick(b);
      const { reminder, outboxId } = await sendReminder(b);
      await scanTransaction(b.store, b.config, (trx) =>
        delivery === 'delivered'
          ? recordRingDelivery(trx, reminder.id, 1, 'worker-1', new Date(now), b.config)
          : ringUndelivered(trx, {
              notificationId: reminder.id,
              outboxId,
              dedupeKey: 'unused',
              session: 'worker-1',
              reason: 'rejected',
              at: new Date(now),
              config: b.config,
            }),
      );
      await spur(b, [completed('worker-1')]);
      now += IDLE * 2;
      await tick(b);
      expect(await endedItems(b)).toHaveLength(1);
      expect(await openLedger(b)).toEqual([]);
    },
  );

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

  it('withdraws a stuck-turn block on a Done wrap-up when its holder ends', async () => {
    const b = await board();
    await prs(b, [pr(7, 'merged')]);
    await b.store.db
      .updateTable('task')
      .set({ column: 'done' })
      .where('id', '=', b.task.id)
      .execute();
    await spur(b, [session('worker-1', 'waiting')]);
    const turn = await heldTurn(b, 'worker-1', 'done');
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
    await spur(b, [completed('worker-1')]);
    expect(await openLedger(b)).toEqual([]);
    const { blocks, items } = await surface(b);
    expect(blocks.map(({ outcome, outcome_reason }) => ({ outcome, outcome_reason }))).toEqual([
      {
        outcome: 'withdrawn',
        outcome_reason: `turn T${String(turn.id)} closed: its holder worker-1 ended in Done`,
      },
    ]);
    expect(items.map((item) => item.cleared_at)).toEqual([iso()]);
    expect(
      await b.store.db
        .selectFrom('turn')
        .select('closed_reason')
        .where('id', '=', turn.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ closed_reason: 'moved' });
    now += IDLE * 2;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
  });

  it('opens no stuck-turn block for an ended worker without a PR', async () => {
    const b = await board();
    await prs(b, []);
    await spur(b, [session('worker-1', 'waiting')]);
    await heldTurn(b);
    now += 1_000;
    await spur(b, [killed('worker-1')]);
    now += IDLE * 2;
    await tick(b);
    expect(await openLedger(b)).toEqual([]);
    expect(await endedItems(b)).toHaveLength(1);
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
      await ticket(b, 'closed');
      expect((await task(b)).terminal_at).not.toBeNull();

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
      await ticket(b, 'closed');
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
      await ticket(b, 'closed');
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
      await ticket(b, 'closed');
      expect((await task(b)).terminal_at).toBe(iso());
      expect(await taskPr(b.store.db, (await task(b)).id)).toMatchObject({ number: 9 });
    });

    it('keeps a merged task without a floor terminal', async () => {
      const b = await board();
      await ticket(b, 'open');
      await prs(b, [pr(7, 'merged')]);
      await ticket(b, 'open');
      await ticket(b, 'closed');
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
      // Merged after the ticket's last change: the open ticket is only not moved yet.
      const later = new Date(Date.parse(at) + 1_000).toISOString();
      await prs(merged, [{ ...pr(7, 'merged'), updatedAt: later, mergedAt: later }]);
      await spur(merged, [sessionFact('worker-1', link, true)]);
      expect(await openLedger(merged)).toEqual([]);
    });
  });
});

describe('persisted PR eligibility and source points', () => {
  const prSource = 'github:board:o/r';
  const ref = { kind: 'pr' as const, repo: 'o/r', number: 7 };
  async function accept(core: ReturnType<typeof createObservationCore>, facts: PrFacts, usage = 3) {
    await core.observe(prSource, {
      batch: {
        source: prSource,
        observedAt: new Date(now).toISOString(),
        complete: true,
        items: [{ kind: 'pr', facts }],
        entities: [],
        usage: { points: usage },
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
  }
  it('omits legacy merged snapshots with valid heads, retains held history for explicit refresh, and survives core recreation', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await accept(core, { ...prFact(), state: 'merged' });
    await store.db
      .insertInto('pr_continuation')
      .values({ source: prSource, ref_key: 'pr:o/r#7', resume: null, feedback: '[]' })
      .execute();
    const restarted = createObservationCore({ store, config, clock });
    const ctx = await restarted.context(prSource);
    expect(ctx.observe.prs).toEqual([]);
    expect(ctx.terminalPrs).toEqual([{ ref, state: 'merged' }]);
    expect(ctx.prRechecks).toEqual([]);
    expect(ctx.continuations).toEqual([{ ref, resume: null, feedback: [] }]);
    expect(
      (await store.db.selectFrom('pr_snapshot').selectAll().executeTakeFirstOrThrow()).head_sha,
    ).toBe(prFact().headSha);
  });
  it('persists closed deadlines and changes no facts, events or freshness on unchanged probes', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await accept(core, { ...prFact(), state: 'closed' });
    const old = await store.db.selectFrom('pr_snapshot').selectAll().executeTakeFirstOrThrow();
    const events = await store.db.selectFrom('event').selectAll().execute();
    now += 6 * 3_600_000 - 1;
    expect((await core.context(prSource)).prRechecks).toEqual([]);
    now++;
    expect((await core.context(prSource)).prRechecks).toEqual([ref]);
    await store.db.updateTable('task').set({ membership: 'archived' }).execute();
    expect((await core.context(prSource)).prRechecks).toEqual([]);
    await store.db.updateTable('task').set({ membership: 'active' }).execute();
    expect((await core.context(prSource)).prRechecks).toEqual([ref]);
    await core.observe(prSource, {
      batch: {
        source: prSource,
        observedAt: new Date(now).toISOString(),
        complete: true,
        items: [],
        entities: [],
        prProbes: [{ ref, status: 'closed' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    const refreshed = await store.db
      .selectFrom('pr_snapshot')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect({ ...refreshed, closed_recheck_at: old.closed_recheck_at }).toEqual(old);
    expect(await store.db.selectFrom('event').selectAll().execute()).toEqual(events);
    const restarted = createObservationCore({ store, config, clock });
    expect((await restarted.context(prSource)).prRechecks).toEqual([]);
    await store.db.updateTable('pr_snapshot').set({ closed_recheck_at: null }).execute();
    expect((await restarted.context(prSource)).prRechecks).toEqual([ref]);
    await accept(restarted, { ...prFact(), state: 'open' });
    expect((await restarted.context(prSource)).observe.prs).toEqual([ref]);
    expect((await restarted.context(prSource)).terminalPrs).toEqual([]);
  });
  it('sums reported costs once across standalone reports and restarts with an open lower hour boundary', async () => {
    const { store, core } = setup();
    await accept(core, prFact(), 7);
    await core.reportSourceState(prSource, { gone: [] }, { points: 3 });
    const status = () => getStatus({ store, config, clock, completeSince: new Map() });
    expect(
      (await status()).sources.find((entry) => entry.source === prSource)?.pointsLastHour,
    ).toBe(10);
    now += 3_600_000;
    expect(
      (await status()).sources.find((entry) => entry.source === prSource)?.pointsLastHour,
    ).toBe(0);
    const restarted = createObservationCore({ store, config, clock });
    await restarted.reportSourceState(prSource, { gone: [] }, { points: 5 });
    expect(
      (await status()).sources.find((entry) => entry.source === prSource)?.pointsLastHour,
    ).toBe(5);
    expect(await store.db.selectFrom('source_cost').selectAll().execute()).toHaveLength(1);
  });
  it('keeps each source budget from its last batch that reported one across a store reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'board-observe-')), 'board.db');
    const store = openStore(path);
    const core = createObservationCore({ store, config, clock });
    const issues = 'github-issues:board:o/r';
    const prBudget = { remaining: 4000, limit: 5000, resetAt: '2026-11-04T13:00:00.000Z' };
    const issuesBudget = { remaining: 4999, resetAt: '2026-11-04T12:30:00.000Z' };
    const poll = (source: string, budget?: Batch['budget']) =>
      core.observe(source, {
        batch: {
          source,
          observedAt: new Date(now).toISOString(),
          complete: true,
          items: [],
          entities: [],
          ...(budget === undefined ? {} : { budget }),
        },
        effectiveComplete: true,
        state: { lastCompleteAt: new Date(now).toISOString(), gone: [] },
        outcomes: [],
      });
    const budgets = async (target: Store) =>
      Object.fromEntries(
        (await getStatus({ store: target, config, clock, completeSince: new Map() })).sources.map(
          (entry) => [entry.source, entry.budget],
        ),
      );
    const columns = (target: Store) =>
      target.db
        .selectFrom('source_state')
        .select(['source', 'budget_remaining', 'budget_limit', 'budget_reset_at'])
        .orderBy('source')
        .execute();

    expect(await budgets(store)).toEqual({ spur: null, [issues]: null, [prSource]: null });
    await core.reportSourceState('spur', { lastCompleteAt: at, gone: [] });
    await poll(prSource, prBudget);
    await poll(issues, issuesBudget);
    const expected = {
      spur: null,
      [issues]: { ...issuesBudget, limit: null },
      [prSource]: prBudget,
    };
    expect(await budgets(store)).toEqual(expected);
    const stored = await columns(store);

    now += 60_000;
    await poll(prSource);
    await core.reportSourceState(prSource, { lastCompleteAt: at, gone: [] });
    await core.reportSourceState(issues, { gone: [] }, { points: 1 });
    expect(await columns(store)).toEqual(stored);
    expect(await budgets(store)).toEqual(expected);

    await store.close();
    const reopened = openStore(path);
    stores.push(reopened);
    expect(await budgets(reopened)).toEqual(expected);
    expect(await columns(reopened)).toEqual(stored);
  });
  it('sets healthySince on the first usable observe and clears it when blind', async () => {
    const { store, core } = setup();
    const poll = (complete: boolean, blind?: { reason: 'stale'; message: string }) =>
      core.observe(prSource, {
        batch: {
          source: prSource,
          observedAt: new Date(now).toISOString(),
          complete,
          items: [],
          entities: [],
        },
        effectiveComplete: complete,
        state: {
          lastCompleteAt: at,
          gone: [],
          ...(blind === undefined ? {} : { blind }),
        },
        outcomes: [],
      });
    const row = async () =>
      (
        await getStatus({
          store,
          config,
          clock,
          completeSince: core.completeSince,
          healthySince: core.healthySince,
        })
      ).sources.find((entry) => entry.source === prSource)?.healthySince;

    await core.reportSourceState(prSource, { gone: [] });
    expect(core.healthySince.has(prSource)).toBe(false);
    expect(await row()).toBeNull();

    const first = new Date(now).toISOString();
    await poll(true);
    expect(core.healthySince.get(prSource)).toBe(first);
    now += 60_000;
    await poll(true);
    now += 60_000;
    await poll(false);
    await core.reportSourceState(prSource, { gone: [] });
    expect(await row()).toBe(first);

    now += 60_000;
    await poll(true, { reason: 'stale', message: 'Polls keep failing' });
    expect(await row()).toBeNull();
    now += 60_000;
    const second = new Date(now).toISOString();
    await poll(true);
    expect(await row()).toBe(second);

    await core.reportSourceState(prSource, {
      gone: [],
      blind: { reason: 'auth', message: 'Bad credentials' },
    });
    expect(await row()).toBeNull();
    now += 60_000;
    await poll(false);
    expect(await row()).toBe(new Date(now).toISOString());

    expect(createObservationCore({ store, config, clock }).healthySince.size).toBe(0);
  });
});

describe('source-specific terminal PR processing', () => {
  const shared = configSchema.parse({
    ...config,
    projects: [
      ...config.projects,
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
      },
    ],
  });
  const first = 'github:board:o/r';
  const second = 'github:web:o/r';
  const ref = { kind: 'pr' as const, repo: 'o/r', number: 7 };
  const observe = (
    core: ReturnType<typeof createObservationCore>,
    source: string,
    state: PrFacts['state'],
    keys: string[],
  ) =>
    core.observe(source, {
      batch: {
        source,
        observedAt: new Date(now).toISOString(),
        complete: true,
        items: [{ kind: 'pr', facts: { ...prFact(), state, ticketKeys: keys } }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: new Date(now).toISOString(), gone: [] },
      outcomes: [],
    });
  async function board() {
    const b = setup(shared);
    await b.apply(b.mutations.add, { task: 'o/r#9' }, 'operator');
    await b.apply(b.mutations.add, { task: 'WEBDEV-1' }, 'operator');
    return b;
  }
  it.each(['merged', 'closed'] as const)(
    'scopes final %s suppression to sources that processed their own project links',
    async (state) => {
      const { store, core } = await board();
      await observe(core, first, state, ['o/r#9']);
      // Simulate a snapshot written before per-source processing metadata existed.
      await store.db.deleteFrom('meta').where('key', 'like', 'pr-poll:%').execute();
      expect((await core.context(first)).terminalPrs).toEqual([{ ref, state }]);
      const unprocessed = await core.context(second);
      expect(unprocessed.terminalPrs).toEqual([]);
      expect(unprocessed.observe.prs).toEqual([ref]);
      await observe(core, second, state, ['WEBDEV-1']);
      const links = await store.db
        .selectFrom('link')
        .innerJoin('task', 'task.id', 'link.task_id')
        .select(['task.project', 'task.key'])
        .where('link.entity', '=', 'pr')
        .where('link.number', '=', 7)
        .orderBy('task.project')
        .execute();
      expect(links).toEqual([
        { project: 'board', key: 'o/r#9' },
        { project: 'web', key: 'WEBDEV-1' },
      ]);
      const restarted = createObservationCore({ store, config: shared, clock });
      for (const source of [first, second]) {
        expect((await restarted.context(source)).terminalPrs).toEqual([{ ref, state }]);
        expect((await restarted.context(source)).observe.prs).toEqual([]);
      }
    },
  );
  it.each(['task.add', 'tracker import'] as const)(
    'links late tasks through %s using each source extraction without refreshing snapshots',
    async (route) => {
      const { store, core, apply, mutations } = setup(shared);
      await observe(core, first, 'merged', ['o/r#9']);
      await observe(core, second, 'merged', ['WEBDEV-1']);
      const snapshots = await store.db.selectFrom('pr_snapshot').selectAll().execute();
      const freshness = await store.db.selectFrom('source_state').selectAll().execute();
      now += 3_600_000;
      for (const key of ['o/r#9', 'WEBDEV-1']) {
        if (route === 'task.add') await apply(mutations.add, { task: key }, 'operator');
        else {
          const tracker = key === 'o/r#9' ? source : 'jira:web';
          await core.observe(tracker, {
            batch: {
              source: tracker,
              observedAt: new Date(now).toISOString(),
              complete: true,
              items: [
                { kind: 'ticket', facts: { ...fact(key), trackerId: tracker, inFilter: true } },
              ],
              entities: [],
            },
            effectiveComplete: true,
            state: { lastCompleteAt: at, gone: [] },
            outcomes: [],
          });
        }
      }
      const links = await store.db
        .selectFrom('link')
        .innerJoin('task', 'task.id', 'link.task_id')
        .select(['task.project', 'task.key'])
        .where('link.entity', '=', 'pr')
        .orderBy('task.project')
        .execute();
      expect(links).toEqual([
        { project: 'board', key: 'o/r#9' },
        { project: 'web', key: 'WEBDEV-1' },
      ]);
      expect(await store.db.selectFrom('pr_snapshot').selectAll().execute()).toEqual(snapshots);
      const githubFreshness = (rows: typeof freshness) =>
        rows.filter((row) => row.source.startsWith('github:'));
      expect(
        githubFreshness(await store.db.selectFrom('source_state').selectAll().execute()),
      ).toEqual(githubFreshness(freshness));
      for (const src of [first, second]) {
        expect((await core.context(src)).terminalPrs).toEqual([{ ref, state: 'merged' }]);
        expect((await core.context(src)).observe.prs).toEqual([]);
      }
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      expect(
        await store.db.selectFrom('link').selectAll().where('entity', '=', 'pr').execute(),
      ).toHaveLength(2);
      await store.db
        .updateTable('link')
        .set({ banned: 1 })
        .where(
          'task_id',
          '=',
          (
            await store.db
              .selectFrom('task')
              .select('id')
              .where('key', '=', 'o/r#9')
              .executeTakeFirstOrThrow()
          ).id,
        )
        .execute();
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      expect(
        await store.db.selectFrom('link').select('banned').where('banned', '=', 1).execute(),
      ).toHaveLength(1);
    },
  );
  it.each(['task.add', 'tracker import'] as const)(
    'reads only PRs indexed under the task key on %s',
    async (route) => {
      const { store, core, apply, mutations } = setup(shared);
      await observe(core, first, 'merged', ['o/r#9']);
      // Retained PRs the lookup must not read: a full scan would fail to parse their details.
      await store.db
        .insertInto('pr_snapshot')
        .values(
          Array.from({ length: 50 }, (_, i) => ({
            repo: 'o/r',
            number: 100 + i,
            head_sha: 'b'.repeat(40),
            head_branch: `other-${String(i)}`,
            state: 'merged',
            draft: 0,
            mergeable: null,
            merge_state: null,
            detail: 'not json',
            source: first,
            observed_at: at,
          })),
        )
        .execute();
      now += 3_600_000;
      if (route === 'task.add') await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      else
        await core.observe(source, {
          batch: {
            source,
            observedAt: new Date(now).toISOString(),
            complete: true,
            items: [{ kind: 'ticket', facts: { ...fact('o/r#9'), inFilter: true } }],
            entities: [],
          },
          effectiveComplete: true,
          state: { lastCompleteAt: at, gone: [] },
          outcomes: [],
        });
      expect(
        await store.db
          .selectFrom('link')
          .select(['repo', 'number'])
          .where('entity', '=', 'pr')
          .execute(),
      ).toEqual([{ repo: 'o/r', number: 7 }]);
    },
  );
  it('keeps pr_ticket_key current when sources link and re-link a PR', async () => {
    const { store, core, apply, mutations } = setup(shared);
    const indexed = () =>
      store.db
        .selectFrom('pr_ticket_key')
        .select(['repo', 'number', 'source', 'ticket_key'])
        .orderBy('source')
        .orderBy('ticket_key')
        .execute();
    await observe(core, first, 'open', ['o/r#9']);
    expect(await indexed()).toEqual([
      { repo: 'o/r', number: 7, source: first, ticket_key: 'o/r#9' },
    ]);
    await observe(core, first, 'merged', ['o/r#10']);
    expect(await indexed()).toEqual([
      { repo: 'o/r', number: 7, source: first, ticket_key: 'o/r#10' },
    ]);
    await observe(core, second, 'merged', ['WEBDEV-1']);
    expect(await indexed()).toEqual([
      { repo: 'o/r', number: 7, source: first, ticket_key: 'o/r#10' },
      { repo: 'o/r', number: 7, source: second, ticket_key: 'WEBDEV-1' },
    ]);
    const prLinks = () =>
      store.db
        .selectFrom('link')
        .innerJoin('task', 'task.id', 'link.task_id')
        .select(['task.key', 'link.number'])
        .where('link.entity', '=', 'pr')
        .execute();
    await apply(mutations.add, { task: 'o/r#10' }, 'operator');
    expect(await prLinks()).toEqual([{ key: 'o/r#10', number: 7 }]);
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    expect(await prLinks()).toEqual([{ key: 'o/r#10', number: 7 }]);
    await store.db.deleteFrom('pr_snapshot').execute();
    expect(await indexed()).toEqual([]);
  });
  it('retains late-task associations through a closed state-only probe', async () => {
    const { store, core, apply, mutations } = setup(shared);
    await observe(core, first, 'closed', ['o/r#9']);
    await observe(core, second, 'closed', ['WEBDEV-1']);
    now += 6 * 3_600_000;
    await core.observe(first, {
      batch: {
        source: first,
        observedAt: new Date(now).toISOString(),
        complete: true,
        items: [],
        entities: [],
        prProbes: [{ ref, status: 'closed' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    expect(
      await store.db.selectFrom('link').select('number').where('entity', '=', 'pr').execute(),
    ).toEqual([{ number: 7 }]);
    expect((await core.context(first)).prRechecks).toEqual([]);
    expect((await core.context(second)).terminalPrs).toEqual([{ ref, state: 'closed' }]);
  });
  it('keeps closed deadlines independent when another source reads or probes the shared PR', async () => {
    const { store, core } = await board();
    await observe(core, first, 'closed', ['o/r#9']);
    now += 3_600_000;
    await observe(core, second, 'closed', ['WEBDEV-1']);
    const snapshot = await store.db.selectFrom('pr_snapshot').selectAll().executeTakeFirstOrThrow();
    now += 5 * 3_600_000;
    expect((await core.context(first)).prRechecks).toEqual([ref]);
    expect((await core.context(second)).prRechecks).toEqual([]);
    await core.observe(first, {
      batch: {
        source: first,
        observedAt: new Date(now).toISOString(),
        complete: true,
        items: [],
        entities: [],
        prProbes: [{ ref, status: 'closed' }],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: new Date(now).toISOString(), gone: [] },
      outcomes: [],
    });
    expect(await store.db.selectFrom('pr_snapshot').selectAll().executeTakeFirstOrThrow()).toEqual(
      snapshot,
    );
    now += 3_600_000;
    const restarted = createObservationCore({ store, config: shared, clock });
    expect((await restarted.context(first)).prRechecks).toEqual([]);
    expect((await restarted.context(second)).prRechecks).toEqual([ref]);
  });
});

describe('ordered historical session observations', () => {
  const cursor = (value: string) => value as SourceCursor;
  const transition = (
    position: string,
    to: string,
    links = { 'board-worker': 'https://github.com/o/r/issues/9' },
  ) => ({
    position: cursor(position),
    session: 'worker-1',
    spurProject: 'worker',
    at: '2026-11-03T12:00:00.000Z',
    links,
    dimension: 'health' as const,
    from: 'working',
    to,
  });
  async function deliver(core: ReturnType<typeof setup>['core'], batch: Partial<Batch>) {
    await core.observe('spur', {
      batch: { source: 'spur', observedAt: at, complete: true, items: [], entities: [], ...batch },
      effectiveComplete: true,
      outcomes: [],
      state: { lastCompleteAt: at, gone: [] },
    });
  }

  it.each([
    ['competing labels', 'https://github.com/o/r/issues/9', 'o/r#9', 'worker'],
    ['unresolved first label', 'https://github.com/o/r/issues/999', null, null],
    ['unparseable first label', 'https://example.com/docs', 'o/r#10', 'other'],
    ['cross-project label', 'https://github.com/x/y/issues/1', 'x/y#1', 'worker'],
  ] as const)(
    'uses one explicit ownership rule for snapshot and history with %s',
    async (_name, workerUrl, expectedKey, expectedRole) => {
      const pairedConfig = configSchema.parse({
        ...config,
        projects: [
          ...config.projects,
          {
            id: 'other',
            tracker: { type: 'github-issues', repo: 'x/y', label: 'board' },
            repos: ['x/y'],
            operatorGithubLogin: 'operator',
            spurProjects: [{ name: 'other-worker', role: 'worker' }],
          },
        ],
      });
      const { store, core, apply, mutations } = setup(pairedConfig);
      await apply(mutations.add, { task: 'o/r#9' }, 'operator');
      await apply(mutations.add, { task: 'o/r#10' }, 'operator');
      await apply(mutations.add, { task: 'x/y#1' }, 'operator');
      const links = {
        'board-worker': workerUrl,
        'board-other': 'https://github.com/o/r/issues/10',
      };
      const current = { ...sessionFact('worker-1', links), branch: null };
      const edge = {
        ...transition('label-precedence', 'rate_limited'),
        links,
        rateLimitResetAt: '2026-11-03T13:00:00.000Z',
      };
      await deliver(core, {
        sessionTransitions: [edge],
        cursor: edge.position,
        items: [{ kind: 'session', facts: current }],
      });
      const tasks = await store.db.selectFrom('task').select(['id', 'key', 'project']).execute();
      const selected = tasks.find((task) => task.key === expectedKey);
      const events = await store.db
        .selectFrom('event')
        .selectAll()
        .where('kind', '=', 'session_state_changed')
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        project: selected?.project ?? 'board',
        task_id: selected?.id ?? null,
        at: edge.at,
      });
      expect(JSON.parse(events[0]?.payload ?? '{}')).toEqual({
        session: edge.session,
        from: edge.from,
        to: edge.to,
        transition: edge,
      });
      const registry = createOperationRegistry({
        config: pairedConfig,
        clock,
        completeSince: core.completeSince,
      });
      const query = createQuery({ store, config: pairedConfig, clock });
      for (const task of tasks) {
        const history = await query(registry['task.history'], { task: task.key }, 'operator');
        expect(history.events.filter(({ kind }) => kind === 'session_state_changed')).toHaveLength(
          task.key === expectedKey ? 1 : 0,
        );
      }
      const snapshotLinks = await store.db
        .selectFrom('link')
        .select(['task_id', 'role'])
        .where('entity', '=', 'session')
        .execute();
      expect(snapshotLinks).toEqual(
        selected === undefined ? [] : [{ task_id: selected.id, role: expectedRole }],
      );
      expect(events.map((event) => event.task_id)).toEqual([snapshotLinks[0]?.task_id ?? null]);
      expect(
        JSON.parse(
          (await store.db.selectFrom('session_snapshot').select('detail').executeTakeFirstOrThrow())
            .detail,
        ),
      ).toEqual(current);
    },
  );

  it('records explicit cross-project ownership on the destination board with original source metadata', async () => {
    const cross = configSchema.parse({
      ...config,
      projects: [
        ...config.projects,
        {
          id: 'other',
          tracker: { type: 'github-issues', repo: 'x/y', label: 'board' },
          repos: ['x/y'],
          operatorGithubLogin: 'operator',
          spurProjects: [{ name: 'other-worker', role: 'worker' }],
        },
      ],
    });
    const { store, core, apply, mutations } = setup(cross);
    await apply(mutations.add, { task: 'x/y#1' }, 'operator');
    const links = { 'board-worker': 'https://github.com/x/y/issues/1' };
    const current = { ...sessionFact('worker-1', links), branch: null };
    const edge = { ...transition('cross-project', 'rate_limited'), links };
    await deliver(core, {
      sessionTransitions: [edge],
      cursor: edge.position,
      items: [{ kind: 'session', facts: current }],
    });
    const task = await store.db
      .selectFrom('task')
      .selectAll()
      .where('key', '=', 'x/y#1')
      .executeTakeFirstOrThrow();
    const events = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'session_state_changed')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ project: 'other', task_id: task.id, at: edge.at });
    expect(JSON.parse(events[0]?.payload ?? '{}')).toEqual({
      session: edge.session,
      from: edge.from,
      to: edge.to,
      transition: edge,
    });
    const registry = createOperationRegistry({
      config: cross,
      clock,
      completeSince: core.completeSince,
    });
    const query = createQuery({ store, config: cross, clock });
    const history = await query(registry['task.history'], { task: 'x/y#1' }, 'operator');
    expect(history.events.filter(({ kind }) => kind === 'session_state_changed')).toHaveLength(1);
    expect(
      await store.db
        .selectFrom('link')
        .select(['task_id', 'role'])
        .where('entity', '=', 'session')
        .execute(),
    ).toEqual([{ task_id: task.id, role: 'worker' }]);
    expect(
      JSON.parse(
        (await store.db.selectFrom('session_snapshot').select('detail').executeTakeFirstOrThrow())
          .detail,
      ),
    ).toEqual(current);
    expect(task.last_change_at).toBe(at);
    expect((await core.context('spur')).cursor).toBe(edge.position);
  });

  it('keeps an unlabeled transition project-scoped when the same poll infers a session link', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const previous = { ...sessionFact('worker-1'), branch: null };
    await deliver(core, {
      sessionTransitions: [],
      cursor: cursor('before-link'),
      items: [{ kind: 'session', facts: previous }],
    });
    expect(
      await store.db.selectFrom('link').selectAll().where('entity', '=', 'session').execute(),
    ).toEqual([]);
    const observedAt = new Date(Date.parse(at) + 15_000).toISOString();
    const current = { ...sessionFact('worker-1'), lifecycle: 'stopped' as const };
    const edge = {
      ...transition('newly-linked-edge', 'stopped'),
      links: {},
      dimension: 'lifecycle' as const,
      from: 'running',
    };
    await deliver(core, {
      observedAt,
      sessionTransitions: [edge],
      cursor: edge.position,
      items: [{ kind: 'session', facts: current }],
    });
    const task = await store.db
      .selectFrom('task')
      .selectAll()
      .where('key', '=', 'o/r#9')
      .executeTakeFirstOrThrow();
    const registry = createOperationRegistry({ config, clock, completeSince: core.completeSince });
    const query = createQuery({ store, config, clock });
    const history = () => query(registry['task.history'], { task: 'o/r#9' }, 'operator');
    expect((await history()).events.filter(({ kind }) => kind === 'session_state_changed')).toEqual(
      [],
    );
    const rows = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'session_state_changed')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project: 'board', task_id: null, at: edge.at });
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({
      session: edge.session,
      from: edge.from,
      to: edge.to,
      transition: edge,
    });
    expect(
      await store.db
        .selectFrom('link')
        .select(['task_id', 'source'])
        .where('entity', '=', 'session')
        .execute(),
    ).toEqual([{ task_id: task.id, source: 'branch' }]);
    expect(
      JSON.parse(
        (await store.db.selectFrom('session_snapshot').select('detail').executeTakeFirstOrThrow())
          .detail,
      ),
    ).toEqual(current);
    expect(task.last_change_at).toBe(observedAt);
    expect((await core.context('spur')).cursor).toBe(edge.position);
    await deliver(createObservationCore({ store, config, clock }), {
      observedAt,
      sessionTransitions: [],
      cursor: edge.position,
      items: [{ kind: 'session', facts: current }],
    });
    expect(
      (await history()).events.filter(({ kind }) => kind === 'session_state_changed'),
    ).toHaveLength(0);
  });

  it('keeps older unlabeled transitions project-scoped despite a current session association', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    const current = sessionFact('worker-1');
    await deliver(core, {
      sessionTransitions: [],
      cursor: cursor('before'),
      items: [{ kind: 'session', facts: current }],
    });
    const links = await store.db
      .selectFrom('link')
      .selectAll()
      .where('entity', '=', 'session')
      .execute();
    expect(links).toHaveLength(1);
    const task = await store.db
      .selectFrom('task')
      .selectAll()
      .where('key', '=', 'o/r#9')
      .executeTakeFirstOrThrow();
    const edge = {
      ...transition('old-unlabeled', 'killed'),
      links: {},
      dimension: 'lifecycle' as const,
      from: 'running',
    };
    await deliver(core, {
      sessionTransitions: [edge],
      cursor: edge.position,
      items: [{ kind: 'session', facts: current }],
    });
    const registry = createOperationRegistry({ config, clock, completeSince: core.completeSince });
    const history = await createQuery({ store, config, clock })(
      registry['task.history'],
      { task: 'o/r#9' },
      'operator',
    );
    expect(history.events.filter(({ kind }) => kind === 'session_state_changed')).toEqual([]);
    const events = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'session_state_changed')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ project: 'board', task_id: null, at: edge.at });
    expect(JSON.parse(events[0]?.payload ?? '{}')).toEqual({
      session: edge.session,
      from: edge.from,
      to: edge.to,
      transition: edge,
    });
    expect(
      await store.db.selectFrom('link').selectAll().where('entity', '=', 'session').execute(),
    ).toEqual(links);
    expect(
      JSON.parse(
        (await store.db.selectFrom('session_snapshot').select('detail').executeTakeFirstOrThrow())
          .detail,
      ),
    ).toEqual(current);
    expect(
      (
        await store.db
          .selectFrom('task')
          .selectAll()
          .where('id', '=', task.id)
          .executeTakeFirstOrThrow()
      ).last_change_at,
    ).toBe(task.last_change_at);
  });

  it('journals original order and attribution without regressing snapshot or task timestamps', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await apply(mutations.add, { task: 'o/r#10' }, 'operator');
    const current = {
      ...sessionFact('worker-1', { 'board-worker': 'https://github.com/o/r/issues/10' }),
      branch: null,
    };
    await deliver(core, {
      sessionTransitions: [],
      cursor: cursor('before'),
      items: [{ kind: 'session', facts: current }],
    });
    const before = await store.db
      .selectFrom('task')
      .select(['id', 'key', 'last_change_at'])
      .orderBy('id')
      .execute();
    const edges = [
      { ...transition('edge-1', 'rate_limited'), rateLimitResetAt: '2026-11-03T13:00:00.000Z' },
      { ...transition('edge-2', 'killed'), dimension: 'lifecycle' as const, from: 'running' },
      { ...transition('edge-3', 'working'), from: 'rate_limited' },
    ];
    await deliver(createObservationCore({ store, config, clock }), {
      sessionTransitions: edges,
      cursor: cursor('edge-3'),
      items: [{ kind: 'session', facts: current }],
    });
    const events = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'session_state_changed')
      .orderBy('id')
      .execute();
    expect(events.map((row) => JSON.parse(row.payload) as unknown)).toEqual(
      edges.map((edge) => ({
        session: edge.session,
        from: edge.from,
        to: edge.to,
        transition: edge,
      })),
    );
    expect(events.every((row) => row.at === edges[0]?.at && row.task_id === before[0]?.id)).toBe(
      true,
    );
    expect(
      JSON.parse(
        (await store.db.selectFrom('session_snapshot').select('detail').executeTakeFirstOrThrow())
          .detail,
      ),
    ).toEqual(current);
    expect(
      await store.db
        .selectFrom('task')
        .select(['id', 'key', 'last_change_at'])
        .orderBy('id')
        .execute(),
    ).toEqual(before);
    expect(
      (
        await store.db
          .selectFrom('link')
          .select('task_id')
          .where('entity', '=', 'session')
          .execute()
      ).map((row) => row.task_id),
    ).toEqual([before[1]?.id]);
    expect((await createObservationCore({ store, config, clock }).context('spur')).cursor).toBe(
      'edge-3',
    );
  });

  it('suppresses lifecycle snapshot edges across ticks and emits a delayed feed edge once', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await deliver(core, {
      sessionTransitions: [],
      cursor: cursor('start'),
      items: [{ kind: 'session', facts: sessionFact('worker-1') }],
    });
    const ended = sessionFact('worker-1', {}, true);
    await deliver(core, {
      sessionTransitions: [],
      cursor: cursor('page-cap'),
      items: [{ kind: 'session', facts: ended }],
    });
    expect(
      await store.db
        .selectFrom('event')
        .select('id')
        .where('kind', '=', 'session_state_changed')
        .execute(),
    ).toEqual([]);
    const recreated = createObservationCore({ store, config, clock });
    await deliver(recreated, {
      sessionTransitions: [
        { ...transition('delayed', 'completed'), dimension: 'lifecycle', from: 'running' },
      ],
      cursor: cursor('delayed'),
      items: [{ kind: 'session', facts: ended }],
    });
    await deliver(createObservationCore({ store, config, clock }), {
      sessionTransitions: [],
      cursor: cursor('delayed'),
      items: [{ kind: 'session', facts: ended }],
    });
    expect(
      await store.db
        .selectFrom('event')
        .select('id')
        .where('kind', '=', 'session_state_changed')
        .execute(),
    ).toHaveLength(1);
    expect((await recreated.context('spur')).cursor).toBe('delayed');
  });

  it('rolls back transitions and cursor when later reconciliation fails, then retries one copy', async () => {
    const { store, core, apply, mutations } = setup();
    await apply(mutations.add, { task: 'o/r#9' }, 'operator');
    await deliver(core, { sessionTransitions: [], cursor: cursor('before') });
    const { sql } = await import('kysely');
    await sql`create trigger fail_reconcile before update of terminal_at on task begin
      select case when exists (select 1 from event where kind = 'session_state_changed' and json_extract(payload, '$.transition.position') = 'after')
        then raise(abort, 'injected post-transition failure')
        else raise(abort, 'expected transition before failure') end;
      end`.execute(store.db);
    const batch = {
      sessionTransitions: [transition('after', 'rate_limited')],
      cursor: cursor('after'),
      items: [{ kind: 'session' as const, facts: sessionFact('worker-1') }],
    };
    await expect(deliver(core, batch)).rejects.toThrow('injected post-transition failure');
    expect((await core.context('spur')).cursor).toBe('before');
    expect(
      await store.db
        .selectFrom('event')
        .select('id')
        .where('kind', '=', 'session_state_changed')
        .execute(),
    ).toEqual([]);
    expect(await store.db.selectFrom('session_snapshot').selectAll().execute()).toEqual([]);
    expect(
      await store.db.selectFrom('link').selectAll().where('entity', '=', 'session').execute(),
    ).toEqual([]);
    await sql`drop trigger fail_reconcile`.execute(store.db);
    await deliver(core, batch);
    expect((await core.context('spur')).cursor).toBe('after');
    expect(
      await store.db
        .selectFrom('event')
        .select('id')
        .where('kind', '=', 'session_state_changed')
        .execute(),
    ).toHaveLength(1);
  });
});
