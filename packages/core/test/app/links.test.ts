import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  type ActorId,
  type PrFacts,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandError,
  createObservationCore,
  createOperationRegistry,
  getStatus,
  openStore,
  type Store,
} from '../../src/index.ts';
import { dispatchOperation } from '../../src/app/operations.ts';

const at = '2026-11-05T00:00:00.000Z';
const clock = { now: () => Date.parse(at) };
const task = 'o/r#9';
const prUrl = (n: number) => `https://github.com/o/r/pull/${String(n)}`;
const defaultConfig = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'worker', role: 'worker' },
        { name: 'ops', role: 'operator' },
      ],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const config = defaultConfig;
const stores: Store[] = [];

async function expectConflict(action: Promise<unknown>, blocking: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    if (error instanceof CommandError) {
      expect(error.code).toBe('link_conflict');
      expect(error.hint).toContain(blocking);
    }
    return;
  }
  throw new Error('Expected a link conflict');
}

function prFact(number: number, state: PrFacts['state'] = 'open'): PrFacts {
  return {
    repo: 'o/r',
    number,
    url: prUrl(number),
    title: `${task} work`,
    author: 'worker',
    headSha: 'a'.repeat(40),
    headBranch: `${task}-work`,
    state,
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: [task],
    updatedAt: at,
  };
}

function sessionFact(id: string): SessionFacts {
  return {
    id,
    spurProject: 'worker',
    branch: `${task}-work`,
    pr: null,
    links: { 'board-worker': 'https://github.com/o/r/issues/9' },
    lifecycle: 'running',
    health: 'working',
    healthSince: at,
    lastActivityAt: null,
    endedAt: null,
    endReason: null,
  };
}

function ticketFact(): TicketFacts {
  return {
    trackerId: 'github-issues:board:o/r',
    id: 'node-9',
    key: task,
    title: 'Canonical task',
    status: 'open',
    assignee: null,
    sprint: null,
    labels: ['board'],
    inFilter: true,
    url: 'https://github.com/o/r/issues/9',
    updatedAt: at,
  };
}

async function setup(config = defaultConfig) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-links-')), 'board.db'));
  stores.push(store);
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const core = createObservationCore({ store, config, clock });
  const call = (
    id: 'link.add' | 'link.remove',
    input: unknown,
    actor: ActorId = 'operator',
    key?: string,
  ) => dispatchOperation({ store, config, clock, registry }, id, input, actor, key);
  await dispatchOperation(
    { store, config, clock, registry },
    'task.add',
    { task },
    'operator',
    'add-9',
  );
  const observe = async (
    source: string,
    item:
      | { kind: 'pr'; facts: PrFacts }
      | { kind: 'session'; facts: SessionFacts }
      | { kind: 'ticket'; facts: TicketFacts },
  ) => {
    await core.observe(source, {
      batch: { source, observedAt: at, complete: true, items: [item], entities: [] },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
  };
  return { store, registry, core, call, observe };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('manual task links', () => {
  it('keeps a manual PR and session through matching observations', async () => {
    const { store, call, observe } = await setup();
    await call(
      'link.add',
      { mode: 'pr', task, pr: prUrl(7), reason: 'Earlier work.' },
      'operator',
      'link-pr-7',
    );
    await call(
      'link.add',
      { mode: 'session', task, session: 'worker-1', reason: 'Started early.' },
      'operator',
      'link-session',
    );
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7) });
    await observe('spur', { kind: 'session', facts: sessionFact('worker-1') });
    const links = await store.db
      .selectFrom('link')
      .select(['entity', 'source', 'banned'])
      .orderBy('id')
      .execute();
    expect(links).toEqual([
      { entity: 'pr', source: 'manual', banned: 0 },
      { entity: 'session', source: 'manual', banned: 0 },
    ]);
  });

  it('keeps operator-removed automatic matches banned after observation', async () => {
    const { store, call, observe } = await setup();
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7) });
    await observe('spur', { kind: 'session', facts: sessionFact('worker-1') });
    await call(
      'link.remove',
      { mode: 'pr', task, pr: prUrl(7), reason: 'Wrong PR.' },
      'operator',
      'unlink-pr',
    );
    await call(
      'link.remove',
      { mode: 'session', task, session: 'worker-1', reason: 'Wrong session.' },
      'operator',
      'unlink-session',
    );
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7) });
    await observe('spur', { kind: 'session', facts: sessionFact('worker-1') });
    const links = await store.db
      .selectFrom('link')
      .select(['entity', 'banned'])
      .orderBy('id')
      .execute();
    expect(links).toEqual([
      { entity: 'pr', banned: 1 },
      { entity: 'session', banned: 1 },
    ]);
  });

  it('matches mixed-case observed PRs when manually linked and unlinked', async () => {
    const { store, call, observe } = await setup();
    const facts = { ...prFact(7), repo: 'O/R', url: 'https://github.com/O/R/pull/7' };
    await observe('github:board:o/r', { kind: 'pr', facts });
    await call('link.add', { mode: 'pr', task, pr: prUrl(7), reason: 'Confirm PR.' });
    expect(await store.db.selectFrom('link').select('id').execute()).toHaveLength(1);
    const status = await getStatus(
      { store, config, clock, completeSince: new Map() },
      { detail: true },
    );
    expect(status.tasks[0]?.prs).toHaveLength(1);
    expect(status.unlinkedPrs).toHaveLength(0);
    await call('link.remove', { mode: 'pr', task, pr: prUrl(7), reason: 'Wrong PR.' });
    await observe('github:board:o/r', { kind: 'pr', facts });
    expect(await store.db.selectFrom('link').select(['repo', 'banned']).execute()).toEqual([
      { repo: 'O/R', banned: 1 },
    ]);
    expect(await store.db.selectFrom('pr_snapshot').select('repo').execute()).toEqual([
      { repo: 'O/R' },
    ]);
  });

  it('bans a session only for the named task', async () => {
    const { store, registry, call, observe } = await setup();
    await call('link.remove', {
      mode: 'session',
      task,
      session: 'worker-1',
      reason: 'Wrong task.',
    });
    await dispatchOperation(
      { store, config, clock, registry },
      'task.add',
      { task: 'o/r#10' },
      'operator',
      'add-10',
    );
    const facts = sessionFact('worker-1');
    await observe('spur', {
      kind: 'session',
      facts: { ...facts, links: { 'board-worker': 'https://github.com/o/r/issues/10' } },
    });
    expect(
      await store.db
        .selectFrom('link')
        .select(['task_id', 'session_id', 'banned'])
        .orderBy('task_id')
        .execute(),
    ).toEqual([
      { task_id: 1, session_id: 'worker-1', banned: 1 },
      { task_id: 2, session_id: 'worker-1', banned: 0 },
    ]);
  });

  it('refuses a second open PR, allows a closed replacement, and blocks replacement after merge', async () => {
    const { store, call, observe } = await setup();
    await call(
      'link.add',
      { mode: 'pr', task, pr: prUrl(7), reason: 'First PR.' },
      'operator',
      'first-pr',
    );
    await expectConflict(
      call(
        'link.add',
        { mode: 'pr', task, pr: prUrl(8), reason: 'Another PR.' },
        'operator',
        'second-pr',
      ),
      'o/r#7',
    );
    expect(await store.db.selectFrom('link').select('number').execute()).toEqual([{ number: 7 }]);
    expect(
      await store.db.selectFrom('event').select('id').where('kind', '=', 'link_added').execute(),
    ).toHaveLength(1);
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7, 'closed') });
    await call(
      'link.add',
      { mode: 'pr', task, pr: prUrl(8), reason: 'Replacement.' },
      'operator',
      'replacement-pr',
    );
    expect(
      await store.db
        .selectFrom('link')
        .select(['number', 'banned', 'pr_open'])
        .orderBy('number')
        .execute(),
    ).toEqual([
      { number: 7, banned: 0, pr_open: 0 },
      { number: 8, banned: 0, pr_open: 1 },
    ]);
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7, 'merged') });
    await expectConflict(
      call(
        'link.add',
        { mode: 'pr', task, pr: prUrl(10), reason: 'Late replacement.' },
        'operator',
        'after-merge',
      ),
      'merged',
    );
  });

  it('links a new PR to a reopened task whose merged PR is below the floor', async () => {
    const { store, call, observe } = await setup();
    const tracker = 'github-issues:board:o/r';
    await observe(tracker, { kind: 'ticket', facts: ticketFact() });
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7, 'merged') });
    await observe(tracker, { kind: 'ticket', facts: { ...ticketFact(), status: 'closed' } });
    await observe(tracker, { kind: 'ticket', facts: ticketFact() });
    expect(
      (await store.db.selectFrom('task').select('reopen_link_floor').executeTakeFirstOrThrow())
        .reopen_link_floor,
    ).not.toBeNull();

    await call(
      'link.add',
      { mode: 'pr', task, pr: prUrl(8), reason: 'The reopened ticket needs a new PR.' },
      'operator',
      'after-reopen',
    );
    expect(
      await store.db
        .selectFrom('link')
        .select('number')
        .where('entity', '=', 'pr')
        .orderBy('id')
        .execute(),
    ).toEqual([{ number: 7 }, { number: 8 }]);
  });

  it('restores a reopened manual PR ahead of an automatic open match', async () => {
    const { store, call, observe } = await setup();
    await call('link.add', { mode: 'pr', task, pr: prUrl(7), reason: 'Manual choice.' });
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7, 'closed') });
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(8) });
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7) });
    expect(
      await store.db
        .selectFrom('link')
        .select(['number', 'pr_state', 'source', 'pr_open'])
        .orderBy('number')
        .execute(),
    ).toEqual([
      { number: 7, pr_state: 'active', source: 'manual', pr_open: 1 },
      { number: 8, pr_state: 'conflict', source: 'branch', pr_open: 1 },
    ]);
  });

  it('reports an archived task before a merged PR conflict', async () => {
    const { store, call, observe } = await setup();
    await call('link.add', { mode: 'pr', task, pr: prUrl(7), reason: 'Original PR.' });
    await observe('github:board:o/r', { kind: 'pr', facts: prFact(7, 'merged') });
    await store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'archived' }).where('key', '=', task).execute(),
    );

    await expect(
      call('link.add', { mode: 'pr', task, pr: prUrl(8), reason: 'Later PR.' }),
    ).rejects.toMatchObject({ code: 'task_archived' });
    expect(await store.db.selectFrom('link').select('number').execute()).toEqual([{ number: 7 }]);
  });

  it('shows separate ticket links and records actor, reason, and idempotent replay', async () => {
    const { store, registry, call, core, observe } = await setup();
    await observe('github-issues:board:o/r', { kind: 'ticket', facts: ticketFact() });
    const beforeTask = await store.db
      .selectFrom('task')
      .select(['key', 'tracker_id', 'membership'])
      .executeTakeFirst();
    const beforeTicket = await store.db
      .selectFrom('ticket_snapshot')
      .selectAll()
      .executeTakeFirst();
    const input = { mode: 'ticket', task, ticket: 'o/r#10', reason: 'Related ticket.' };
    const first = await call('link.add', input, 'agent:ops/desk-1', 'ticket-link');
    expect(await call('link.add', input, 'agent:ops/desk-1', 'ticket-link')).toEqual(first);
    await expect(
      call('link.add', { ...input, reason: 'Changed.' }, 'agent:ops/desk-1', 'ticket-link'),
    ).rejects.toMatchObject({ code: 'idempotency_key_mismatch' });
    const detail = (await dispatchOperation(
      { store, config, clock, registry },
      'task.get',
      { task },
      'operator',
    )) as { task: { key: string }; links: unknown[] };
    expect(detail.task.key).toBe(task);
    expect(detail.links).toEqual([{ kind: 'ticket', ref: 'o/r#10', role: null }]);
    const status = await getStatus(
      { store, config, clock, completeSince: core.completeSince },
      { detail: true },
    );
    expect(status.tasks[0]?.ticket?.key).toBe(task);
    expect(status.tasks[0]?.ticket?.status).toBe('open');
    expect(status.tasks[0]?.links).toContainEqual({ kind: 'ticket', ref: 'o/r#10', role: null });
    const event = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'link_added')
      .execute();
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({
      actor: 'agent',
      actor_ref: JSON.stringify({ project: 'ops', session: 'desk-1' }),
    });
    expect(JSON.parse(event[0]?.payload ?? '{}')).toMatchObject({
      entity: 'ticket',
      ticket: 'o/r#10',
      reason: 'Related ticket.',
    });
    const history = (await dispatchOperation(
      { store, config, clock, registry },
      'task.history',
      { task },
      'operator',
    )) as { events: { summary: string; actor: string }[] };
    expect(
      history.events.some(
        (entry) => entry.actor === 'agent:ops/desk-1' && entry.summary.includes('Related ticket.'),
      ),
    ).toBe(true);
    await call(
      'link.remove',
      { ...input, reason: 'No longer related.' },
      'operator',
      'ticket-unlink',
    );
    const after = (await dispatchOperation(
      { store, config, clock, registry },
      'task.get',
      { task },
      'operator',
    )) as { links: unknown[] };
    expect(after.links).toEqual([]);
    expect(
      await store.db
        .selectFrom('task')
        .select(['key', 'tracker_id', 'membership'])
        .executeTakeFirst(),
    ).toEqual(beforeTask);
    expect(await store.db.selectFrom('ticket_snapshot').selectAll().executeTakeFirst()).toEqual(
      beforeTicket,
    );
  });

  it('uses one ticket link for short and full GitHub issue keys', async () => {
    const { store, registry, call } = await setup();
    const short = { mode: 'ticket', task, ticket: 'r#10', reason: 'Related ticket.' };
    const full = { ...short, ticket: 'o/r#10' };

    expect(await call('link.add', short)).toMatchObject({ target: 'o/r#10' });
    await call('link.add', full);
    await call('link.add', { ...full, ticket: 'O/R#10' });
    expect(await store.db.selectFrom('link').select(['ticket_key', 'banned']).execute()).toEqual([
      { ticket_key: 'o/r#10', banned: 0 },
    ]);
    const linked = (await dispatchOperation(
      { store, config, clock, registry },
      'task.get',
      { task },
      'operator',
    )) as { links: unknown[] };
    expect(linked.links).toEqual([{ kind: 'ticket', ref: 'o/r#10', role: null }]);

    await call('link.remove', { ...full, reason: 'No longer related.' });
    expect(await store.db.selectFrom('link').select(['ticket_key', 'banned']).execute()).toEqual([
      { ticket_key: 'o/r#10', banned: 1 },
    ]);
    const detail = (await dispatchOperation(
      { store, config, clock, registry },
      'task.get',
      { task },
      'operator',
    )) as { links: unknown[] };
    expect(detail.links).toEqual([]);
    const history = (await dispatchOperation(
      { store, config, clock, registry },
      'task.history',
      { task },
      'operator',
    )) as { events: { summary: string }[] };
    expect(history.events.filter((event) => event.summary.includes('ticket o/r#10'))).toHaveLength(
      2,
    );
  });

  it('denies a worker with the operator-only hint and no link effect', async () => {
    const { store, call } = await setup();
    await expect(
      call(
        'link.add',
        { mode: 'session', task, session: 'worker-1', reason: 'Try.' },
        'agent:worker/worker-1',
        'worker-link',
      ),
    ).rejects.toMatchObject({ code: 'forbidden', hint: 'Allowed role: operator.' });
    expect(await store.db.selectFrom('link').selectAll().execute()).toEqual([]);
  });
});

describe('link rule hints in status', () => {
  const noKey = 'no key in branch or title by the link rules';
  const keyless = (number: number, state: PrFacts['state'] = 'open'): PrFacts => ({
    ...prFact(number, state),
    title: 'Unrelated work',
    headBranch: 'feature-work',
    ticketKeys: [],
  });
  const status = (store: Store, detail = false) =>
    getStatus({ store, config, clock, completeSince: new Map() }, { detail });

  it('gives an unlinked open tracker-repo PR without a key the link-rules reason', async () => {
    const { store, observe } = await setup();
    await observe('github:board:o/r', { kind: 'pr', facts: keyless(7) });
    const compact = await status(store);
    expect(compact.unlinkedPrs).toEqual([
      {
        repo: 'o/r',
        number: 7,
        url: prUrl(7),
        title: 'Unrelated work',
        state: 'open',
        draft: false,
        reason: noKey,
      },
    ]);
    const detailed = await status(store, true);
    expect(detailed.unlinkedPrs).toEqual([{ ...keyless(7), reason: noKey }]);
  });

  it('names the key of an unlinked PR whose task is not on the board', async () => {
    const { store, observe } = await setup();
    await observe('github:board:o/r', {
      kind: 'pr',
      facts: { ...keyless(7), ticketKeys: ['o/r#42'] },
    });
    const result = await status(store);
    expect(result.unlinkedPrs).toHaveLength(1);
    expect(result.unlinkedPrs[0]?.reason).toBe('no task on the board for o/r#42');
  });

  it('gives no reason for a merged PR or a sibling-repo PR', async () => {
    const sibling = configSchema.parse({
      ...structuredClone(defaultConfig),
      projects: [{ ...structuredClone(defaultConfig.projects[0]), repos: ['o/r', 'o/sib'] }],
    });
    const { store, observe } = await setup(sibling);
    await observe('github:board:o/r', { kind: 'pr', facts: keyless(7, 'merged') });
    await observe('github:board:o/sib', {
      kind: 'pr',
      facts: { ...keyless(8), repo: 'o/sib', url: 'https://github.com/o/sib/pull/8' },
    });
    const result = await getStatus(
      { store, config: sibling, clock, completeSince: new Map() },
      { detail: true },
    );
    expect(result.unlinkedPrs.map((pr) => `${pr.repo}#${String(pr.number)}`).sort()).toEqual([
      'o/r#7',
      'o/sib#8',
    ]);
    for (const pr of result.unlinkedPrs) expect('reason' in pr).toBe(false);
  });

  it('gives no reason for an open keyless PR whose link the operator removed', async () => {
    const { store, call, observe } = await setup();
    await observe('github:board:o/r', { kind: 'pr', facts: keyless(7) });
    await call('link.remove', { mode: 'pr', task, pr: prUrl(7), reason: 'Not this task.' });
    expect(
      await store.db.selectFrom('link').select(['entity', 'number', 'banned']).execute(),
    ).toEqual([{ entity: 'pr', number: 7, banned: 1 }]);
    for (const detail of [false, true]) {
      const result = await status(store, detail);
      expect(result.unlinkedPrs).toHaveLength(1);
      expect(result.unlinkedPrs[0]?.number).toBe(7);
      expect('reason' in (result.unlinkedPrs[0] ?? {})).toBe(false);
    }
  });

  it('hints a task whose session reports an observed PR the link rules did not link', async () => {
    const { store, observe } = await setup();
    await observe('github:board:o/r', { kind: 'pr', facts: keyless(7) });
    await observe('spur', {
      kind: 'session',
      facts: { ...sessionFact('worker-1'), pr: { repo: 'o/r', number: 7 } },
    });
    const hint =
      'Session worker-1 has PR o/r#7, but the link rules give it no link to this task; check projects[].link in config.yaml.';
    for (const detail of [false, true]) {
      const result = await status(store, detail);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.sessionCount).toBe(1);
      expect(result.tasks[0]?.linkHints).toEqual([hint]);
    }
  });

  it('gives no link hint when the session PR is linked or its link was removed by the operator', async () => {
    const linked = await setup();
    await linked.observe('github:board:o/r', { kind: 'pr', facts: prFact(7) });
    await linked.observe('spur', {
      kind: 'session',
      facts: { ...sessionFact('worker-1'), pr: { repo: 'o/r', number: 7 } },
    });
    const linkedRow = (await status(linked.store)).tasks[0];
    expect(linkedRow?.prCount).toBe(1);
    expect('linkHints' in (linkedRow ?? {})).toBe(false);

    const removed = await setup();
    await removed.observe('github:board:o/r', { kind: 'pr', facts: keyless(7) });
    await removed.call('link.remove', { mode: 'pr', task, pr: prUrl(7), reason: 'Wrong PR.' });
    await removed.observe('spur', {
      kind: 'session',
      facts: { ...sessionFact('worker-1'), pr: { repo: 'o/r', number: 7 } },
    });
    for (const detail of [false, true]) {
      const row = (await status(removed.store, detail)).tasks[0];
      expect(row?.sessionCount).toBe(1);
      expect('linkHints' in (row ?? {})).toBe(false);
    }
  });
});
