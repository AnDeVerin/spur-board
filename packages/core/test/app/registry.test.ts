import { scanTransaction } from '../../src/app/secrets.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATIONS, configSchema, roleCanUseOperation } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  createObservationCore,
  createOperationRegistry,
  createQuery,
  openStore,
  type Store,
} from '../../src/index.ts';
import { raiseItem } from '../../src/app/feed.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'first',
      tracker: { type: 'github-issues', repo: 'o/first', label: 'board' },
      repos: ['o/first'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'first-worker', role: 'worker' }],
    },
    {
      id: 'second',
      tracker: { type: 'github-issues', repo: 'o/second', label: 'board' },
      repos: ['o/second'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'second-worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

it('registers status and limits an agent to its configured project', async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-registry-')), 'board.db'));
  stores.push(store);
  await scanTransaction(store, async (trx) => {
    for (const [project, key] of [
      ['first', 'o/first#1'],
      ['second', 'o/second#2'],
    ] as const) {
      await trx
        .insertInto('task')
        .values({
          project,
          tracker_kind: 'github-issues',
          tracker_id: key,
          key,
          membership: 'active',
          archive_reason: null,
          column: 'todo',
          shadow_column: null,
          created_at: new Date(clock.now()).toISOString(),
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
    }
  });
  const core = createObservationCore({ store, config, clock });
  for (const [source, message] of [
    ['github-issues:first:o/first', 'First source unavailable'],
    ['github-issues:second:o/second', 'Second source unavailable'],
  ] as const) {
    await core.reportSourceState(source, {
      blind: { reason: 'auth', message },
      gone: [],
    });
  }
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const status = registry['status.get'];
  if (status === undefined) throw new Error('Status handler was not registered');
  const query = createQuery({ store, config, clock });
  const agent = 'agent:first-worker/session-1' as const;
  const visible = await query(status, {}, agent);
  expect(visible.tasks.map((task) => task.key)).toEqual(['o/first#1']);
  expect(visible.sources.every((source) => !source.source.includes('second'))).toBe(true);
  expect(visible.items.map((item) => item.summary)).toEqual([
    'github-issues:first:o/first: First source unavailable (not confirmed)',
  ]);
  await expect(query(status, { project: 'second' }, agent)).rejects.toMatchObject({
    code: 'forbidden',
  });
  const operator = await query(status, {}, 'operator');
  expect(operator.tasks.map((task) => task.key).sort()).toEqual(['o/first#1', 'o/second#2']);
  expect(operator.items).toHaveLength(2);
  const schema = registry['schema.get'];
  if (schema === undefined) throw new Error('Schema handler was not registered');
  const catalog = await query(schema, { role: 'worker' }, agent);
  expect(catalog.version).toMatch(/^[0-9a-f]{64}$/);
  expect(catalog.operations.map(({ id, cli }) => [id, cli.command])).toEqual(
    OPERATIONS.filter((operation) => roleCanUseOperation(operation, 'worker')).map((operation) => [
      operation.id,
      operation.cli.command,
    ]),
  );
  expect(catalog.operations.map(({ id }) => id)).toContain('comment.add');
  expect(catalog.operations.map(({ id }) => id)).not.toContain('task.add');
  const all = await query(schema, {}, agent);
  expect(all.operations.map(({ id }) => id)).toEqual(OPERATIONS.map(({ id }) => id));
});

it('keeps board-wide items from a project agent on a one-project board', async () => {
  const oneProject = configSchema.parse({ ...config, projects: [config.projects[0]] });
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-registry-')), 'board.db'));
  stores.push(store);
  await scanTransaction(store, async (trx) => {
    await raiseItem(trx, {
      itemKey: 'delivery:1',
      kind: 'post_failed',
      text: 'Board feed delivery failed',
      url: 'https://example.com/feed',
      taskId: null,
      blockId: null,
      at: new Date(clock.now()),
    });
  });
  const registry = createOperationRegistry({ config: oneProject, clock, completeSince: new Map() });
  const status = registry['status.get'];
  if (status === undefined) throw new Error('Status handler was not registered');
  const query = createQuery({ store, config: oneProject, clock });
  const agent = await query(status, {}, 'agent:first-worker/session-1');
  expect(agent.items).toEqual([]);
  const operator = await query(status, {}, 'operator');
  expect(operator.items.map((item) => item.key)).toEqual(['delivery:1']);
});

it('reports transport state per gateway and keeps the health item board-wide', async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-registry-')), 'board.db'));
  stores.push(store);
  const since = '2026-11-04T07:50:00.000Z';
  await scanTransaction(store, async (trx) => {
    await trx
      .insertInto('transport_health')
      .values(
        (['orchestrators', 'feed'] as const).map((space) => ({
          gateway: 'slack',
          space,
          reason: 'down',
          since,
          probe_at: since,
        })),
      )
      .execute();
    await raiseItem(trx, {
      itemKey: 'transport:slack',
      kind: 'transport_health',
      text: 'slack delivery down',
      url: '',
      taskId: null,
      blockId: null,
      priority: 1,
      suppressFeed: true,
      at: new Date(clock.now()),
    });
  });
  const registry = createOperationRegistry({
    config,
    clock,
    completeSince: new Map(),
    gateways: ['slack'],
  });
  const status = registry['status.get'];
  if (status === undefined) throw new Error('Status handler was not registered');
  const query = createQuery({ store, config, clock });
  const down = {
    gateway: 'slack',
    state: 'down',
    since,
    reason: 'down',
    spaces: ['feed', 'orchestrators'],
  };
  const operator = await query(status, {}, 'operator');
  expect(operator.transport).toEqual([down]);
  expect(operator.items.map((item) => item.key)).toEqual(['transport:slack']);
  const agent = await query(status, {}, 'agent:first-worker/session-1');
  expect(agent.transport).toEqual([down]);
  expect(agent.items).toEqual([]);

  await scanTransaction(store, (trx) => trx.deleteFrom('transport_health').execute());
  expect((await query(status, {}, 'operator')).transport).toEqual([
    { gateway: 'slack', state: 'up', since: null, reason: null, spaces: [] },
  ]);
});

it('keeps the default status for 100 tasks under the budget and lists every item', async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-registry-')), 'board.db'));
  stores.push(store);
  const at = new Date(clock.now()).toISOString();
  const sha = (n: number) => n.toString(16).padStart(40, 'a');
  const check = (n: number) => ({
    name: `ci / test-shard-${String(n)}`,
    state: 'success' as const,
    completedAt: at,
  });
  const prFacts = (number: number) => ({
    repo: 'o/first',
    number,
    url: `https://github.com/o/first/pull/${String(number)}`,
    title: `Fix the board status output for agents, part ${String(number)}`,
    author: 'worker-bot',
    headSha: sha(number),
    headBranch: `worker/fix-status-${String(number)}`,
    state: 'open' as const,
    draft: false,
    mergeable: 'mergeable' as const,
    mergeState: 'clean' as const,
    requiredChecks: [check(0)],
    checks: Array.from({ length: 13 }, (_, n) => check(n)),
    reviews: ['alice', 'bob'].map((reviewer) => ({
      reviewer,
      state: 'commented' as const,
      commitSha: sha(number),
      submittedAt: at,
    })),
    reviewThreads: Array.from({ length: 13 }, (_, n) => ({ resolved: n % 2 === 0 })),
    reviewRequests: [{ reviewer: 'carol', asCodeOwner: true }],
    ticketKeys: [`o/first#${String(number)}`],
    updatedAt: at,
  });
  const sessionFacts = (id: string) => ({
    id,
    spurProject: 'first-worker',
    branch: `worker/${id}`,
    pr: null,
    links: { log: `https://spur.example.com/sessions/${id}/log` },
    lifecycle: 'running' as const,
    health: 'working' as const,
    healthSince: at,
    lastActivityAt: at,
    endedAt: null,
    endReason: null,
  });
  const ticketFacts = (key: string, n: number) => ({
    trackerId: 'github-issues:o/first',
    id: `I_kwDOAbCdEf${String(n).padStart(6, '0')}`,
    key,
    title: `Make the board status readable for an agent with many tasks, case ${String(n)}`,
    status: 'In Progress',
    assignee: 'worker-bot',
    sprint: 'Sprint 42',
    labels: ['board', 'agent-surface', 'priority-high'],
    inFilter: true,
    url: `https://github.com/o/first/issues/${String(n)}`,
    updatedAt: at,
  });
  const ids: number[] = [];
  const items: { key: string; priority: number }[] = [];
  await scanTransaction(store, async (trx) => {
    for (let n = 1; n <= 100; n += 1) {
      const key = `o/first#${String(n)}`;
      const task = await trx
        .insertInto('task')
        .values({
          project: 'first',
          tracker_kind: 'github-issues',
          tracker_id: key,
          key,
          membership: 'active',
          archive_reason: null,
          column: 'dev',
          shadow_column: null,
          created_at: at,
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.push(task.id);
      // Task 100 stays unobserved.
      if (n === 100) continue;
      await trx
        .insertInto('ticket_snapshot')
        .values({
          task_id: task.id,
          status: 'In Progress',
          assignee: 'worker-bot',
          detail: JSON.stringify(ticketFacts(key, n)),
          source: 'github-issues:first:o/first',
          observed_at: at,
        })
        .execute();
    }
    const link = {
      pr_state: null,
      pr_open: null,
      role: null,
      source: 'branch',
      banned: 0,
      created_at: at,
      ticket_key: null,
    } as const;
    for (let n = 1; n <= 25; n += 1) {
      const facts = prFacts(n);
      await trx
        .insertInto('pr_snapshot')
        .values({
          repo: facts.repo,
          number: n,
          head_sha: facts.headSha,
          head_branch: facts.headBranch,
          state: 'open',
          draft: 0,
          mergeable: 'mergeable',
          merge_state: 'clean',
          detail: JSON.stringify(facts),
          source: 'github:first:o/first',
          observed_at: at,
        })
        .execute();
      // PRs 21-25 stay unlinked.
      if (n > 20) continue;
      await trx
        .insertInto('link')
        .values({
          ...link,
          task_id: ids[n - 1] ?? 0,
          entity: 'pr',
          repo: 'o/first',
          number: n,
          pr_state: 'active',
          pr_open: 1,
          session_id: null,
        })
        .execute();
    }
    for (let n = 1; n <= 33; n += 1) {
      const id = `session-${String(n)}`;
      await trx
        .insertInto('session_snapshot')
        .values({
          id,
          spur_project: 'first-worker',
          branch: `worker/${id}`,
          pr: null,
          raw_state: 'running',
          state: 'running',
          first_seen: at,
          last_seen: at,
          ended_at: null,
          end_reason: null,
          detail: JSON.stringify(sessionFacts(id)),
          source: 'spur',
          observed_at: at,
        })
        .execute();
      // Sessions 21-33 stay unlinked.
      if (n > 20) continue;
      await trx
        .insertInto('link')
        .values({
          ...link,
          role: 'worker',
          task_id: ids[n - 1] ?? 0,
          entity: 'session',
          repo: null,
          number: null,
          session_id: id,
        })
        .execute();
    }
    for (let n = 1; n <= 10; n += 1) {
      await trx
        .insertInto('block')
        .values({
          task_id: ids[n - 1] ?? 0,
          type: 'needs_input',
          reason: 'Which API version should the client target?',
          author: 'agent:first-worker/session-1',
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
    }
    for (let n = 1; n <= 12; n += 1) {
      const priority = [3, 1, 2][n % 3] ?? 4;
      const key = `item:${String(n)}`;
      items.push({ key, priority });
      await raiseItem(trx, {
        itemKey: key,
        kind: 'post_failed',
        text: `Item ${String(n)} needs the operator`,
        url: 'https://example.com/item',
        taskId: ids[n - 1] ?? null,
        blockId: null,
        priority,
        suppressFeed: true,
        at: new Date(clock.now() + n * 1_000),
      });
    }
  });
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const status = registry['status.get'];
  if (status === undefined) throw new Error('Status handler was not registered');
  const query = createQuery({ store, config, clock });

  const result = await query(status, {}, 'operator');
  // Measured 2026-11-08: 20,530 chars for this fixture; the full detail is 129,112.
  expect(JSON.stringify(result).length).toBeLessThan(30_000);
  expect(Object.keys(result)[0]).toBe('items');
  expect(result.items.map((item) => item.key)).toEqual(
    items.toSorted((a, b) => a.priority - b.priority).map((item) => item.key),
  );
  const compact = [
    'column',
    'key',
    'membership',
    'openBlocks',
    'prCount',
    'project',
    'sessionCount',
    'state',
  ];
  expect(result.tasks).toHaveLength(100);
  for (const row of result.tasks) expect(Object.keys(row).sort()).toEqual(compact);
  const linked = result.tasks.find((row) => row.key === 'o/first#1');
  expect(linked).toEqual({
    key: 'o/first#1',
    project: 'first',
    column: 'dev',
    membership: 'active',
    state: 'ticket In Progress; PRs 1 open; sessions 1 working',
    prCount: 1,
    sessionCount: 1,
    openBlocks: 1,
  });
  expect(result.tasks.find((row) => row.key === 'o/first#100')?.state).toBe('ticket not observed');
  expect(result.unlinkedPrs).toHaveLength(5);
  expect(result.unlinkedPrs[0]).toEqual({
    repo: 'o/first',
    number: 21,
    url: 'https://github.com/o/first/pull/21',
    title: prFacts(21).title,
    state: 'open',
    draft: false,
  });
  expect(result.unlinkedSessions).toHaveLength(13);
  expect(Object.keys(result.unlinkedSessions[0] ?? {}).sort()).toEqual([
    'branch',
    'health',
    'id',
    'lifecycle',
    'spurProject',
  ]);

  const detail = await query(status, { detail: true }, 'operator');
  expect(JSON.stringify(detail).length).toBeGreaterThan(60_000);
  const full = detail.tasks.find((row) => row.key === 'o/first#1');
  expect(full?.ticket).toEqual(ticketFacts('o/first#1', 1));
  expect(full?.prs).toEqual([prFacts(1)]);
  expect(full?.sessions).toEqual([
    {
      ...sessionFacts('session-1'),
      links: [{ label: 'log', url: 'https://spur.example.com/sessions/session-1/log' }],
    },
  ]);
  expect(full?.links).toEqual(
    expect.arrayContaining([
      { kind: 'pr', ref: 'o/first#1', role: null },
      { kind: 'session', ref: 'session-1', role: 'worker' },
    ]),
  );
  expect(detail.tasks.find((row) => row.key === 'o/first#100')?.ticket).toBeNull();
  expect(detail.unlinkedPrs[0]?.checks).toHaveLength(13);
  expect(detail.unlinkedSessions[0]?.healthSince).toBe(at);
  expect(detail.items).toEqual(result.items);
});
