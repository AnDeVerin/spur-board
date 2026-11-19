import type { PrFacts, PrReviewRule, ReviewRule } from '@spur-board/contracts';

/**
 * What one read of a PR head says about its base branch's review rule, in rule order:
 * - `keep`: GitHub has not computed mergeability or the merge state; the stored decision stands.
 * - `dev`: a draft or a conflict, which Dev's own conditions handle.
 * - `checks_pending`: no required check has completed on the head.
 * - `changes_requested`: a reviewer asked for changes.
 * - `satisfied`: the merge is not blocked (clean, unstable or has hooks).
 * - `unresolved_threads`: the merge is blocked while review threads stay unresolved.
 * - `blocked`: the merge is blocked with every thread resolved, so the rule itself holds it.
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

type RulePr = Pick<PrFacts, 'draft' | 'mergeable' | 'mergeState' | 'requiredChecks'>;

/**
 * Whether a required check has completed on the head: a check GitHub marks required that is not
 * expected or pending. With none on the head, met only when no source of the rule lists one, or
 * when the rule is unreadable: then only GitHub's required checks can hold the head.
 */
export function requiredCheckCompleted(pr: RulePr, rule: ReviewRule | null): boolean {
  if (pr.requiredChecks.some((check) => check.state !== 'expected' && check.state !== 'pending'))
    return true;
  return pr.requiredChecks.length === 0 && (rule === null || rule.requiredChecks.length === 0);
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
  if (pr.mergeState === 'blocked') return unresolvedThreads > 0 ? 'unresolved_threads' : 'blocked';
  return 'undecided';
}

/**
 * Whether the verdict runs the 30-minute clock: GitHub's answer names nobody to act. For `keep`
 * the caller also requires a completed required check.
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
