import {
  configSchema,
  prSourceId,
  type ColumnId,
  type PrFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import { createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import { dispatch } from '../../src/domain/dispatch.ts';
import { evaluateGate } from '../../src/domain/gates.ts';
import { openTempStore } from '../support/store.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { dispatchTasks, readInput } from '../../src/app/dispatch.ts';
import { scanTransaction } from '../../src/app/secrets.ts';

type Input = Parameters<typeof dispatch>[0];
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const layouts: { name: string; stages: ColumnId[] }[] = [
  { name: 'minimal', stages: ['dev'] },
  { name: 'internal review last', stages: ['dev', 'review'] },
  { name: 'product review last', stages: ['dev', 'product-review'] },
  { name: 'external review last', stages: ['dev', 'external-review'] },
  { name: 'QA after review last', stages: ['dev', 'review', 'qa'] },
  { name: 'ready to merge last', stages: ['dev', 'ready-to-merge'] },
];
const facts: {
  name: string;
  pr: 'open' | 'merged' | null;
  flags?: Partial<Omit<Input, 'column' | 'project' | 'facts'>>;
  start?: 'todo' | 'done';
  reason: 'merged' | 'ticket_done_no_pr' | null;
}[] = [
  { name: 'green submitted open PR stays', pr: 'open', reason: null },
  { name: 'merged PR completes', pr: 'merged', reason: 'merged' },
  { name: 'closed ticket without live work completes', pr: null, reason: 'ticket_done_no_pr' },
  {
    name: 'open linked PR prevents absence completion',
    pr: null,
    flags: { hasOpenLinkedPr: true },
    reason: null,
  },
  {
    name: 'live worker prevents absence completion',
    pr: null,
    flags: { liveWorker: true },
    reason: null,
  },
  {
    name: 'unready repository prevents absence completion',
    pr: null,
    flags: { allGithubReposReady: false },
    reason: null,
  },
  {
    name: 'unready Spur prevents absence completion',
    pr: null,
    flags: { spurReady: false },
    reason: null,
  },
  {
    name: 'blind Spur prevents absence completion',
    pr: null,
    flags: { spurBlind: true },
    reason: null,
  },
  {
    name: 'ticket still open prevents absence completion',
    pr: null,
    flags: { ticketDone: false },
    reason: null,
  },
  {
    name: 'blind GitHub holds closed-ticket completion',
    pr: null,
    flags: { githubBlind: true },
    reason: null,
  },
  {
    name: 'pending submit holds closed-ticket completion',
    pr: null,
    flags: { submitPending: true },
    reason: null,
  },
  {
    name: 'blind GitHub holds merged completion',
    pr: 'merged',
    flags: { githubBlind: true },
    reason: null,
  },
  {
    name: 'pending submit holds merged completion',
    pr: 'merged',
    flags: { submitPending: true },
    reason: null,
  },
  {
    name: 'merged shortcut bypasses absence readiness',
    pr: 'merged',
    flags: { allGithubReposReady: false, spurReady: false, spurBlind: true },
    reason: 'merged',
  },
  {
    name: 'closed-ticket shortcut bypasses cycle hold and normal gates',
    pr: null,
    flags: { cycleHeld: true },
    reason: 'ticket_done_no_pr',
  },
  { name: 'merged shortcut applies from Todo', start: 'todo', pr: 'merged', reason: 'merged' },
  {
    name: 'closed-ticket shortcut applies from Todo',
    start: 'todo',
    pr: null,
    reason: 'ticket_done_no_pr',
  },
  { name: 'Done itself has no exit', start: 'done', pr: 'open', reason: null },
];

it.each(
  layouts.flatMap((layout) =>
    facts.map((fact) => ({ ...layout, ...fact, name: `${layout.name}: ${fact.name}` })),
  ),
)(
  'separates ordinary progression and completion in $name',
  async ({ stages, pr, flags, start, reason }) => {
    const store = openTempStore('board-column-completion-').store;
    stores.push(store);
    const config = configSchema.parse({
      projects: [
        {
          id: 'policy',
          tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          columns: ['todo', ...stages, 'done'].map((id) => ({ id })),
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    const project = config.projects[0];
    const last = stages.at(-1);
    if (project === undefined || last === undefined) throw new Error('missing layout');
    const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
    const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
    const policy = (
      await createQuery({ store, config, clock })(registry['columns.describe'], {}, 'operator')
    ).projects[0];
    if (policy === undefined) throw new Error('missing policy');
    expect(policy.columns.find((column) => column.id === last)?.exit.to).toBeNull();
    expect(policy.columns.find((column) => column.id === 'done')?.exit).toEqual({
      to: null,
      conditions: [],
    });
    expect(policy.completion.to).toBe('done');
    expect(policy.completion.text).toContain('bypasses normal gates');
    for (const requirement of [
      'merged PR',
      'closed ticket',
      'no open linked PR',
      'no live worker',
      'every configured repository',
      'Spur',
      'GitHub is blind',
      'submit is pending',
    ])
      expect(policy.completion.text).toContain(requirement);
    const headSha = 'a'.repeat(40);
    const input: Input = {
      column: start ?? last,
      project,
      facts: {
        pr:
          pr === null
            ? null
            : {
                repo: 'o/r',
                state: pr,
                draft: false,
                mergeable: 'mergeable',
                headSha,
                requiredChecks: [{ name: 'ci', state: 'success', completedAt: null }],
                checks: [{ name: 'ci', state: 'success', completedAt: null }],
              },
        externalReviewApproved: true,
        commentHistory: 'complete',
        unhandledExternalComments: 0,
        unresolvedThreads: 0,
        marks: project.columns.map((column) => ({ kind: 'submit', column: column.id, headSha })),
      },
      reopened: false,
      // Domain merged facts have already passed the app's ticket qualification below.
      ticketDone: pr === null || pr === 'merged',
      hasOpenLinkedPr: pr !== null,
      allGithubReposReady: true,
      spurReady: true,
      openPr: pr !== null,
      githubBlind: false,
      spurBlind: false,
      liveWorker: pr !== null,
      cycleHeld: false,
      submitPending: false,
      submitFailed: false,
      turn: { visit: 'none', open: false, operatorUntaken: false, headMoved: false },
      ...flags,
    };
    const result = dispatch(input);
    const completion = result.moves.find((move) => move.to === 'done');
    expect(completion?.reason ?? null).toBe(reason);
    if (reason !== null) expect(completion?.to).toBe(policy.completion.to);
    if (pr === 'open' && flags === undefined && start === undefined) {
      expect(result.moves).toEqual([]);
      if (last !== 'ready-to-merge') expect(evaluateGate(last, input.facts, project).ok).toBe(true);
      else
        expect(
          policy.columns
            .find((column) => column.id === last)
            ?.exit.conditions.map((rule) => rule.id),
        ).toContain('merged');
    }
  },
);

const ticketEvidence = [
  {
    name: 'done ticket',
    status: 'done',
    changed: 'before',
    inFilter: true,
    manual: false,
    column: 'done',
    unconfirmed: false,
  },
  {
    name: 'missing ticket',
    status: 'missing',
    changed: 'before',
    inFilter: true,
    manual: false,
    column: 'ready-to-merge',
    unconfirmed: true,
  },
  {
    name: 'open, untouched since merge, observed past interval',
    status: 'open',
    changed: 'before',
    inFilter: true,
    manual: false,
    column: 'ready-to-merge',
    unconfirmed: true,
  },
  {
    name: 'open, changed after merge in filter',
    status: 'open',
    changed: 'after',
    inFilter: true,
    manual: false,
    column: 'dev',
    unconfirmed: false,
  },
  {
    // GitHub times have one-second precision: an edit in the merge's second shows the merge time.
    name: 'open, changed at the merge time in filter',
    status: 'open',
    changed: 'at',
    inFilter: true,
    manual: false,
    column: 'dev',
    unconfirmed: false,
  },
  {
    name: 'dropped filter keeps stale status',
    status: 'open',
    changed: 'after',
    inFilter: false,
    manual: false,
    column: 'ready-to-merge',
    unconfirmed: true,
  },
  {
    name: 'manual inclusion, changed after merge outside filter',
    status: 'open',
    changed: 'after',
    inFilter: false,
    manual: true,
    column: 'dev',
    unconfirmed: false,
  },
  {
    name: 'manual inclusion still waits while untouched since merge',
    status: 'open',
    changed: 'before',
    inFilter: false,
    manual: true,
    column: 'ready-to-merge',
    unconfirmed: true,
  },
] as const;
const trackers = [
  { name: 'GitHub', tracker: { type: 'github-issues', repo: 'o/r', label: 'board' } },
  {
    name: 'Jira',
    tracker: {
      type: 'jira',
      baseUrl: 'https://issues.example.test',
      jql: 'project = POL',
      doneStatuses: ['Accepted'],
      readyStatuses: ['Ready'],
      projectKeys: ['POL'],
    },
  },
] as const;

it.each(
  trackers.flatMap((tracker) =>
    ticketEvidence.map((evidence) => ({
      ...tracker,
      ...evidence,
      name: `${tracker.name}: ${evidence.name}`,
    })),
  ),
)(
  'qualifies completion against app ticket evidence in $name',
  async ({ tracker, status, changed, inFilter, manual, column, unconfirmed }) => {
    const store = openTempStore('board-app-completion-').store;
    stores.push(store);
    const config = configSchema.parse({
      projects: [
        {
          id: 'policy',
          tracker,
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          columns: [
            { id: 'todo' },
            { id: 'dev' },
            { id: 'ready-to-merge', orchestrator: 'operator' },
            { id: 'done' },
          ],
          dispatcher: { mode: 'on' },
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
      adapters: { githubIssues: { intervalMs: 120000 }, jira: { intervalMs: 180000 } },
    });
    const project = config.projects[0];
    if (project === undefined) throw new Error('missing project');
    const jira = project.tracker.type === 'jira';
    const interval = jira
      ? config.adapters.jira.intervalMs
      : config.adapters.githubIssues.intervalMs;
    const doneStatus = project.tracker.type === 'jira' ? project.tracker.doneStatuses[0] : 'closed';
    if (doneStatus === undefined) throw new Error('missing done status');
    const mergedAt = '2026-11-04T08:00:00.000Z';
    const now = Date.parse(mergedAt) + 2 * interval;
    const at = new Date(now);
    // Observed past the tracker interval either way: only a change at or after the merge counts.
    const observedAt = new Date(Date.parse(mergedAt) + interval).toISOString();
    const updatedAt = new Date(
      Date.parse(mergedAt) + { before: -1, at: 0, after: 1 }[changed],
    ).toISOString();
    const key = jira ? 'POL-1' : 'o/r#1';
    const pr: PrFacts = {
      repo: 'o/r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      title: 'Work',
      author: 'operator',
      headSha: 'a'.repeat(40),
      headBranch: 'work',
      state: 'merged',
      draft: false,
      mergeable: 'mergeable',
      mergeState: 'clean',
      requiredChecks: [],
      checks: [],
      reviews: [],
      reviewThreads: [],
      reviewRequests: [],
      ticketKeys: [key],
      feedback: [],
      feedbackComplete: true,
      updatedAt: mergedAt,
      mergedAt,
    };
    await store.transaction(async (trx) => {
      await trx
        .insertInto('task')
        .values({
          ...sampleRows.task,
          project: project.id,
          tracker_kind: project.tracker.type,
          tracker_id: '1',
          key,
          membership: 'active',
          archive_reason: null,
          column: 'ready-to-merge',
          shadow_column: null,
          manual_include: manual ? 1 : 0,
          reopened_at: null,
          last_change_at: mergedAt,
        })
        .execute();
      await trx
        .insertInto('pr_snapshot')
        .values({
          ...sampleRows.pr_snapshot,
          repo: pr.repo,
          number: pr.number,
          state: 'merged',
          detail: JSON.stringify(pr),
          observed_at: at.toISOString(),
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          repo: pr.repo,
          number: pr.number,
          pr_open: 0,
          pr_state: 'active',
        })
        .execute();
      if (status !== 'missing') {
        const ticket: TicketFacts = {
          trackerId: 'fixture',
          id: '1',
          key,
          title: 'Work',
          status: status === 'done' ? doneStatus : 'open',
          assignee: null,
          sprint: null,
          labels: [],
          inFilter,
          url: 'https://issues.example.test/1',
          updatedAt,
        };
        await trx
          .insertInto('ticket_snapshot')
          .values({
            ...sampleRows.ticket_snapshot,
            status: ticket.status,
            detail: JSON.stringify(ticket),
            observed_at: observedAt,
          })
          .execute();
      }
    });
    const complete = new Map([
      [prSourceId(project.id, 'o/r'), at.toISOString()],
      ['spur', at.toISOString()],
    ]);
    const read = await store.transaction(async (trx) => {
      const task = await trx
        .selectFrom('task')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      return readInput(trx, task, project, 'on', () => false, config, { at, complete });
    });
    expect(read?.ticketUnconfirmed).toBe(unconfirmed);
    expect(read?.input.ticketDone).toBe(status === 'done');
    expect(read?.input.facts.pr?.state ?? null).toBe(column === 'dev' ? null : 'merged');
    await scanTransaction(
      store,
      config,
      (trx) => dispatchTasks(trx, [1], { config, at, complete }),
      { now: () => now },
    );
    expect(
      (
        await store.db
          .selectFrom('task')
          .select('column')
          .where('id', '=', 1)
          .executeTakeFirstOrThrow()
      ).column,
    ).toBe(column);
    const registry = createOperationRegistry({
      config,
      clock: { now: () => now },
      completeSince: complete,
    });
    const policy = (
      await createQuery({ store, config, clock: { now: () => now } })(
        registry['columns.describe'],
        {},
        'operator',
      )
    ).projects[0];
    for (const qualification of [
      'done ticket',
      'unconfirmed',
      'in the tracker filter',
      'manually included',
      'resumes work',
      doneStatus,
      'changed at or after the merge',
    ])
      expect(policy?.completion.text).toContain(qualification);
  },
);
