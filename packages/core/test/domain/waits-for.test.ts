import { COLUMN_IDS, WAITS_FOR_KINDS, type ColumnId } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import type { GateProject } from '../../src/domain/gates.ts';
import {
  gateWaitsFor,
  waitsFor,
  type PrRef,
  type WaitsFor,
  type WaitsForFacts,
} from '../../src/domain/waits-for.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const MINIMAL: readonly ColumnId[] = ['todo', 'dev', 'review', 'done'];

/** A project with the `enabled` columns on and every other column off. */
const project = (enabled: readonly ColumnId[] = MINIMAL): GateProject => ({
  columns: COLUMN_IDS.map((id) => ({ id, enabled: enabled.includes(id), orchestrator: 'none' })),
  reposWithoutCi: [],
  checksGate: 'dev',
});

const open: PrRef = { repo: 'o/r', number: 7, state: 'open' };
const merged: PrRef = { ...open, state: 'merged' };
const closed: PrRef = { ...open, state: 'closed' };

type Read = Extract<WaitsForFacts, { column: ColumnId }>;
type Work = Read['work'];

/** Nothing reopened, the ticket open and no live worker, with `changes` over it. */
const work = (changes: Partial<Work> = {}): Work => ({
  reopened: false,
  ticketDone: false,
  liveWorker: false,
  ...changes,
});

/** A task in Review of the minimal board, its gate passing, with nothing holding it. */
const facts = (changes: Partial<Read> = {}): Read => ({
  project: project(),
  archived: false,
  gate: { ok: true },
  column: 'review',
  holds: [],
  heldBlocks: [],
  pendingSha: undefined,
  turn: null,
  waiting: [],
  pr: open,
  work: work(),
  ...changes,
});

const failing = (column: ColumnId, ...reasons: Read['waiting'][number]['reason'][]) => {
  const [first = 'no_pr', ...rest] = reasons;
  return { ok: false as const, column, reasons: [first, ...rest] as const };
};

const waitingOn = (
  reason: Read['waiting'][number]['reason'],
  reviewers?: readonly string[],
): Read => {
  const gate = failing('review', reason);
  return facts({
    gate,
    waiting: [{ reason, head: SHA, ...(reviewers === undefined ? {} : { reviewers }) }],
  });
};

const ARCHIVED: WaitsFor = {
  kind: 'archived',
  text: 'nothing while the task is archived; unarchive it to resume (operator)',
  actor: 'operator',
};

const rows: [string, WaitsForFacts, WaitsFor][] = [
  [
    'the project left the config',
    { project: null },
    { kind: 'config', text: 'the project in config.yaml (operator)', actor: 'operator' },
  ],
  [
    'pr_snapshot_missing',
    { project: project(), archived: false, gate: null },
    { kind: 'board', text: 'the first poll of the linked PR', actor: null },
  ],
  [
    'an archived task, before a missing snapshot',
    { project: project(), archived: true, gate: null },
    ARCHIVED,
  ],
  [
    'an archived task, before work to start',
    facts({ archived: true, column: 'todo', holds: ['work_not_started'], pr: null }),
    ARCHIVED,
  ],
  [
    'github_blind',
    facts({ holds: ['github_blind', 'submit_pending'] }),
    { kind: 'github', text: 'GitHub to be readable', actor: null },
  ],
  [
    'submit_pending',
    facts({ holds: ['submit_pending'], pendingSha: SHA }),
    { kind: 'board', text: 'confirmation of submit 0123456', actor: null },
  ],
  [
    'ticket_unconfirmed',
    facts({ holds: ['ticket_unconfirmed'], pr: merged }),
    { kind: 'ticket', text: 'ticket to close', actor: null },
  ],
  [
    'cycle_limit with curator-addressed blocks',
    facts({
      holds: ['cycle_limit'],
      heldBlocks: [
        { id: 'B4', addressee: 'curator' },
        { id: 'B9', addressee: 'operator' },
      ],
      turn: { id: 'T2', column: 'review', addressee: 'orchestrator:review' },
    }),
    { kind: 'answer', text: 'answer to B4, B9 (curator)', actor: 'curator' },
  ],
  [
    'cycle_limit with no held block',
    facts({ holds: ['cycle_limit'] }),
    {
      kind: 'answer',
      text: 'clearing of the cycle-limit or course-check item (operator)',
      actor: 'operator',
    },
  ],
  [
    'an open turn',
    facts({
      holds: ['spur_blind'],
      turn: { id: 'T2', column: 'review', addressee: 'orchestrator:review' },
    }),
    { kind: 'turn', text: 'Review turn T2 (orchestrator:review)', actor: 'orchestrator:review' },
  ],
  [
    'spur_blind',
    facts({ holds: ['spur_blind'] }),
    { kind: 'spur', text: 'Spur to be readable', actor: null },
  ],
  [
    'work_not_started',
    facts({ column: 'todo', holds: ['work_not_started'], pr: null }),
    { kind: 'work', text: 'work to start: an open PR or a live worker', actor: null },
  ],
  [
    'work_not_started after a reopen',
    facts({
      column: 'todo',
      holds: ['work_not_started'],
      pr: null,
      work: work({ reopened: true }),
    }),
    { kind: 'work', text: 'work to start: an open PR (the ticket was reopened)', actor: null },
  ],
  [
    'checks_pending',
    waitingOn('checks_pending'),
    { kind: 'checks', text: 'CI on 01234567', actor: null },
  ],
  [
    'checks_red',
    waitingOn('checks_red'),
    { kind: 'checks', text: 'green checks on 01234567', actor: null },
  ],
  [
    'mergeable_unknown',
    waitingOn('mergeable_unknown'),
    { kind: 'github', text: 'GitHub to compute mergeability on 01234567', actor: null },
  ],
  [
    'comment_history_incomplete',
    waitingOn('comment_history_incomplete'),
    {
      kind: 'board',
      text: 'the board to read the full PR comment history on 01234567',
      actor: null,
    },
  ],
  [
    'merge_state_unknown',
    waitingOn('merge_state_unknown'),
    { kind: 'github', text: 'GitHub to compute the merge state', actor: null },
  ],
  [
    'review_rule_unreadable',
    waitingOn('review_rule_unreadable'),
    {
      kind: 'github',
      text: 'the GitHub review rule for the base branch to be readable',
      actor: null,
    },
  ],
  [
    'awaiting_required_reviewers',
    waitingOn('awaiting_required_reviewers', ['alice', 'acme/core']),
    { kind: 'approval', text: 'review by alice, acme/core (a human)', actor: 'human' },
  ],
  [
    'review_rule_blocked',
    waitingOn('review_rule_blocked'),
    { kind: 'approval', text: 'the GitHub review rule to pass (a human)', actor: 'human' },
  ],
  [
    'changes_requested',
    waitingOn('changes_requested'),
    {
      kind: 'approval',
      text: 'a new review of the requested changes on o/r#7 (a human)',
      actor: 'human',
    },
  ],
  [
    'done',
    facts({ column: 'done', pr: merged }),
    { kind: 'done', text: 'nothing, the task is done', actor: null },
  ],
  [
    'gate ok, next is Done, PR open',
    facts(),
    { kind: 'merge', text: 'merge of o/r#7 (a human)', actor: 'human' },
  ],
  [
    'gate ok, PR merged',
    facts({ pr: merged }),
    { kind: 'board', text: 'the next dispatcher pass to move it to done', actor: null },
  ],
  [
    'gate ok, next is Done, no PR',
    facts({ pr: null }),
    {
      kind: 'ticket',
      text: 'ticket to close, with no open PR and no live worker',
      actor: null,
    },
  ],
  [
    'gate ok, next is Done, no PR, ticket done, worker live',
    facts({ pr: null, work: work({ ticketDone: true, liveWorker: true }) }),
    { kind: 'work', text: 'the worker session to end, with no open PR', actor: null },
  ],
  [
    'gate ok, next is Done, no PR, ticket done, nothing live',
    facts({ pr: null, work: work({ ticketDone: true }) }),
    { kind: 'board', text: 'the next dispatcher pass to move it to done', actor: null },
  ],
  [
    'gate ok, next is Done, PR closed',
    facts({ pr: closed }),
    {
      kind: 'ticket',
      text: 'ticket to close, with no open PR and no live worker',
      actor: null,
    },
  ],
  [
    'gate ok, next column forward',
    facts({ column: 'dev' }),
    { kind: 'board', text: 'the next dispatcher pass to move it to review', actor: null },
  ],
  [
    'Ready to Merge fails on not_merged only',
    facts({
      project: project([...MINIMAL, 'ready-to-merge']),
      column: 'ready-to-merge',
      gate: failing('ready-to-merge', 'not_merged'),
    }),
    { kind: 'merge', text: 'merge of o/r#7 (a human)', actor: 'human' },
  ],
  [
    'External Review fails on not_approved',
    facts({
      project: project([...MINIMAL, 'external-review']),
      column: 'external-review',
      gate: failing('external-review', 'not_approved'),
    }),
    {
      kind: 'approval',
      text: 'approval of o/r#7 by an external reviewer (a human)',
      actor: 'human',
    },
  ],
  [
    'the gate fails at the column',
    facts({ gate: failing('review', 'no_review_on_head') }),
    { kind: 'gate', text: 'Review exit: no_review_on_head', actor: null },
  ],
  [
    'the gate fails left of the column',
    facts({ gate: failing('dev', 'checks_red', 'conflict') }),
    { kind: 'board', text: 'the next dispatcher pass to move it back to dev', actor: null },
  ],
];

describe('waitsFor', () => {
  it.each(rows)('%s', (_name, input, expected) => {
    expect(waitsFor(input)).toEqual(expected);
  });

  it('gives every kind on some rung', () => {
    expect(new Set(rows.map(([, , expected]) => expected.kind))).toEqual(new Set(WAITS_FOR_KINDS));
  });
});

describe('gateWaitsFor', () => {
  const done = { column: 'done', enabled: true } as const;
  const base = {
    column: 'review' as ColumnId,
    holds: [] as const,
    pr: open,
    archived: false,
    work: work(),
  };
  const notStarted = { ...base, column: 'todo' as ColumnId, holds: ['work_not_started'] as const };
  const noPr = { ...base, pr: null };

  it.each([
    ['done, PR open, ticket open', done, base, 'merge of o/r#7, then the ticket to close'],
    [
      'done, PR open, ticket done',
      done,
      { ...base, work: work({ ticketDone: true }) },
      'merge of o/r#7',
    ],
    ['done, PR merged', done, { ...base, pr: merged }, 'ticket to close'],
    [
      'done, PR merged, ticket done',
      done,
      { ...base, pr: merged, work: work({ ticketDone: true }) },
      'the next dispatcher pass to move it to done',
    ],
    ['done, no PR', done, noPr, 'ticket to close, with no open PR and no live worker'],
    [
      'done, no PR, ticket done, worker live',
      done,
      { ...noPr, work: work({ ticketDone: true, liveWorker: true }) },
      'the worker session to end, with no open PR',
    ],
    [
      'done, no PR, ticket done, nothing live',
      done,
      { ...noPr, work: work({ ticketDone: true }) },
      'the next dispatcher pass to move it to done',
    ],
    [
      'the To Do group column the task sits in before work starts',
      { column: 'todo', enabled: true },
      { ...notStarted, pr: null },
      'work to start: an open PR or a live worker',
    ],
    [
      'the To Do group column after a reopen',
      { column: 'todo', enabled: true },
      { ...notStarted, pr: null, work: work({ reopened: true }) },
      'work to start: an open PR (the ticket was reopened)',
    ],
    ['a disabled Done gate', { column: 'done', enabled: false }, base, undefined],
    ['the Done gate of an archived task', done, { ...base, archived: true }, undefined],
    [
      'the To Do group column of an archived task',
      { column: 'todo', enabled: true },
      { ...notStarted, pr: null, archived: true },
      undefined,
    ],
    ['the Done gate of a task in Done', done, { ...base, column: 'done' as ColumnId }, undefined],
    ['a gate with conditions', { column: 'review', enabled: true }, base, undefined],
    [
      'a To Do group gate the task is not in',
      { column: 'ready-for-dev', enabled: true },
      { ...notStarted, pr: null },
      undefined,
    ],
  ] as const)('%s', (_name, gate, input, expected) => {
    expect(gateWaitsFor(gate, input)).toBe(expected);
  });
});
