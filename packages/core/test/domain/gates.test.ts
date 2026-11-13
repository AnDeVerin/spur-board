import { CHECK_STATES, COLUMN_IDS, configSchema, type ColumnId } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import {
  countCycles,
  evaluateGate,
  explainGates,
  type TaskGateFacts,
} from '../../src/domain/gates.ts';

type Board = Parameters<typeof evaluateGate>[2]['columns'];
type Mark = TaskGateFacts['marks'][number];
type Pr = NonNullable<TaskGateFacts['pr']>;
type Check = Pr['checks'][number];
type Expected = ReturnType<typeof evaluateGate>;

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const check = (state: Check['state'], name = 'ci'): Check => ({ name, state, completedAt: null });
const submit = (column: ColumnId, headSha: string): Mark => ({ kind: 'submit', column, headSha });
const mark = (column: 'review' | 'product-review', headSha: string): Mark => ({
  kind: 'mark',
  column,
  headSha,
});

const readyPr: Pr = {
  repo: 'o/r',
  state: 'open',
  draft: false,
  mergeable: 'mergeable',
  headSha: A,
  requiredChecks: [check('success')],
  checks: [check('success')],
};

/** ready(A) with `changes`; `pr` changes merge into the ready pull request. */
function ready(
  changes: Partial<Omit<TaskGateFacts, 'pr'>> & { pr?: Partial<Pr> | null } = {},
): TaskGateFacts {
  const { pr, ...rest } = changes;
  return {
    pr: pr === null ? null : { ...readyPr, ...pr },
    externalReviewApproved: false,
    commentHistory: 'complete',
    unhandledExternalComments: 0,
    marks: [submit('dev', A)],
    ...rest,
  };
}

const ORCHESTRATORS: Partial<Record<ColumnId, string>> = {
  review: 'conductor',
  'product-review': 'coordinator',
  qa: 'qa-bot',
};
const ORCH: Board = COLUMN_IDS.map((id) => ({
  id,
  enabled: true,
  orchestrator: ORCHESTRATORS[id] ?? 'none',
}));

const [defaultProject] = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
}).projects;
if (defaultProject === undefined) throw new Error('the default config has no project');
/** The parsed default board of a project without `columns`. */
const DEFAULT: Board = defaultProject.columns;

const disable = (board: Board, ...ids: ColumnId[]): Board =>
  board.map((c) => (ids.includes(c.id) ? { ...c, enabled: false } : c));
const orchestrate = (board: Board, id: ColumnId, orchestrator: string): Board =>
  board.map((c) => (c.id === id ? { ...c, orchestrator } : c));

/** evaluateGate on `board`, with the project's repos without CI. */
const gate = (
  column: ColumnId,
  facts: TaskGateFacts,
  board: Board,
  reposWithoutCi: readonly string[] = [],
): Expected => evaluateGate(column, facts, { columns: board, reposWithoutCi });

const SB = disable(ORCH, 'external-review', 'qa');
const reviewMarks = [submit('dev', A), mark('review', A), mark('product-review', A)];
const ok: Expected = { ok: true };
type Reason = Extract<Expected, { ok: false }>['reasons'][number];
const broken = (column: ColumnId, ...reasons: [Reason, ...Reason[]]): Expected => ({
  ok: false,
  column,
  reasons,
});

const gateCases: [string, ColumnId, TaskGateFacts, Board, Expected][] = [
  ['1 to do without a PR', 'todo', ready({ pr: null, marks: [] }), ORCH, ok],
  ['2 ready for dev without a PR', 'ready-for-dev', ready({ pr: null, marks: [] }), ORCH, ok],
  ['3 dev without a PR', 'dev', ready({ pr: null, marks: [] }), ORCH, broken('dev', 'no_pr')],
  ['4 dev without a submit', 'dev', ready({ marks: [] }), ORCH, broken('dev', 'no_submit_on_head')],
  ['5 dev submitted', 'dev', ready(), ORCH, ok],
  ['6 review waits', 'review', ready(), ORCH, broken('review', 'no_review_on_head')],
  [
    '7 review submitted',
    'review',
    ready({ marks: [submit('dev', A), submit('review', A)] }),
    ORCH,
    ok,
  ],
  [
    '8 product review waits',
    'product-review',
    ready({ marks: [submit('dev', A), submit('review', A)] }),
    ORCH,
    broken('product-review', 'no_review_on_head'),
  ],
  [
    '9 product review marked',
    'product-review',
    ready({ marks: [submit('dev', A), submit('review', A), mark('product-review', A)] }),
    ORCH,
    ok,
  ],
  [
    '10 ready to merge waits for the merge',
    'ready-to-merge',
    ready({ marks: reviewMarks }),
    SB,
    broken('ready-to-merge', 'not_merged'),
  ],
  ['11 ready to merge merged', 'ready-to-merge', ready({ pr: { state: 'merged' } }), ORCH, ok],
  ['12 done merged', 'done', ready({ pr: { state: 'merged' } }), ORCH, ok],
  [
    '13 qa executor holds',
    'qa',
    ready({ marks: reviewMarks }),
    disable(ORCH, 'external-review'),
    broken('qa', 'no_submit_on_head'),
  ],
  [
    '14 new head without a dev submit',
    'review',
    ready({ pr: { headSha: B }, marks: [submit('dev', A), mark('review', A)] }),
    ORCH,
    broken('dev', 'no_submit_on_head'),
  ],
  [
    '15 new head drops the review mark',
    'review',
    ready({ pr: { headSha: B }, marks: [submit('dev', B), mark('review', A)] }),
    ORCH,
    broken('review', 'no_review_on_head'),
  ],
  [
    '16 checks pending',
    'dev',
    ready({ pr: { requiredChecks: [check('pending')] } }),
    ORCH,
    broken('dev', 'checks_pending'),
  ],
  [
    '17 checks red',
    'dev',
    ready({ pr: { requiredChecks: [check('failure')] } }),
    ORCH,
    broken('dev', 'checks_red'),
  ],
  [
    '18 red checks break product review at dev',
    'product-review',
    ready({ marks: reviewMarks, pr: { requiredChecks: [check('failure')] } }),
    ORCH,
    broken('dev', 'checks_red'),
  ],
  [
    '19 conflict in dev',
    'dev',
    ready({ pr: { mergeable: 'conflicting' } }),
    ORCH,
    broken('dev', 'conflict'),
  ],
  [
    '20 conflict in review',
    'review',
    ready({ marks: [submit('dev', A), mark('review', A)], pr: { mergeable: 'conflicting' } }),
    ORCH,
    broken('dev', 'conflict'),
  ],
  [
    '21 conflict in ready to merge',
    'ready-to-merge',
    ready({ marks: [...reviewMarks, submit('qa', A)], pr: { mergeable: 'conflicting' } }),
    ORCH,
    broken('dev', 'conflict'),
  ],
  [
    '22 mergeability not computed',
    'dev',
    ready({ pr: { mergeable: 'unknown' } }),
    ORCH,
    broken('dev', 'mergeable_unknown'),
  ],
  [
    '23 external review waits for approval',
    'external-review',
    ready({ marks: reviewMarks }),
    ORCH,
    broken('external-review', 'not_approved'),
  ],
  [
    '24 external review approved',
    'external-review',
    ready({ marks: reviewMarks, externalReviewApproved: true }),
    ORCH,
    ok,
  ],
  [
    '25 external comments',
    'external-review',
    ready({ marks: reviewMarks, externalReviewApproved: true, unhandledExternalComments: 1 }),
    ORCH,
    broken('dev', 'external_comments'),
  ],
  [
    '26 new head after external review',
    'external-review',
    ready({
      pr: { headSha: B },
      marks: [submit('dev', B), mark('review', A), mark('product-review', A)],
      externalReviewApproved: true,
    }),
    ORCH,
    broken('review', 'no_review_on_head'),
  ],
  [
    '27 comment history incomplete',
    'dev',
    ready({ commentHistory: 'incomplete' }),
    ORCH,
    broken('dev', 'comment_history_incomplete'),
  ],
  ['28 draft', 'dev', ready({ pr: { draft: true } }), ORCH, broken('dev', 'pr_draft')],
  ['29 closed', 'review', ready({ pr: { state: 'closed' } }), ORCH, broken('dev', 'pr_closed')],
  ['30 merge from any column', 'review', ready({ pr: { state: 'merged' }, marks: [] }), ORCH, ok],
  ['31 re-entry on the same head', 'product-review', ready({ marks: reviewMarks }), ORCH, ok],
  [
    '32 re-entry on a new head',
    'product-review',
    ready({ pr: { headSha: B }, marks: reviewMarks }),
    ORCH,
    broken('dev', 'no_submit_on_head'),
  ],
  [
    '33 disabled review',
    'product-review',
    ready({ marks: [submit('dev', A), mark('product-review', A)] }),
    disable(ORCH, 'review'),
    ok,
  ],
  [
    '34 every dev failure',
    'dev',
    ready({
      pr: { draft: true, requiredChecks: [check('failure')], mergeable: 'conflicting' },
      unhandledExternalComments: 2,
      commentHistory: 'incomplete',
      marks: [],
    }),
    ORCH,
    broken(
      'dev',
      'pr_draft',
      'checks_red',
      'conflict',
      'external_comments',
      'comment_history_incomplete',
      'no_submit_on_head',
    ),
  ],
  [
    '35 qa executor passes',
    'qa',
    ready({ marks: [...reviewMarks, submit('qa', A)] }),
    disable(ORCH, 'external-review'),
    ok,
  ],
  [
    '36 conflict in product review',
    'product-review',
    ready({ marks: reviewMarks, pr: { mergeable: 'conflicting' } }),
    ORCH,
    broken('dev', 'conflict'),
  ],
  [
    '37 conflict in external review',
    'external-review',
    ready({ marks: reviewMarks, externalReviewApproved: true, pr: { mergeable: 'conflicting' } }),
    ORCH,
    broken('dev', 'conflict'),
  ],
  [
    '38 review mark on the new head',
    'review',
    ready({ pr: { headSha: B }, marks: [submit('dev', B), mark('review', B)] }),
    ORCH,
    ok,
  ],
  ['39 default board review', 'review', ready(), DEFAULT, ok],
  ['40 default board product review', 'product-review', ready(), DEFAULT, ok],
  ['41 default board qa', 'qa', ready({ externalReviewApproved: true }), DEFAULT, ok],
  [
    '42 default board holds at external review',
    'ready-to-merge',
    ready(),
    DEFAULT,
    broken('external-review', 'not_approved'),
  ],
  [
    '43 review orchestrator',
    'review',
    ready(),
    orchestrate(DEFAULT, 'review', 'conductor'),
    broken('review', 'no_review_on_head'),
  ],
  [
    '44 carry-over past an orchestrated column',
    'product-review',
    ready({ marks: [submit('dev', A), submit('review', A)] }),
    orchestrate(DEFAULT, 'review', 'conductor'),
    ok,
  ],
  [
    '45 operator executor holds',
    'qa',
    ready({ externalReviewApproved: true }),
    orchestrate(DEFAULT, 'qa', 'operator'),
    broken('qa', 'no_submit_on_head'),
  ],
  [
    '46 operator executor passes',
    'qa',
    ready({ externalReviewApproved: true, marks: [submit('dev', A), submit('qa', A)] }),
    orchestrate(DEFAULT, 'qa', 'operator'),
    ok,
  ],
  [
    '47 carry-over is head-bound',
    'review',
    ready({ pr: { headSha: B } }),
    DEFAULT,
    broken('dev', 'no_submit_on_head'),
  ],
  [
    '48 wait right of dev',
    'review',
    ready({ marks: [submit('dev', A), mark('review', A)], pr: { mergeable: 'unknown' } }),
    ORCH,
    broken('dev', 'mergeable_unknown'),
  ],
  [
    '49 wait mixed with a return',
    'review',
    ready({
      marks: [submit('dev', A), mark('review', A)],
      pr: { mergeable: 'unknown' },
      unhandledExternalComments: 1,
      commentHistory: 'incomplete',
    }),
    ORCH,
    broken('dev', 'mergeable_unknown', 'external_comments', 'comment_history_incomplete'),
  ],
  [
    '50 wait masks a break further right',
    'product-review',
    ready({
      pr: { headSha: B, requiredChecks: [check('pending')] },
      marks: [submit('dev', B), mark('review', A), mark('product-review', A)],
    }),
    ORCH,
    broken('dev', 'checks_pending'),
  ],
  [
    '51 pending checks mixed with a return',
    'review',
    ready({ pr: { requiredChecks: [check('pending')] }, marks: [] }),
    ORCH,
    broken('dev', 'checks_pending', 'no_submit_on_head'),
  ],
];

describe('evaluateGate', () => {
  it.each(gateCases)('%s', (_name, column, facts, board, expected) => {
    expect(gate(column, facts, board)).toEqual(expected);
  });

  it('keeps every column consistent with the leftmost broken one', () => {
    for (const [name, , facts, board] of gateCases) {
      if (facts.pr?.state === 'merged') continue;
      const before = structuredClone(facts);
      const last = gate('done', facts, board);
      const brokenAt = last.ok ? COLUMN_IDS.length : COLUMN_IDS.indexOf(last.column);
      COLUMN_IDS.forEach((column, i) => {
        expect(gate(column, facts, board), `${name} at ${column}`).toEqual(
          i < brokenAt ? ok : last,
        );
      });
      expect(facts, name).toEqual(before);
    }
  });
});

describe('check verdict', () => {
  const verdictOf: Record<(typeof CHECK_STATES)[number], Expected> = {
    success: ok,
    neutral: ok,
    expected: broken('dev', 'checks_pending'),
    pending: broken('dev', 'checks_pending'),
    skipped: broken('dev', 'checks_red'),
    failure: broken('dev', 'checks_red'),
    error: broken('dev', 'checks_red'),
    cancelled: broken('dev', 'checks_red'),
    timed_out: broken('dev', 'checks_red'),
    action_required: broken('dev', 'checks_red'),
    stale: broken('dev', 'checks_red'),
  };

  it.each(CHECK_STATES)('a required %s check', (state) => {
    expect(gate('dev', ready({ pr: { requiredChecks: [check(state)] } }), ORCH)).toEqual(
      verdictOf[state],
    );
  });

  it.each<[string, Check[], Check[], Expected]>([
    ['required checks win', [check('success')], [check('failure')], ok],
    ['all checks as the fallback', [], [check('failure')], broken('dev', 'checks_red')],
    ['no checks', [], [], broken('dev', 'checks_pending')],
    ['only skipped checks', [], [check('skipped')], broken('dev', 'checks_pending')],
    ['skipped dropped from the fallback', [], [check('success'), check('skipped', 'lint')], ok],
    [
      'a skipped required check',
      [check('skipped')],
      [check('success')],
      broken('dev', 'checks_red'),
    ],
    [
      'red wins over pending',
      [check('pending'), check('failure', 'lint')],
      [],
      broken('dev', 'checks_red'),
    ],
  ])('%s', (_name, requiredChecks, checks, expected) => {
    expect(gate('dev', ready({ pr: { requiredChecks, checks } }), ORCH)).toEqual(expected);
  });
});

const noChecks = { requiredChecks: [], checks: [] };
const waived = { checksWaivedBy: 'reposWithoutCi' } as const;
/** The reposWithoutCi marker cases, evaluated with `o/r` listed. */
const markerCases: [string, ColumnId, TaskGateFacts, Board, Expected][] = [
  ['(a) dev passes', 'dev', ready({ pr: noChecks }), ORCH, { ok: true, ...waived }],
  [
    '(b) broken right of dev',
    'review',
    ready({ pr: noChecks }),
    ORCH,
    { ...broken('review', 'no_review_on_head'), ...waived },
  ],
  [
    '(c1) broken at dev without a submit',
    'dev',
    ready({ pr: noChecks, marks: [] }),
    ORCH,
    { ...broken('dev', 'no_submit_on_head'), ...waived },
  ],
  [
    '(c2) broken at dev as a draft',
    'dev',
    ready({ pr: { ...noChecks, draft: true } }),
    ORCH,
    { ...broken('dev', 'pr_draft'), ...waived },
  ],
  ['(d) asked left of dev', 'ready-for-dev', ready({ pr: noChecks }), ORCH, ok],
  ['(e) merged', 'done', ready({ pr: { ...noChecks, state: 'merged' } }), ORCH, ok],
  [
    '(f) closed',
    'dev',
    ready({ pr: { ...noChecks, state: 'closed' } }),
    ORCH,
    broken('dev', 'pr_closed'),
  ],
  ['(g) no PR', 'dev', ready({ pr: null, marks: [] }), ORCH, broken('dev', 'no_pr')],
  [
    '(h) dev disabled',
    'review',
    ready({ pr: noChecks }),
    disable(ORCH, 'dev'),
    broken('review', 'no_review_on_head'),
  ],
];

describe('repositories without CI', () => {
  it.each<[string, readonly string[], Check[], Check[], Expected]>([
    ['no key, no checks', [], [], [], broken('dev', 'checks_pending')],
    ['key for another repo, no checks', ['o/other'], [], [], broken('dev', 'checks_pending')],
    ['key, no checks', ['o/r'], [], [], { ok: true, ...waived }],
    ['key in other case', ['O/R'], [], [], { ok: true, ...waived }],
    ['key, a red check', ['o/r'], [], [check('failure')], broken('dev', 'checks_red')],
    ['key, a pending check', ['o/r'], [], [check('pending')], broken('dev', 'checks_pending')],
    [
      'key, a required expected check',
      ['o/r'],
      [check('expected')],
      [check('expected')],
      broken('dev', 'checks_pending'),
    ],
    ['key, only skipped checks', ['o/r'], [], [check('skipped')], broken('dev', 'checks_pending')],
  ])('%s', (_name, reposWithoutCi, requiredChecks, checks, expected) => {
    expect(gate('dev', ready({ pr: { requiredChecks, checks } }), ORCH, reposWithoutCi)).toEqual(
      expected,
    );
  });

  it.each(markerCases)('marker %s', (_name, column, facts, board, expected) => {
    expect(gate(column, facts, board, ['o/r'])).toEqual(expected);
  });
});

describe('explainGates', () => {
  const explain = (facts: TaskGateFacts, board: Board, reposWithoutCi: readonly string[] = []) =>
    explainGates(facts, { columns: board, reposWithoutCi });
  const blockedIn = (expected: Expected) => (expected.ok ? null : expected.column);

  it('agrees with evaluateGate at every column for every gate case', () => {
    for (const [name, , facts, board] of gateCases) {
      const { gates, checksWaivedBy } = explain(facts, board);
      expect(gates.map((entry) => entry.column)).toEqual(COLUMN_IDS);
      for (const entry of gates) {
        expect(entry.blockedIn, `${name} at ${entry.column}`).toBe(
          blockedIn(gate(entry.column, facts, board)),
        );
        expect(entry.enabled).toBe(board.find((c) => c.id === entry.column)?.enabled === true);
      }
      expect(checksWaivedBy, name).toBe(gate('done', facts, board).checksWaivedBy ?? null);
    }
  });

  it("names each column's own failing and waiting conditions with their reasons", () => {
    const facts = ready({
      pr: { draft: true, requiredChecks: [check('pending')], mergeable: 'conflicting' },
      commentHistory: 'incomplete',
      unhandledExternalComments: 1,
      marks: [],
    });
    const [, , dev, review] = explain(facts, ORCH).gates;
    expect(dev).toEqual({
      column: 'dev',
      enabled: true,
      ok: false,
      blockedIn: 'dev',
      conditions: [
        { condition: 'pr_open', state: 'met', reason: null },
        { condition: 'not_draft', state: 'failed', reason: 'pr_draft' },
        { condition: 'checks_green', state: 'waiting', reason: 'checks_pending' },
        { condition: 'no_conflict', state: 'failed', reason: 'conflict' },
        {
          condition: 'external_comments_handled',
          state: 'failed',
          reason: 'external_comments',
        },
        {
          condition: 'comment_history_read',
          state: 'waiting',
          reason: 'comment_history_incomplete',
        },
        { condition: 'submit_on_head', state: 'failed', reason: 'no_submit_on_head' },
      ],
    });
    expect(review).toEqual({
      column: 'review',
      enabled: true,
      ok: false,
      blockedIn: 'dev',
      conditions: [{ condition: 'review_on_head', state: 'failed', reason: 'no_review_on_head' }],
    });
  });

  it('marks Dev conditions unchecked without a PR', () => {
    for (const [pr, reason] of [
      [null, 'no_pr'],
      [{ state: 'closed' }, 'pr_closed'],
    ] as const) {
      const dev = explain(ready({ pr, marks: [] }), ORCH).gates.find((g) => g.column === 'dev');
      expect(dev?.conditions).toEqual([
        { condition: 'pr_open', state: 'failed', reason },
        ...[
          'not_draft',
          'checks_green',
          'no_conflict',
          'external_comments_handled',
          'comment_history_read',
          'submit_on_head',
        ].map((condition) => ({ condition, state: 'unchecked', reason: null })),
      ]);
    }
  });

  it('passes every column with every condition met under a merged PR', () => {
    // No review mark and no approval: the raw column conditions would fail.
    const facts = ready({ pr: { state: 'merged', requiredChecks: [], checks: [] }, marks: [] });
    const { gates, checksWaivedBy } = explain(facts, ORCH, ['o/r']);
    expect(checksWaivedBy).toBeNull();
    expect(gates).toHaveLength(COLUMN_IDS.length);
    for (const entry of gates) {
      expect(entry).toMatchObject({ ok: true, blockedIn: null });
      for (const condition of entry.conditions)
        expect(condition).toMatchObject({ state: 'met', reason: null });
    }
    expect(gates.flatMap((entry) => entry.conditions).length).toBeGreaterThan(0);
  });

  it('names reposWithoutCi exactly where evaluateGate marks it', () => {
    for (const [name, , facts, board, expected] of markerCases) {
      const explained = explain(facts, board, ['o/r']);
      expect(explained.checksWaivedBy, name).toBe(
        evaluateGate('done', facts, { columns: board, reposWithoutCi: ['o/r'] }).checksWaivedBy ??
          null,
      );
      const dev = explained.gates.find((entry) => entry.column === 'dev');
      if (expected.checksWaivedBy !== undefined) {
        expect(explained.checksWaivedBy, name).toBe('reposWithoutCi');
        expect(dev?.conditions.find((c) => c.condition === 'checks_green')?.state, name).toBe(
          'met',
        );
      }
    }
  });
});

type CycleEvent = Parameters<typeof countCycles>[0][number];
type ReturnCause = Extract<CycleEvent, { kind: 'return' }>['causes'][number];

const ret = (column: ColumnId, ...causes: [ReturnCause, ...ReturnCause[]]): CycleEvent => ({
  kind: 'return',
  column,
  causes,
});
const reset = (column: ColumnId): CycleEvent => ({ kind: 'limit_reset', column });
const times = (n: number, event: CycleEvent): CycleEvent[] =>
  Array.from({ length: n }, () => event);

describe('countCycles', () => {
  it.each<[string, CycleEvent[], ColumnId, number, { count: number; limitReached: boolean }]>([
    [
      'an executor return',
      [ret('review', 'executor')],
      'review',
      10,
      { count: 1, limitReached: false },
    ],
    [
      'changes requested',
      [ret('review', 'changes_requested')],
      'review',
      10,
      { count: 1, limitReached: false },
    ],
    [
      'external comments',
      [ret('review', 'external_comments')],
      'review',
      10,
      { count: 1, limitReached: false },
    ],
    ['a conflict', [ret('review', 'conflict')], 'review', 10, { count: 0, limitReached: false }],
    ['red checks', [ret('review', 'checks_red')], 'review', 10, { count: 0, limitReached: false }],
    ['a draft', [ret('review', 'draft')], 'review', 10, { count: 0, limitReached: false }],
    [
      'a counted cause next to an uncounted one, once',
      [ret('review', 'conflict', 'external_comments')],
      'review',
      10,
      { count: 1, limitReached: false },
    ],
    [
      'another column',
      [ret('review', 'executor')],
      'product-review',
      10,
      { count: 0, limitReached: false },
    ],
    [
      'returns after the last reset',
      [
        ret('review', 'executor'),
        ret('review', 'executor'),
        reset('review'),
        ret('review', 'executor'),
      ],
      'review',
      10,
      { count: 1, limitReached: false },
    ],
    [
      'a reset of another column',
      [ret('review', 'executor'), reset('product-review'), ret('review', 'executor')],
      'review',
      10,
      { count: 2, limitReached: false },
    ],
    [
      'nine of ten',
      times(9, ret('review', 'executor')),
      'review',
      10,
      { count: 9, limitReached: false },
    ],
    [
      'ten of ten',
      times(10, ret('review', 'executor')),
      'review',
      10,
      { count: 10, limitReached: true },
    ],
    ['three of three', times(3, ret('qa', 'executor')), 'qa', 3, { count: 3, limitReached: true }],
  ])('%s', (_name, events, column, limit, expected) => {
    expect(countCycles(events, column, limit)).toEqual(expected);
  });
});
