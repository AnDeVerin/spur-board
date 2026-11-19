import type { PrFacts, PrReviewRule, ReviewRule } from '@spur-board/contracts';
import { VERDICT } from './gates.ts';

/**
 * What one read of a PR head says about its base branch's review rule, in rule order:
 * - `keep`: GitHub has not computed mergeability or the merge state; the stored decision stands.
 * - `dev`: a draft or a conflict, which Dev's own conditions handle.
 * - `checks_pending`: no required check has completed on the head (with none required, a
 *   non-skipped check pending or red, or only skipped ones), or the merge is blocked while a
 *   required check is still running.
 * - `changes_requested`: a reviewer asked for changes.
 * - `satisfied`: the merge is not blocked (clean, unstable or has hooks).
 * - `unresolved_threads`: the merge is blocked while review threads stay unresolved.
 * - `blocked`: the merge is blocked with every thread resolved and every required check
 *   completed, so the rule itself holds it.
 * - `undecided`: any other merge state, behind included, or a rule the token could not read
 *   (null), on which the read decides nothing.
 */
export type ReviewRuleVerdict =
  | 'keep'
  | 'dev'
  | 'checks_pending'
  | 'changes_requested'
  | 'satisfied'
  | 'unresolved_threads'
  | 'blocked'
  | 'undecided';

type RulePr = Pick<PrFacts, 'draft' | 'mergeable' | 'mergeState' | 'requiredChecks' | 'checks'>;

/**
 * Whether a required check has completed on the head: a check GitHub marks required that is not
 * expected or pending. When none is required (none on the head, and no source of the rule lists
 * one or the rule is unreadable), the Board's rule for no required checks applies, as for
 * `checks_green`: every check except skipped ones is green and there is at least one, or the
 * head has no checks at all.
 */
export function requiredCheckCompleted(pr: RulePr, rule: ReviewRule | null): boolean {
  if (pr.requiredChecks.length > 0)
    return pr.requiredChecks.some(
      (check) => check.state !== 'expected' && check.state !== 'pending',
    );
  if (rule !== null && rule.requiredChecks.length > 0) return false;
  if (pr.checks.length === 0) return true;
  const optional = pr.checks.filter((check) => check.state !== 'skipped');
  return optional.length > 0 && optional.every((check) => VERDICT[check.state] === 'green');
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
  if (!requiredCheckCompleted(pr, rule)) return 'checks_pending';
  if (changesRequested) return 'changes_requested';
  if (rule === null) return 'undecided';
  if (pr.mergeState === 'clean' || pr.mergeState === 'unstable' || pr.mergeState === 'has_hooks')
    return 'satisfied';
  if (pr.mergeState !== 'blocked') return 'undecided';
  if (unresolvedThreads > 0) return 'unresolved_threads';
  // A required check still running may be what blocks the merge, so CI holds the head.
  return pr.requiredChecks.some((check) => check.state === 'expected' || check.state === 'pending')
    ? 'checks_pending'
    : 'blocked';
}

/**
 * Whether the verdict runs the 30-minute clock: GitHub's answer names nobody to act. For `keep`
 * the caller also requires a completed required check and no changes requested.
 */
export function onClock(verdict: ReviewRuleVerdict): boolean {
  return verdict === 'keep' || verdict === 'unresolved_threads' || verdict === 'undecided';
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

/** Changes requested by GitHub's review verdict, or by an external reviewer's latest review. */
export function changesRequested(
  pr: PrFacts,
  reviewDecision: PrReviewRule['reviewDecision'],
  agentLogin: string,
): boolean {
  return (
    reviewDecision === 'changes_requested' ||
    externalReviews(pr, agentLogin).some((review) => review.state === 'changes_requested')
  );
}
