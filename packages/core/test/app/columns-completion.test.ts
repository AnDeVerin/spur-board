import { configSchema, type ColumnId } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import { createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import { dispatch } from '../../src/domain/dispatch.ts';
import { evaluateGate } from '../../src/domain/gates.ts';
import { openTempStore } from '../support/store.ts';

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
      ticketDone: pr === null,
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
