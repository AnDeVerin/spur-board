import { COLUMN_IDS, type ColumnId, type GateReason } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { dispatch, returnCauses, turnReason } from '../../src/domain/dispatch.ts';
import type { TaskGateFacts } from '../../src/domain/gates.ts';

type Input = Parameters<typeof dispatch>[0];
type Result = ReturnType<typeof dispatch>;
type Turn = NonNullable<Result['turn']>;
type Move = Result['moves'][number];
type Board = Input['project']['columns'];
type Mark = TaskGateFacts['marks'][number];
type Pr = NonNullable<TaskGateFacts['pr']>;

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const submit = (column: ColumnId, headSha = A): Mark => ({ kind: 'submit', column, headSha });
const mark = (column: 'review' | 'product-review', headSha = A): Mark => ({
  kind: 'mark',
  column,
  headSha,
});

const greenPr: Pr = {
  repo: 'o/r',
  state: 'open',
  draft: false,
  mergeable: 'mergeable',
  headSha: A,
  requiredChecks: [{ name: 'ci', state: 'success', completedAt: null }],
  checks: [{ name: 'ci', state: 'success', completedAt: null }],
};
const red: Partial<Pr> = { requiredChecks: [{ name: 'ci', state: 'failure', completedAt: null }] };
const pending: Partial<Pr> = {
  requiredChecks: [{ name: 'ci', state: 'pending', completedAt: null }],
};

const ORCHESTRATORS: Partial<Record<ColumnId, string>> = {
  review: 'rev',
  'product-review': 'coord',
  'ready-to-merge': 'operator',
};
/** Every column enabled; review, product review and ready to merge have executors. */
const ALL: Board = COLUMN_IDS.map((id) => ({
  id,
  enabled: true,
  orchestrator: ORCHESTRATORS[id] ?? 'none',
}));
const disable = (board: Board, ...ids: ColumnId[]): Board =>
  board.map((c) => (ids.includes(c.id) ? { ...c, enabled: false } : c));
const orchestrate = (board: Board, id: ColumnId, orchestrator: string): Board =>
  board.map((c) => (c.id === id ? { ...c, orchestrator } : c));
/** The sb-like board: no Ready for Dev, External Review or QA. */
const SB = disable(ALL, 'ready-for-dev', 'external-review', 'qa');

type Changes = Partial<Omit<Input, 'facts' | 'project' | 'turn'>> & {
  pr?: Partial<Pr> | null;
  facts?: Partial<Omit<TaskGateFacts, 'pr'>>;
  board?: Board;
  turn?: Partial<Input['turn']>;
};

/** A task in Dev on the sb board with a green open PR on A, a Dev submit and a live worker. */
function input(changes: Changes = {}): Input {
  const { pr, facts, board, turn, ...rest } = changes;
  return {
    column: 'dev',
    project: { columns: board ?? SB, reposWithoutCi: [] },
    facts: {
      pr: pr === null ? null : { ...greenPr, ...pr },
      externalReviewApproved: false,
      commentHistory: 'complete',
      unhandledExternalComments: 0,
      marks: [submit('dev')],
      ...facts,
    },
    reopened: false,
    openPr: true,
    githubBlind: false,
    spurBlind: false,
    liveWorker: true,
    cycleHeld: false,
    turn: { visit: 'none', open: false, operatorUntaken: false, ...turn },
    ...rest,
  };
}

const right = (from: ColumnId, to: ColumnId): Move => ({ from, to, reason: 'gate_passed' });
const left = (from: ColumnId, to: ColumnId, ...gate: GateReason[]): Move => ({
  from,
  to,
  reason: 'gate_broken',
  gate,
});
const merged = (from: ColumnId): Move => ({ from, to: 'done', reason: 'merged' });
const reopened: Move = { from: 'done', to: 'todo', reason: 'ticket_reopened' };
const turn = (kind: Turn['kind'], column: ColumnId, ...reasons: GateReason[]): Turn => ({
  column,
  reasons,
  kind,
});
const wrapUp = turn('wrap_up', 'done');
const nothing: Result = { moves: [], turn: null };

const cases: [string, Changes, Result][] = [
  [
    'moves right when the gate holds',
    {},
    { moves: [right('dev', 'review')], turn: turn('entry', 'review', 'no_review_on_head') },
  ],
  [
    'stops before Done without a merge',
    {
      column: 'product-review',
      board: disable(SB, 'ready-to-merge'),
      facts: { marks: [submit('dev'), mark('review'), mark('product-review')] },
    },
    nothing,
  ],
  [
    'holds To Do without work',
    { column: 'todo', pr: null, facts: { marks: [] }, openPr: false, liveWorker: false },
    nothing,
  ],
  [
    'leaves To Do on an open PR',
    { column: 'todo', facts: { marks: [] }, liveWorker: false },
    { moves: [right('todo', 'dev')], turn: turn('entry', 'dev', 'no_submit_on_head') },
  ],
  [
    'leaves To Do on a live worker while Spur reports',
    { column: 'todo', pr: null, facts: { marks: [] }, openPr: false },
    { moves: [right('todo', 'dev')], turn: turn('entry', 'dev', 'no_pr') },
  ],
  [
    'holds To Do on a live worker while Spur is blind',
    { column: 'todo', pr: null, facts: { marks: [] }, openPr: false, spurBlind: true },
    nothing,
  ],
  [
    'holds a reopened task in To Do with a live worker',
    { column: 'todo', reopened: true, pr: null, facts: { marks: [] }, openPr: false },
    nothing,
  ],
  [
    'leaves a reopened To Do on an open PR above the floor',
    { column: 'todo', reopened: true, pr: { headSha: B } },
    { moves: [right('todo', 'dev')], turn: turn('entry', 'dev', 'no_submit_on_head') },
  ],
  ['entry turn', { pr: red }, { moves: [], turn: turn('entry', 'dev', 'checks_red') }],
  [
    're-entry passes on a mark',
    { facts: { marks: [submit('dev'), mark('review')] } },
    {
      moves: [right('dev', 'review'), right('review', 'product-review')],
      turn: turn('entry', 'product-review', 'no_review_on_head'),
    },
  ],
  [
    'waits for an open turn',
    { column: 'review', pr: red, turn: { visit: 'unclosed', open: true } },
    nothing,
  ],
  [
    'moves past an unacked turn',
    { column: 'review', pr: red, turn: { visit: 'unclosed', open: false } },
    {
      moves: [left('review', 'dev', 'checks_red')],
      turn: turn('entry', 'dev', 'checks_red', 'no_submit_on_head'),
    },
  ],
  ['holds on hold-only reasons', { column: 'review', pr: pending }, nothing],
  [
    'holds on every hold-only reason',
    { column: 'review', pr: { mergeable: 'unknown' }, facts: { commentHistory: 'incomplete' } },
    nothing,
  ],
  [
    'new turn after submit',
    { pr: red, turn: { visit: 'submitted' } },
    { moves: [], turn: turn('after_submit', 'dev', 'checks_red') },
  ],
  [
    'no new turn after submit on hold-only reasons',
    { pr: pending, turn: { visit: 'submitted' } },
    nothing,
  ],
  [
    'no new turn while the visit turn is unclosed',
    { pr: red, turn: { visit: 'unclosed', open: true } },
    nothing,
  ],
  ...(['todo', 'dev', 'review', 'ready-to-merge'] as const).map(
    (column): [string, Changes, Result] => [
      `merge from ${column}`,
      { column, pr: { state: 'merged' } },
      { moves: [merged(column)], turn: wrapUp },
    ],
  ),
  [
    'merge from Dev with an open turn',
    { pr: { state: 'merged' }, turn: { visit: 'unclosed', open: true } },
    { moves: [merged('dev')], turn: wrapUp },
  ],
  [
    'reopen',
    { column: 'done', reopened: true, pr: null, facts: { marks: [] }, openPr: false },
    { moves: [reopened], turn: null },
  ],
  [
    'a reopened task drops its stale Dev submit and stops at Dev on the same head',
    { column: 'done', reopened: true },
    {
      moves: [reopened, right('todo', 'dev')],
      turn: turn('entry', 'dev', 'no_submit_on_head'),
    },
  ],
  [
    'a reopened task with its new PR merged stays in Done',
    { column: 'done', reopened: true, pr: { state: 'merged' }, turn: { visit: 'submitted' } },
    nothing,
  ],
  [
    'wrap-up for a live worker in Done',
    { column: 'done', pr: { state: 'merged' } },
    { moves: [], turn: wrapUp },
  ],
  [
    'wrap-up for a Done orchestrator',
    {
      column: 'done',
      pr: { state: 'merged' },
      liveWorker: false,
      board: orchestrate(SB, 'done', 'closer'),
    },
    { moves: [], turn: wrapUp },
  ],
  [
    'no wrap-up without a live worker',
    { column: 'done', pr: { state: 'merged' }, liveWorker: false },
    nothing,
  ],
  [
    'no wrap-up while Spur is blind',
    { column: 'done', pr: { state: 'merged' }, spurBlind: true },
    nothing,
  ],
  [
    'no wrap-up for an operator Done',
    { column: 'done', pr: { state: 'merged' }, board: orchestrate(SB, 'done', 'operator') },
    nothing,
  ],
  [
    'no second wrap-up after a submit',
    { column: 'done', pr: { state: 'merged' }, turn: { visit: 'submitted' } },
    nothing,
  ],
  ['GitHub blind', { column: 'review', pr: { state: 'merged' }, githubBlind: true }, nothing],
  ['GitHub blind on a broken gate', { column: 'review', pr: red, githubBlind: true }, nothing],
  ['Spur defer', { pr: red, spurBlind: true }, nothing],
  [
    'Spur blind keeps an orchestrator turn',
    { column: 'review', spurBlind: true },
    { moves: [], turn: turn('entry', 'review', 'no_review_on_head') },
  ],
  [
    'Spur blind keeps an operator turn',
    {
      column: 'ready-to-merge',
      spurBlind: true,
      facts: { marks: [submit('dev'), mark('review'), mark('product-review')] },
    },
    { moves: [], turn: turn('entry', 'ready-to-merge', 'not_merged') },
  ],
  [
    'reroute',
    { facts: { marks: [] }, turn: { visit: 'unclosed', operatorUntaken: true } },
    { moves: [], turn: turn('reroute', 'dev', 'no_submit_on_head') },
  ],
  [
    'no reroute without a live worker',
    { facts: { marks: [] }, liveWorker: false, turn: { visit: 'unclosed', operatorUntaken: true } },
    nothing,
  ],
  [
    'no reroute while Spur is blind',
    { facts: { marks: [] }, spurBlind: true, turn: { visit: 'unclosed', operatorUntaken: true } },
    nothing,
  ],
  [
    'no reroute of an operator column',
    {
      column: 'ready-to-merge',
      facts: { marks: [submit('dev'), mark('review'), mark('product-review')] },
      turn: { visit: 'unclosed', operatorUntaken: true },
    },
    nothing,
  ],
  [
    'External Review holds',
    {
      column: 'external-review',
      board: disable(ALL, 'ready-for-dev', 'qa'),
      facts: { marks: [submit('dev'), mark('review'), mark('product-review')] },
    },
    nothing,
  ],
  [
    'External Review passes on an external approval',
    {
      column: 'external-review',
      board: disable(ALL, 'ready-for-dev', 'qa'),
      facts: {
        marks: [submit('dev'), mark('review'), mark('product-review')],
        externalReviewApproved: true,
      },
    },
    {
      moves: [right('external-review', 'ready-to-merge')],
      turn: turn('entry', 'ready-to-merge', 'not_merged'),
    },
  ],
  [
    'External Review with an executor gets a turn',
    {
      column: 'external-review',
      board: orchestrate(disable(ALL, 'ready-for-dev', 'qa'), 'external-review', 'ext'),
      facts: { marks: [submit('dev'), mark('review'), mark('product-review')] },
    },
    { moves: [], turn: turn('entry', 'external-review', 'not_approved') },
  ],
  [
    'PR closed opens no turn',
    { column: 'review', pr: { state: 'closed' } },
    { moves: [left('review', 'dev', 'pr_closed')], turn: null },
  ],
  ['cycle hold opens no turn', { pr: red, cycleHeld: true }, nothing],
  ['cycle hold makes no right move', { cycleHeld: true }, nothing],
  ['cycle hold makes no left move', { column: 'review', pr: red, cycleHeld: true }, nothing],
  [
    'cycle hold keeps merge, with no wrap-up',
    { column: 'dev', pr: { state: 'merged' }, cycleHeld: true },
    { moves: [merged('dev')], turn: null },
  ],
  [
    'cycle hold keeps reopen',
    { column: 'done', reopened: true, pr: { headSha: B }, facts: { marks: [] }, cycleHeld: true },
    { moves: [reopened], turn: null },
  ],
  [
    'drops submits on a left move and keeps marks',
    {
      column: 'product-review',
      pr: { mergeable: 'conflicting' },
      facts: { marks: [submit('dev'), mark('review'), submit('product-review')] },
    },
    {
      moves: [left('product-review', 'dev', 'conflict')],
      turn: turn('entry', 'dev', 'conflict', 'no_submit_on_head'),
    },
  ],
  [
    // A left move drops the submits, so the longest cascade starts in To Do, not after a reopen.
    'step bound: the longest cascade runs to its end',
    {
      column: 'todo',
      board: ALL,
      pr: { headSha: B },
      facts: {
        marks: [submit('dev', B), mark('review', B), mark('product-review', B), submit('qa', B)],
        externalReviewApproved: true,
      },
    },
    {
      moves: [
        right('todo', 'ready-for-dev'),
        right('ready-for-dev', 'dev'),
        right('dev', 'review'),
        right('review', 'product-review'),
        right('product-review', 'external-review'),
        right('external-review', 'qa'),
        right('qa', 'ready-to-merge'),
      ],
      turn: turn('entry', 'ready-to-merge', 'not_merged'),
    },
  ],
];

describe('dispatch', () => {
  it.each(cases)('%s', (_name, changes, expected) => {
    expect(dispatch(input(changes))).toEqual(expected);
  });

  it('never moves right into Done', () => {
    for (const column of COLUMN_IDS.filter((id) => id !== 'done')) {
      const { moves } = dispatch(
        input({
          column,
          board: ALL,
          facts: {
            marks: [submit('dev'), mark('review'), mark('product-review'), submit('qa')],
            externalReviewApproved: true,
          },
        }),
      );
      expect(moves.filter((move) => move.to === 'done')).toEqual([]);
    }
  });
});

describe('returnCauses', () => {
  it.each<[string, GateReason[], boolean, ReturnType<typeof returnCauses>]>([
    ['an executor return', ['no_review_on_head'], true, ['executor']],
    [
      'a gate return with mapped reasons',
      ['pr_draft', 'checks_red', 'conflict'],
      false,
      ['draft', 'checks_red', 'conflict'],
    ],
    ['external comments', ['external_comments', 'no_submit_on_head'], false, ['external_comments']],
    ['an executor return with a conflict', ['conflict'], true, ['executor', 'conflict']],
    ['unmapped reasons only', ['pr_closed', 'no_pr', 'checks_pending'], false, []],
  ])('%s', (_name, gate, byExecutor, expected) => {
    expect(returnCauses(gate, byExecutor)).toEqual(expected);
  });
});

describe('turnReason', () => {
  it.each<[string, Turn, string | undefined, string]>([
    [
      'an entry turn',
      turn('entry', 'dev', 'checks_red', 'conflict'),
      undefined,
      'dev: checks_red, conflict',
    ],
    [
      'an after-submit turn',
      turn('after_submit', 'review', 'no_review_on_head'),
      undefined,
      'review: no_review_on_head',
    ],
    ['a wrap-up turn', wrapUp, undefined, 'done: wrap up'],
    [
      'a reroute keeps the old reason',
      turn('reroute', 'dev', 'no_pr'),
      'dev: no_submit_on_head',
      'dev: no_submit_on_head',
    ],
  ])('%s', (_name, given, rerouted, expected) => {
    expect(turnReason(given, rerouted)).toEqual(expected);
  });
});
