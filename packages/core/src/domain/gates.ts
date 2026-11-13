import {
  assertNever,
  COLUMN_IDS,
  type CheckState,
  type ColumnId,
  type Config,
  type GateReason,
  type PrFacts,
} from '@spur-board/contracts';

/**
 * A submit or a mark, each bound to the head commit it was given on. A mark lasts for its head
 * whatever the visit; a submit lasts for one visit of its column.
 */
export type GateMark =
  | { kind: 'submit'; column: ColumnId; headSha: string }
  | { kind: 'mark'; column: 'review' | 'product-review'; headSha: string };

/** What the gates read about one task. */
export interface TaskGateFacts {
  /** The task's pull request, or null when it has none. */
  pr: Pick<
    PrFacts,
    'repo' | 'state' | 'draft' | 'mergeable' | 'headSha' | 'requiredChecks' | 'checks'
  > | null;
  /** Whether the external reviewers approved the pull request. */
  externalReviewApproved: boolean;
  /** Whether the external comment history was read to the end. */
  commentHistory: 'complete' | 'incomplete';
  /** External comments nobody has handled yet, external changes requested included. */
  unhandledExternalComments: number;
  /**
   * Submits and marks of the task, on any head. On a move left to a column, the caller drops the
   * submits of that column and of every column right of it, and passes the remaining submits and
   * every mark. Only those on the current head count.
   */
  marks: readonly GateMark[];
}

type GateColumn = Pick<
  Config['projects'][number]['columns'][number],
  'id' | 'enabled' | 'orchestrator'
>;

/** What the gates read about the task's project: its board and its repos without CI. */
export type GateProject = {
  columns: readonly GateColumn[];
  reposWithoutCi: readonly string[];
};

/**
 * The hold-only reasons: a fact is not known yet, and waiting resolves it. See `GateResult` for
 * the caller rule.
 */
export const HOLD_ONLY: ReadonlySet<GateReason> = new Set([
  'mergeable_unknown',
  'checks_pending',
  'comment_history_incomplete',
]);

/**
 * The gate result: ok, or the leftmost enabled column whose exit condition fails, with every
 * failing reason of that column.
 *
 * The caller rule: when `column` is the column asked for, the task waits there. When `column` is
 * left of it, the task returns there only if `reasons` holds a reason other than
 * `mergeable_unknown`, `checks_pending` or `comment_history_incomplete`; with only those, it waits
 * in its column. These three are hold-only: they mean a fact is not known yet (GitHub has not
 * computed mergeability, the checks on head have not finished, or the comment history was not
 * read to the end), and waiting resolves them.
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
const VERDICT = {
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
    (mark) => mark.kind === 'submit' && orchestratorOf(mark.column, columns) === 'none',
  );
}

function devReasons(
  facts: TaskGateFacts,
  columns: readonly GateColumn[],
  waived: boolean,
): GateReason[] {
  const { pr } = facts;
  if (pr === null) return ['no_pr'];
  if (pr.state === 'closed') return ['pr_closed'];
  const reasons: GateReason[] = [];
  if (pr.draft) reasons.push('pr_draft');
  const verdict = checksVerdict(pr, waived);
  if (verdict === 'red') reasons.push('checks_red');
  if (verdict === 'pending') reasons.push('checks_pending');
  if (pr.mergeable === 'conflicting') reasons.push('conflict');
  if (pr.mergeable === 'unknown') reasons.push('mergeable_unknown');
  if (facts.unhandledExternalComments > 0) reasons.push('external_comments');
  if (facts.commentHistory === 'incomplete') reasons.push('comment_history_incomplete');
  if (!executorDone('dev', facts, columns)) reasons.push('no_submit_on_head');
  return reasons;
}

/** The failing reasons of one column's exit condition; it does not depend on the column asked. */
function columnCondition(
  column: ColumnId,
  facts: TaskGateFacts,
  columns: readonly GateColumn[],
  waived: boolean,
): GateReason[] {
  switch (column) {
    case 'todo':
    case 'ready-for-dev':
    case 'done':
      return [];
    case 'dev':
      return devReasons(facts, columns, waived);
    case 'review':
    case 'product-review':
      return executorDone(column, facts, columns) ? [] : ['no_review_on_head'];
    case 'external-review':
      return facts.externalReviewApproved ? [] : ['not_approved'];
    case 'qa':
      return executorDone(column, facts, columns) ? [] : ['no_submit_on_head'];
    case 'ready-to-merge':
      return facts.pr?.state === 'merged' ? [] : ['not_merged'];
    default:
      return assertNever(column);
  }
}

/**
 * Evaluates the exit conditions of every enabled column from To Do up to and including `column`,
 * and returns the leftmost one that fails. A column absent from the project's columns or disabled
 * passes through. A merged pull request passes every column. Once Dev is evaluated with its check
 * condition passed by `reposWithoutCi`, the result carries `checksWaivedBy`.
 */
export function evaluateGate(
  column: ColumnId,
  facts: TaskGateFacts,
  project: GateProject,
): GateResult {
  if (facts.pr?.state === 'merged') return { ok: true };
  const waived = noCiWaives(facts.pr, project);
  let marker: { checksWaivedBy?: ChecksWaiver } = {};
  for (const id of COLUMN_IDS.slice(0, COLUMN_IDS.indexOf(column) + 1)) {
    if (project.columns.find((c) => c.id === id)?.enabled !== true) continue;
    if (id === 'dev' && waived) marker = { checksWaivedBy: 'reposWithoutCi' };
    const [first, ...rest] = columnCondition(id, facts, project.columns, waived);
    if (first !== undefined) return { ok: false, column: id, reasons: [first, ...rest], ...marker };
  }
  return { ok: true, ...marker };
}

export type ReturnCause =
  'executor' | 'changes_requested' | 'external_comments' | 'conflict' | 'checks_red' | 'draft';

/** A return counts toward the column's cycle limit when one of its causes counts. */
const COUNTED = {
  executor: true,
  changes_requested: true,
  external_comments: true,
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
