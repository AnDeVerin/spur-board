import {
  approvalRuleOf,
  prFactsSchema,
  prReviewRuleSchema,
  prSourceId,
  type Config,
  type PrFacts,
  type PrReviewRule,
} from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { REVIEW_RULE_KEY, type ItemCandidate } from '../domain/fromYou.ts';
import type { TaskGateFacts } from '../domain/gates.ts';
import {
  changesRequested,
  externalReviews,
  onClock,
  requiredCheckState,
  reviewRuleVerdict,
  ruleDecision,
  storedDecision,
  waitsOnGitHub,
  type ReviewRuleVerdict,
} from '../domain/review-rule.ts';
import { withUnconfirmedCancels } from './cancelled-checks.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { TaskTable } from '../store/schema.ts';
import { parsePr, taskPr, type Trx } from './board-utils.ts';

// Under `approvalRule: github-rules`, one `meta` row per PR and source holds GitHub's review
// verdict and the base branch's review rule from that source's last full read, with the decision
// on that head. Only calls for a github-rules project write it; nothing else reads it.

/** How long a head may stay undecided in External Review before the operator gets an item. */
const REVIEW_RULE_UNDECIDED_MS = 30 * 60_000;

const storedSchema = z.strictObject({
  headSha: prFactsSchema.shape.headSha,
  decision: z.enum(['satisfied', 'blocked']).nullable(),
  reviewDecision: prReviewRuleSchema.shape.reviewDecision,
  rule: prReviewRuleSchema.shape.rule,
  /**
   * When this head's undecided GitHub answer started: no stored decision, and the gate waits on
   * GitHub alone (`waitsOnGitHub`). Null while a decision is stored or the read names someone to
   * act.
   */
  undecidedSince: z.iso.datetime().nullable(),
  /**
   * GitHub's raw values for the item, frozen at the first reconcile 30 minutes after
   * `undecidedSince`. The PR's tasks share it; each item's summary adds its own task key.
   */
  raised: z.string().nullable(),
});
type Stored = z.output<typeof storedSchema>;

const reviewRuleKey = (source: string, ref: { repo: string; number: number }): string =>
  `review-rule:${source}:pr:${ref.repo.toLowerCase()}#${String(ref.number)}`;

/** The stored row of `pr` on its current head; null when absent, unreadable or on another head. */
async function rowOnHead(
  trx: Trx,
  source: string,
  pr: Pick<PrFacts, 'repo' | 'number' | 'headSha'>,
): Promise<Stored | null> {
  const row = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', reviewRuleKey(source, pr))
    .executeTakeFirst();
  if (row === undefined) return null;
  let stored: Stored;
  try {
    stored = parseJson(storedSchema, row.value);
  } catch {
    return null;
  }
  return stored.headSha.toLowerCase() === pr.headSha.toLowerCase() ? stored : null;
}

function verdictOf(pr: PrFacts, reviewRule: PrReviewRule, requested: boolean): ReviewRuleVerdict {
  return reviewRuleVerdict(
    pr,
    reviewRule.rule,
    requested,
    pr.reviewThreads.filter((thread) => !thread.resolved).length,
  );
}

/**
 * Records one full read's review rule for a github-rules project's source. A PR that is not open
 * drops its row; an item without a review rule says nothing new. The adapter sends a reused read
 * with its first read's review rule again, which rewrites no unchanged row and writes a lost one
 * back, as after a rolled-back observation. A new head starts without a decision; `keep` (GitHub
 * has not computed the merge state) keeps the stored one. The 30-minute clock runs only while the
 * head has no decision, the gate reads the same read as waiting on GitHub alone and nobody asks
 * for changes, GitHub's verdict on an unknown merge state included. Returns true
 * when the decision, GitHub's verdict or the rule changed.
 */
export async function recordReviewRule(
  trx: Trx,
  source: string,
  fact: PrFacts,
  reviewRule: PrReviewRule | undefined,
  at: string,
  agentLogin: string,
): Promise<boolean> {
  const key = reviewRuleKey(source, fact);
  if (fact.state !== 'open') {
    const deleted = await trx.deleteFrom('meta').where('key', '=', key).executeTakeFirst();
    return deleted.numDeletedRows > 0n;
  }
  if (reviewRule === undefined) return false;
  const old = await rowOnHead(trx, source, fact);
  const requested = changesRequested(fact, reviewRule.reviewDecision, agentLogin);
  const verdict = verdictOf(fact, reviewRule, requested);
  const decision = storedDecision(verdict, old?.decision ?? null);
  // GitHub's changes request names someone to act, though the gate ignores it on an unknown
  // merge state, so it keeps the clock off.
  const clock = onClock(
    verdict,
    requiredCheckState(fact, reviewRule.rule),
    decision,
    requested || reviewRule.reviewDecision === 'changes_requested',
  );
  const next: Stored = {
    headSha: fact.headSha.toLowerCase(),
    decision,
    reviewDecision: reviewRule.reviewDecision,
    rule: reviewRule.rule,
    undecidedSince: clock ? (old?.undecidedSince ?? at) : null,
    raised: clock ? (old?.raised ?? null) : null,
  };
  const value = toJson(storedSchema, next);
  // A reused read sends the same review rule again: an unchanged row is not rewritten.
  if (old !== null && toJson(storedSchema, old) === value) return false;
  await trx
    .insertInto('meta')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
  return (
    old === null ||
    old.decision !== next.decision ||
    old.reviewDecision !== next.reviewDecision ||
    JSON.stringify(old.rule) !== JSON.stringify(next.rule)
  );
}

/**
 * What External Review reads under github-rules: the stored row of the project's own source on
 * the current head with the PR's facts. Without a row on the head GitHub's answer is undecided.
 * While the merge state is unknown the stored decision does not count: the task waits on a
 * running required check or on GitHub, which holds it without returning it. The facts may come
 * from another project's newer read of the same head: its block overrides a stored satisfied
 * decision, its satisfied state never overrides a stored block, and neither changes the row.
 */
export async function storedReviewRule(
  trx: Trx,
  source: string,
  pr: PrFacts,
  agentLogin: string,
): Promise<NonNullable<TaskGateFacts['reviewRule']>> {
  const row = await rowOnHead(trx, source, pr);
  const requested = changesRequested(pr, row?.reviewDecision ?? null, agentLogin);
  const approved = externalReviews(pr, agentLogin).some((review) => review.state === 'approved');
  if (row === null) return { approved, changesRequested: requested, decision: 'undecided' };
  const decision = ruleDecision(
    verdictOf(pr, row, requested),
    requiredCheckState(pr, row.rule),
    row.decision,
  );
  return { approved, changesRequested: requested, decision };
}

const upper = (value: string | null): string => (value === null ? 'null' : value.toUpperCase());

/**
 * The items of github-rules tasks in External Review whose head has stayed undecided for
 * `REVIEW_RULE_UNDECIDED_MS` and whose gate, read as `readInput` reads it, still waits on GitHub
 * alone: a newer read of the head by another project's source can name someone to act first or
 * carry GitHub's decision, satisfied or blocked, and then no item is raised or kept.
 * GitHub's values are frozen in the row at the first reconcile past the threshold, so a later
 * poll or a restart keeps the item as raised.
 */
export async function reviewRuleItems(
  trx: Trx,
  config: Config,
  now: number,
  tasks: readonly Selectable<TaskTable>[],
): Promise<ItemCandidate[]> {
  const candidates: ItemCandidate[] = [];
  for (const task of tasks) {
    if (task.column !== 'external-review') continue;
    const project = config.projects.find((entry) => entry.id === task.project);
    if (project === undefined || approvalRuleOf(project) !== 'github-rules') continue;
    const link = await taskPr(trx, task.id);
    if (link === null || !link.open) continue;
    const pr = parsePr(
      (
        await trx
          .selectFrom('pr_snapshot')
          .select('detail')
          .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
          .where('number', '=', link.number)
          .executeTakeFirst()
      )?.detail,
    );
    if (pr === null || pr.state !== 'open') continue;
    const source = prSourceId(project.id, pr.repo);
    const key = reviewRuleKey(source, pr);
    const row = await rowOnHead(trx, source, pr);
    if (row?.undecidedSince == null) continue;
    if (now - Date.parse(row.undecidedSince) < REVIEW_RULE_UNDECIDED_MS) continue;
    const gatePr =
      project.checksGate === 'dev' ? pr : await withUnconfirmedCancels(trx, source, pr);
    const gate = await storedReviewRule(trx, source, gatePr, project.operatorGithubLogin);
    // Another project's newer read may already be GitHub's decision on the head: the gate waits
    // for this source's own read, but GitHub has not left the rule undecided.
    const decided = storedDecision(verdictOf(gatePr, row, gate.changesRequested), null) !== null;
    if (!waitsOnGitHub(gate) || decided) continue;
    // The slug as the meta key holds it: a manual link and a poll can spell it differently.
    const ref = `${pr.repo.toLowerCase()}#${String(pr.number)}`;
    let raised = row.raised;
    if (raised === null) {
      const what =
        gate.decision === 'unreadable'
          ? `The GitHub review rule for the base branch of ${ref} could not be read`
          : `GitHub has not decided the review rule of ${ref}`;
      raised = `${what} on ${row.headSha.slice(0, 7)} for 30 minutes in External Review (mergeStateStatus=${upper(pr.mergeState)}, mergeable=${upper(pr.mergeable)}, reviewDecision=${upper(row.reviewDecision)})`;
      const value = toJson(storedSchema, { ...row, raised });
      await trx.updateTable('meta').set({ value }).where('key', '=', key).execute();
    }
    // Tasks linking the same PR share the row; each item names its own task.
    const summary = `${task.key}: ${raised}`;
    candidates.push({
      key: `${REVIEW_RULE_KEY}${String(task.id)}:${ref}:${row.headSha}`,
      kind: 'board_observation',
      taskId: task.id,
      summary,
      factAt: row.undecidedSince,
      source,
      priority: 4,
    });
  }
  return candidates;
}
