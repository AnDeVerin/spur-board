import type { PrFacts, PrReviewRule, ReviewRule } from '@spur-board/contracts';
import { VERDICT, type TaskGateFacts } from './gates.ts';

/**
 * What one read of a PR head says about its base branch's review rule, in rule order, a draft
 * or a known conflict (`dev`) first:
 * - `checks_pending`: no required check has completed on the head (with none required, a
 *   non-skipped check pending or red, or only skipped ones), or, unless GitHub reports the merge
 *   not blocked, a required check is still pending (see `requiredCheckState`). On an unknown
 *   merge state this comes first.
 * - `unreadable`: the token could not read the base branch's rule (null).
 * - `unknown`: GitHub has not computed mergeability, or the merge state of a head it does not
 *   report conflicting.
 * - `dev`: a draft or a conflict, which Dev's own conditions handle.
 * - `changes_requested`: a reviewer asked for changes.
 * - `satisfied`: the merge is not blocked (clean, unstable or has hooks).
 * - `unresolved_threads`: the merge is blocked while review threads stay unresolved.
 * - `blocked`: the merge is blocked with every thread resolved.
 * - `undecided`: any other merge state, behind included.
 * Only `satisfied`, `unresolved_threads` and `blocked` are GitHub's answer (`ruleTransition`).
 */
export type ReviewRuleVerdict =
  | 'checks_pending'
  | 'unreadable'
  | 'unknown'
  | 'dev'
  | 'changes_requested'
  | 'satisfied'
  | 'unresolved_threads'
  | 'blocked'
  | 'undecided';

type RulePr = Pick<PrFacts, 'draft' | 'mergeable' | 'mergeState' | 'requiredChecks' | 'checks'>;

/**
 * The required checks on the head, the one reading the verdict, the gate and the clock share. A
 * check is required when GitHub marks it required on the head or a source of the rule lists its
 * context. Only a run GitHub marks required completes a check: GitHub checks the app a branch
 * protection or ruleset requires, which the rule read does not carry, so a run of a listed name
 * GitHub does not mark required (another app's) counts as absent.
 * - `none`: no required check has completed. When none is required (none marked, and no source
 *   lists one or the rule is unreadable), the Board's rule for no required checks applies instead,
 *   as for `checks_green`: every check except skipped ones green and at least one, or no checks at
 *   all on the head, gives `done`, anything else `none`.
 * - `pending`: a check GitHub marks required has completed while another required check is
 *   expected, pending, or a listed context has no completed run GitHub marks required (absent
 *   included).
 * - `done`: every required check has completed.
 */
export type RequiredCheckState = 'none' | 'pending' | 'done';

export function requiredCheckState(pr: RulePr, rule: ReviewRule | null): RequiredCheckState {
  const listed = rule?.requiredChecks ?? [];
  const running = (check: RulePr['checks'][number]) =>
    check.state === 'expected' || check.state === 'pending';
  if (pr.requiredChecks.length === 0 && listed.length === 0) {
    if (pr.checks.length === 0) return 'done';
    const optional = pr.checks.filter((check) => check.state !== 'skipped');
    return optional.length > 0 && optional.every((check) => VERDICT[check.state] === 'green')
      ? 'done'
      : 'none';
  }
  // Only a check GitHub marks required completes the rule, as the issue asks.
  if (pr.requiredChecks.every(running)) return 'none';
  const completed = (context: string) =>
    pr.requiredChecks.some((check) => check.name === context && !running(check));
  return pr.requiredChecks.some(running) || listed.some((context) => !completed(context))
    ? 'pending'
    : 'done';
}

/** The verdict of one read; see `ReviewRuleVerdict` for the order. */
export function reviewRuleVerdict(
  pr: RulePr,
  rule: ReviewRule | null,
  changesRequested: boolean,
  unresolvedThreads: number,
): ReviewRuleVerdict {
  const checks = requiredCheckState(pr, rule);
  // A known draft or conflict is Dev's even before GitHub computes the merge state.
  if (pr.draft || pr.mergeable === 'conflicting') return 'dev';
  if (pr.mergeable === 'unknown' || pr.mergeState === 'unknown')
    return checks !== 'done' ? 'checks_pending' : rule === null ? 'unreadable' : 'unknown';
  if (checks === 'none') return 'checks_pending';
  if (changesRequested) return 'changes_requested';
  // GitHub's own answer that the merge is not blocked wins over a check it does not wait for.
  if (
    rule !== null &&
    (pr.mergeState === 'clean' || pr.mergeState === 'unstable' || pr.mergeState === 'has_hooks')
  )
    return 'satisfied';
  // A required check still pending may be what holds the merge, so CI holds the head.
  if (checks === 'pending') return 'checks_pending';
  if (rule === null) return 'unreadable';
  if (pr.mergeState !== 'blocked') return 'undecided';
  return unresolvedThreads > 0 ? 'unresolved_threads' : 'blocked';
}

/** The decision a head keeps once GitHub has answered for it; null before. */
export type StoredDecision = 'satisfied' | 'blocked' | null;

/** One read of a head under its stored decision; see `ruleTransition`. */
export interface RuleTransition {
  /** The decision the project's own read stores for the head. */
  decision: StoredDecision;
  /** What External Review's review rule condition reads. */
  gate: NonNullable<TaskGateFacts['reviewRule']>['decision'];
  /** Whether the 30-minute clock runs. */
  clock: boolean;
}

/**
 * The one rule for a read of a head, given the decision stored for it:
 * - GitHub's answer (`satisfied`, or a block with the required checks completed: `blocked` and
 *   `unresolved_threads`) stores it, stops the clock, and the gate reads it over the stored
 *   decision as recorded: a block counts, a satisfied state only through a stored satisfied one
 *   (the project's own read stores it first; another project's read stores nothing), and over no
 *   stored decision the head stays undecided.
 * - Every other read keeps the stored decision and holds the head: a pending or missing required
 *   check as `checks_pending`, a rule the token could not read as `unreadable`, anything else as
 *   `undecided`. Draft, conflict and changes requested fail Dev's conditions or `approved`.
 * - The clock runs only while the head has no stored decision, the read is unknown, undecided or
 *   unreadable, and nobody is known to ask for changes (`requested`: a reviewer's latest review or
 *   GitHub's review verdict, also on an unknown merge state).
 */
export function ruleTransition(
  stored: StoredDecision,
  verdict: ReviewRuleVerdict,
  requested: boolean,
): RuleTransition {
  if (verdict === 'satisfied' || verdict === 'blocked' || verdict === 'unresolved_threads')
    return {
      decision: verdict === 'satisfied' ? 'satisfied' : 'blocked',
      gate: stored === null ? 'undecided' : verdict === 'satisfied' ? stored : verdict,
      clock: false,
    };
  return {
    decision: stored,
    gate: verdict === 'checks_pending' || verdict === 'unreadable' ? verdict : 'undecided',
    clock:
      stored === null &&
      !requested &&
      (verdict === 'unknown' || verdict === 'undecided' || verdict === 'unreadable'),
  };
}

/**
 * The latest reviews of external reviewers: not the agents' login, and not a login that wrote
 * bot feedback on the PR.
 */
export function externalReviews(pr: PrFacts, agentLogin: string): PrFacts['reviews'] {
  const external = (login: string) =>
    login.toLowerCase() !== agentLogin.toLowerCase() &&
    !(pr.feedback ?? []).some(
      (entry) =>
        entry.author?.type === 'bot' && entry.author.login.toLowerCase() === login.toLowerCase(),
    );
  return pr.reviews.filter((review) => external(review.reviewer));
}

/**
 * The pending review requests a required review can come from, named by login or team slug in
 * GitHub's request order; empty unless the rule was read, requires a code owner review or
 * approvals, and GitHub reads the merge blocked. Only users and teams count, never bots or a
 * request stored by an earlier version without a kind. A rule with no review requirement waits for
 * nobody, even for a code owner GitHub requested on its own: its block has another cause.
 */
export function awaitedReviewers(
  pr: Pick<PrFacts, 'mergeState' | 'reviewRequests'>,
  rule: ReviewRule | null,
): string[] {
  if (rule === null || pr.mergeState !== 'blocked') return [];
  if (!rule.codeOwners && (rule.approvals ?? 0) === 0) return [];
  return pr.reviewRequests.flatMap((request) =>
    (request.kind === 'user' || request.kind === 'team') && request.id !== undefined
      ? [request.id]
      : [],
  );
}

/**
 * Changes requested by GitHub's review verdict, or by an external reviewer's latest review. While
 * GitHub has not computed mergeability or the merge state, its verdict does not count, so the head
 * holds as on any unknown read instead of moving the task; a reviewer's latest review always counts, as
 * under any-approval.
 */
export function changesRequested(
  pr: PrFacts,
  reviewDecision: PrReviewRule['reviewDecision'],
  agentLogin: string,
): boolean {
  const unknown = pr.mergeable === 'unknown' || pr.mergeState === 'unknown';
  return (
    (reviewDecision === 'changes_requested' && !unknown) ||
    externalReviews(pr, agentLogin).some((review) => review.state === 'changes_requested')
  );
}
