import {
  COLUMN_IDS,
  approvalRuleOf,
  isTodoGroupColumn,
  type CheckGateColumn,
  type CheckState,
  type ColumnId,
  type Config,
  type GateCondition,
  type GateConditionState,
  type GateReason,
  type MarkColumnId,
  type PrFacts,
  type TodoGroupColumnId,
} from '@spur-board/contracts';

/**
 * A submit or a mark, each bound to the head commit it was given on. A mark lasts whatever the
 * visit while its head stays the PR's head (a new head voids it). QA submits also survive visits
 * until a new head or explicit correction into QA; other submits last for one column visit.
 */
export type GateMark =
  | { kind: 'submit'; column: ColumnId; headSha: string }
  | { kind: 'mark'; column: MarkColumnId; headSha: string };

/** What the gates read about one task. */
export interface TaskGateFacts {
  /** The task's pull request, or null when it has none. */
  pr: Pick<
    PrFacts,
    'repo' | 'state' | 'draft' | 'mergeable' | 'headSha' | 'requiredChecks' | 'checks'
  > | null;
  /** Whether the external reviewers approved the pull request. */
  externalReviewApproved: boolean;
  /**
   * What External Review reads under `approvalRule: github-rules`, absent otherwise: an external
   * approval, changes requested by a reviewer or by GitHub's review verdict, and the review rule
   * decision on the current head (`undecided` when GitHub has not given one).
   */
  reviewRule?: {
    approved: boolean;
    changesRequested: boolean;
    decision: 'satisfied' | 'blocked' | 'checks_pending' | 'unresolved_threads' | 'undecided';
  };
  /** Whether the external comment history was read to the end. */
  commentHistory: 'complete' | 'incomplete';
  /** External comments nobody has handled yet, external changes requested included. */
  unhandledExternalComments: number;
  /** Unresolved review threads on the pull request, outdated ones included; 0 without one. */
  unresolvedThreads: number;
  /**
   * Submits and marks of the task, on any head. On a move left to a column, the caller drops the
   * visit submits of that column and of every column right of it, preserving QA submits and
   * every mark. Only those on the current head count.
   */
  marks: readonly GateMark[];
}

type GateColumn = Pick<
  Config['projects'][number]['columns'][number],
  'id' | 'enabled' | 'orchestrator' | 'requireResolvedThreads' | 'approvalRule'
>;

/**
 * What the gates read about the task's project: its board, its repos without CI and the column
 * whose exit requires green checks.
 */
export type GateProject = {
  columns: readonly GateColumn[];
  reposWithoutCi: readonly string[];
  checksGate: CheckGateColumn;
};

/**
 * The hold-only reasons: a fact is not known yet, and waiting resolves it. See `GateResult` for
 * the caller rule.
 */
const HOLD_ONLY_REASONS = [
  'mergeable_unknown',
  'checks_pending',
  'comment_history_incomplete',
  'merge_state_unknown',
] as const satisfies readonly GateReason[];

/** A gate reason that holds dispatch without failing the gate. */
export type HoldOnlyReason = (typeof HOLD_ONLY_REASONS)[number];

export const HOLD_ONLY: ReadonlySet<GateReason> = new Set(HOLD_ONLY_REASONS);

/**
 * The gate result: ok, or the leftmost enabled column whose exit condition fails, with every
 * failing reason of that column.
 *
 * The caller rule: when `column` is the column asked for, the task waits there. When `column` is
 * left of it, the task returns there only if `reasons` holds a reason other than
 * `mergeable_unknown`, `checks_pending`, `comment_history_incomplete` or `merge_state_unknown`;
 * with only those, it waits in its column. These four are hold-only: they mean a fact is not known
 * yet (GitHub has not computed mergeability, the checks on head have not finished, the comment
 * history was not read to the end, or GitHub has not decided its review rule on the head), and
 * waiting resolves them.
 *
 * `checksWaivedBy` names the config key that passed Dev's check condition: it is present exactly
 * when Dev was evaluated and its check condition passed only because the PR's repo is in
 * `reposWithoutCi` and its head has no checks. It never changes `ok`, `column` or `reasons`.
 */
type GateResult =
  | { ok: true; checksWaivedBy?: ChecksWaiver }
  | {
      ok: false;
      column: ColumnId;
      reasons: readonly [GateReason, ...GateReason[]];
      checksWaivedBy?: ChecksWaiver;
    };

type ChecksWaiver = Extract<keyof Config['projects'][number], 'reposWithoutCi'>;

type Verdict = 'green' | 'pending' | 'red';

/** Neutral passes like success. Skipped is red: a skipped required check reports no more. */
export const VERDICT = {
  success: 'green',
  neutral: 'green',
  expected: 'pending',
  pending: 'pending',
  skipped: 'red',
  failure: 'red',
  error: 'red',
  cancelled: 'red',
  timed_out: 'red',
  action_required: 'red',
  stale: 'red',
} as const satisfies Record<CheckState, Verdict>;

/**
 * Whether `reposWithoutCi` passes Dev's check condition: the PR is open, its repo is listed in any
 * letter case, and its head has no checks at all. A list of only skipped checks does not count.
 */
function noCiWaives(pr: TaskGateFacts['pr'], project: GateProject): boolean {
  if (pr === null || pr.state !== 'open') return false;
  if (pr.checks.length > 0 || pr.requiredChecks.length > 0) return false;
  const repo = pr.repo.toLowerCase();
  return project.reposWithoutCi.some((listed) => listed.toLowerCase() === repo);
}

/**
 * The verdict over the required checks on head, or, when none is required, over every check on
 * head except skipped ones. No check gives pending, and red wins over pending. `waived` (from
 * `noCiWaives`, so the head has no checks) gives green.
 */
function checksVerdict(pr: NonNullable<TaskGateFacts['pr']>, waived: boolean): Verdict {
  if (waived) return 'green';
  const list =
    pr.requiredChecks.length > 0
      ? pr.requiredChecks
      : pr.checks.filter((check) => check.state !== 'skipped');
  const verdicts = list.map((check) => VERDICT[check.state]);
  if (verdicts.includes('red')) return 'red';
  if (verdicts.length === 0 || verdicts.includes('pending')) return 'pending';
  return 'green';
}

function orchestratorOf(column: ColumnId, columns: readonly GateColumn[]): string | undefined {
  return columns.find((c) => c.id === column)?.orchestrator;
}

/**
 * Whether the column's executor is done on the current head: a submit or mark in the column is on
 * head. A column without an orchestrator is executed by the worker, so any worker submit on head
 * (a submit in a column without an orchestrator) also counts there.
 */
function executorDone(
  column: ColumnId,
  facts: TaskGateFacts,
  columns: readonly GateColumn[],
): boolean {
  const head = facts.pr?.headSha;
  if (head === undefined) return false;
  const onHead = facts.marks.filter((mark) => mark.headSha === head);
  if (onHead.some((mark) => mark.column === column)) return true;
  if (orchestratorOf(column, columns) !== 'none') return false;
  return onHead.some(
    (mark) =>
      mark.kind === 'submit' &&
      !(column === 'dev' && mark.column === 'qa') &&
      orchestratorOf(mark.column, columns) === 'none',
  );
}

/**
 * The leftmost enabled column that requires resolved threads: `requireResolvedThreads`, by default
 * true on Ready to Merge only. Undefined when no enabled column requires them.
 */
export function threadsFrom(project: GateProject): ColumnId | undefined {
  return project.columns.find(
    (c) => c.enabled && (c.requireResolvedThreads ?? c.id === 'ready-to-merge'),
  )?.id;
}

/** Whether any enabled column of the project requires resolved review threads. */
export function threadsGated(project: GateProject): boolean {
  return threadsFrom(project) !== undefined;
}

/**
 * Dev's failing reasons. `threads` adds the resolved-threads condition: it holds for the gate of
 * every column at or right of the leftmost column requiring resolved threads. Red checks fail Dev
 * whatever `checksGate` is; pending checks hold Dev only when `checksGate` is Dev.
 */
function devReasons(
  facts: TaskGateFacts,
  project: GateProject,
  waived: boolean,
  threads: boolean,
): GateReason[] {
  const opening = CONDITION_DEFINITIONS.pr_open.reasons(facts, project, 'dev', waived);
  if (opening.length > 0) return opening;
  return columnConditions('dev', project).flatMap((id) =>
    id === 'threads_resolved' && !threads
      ? []
      : CONDITION_DEFINITIONS[id].reasons(facts, project, 'dev', waived),
  );
}

/**
 * The check reasons of a `checksGate` column right of Dev: red or pending checks on the open PR's
 * head. Dev already fails on red, so in a cumulative gate only pending reaches this column.
 */
function gateCheckReasons(facts: TaskGateFacts, waived: boolean): GateReason[] {
  const { pr } = facts;
  if (pr === null || pr.state !== 'open') return [];
  const verdict = checksVerdict(pr, waived);
  return verdict === 'red' ? ['checks_red'] : verdict === 'pending' ? ['checks_pending'] : [];
}

/**
 * The failing reasons of one column's exit condition. Only Dev's resolved-threads condition depends
 * on the column asked: `threads` says whether it counts. A `gate_broken` move re-evaluates at Dev,
 * where that condition may not count, so a reason or hand-over that must survive it keys on the
 * facts and `threadsGated(project)` (`withThreads`, `turnThreads`), and `explainGates` takes
 * `blockedIn` from `evaluateGate`.
 */
function columnCondition(
  column: ColumnId,
  facts: TaskGateFacts,
  project: GateProject,
  waived: boolean,
  threads: boolean,
): GateReason[] {
  if (column === 'dev') return devReasons(facts, project, waived, threads);
  if (isTodoGroupColumn(column)) return [];
  // Under github-rules a pending required check can fail both checks green and the review rule.
  return [
    ...new Set(
      columnConditions(column, project).flatMap((id) =>
        CONDITION_DEFINITIONS[id].reasons(facts, project, column, waived),
      ),
    ),
  ];
}

interface ConditionDefinition {
  text: string;
  reasons(
    facts: TaskGateFacts,
    project: GateProject,
    column: ColumnId,
    waived: boolean,
  ): GateReason[];
}

/** The positive rule and its predicate have one owner for evaluation and policy reads. */
const CONDITION_DEFINITIONS: Record<GateCondition, ConditionDefinition> = {
  pr_open: {
    text: 'An open pull request is linked.',
    reasons: ({ pr }) => (pr === null ? ['no_pr'] : pr.state === 'closed' ? ['pr_closed'] : []),
  },
  not_draft: {
    text: 'The pull request is not a draft.',
    reasons: ({ pr }) => (pr?.draft ? ['pr_draft'] : []),
  },
  checks_green: {
    text: 'Required checks, or all non-skipped checks when none are required, are green. For an open PR, reposWithoutCi additionally waives absent checks only when there are no checks and no required checks.',
    reasons: (facts, _project, _column, waived) => gateCheckReasons(facts, waived),
  },
  checks_not_red: {
    text: 'Checks are not red; pending checks may continue until checksGate. reposWithoutCi never waives failed, pending or required checks.',
    reasons: ({ pr }, _project, _column, waived) =>
      pr !== null && checksVerdict(pr, waived) === 'red' ? ['checks_red'] : [],
  },
  no_conflict: {
    text: 'GitHub has computed mergeability and reports no conflict.',
    reasons: ({ pr }) =>
      pr?.mergeable === 'conflicting'
        ? ['conflict']
        : pr?.mergeable === 'unknown'
          ? ['mergeable_unknown']
          : [],
  },
  external_comments_handled: {
    text: 'External feedback, including changes requested, has been handled.',
    reasons: (facts) => (facts.unhandledExternalComments > 0 ? ['external_comments'] : []),
  },
  comment_history_read: {
    text: 'The external comment history has been read to the end.',
    reasons: (facts) =>
      facts.commentHistory === 'incomplete' ? ['comment_history_incomplete'] : [],
  },
  threads_resolved: {
    text: 'Every review thread is resolved, including outdated threads regardless of author.',
    reasons: (facts) => (facts.unresolvedThreads > 0 ? ['unresolved_threads'] : []),
  },
  submit_on_head: {
    text: 'The executor has submitted on the current PR head. Worker submits can satisfy other unbound worker stages; a QA submit does not satisfy Dev.',
    reasons: (facts, project, column) =>
      executorDone(column, facts, project.columns) ? [] : ['no_submit_on_head'],
  },
  review_on_head: {
    text: 'The executor has reviewed or submitted on the current PR head.',
    reasons: (facts, project, column) =>
      executorDone(column, facts, project.columns) ? [] : ['no_review_on_head'],
  },
  approved: {
    text: 'Approved by an external reviewer.',
    reasons: ({ externalReviewApproved, reviewRule }) =>
      reviewRule?.changesRequested === true
        ? ['changes_requested']
        : (reviewRule?.approved ?? externalReviewApproved)
          ? []
          : ['not_approved'],
  },
  review_rule_satisfied: {
    text: "GitHub's review rule for the base branch, from branch protection and rulesets, is satisfied on the current PR head: a required check completed, or, when none is required, every check except skipped ones green and at least one (no checks at all also counts); no changes requested; and the merge not blocked. A required check, one GitHub marks required or a context the rule lists, that is pending or missing holds the head on CI unless the merge state is clean, unstable or has hooks.",
    reasons: ({ reviewRule }) =>
      reviewRule === undefined || reviewRule.changesRequested
        ? []
        : [...RULE_REASONS[reviewRule.decision]],
  },
  merged: {
    text: 'The pull request is merged.',
    reasons: (facts) => (facts.pr?.state === 'merged' ? [] : ['not_merged']),
  },
};

/** The review rule reason of each decision; changes requested fails `approved` instead. */
const RULE_REASONS = {
  satisfied: [],
  blocked: ['review_rule_blocked'],
  checks_pending: ['checks_pending'],
  unresolved_threads: ['unresolved_threads'],
  undecided: ['merge_state_unknown'],
} as const satisfies Record<
  NonNullable<TaskGateFacts['reviewRule']>['decision'],
  readonly GateReason[]
>;

/** Effective ownership differs from legacy task explanations: thread failures still name Dev. */
export function describeConditions(
  column: ColumnId,
  project: GateProject,
): { id: GateCondition | 'work_started'; text: string }[] {
  if (isTodoGroupColumn(column))
    return [
      {
        id: 'work_started',
        text: 'Work has started: an open PR, or a live worker with a fresh, non-blind Spur source and no reopened ticket. A reopened ticket needs an open PR. Source readiness and holds still apply; no executor turn opens in the Todo group.',
      },
    ];
  const from = threadsFrom(project);
  const ids = columnConditions(column, project).filter(
    (id) => id !== 'threads_resolved' || from === column,
  );
  if (from === column && column !== 'dev') {
    const checks = ids[0] === 'checks_green' ? 1 : 0;
    ids.splice(checks, 0, 'threads_resolved');
  }
  return ids.map((id) => ({ id, text: CONDITION_DEFINITIONS[id].text }));
}

/**
 * Evaluates the exit conditions of every enabled column from To Do up to and including `column`,
 * and returns the leftmost one that fails. A column absent from the project's columns or disabled
 * passes through. A merged pull request passes every column. Dev's resolved-threads condition
 * counts when `column` is at or right of the leftmost enabled column requiring resolved threads.
 * Once Dev is evaluated with its check condition passed by `reposWithoutCi`, the result carries
 * `checksWaivedBy`.
 */
export function evaluateGate(
  column: ColumnId,
  facts: TaskGateFacts,
  project: GateProject,
): GateResult {
  if (facts.pr?.state === 'merged') return { ok: true };
  const waived = noCiWaives(facts.pr, project);
  const from = threadsFrom(project);
  const threads = from !== undefined && COLUMN_IDS.indexOf(from) <= COLUMN_IDS.indexOf(column);
  let marker: { checksWaivedBy?: ChecksWaiver } = {};
  for (const id of COLUMN_IDS.slice(0, COLUMN_IDS.indexOf(column) + 1)) {
    if (project.columns.find((c) => c.id === id)?.enabled !== true) continue;
    if (id === 'dev' && waived) marker = { checksWaivedBy: 'reposWithoutCi' };
    const [first, ...rest] = columnCondition(id, facts, project, waived, threads);
    if (first !== undefined) return { ok: false, column: id, reasons: [first, ...rest], ...marker };
  }
  return { ok: true, ...marker };
}

/**
 * The exit conditions of each column outside the Todo group, which has none, in the order the
 * gates report their reasons, with checks green at Dev.
 */
const COLUMN_CONDITIONS = {
  dev: [
    'pr_open',
    'not_draft',
    'checks_green',
    'no_conflict',
    'external_comments_handled',
    'comment_history_read',
    'threads_resolved',
    'submit_on_head',
  ],
  review: ['review_on_head'],
  'product-review': ['review_on_head'],
  'external-review': ['approved'],
  qa: ['submit_on_head'],
  'ready-to-merge': ['merged'],
  done: [],
} as const satisfies Record<Exclude<ColumnId, TodoGroupColumnId>, readonly GateCondition[]>;

/**
 * The exit conditions of `column` in `project`: with a `checksGate` right of Dev, Dev requires
 * checks not red, and the gate column requires checks green before its own conditions. Under
 * `approvalRule: github-rules`, External Review also requires the review rule satisfied.
 */
function columnConditions(
  column: Exclude<ColumnId, TodoGroupColumnId>,
  project: GateProject,
): readonly GateCondition[] {
  const conditions = checkConditions(column, project.checksGate);
  return column === 'external-review' && approvalRuleOf(project) === 'github-rules'
    ? [...conditions, 'review_rule_satisfied']
    : conditions;
}

function checkConditions(
  column: Exclude<ColumnId, TodoGroupColumnId>,
  checksGate: CheckGateColumn,
): readonly GateCondition[] {
  if (checksGate === 'dev') return COLUMN_CONDITIONS[column];
  if (column === 'dev')
    return COLUMN_CONDITIONS.dev.map((condition) =>
      condition === 'checks_green' ? 'checks_not_red' : condition,
    );
  if (column === checksGate) return ['checks_green', ...COLUMN_CONDITIONS[column]];
  return COLUMN_CONDITIONS[column];
}

/**
 * The condition a gate reason fails in `column`: with a gate right of Dev, red checks fail Dev's
 * checks not red, and every other check reason fails checks green. External Review under
 * github-rules reads each condition's own reasons instead (`explainGates`).
 */
function conditionOf(
  reason: GateReason,
  column: ColumnId,
  checksGate: CheckGateColumn,
): GateCondition {
  if (reason === 'checks_red' && column === 'dev' && checksGate !== 'dev') return 'checks_not_red';
  return CONDITION_OF[reason];
}

/** The condition each gate reason fails, with checks green at Dev. */
const CONDITION_OF = {
  no_pr: 'pr_open',
  pr_closed: 'pr_open',
  pr_draft: 'not_draft',
  checks_red: 'checks_green',
  checks_pending: 'checks_green',
  conflict: 'no_conflict',
  mergeable_unknown: 'no_conflict',
  external_comments: 'external_comments_handled',
  comment_history_incomplete: 'comment_history_read',
  unresolved_threads: 'threads_resolved',
  no_submit_on_head: 'submit_on_head',
  no_review_on_head: 'review_on_head',
  not_approved: 'approved',
  changes_requested: 'approved',
  review_rule_blocked: 'review_rule_satisfied',
  merge_state_unknown: 'review_rule_satisfied',
  not_merged: 'merged',
} as const satisfies Record<GateReason, GateCondition>;

/** Reasons that stop Dev's evaluation: the rest of its conditions are not checked. */
const STOPS_DEV: ReadonlySet<GateReason> = new Set(['no_pr', 'pr_closed']);

interface ConditionExplanation {
  condition: GateCondition;
  state: GateConditionState;
  reason: GateReason | null;
}

interface GateExplanation {
  column: ColumnId;
  enabled: boolean;
  /** Whether the column's own exit conditions pass. */
  ok: boolean;
  /** The column `evaluateGate(column)` fails at, or null when it passes. */
  blockedIn: ColumnId | null;
  conditions: ConditionExplanation[];
}

/**
 * Every column's own exit conditions with their state, and where its cumulative gate blocks, as
 * `evaluateGate` decides it for each column. Dev's own conditions count resolved threads once any
 * enabled column requires them. A merged pull request passes every column and every condition.
 * `checksWaivedBy` is the marker `evaluateGate('done')` carries, or null.
 */
export function explainGates(
  facts: TaskGateFacts,
  project: GateProject,
): { gates: GateExplanation[]; checksWaivedBy: ChecksWaiver | null } {
  const merged = facts.pr?.state === 'merged';
  const waived = noCiWaives(facts.pr, project);
  const threads = threadsGated(project);
  let checksWaivedBy: ChecksWaiver | null = null;
  const gates = COLUMN_IDS.map((column): GateExplanation => {
    const enabled = project.columns.find((c) => c.id === column)?.enabled === true;
    const reasons = merged ? [] : columnCondition(column, facts, project, waived, threads);
    if (enabled && !merged && column === 'dev' && waived) checksWaivedBy = 'reposWithoutCi';
    const gate = evaluateGate(column, facts, project);
    const blockedIn = gate.ok ? null : gate.column;
    const stopped = reasons.some((reason) => STOPS_DEV.has(reason));
    const own = isTodoGroupColumn(column) ? [] : columnConditions(column, project);
    // Under github-rules External Review's conditions can share a pending check: each shows the
    // reasons its own rule gives, so a required check only the review rule waits for shows there.
    const direct = own.includes('review_rule_satisfied');
    const conditions = own.map((condition): ConditionExplanation => {
      const mine = direct
        ? CONDITION_DEFINITIONS[condition].reasons(facts, project, column, waived)
        : [];
      const reason =
        reasons.find((r) =>
          direct ? mine.includes(r) : conditionOf(r, column, project.checksGate) === condition,
        ) ?? null;
      if (reason === null) return { condition, state: stopped ? 'unchecked' : 'met', reason: null };
      return { condition, state: HOLD_ONLY.has(reason) ? 'waiting' : 'failed', reason };
    });
    return { column, enabled, ok: reasons.length === 0, blockedIn, conditions };
  });
  return { gates, checksWaivedBy };
}

export type ReturnCause =
  | 'executor'
  | 'changes_requested'
  | 'external_comments'
  | 'unresolved_threads'
  | 'conflict'
  | 'checks_red'
  | 'draft';

/** A return counts toward the column's cycle limit when one of its causes counts. */
const COUNTED = {
  executor: true,
  changes_requested: true,
  external_comments: true,
  unresolved_threads: true,
  conflict: false,
  checks_red: false,
  draft: false,
} as const satisfies Record<ReturnCause, boolean>;

/**
 * A task's return to Dev from `column`, with its causes, or the operator resetting the cycle
 * count of `column`.
 */
export type CycleEvent =
  | { kind: 'return'; column: ColumnId; causes: readonly [ReturnCause, ...ReturnCause[]] }
  | { kind: 'limit_reset'; column: ColumnId };

/**
 * Counts the returns from `column` since its last limit reset, once per return with a counted
 * cause. `events` are in the order they happened.
 */
export function countCycles(
  events: readonly CycleEvent[],
  column: ColumnId,
  limit: number,
): { count: number; limitReached: boolean } {
  let count = 0;
  for (const event of events) {
    if (event.column !== column) continue;
    if (event.kind === 'limit_reset') count = 0;
    else if (event.causes.some((cause) => COUNTED[cause])) count += 1;
  }
  return { count, limitReached: count >= limit };
}
