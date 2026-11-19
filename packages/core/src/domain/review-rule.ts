import type { PrFacts, PrReviewRule, ReviewRule } from '@spur-board/contracts';
import { VERDICT, type TaskGateFacts } from './gates.ts';

/**
 * What one read of a PR head says about its base branch's review rule, in rule order:
 * - `keep`: GitHub has not computed mergeability or the merge state; the stored decision stands,
 *   even under a rule the token could not read, which the gate still reports (`ruleDecision`).
 * - `dev`: a draft or a conflict, which Dev's own conditions handle.
 * - `checks_pending`: no required check has completed on the head (with none required, a
 *   non-skipped check pending or red, or only skipped ones), or, unless GitHub reports the merge
 *   not blocked, a required check is still pending (see `requiredCheckState`).
 * - `changes_requested`: a reviewer asked for changes.
 * - `satisfied`: the merge is not blocked (clean, unstable or has hooks).
 * - `unresolved_threads`: the merge is blocked while review threads stay unresolved.
 * - `blocked`: the merge is blocked with every thread resolved and every required check
 *   completed, so the rule itself holds it.
 * - `unreadable`: the token could not read the base branch's rule (null), so the read decides
 *   nothing.
 * - `undecided`: any other merge state, behind included, on which the read decides nothing.
 */
export type ReviewRuleVerdict =
  | 'keep'
  | 'dev'
  | 'checks_pending'
  | 'changes_requested'
  | 'satisfied'
  | 'unresolved_threads'
  | 'blocked'
  | 'unreadable'
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
  if (pr.mergeable === 'unknown' || pr.mergeState === 'unknown') return 'keep';
  if (pr.draft || pr.mergeable === 'conflicting') return 'dev';
  const checks = requiredCheckState(pr, rule);
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

type ReviewRuleDecision = NonNullable<TaskGateFacts['reviewRule']>['decision'];

/**
 * What the gate reads from one read's verdict and the head's stored decision. While the merge
 * state is unknown the stored decision does not count: the head waits on a pending required check,
 * on a base branch rule the token could not read (`readable` false), or on GitHub. A read's block
 * overrides a stored satisfied decision; a read's satisfied state or block never replaces a
 * missing one. Dev's own conditions and `approved` own `dev` and `changes_requested`.
 */
export function ruleDecision(
  verdict: ReviewRuleVerdict,
  checks: RequiredCheckState,
  stored: 'satisfied' | 'blocked' | null,
  readable: boolean,
): ReviewRuleDecision {
  if (verdict === 'keep')
    return checks !== 'done' ? 'checks_pending' : readable ? 'undecided' : 'unreadable';
  if (
    verdict === 'checks_pending' ||
    verdict === 'unresolved_threads' ||
    verdict === 'unreadable' ||
    verdict === 'undecided'
  )
    return verdict;
  if (verdict === 'dev' || verdict === 'changes_requested' || stored === null) return 'undecided';
  return verdict === 'blocked' ? 'blocked' : stored;
}

/**
 * Whether the head waits on GitHub alone, which the 30-minute item reports: no changes requested
 * and the gate reads `undecided`, a rule the token could not read, or unresolved threads under a
 * blocked merge.
 */
export function waitsOnGitHub(gate: {
  changesRequested: boolean;
  decision: ReviewRuleDecision;
}): boolean {
  return (
    !gate.changesRequested &&
    (gate.decision === 'undecided' ||
      gate.decision === 'unreadable' ||
      gate.decision === 'unresolved_threads')
  );
}

/** The decision a read stores for its head: its own satisfied or blocked, else none; `keep` keeps `old`. */
export function storedDecision(
  verdict: ReviewRuleVerdict,
  old: 'satisfied' | 'blocked' | null,
): 'satisfied' | 'blocked' | null {
  if (verdict === 'keep') return old;
  return verdict === 'satisfied' || verdict === 'blocked' ? verdict : null;
}

/**
 * Whether one read of a head runs the 30-minute clock: the head has no stored decision, the read
 * is not Dev's, and the gate reads it as waiting on GitHub alone. A rule the token could not read
 * and an undecided answer both wait on GitHub, so the rule's readability does not change it.
 */
export function onClock(
  verdict: ReviewRuleVerdict,
  checks: RequiredCheckState,
  stored: 'satisfied' | 'blocked' | null,
  changesRequested: boolean,
): boolean {
  return (
    stored === null &&
    verdict !== 'dev' &&
    waitsOnGitHub({ changesRequested, decision: ruleDecision(verdict, checks, stored, true) })
  );
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
 * Changes requested by GitHub's review verdict, or by an external reviewer's latest review. While
 * GitHub has not computed mergeability or the merge state, its verdict does not count, so it holds
 * the head as `keep` does instead of moving the task; a reviewer's latest review always counts, as
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
