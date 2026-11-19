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
  reviewRuleVerdict,
  type ReviewRuleVerdict,
} from '../domain/review-rule.ts';
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
  /** When this head's undecided GitHub answer started; null while it has a decision or a reason. */
  undecidedSince: z.iso.datetime().nullable(),
  /** The item summary, frozen at the first reconcile 30 minutes after `undecidedSince`. */
  raised: z.string().nullable(),
});
type Stored = z.output<typeof storedSchema>;

const reviewRuleKey = (source: string, ref: { repo: string; number: number }): string =>
  `review-rule:${source}:pr:${ref.repo.toLowerCase()}#${String(ref.number)}`;

async function readRow(trx: Trx, key: string): Promise<Stored | null> {
  const row = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  if (row === undefined) return null;
  try {
    return parseJson(storedSchema, row.value);
  } catch {
    return null;
  }
}

/** The stored row of `pr` on its current head; null when absent, unreadable or on another head. */
async function rowOnHead(
  trx: Trx,
  source: string,
  pr: Pick<PrFacts, 'repo' | 'number' | 'headSha'>,
): Promise<Stored | null> {
  const row = await readRow(trx, reviewRuleKey(source, pr));
  return row !== null && row.headSha.toLowerCase() === pr.headSha.toLowerCase() ? row : null;
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
 * drops its row; an item without a review rule (facts reused from an earlier read) says nothing
 * new. A new head starts without a decision; `keep` (GitHub has not computed the merge state)
 * keeps the stored one. Returns true when the decision, GitHub's verdict or the rule changed.
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
  const verdict = verdictOf(
    fact,
    reviewRule,
    changesRequested(fact, reviewRule.reviewDecision, agentLogin),
  );
  const decision =
    verdict === 'keep'
      ? (old?.decision ?? null)
      : verdict === 'satisfied' || verdict === 'blocked'
        ? verdict
        : null;
  const clock = decision === null && onClock(verdict, false);
  const next: Stored = {
    headSha: fact.headSha.toLowerCase(),
    decision,
    reviewDecision: reviewRule.reviewDecision,
    rule: reviewRule.rule,
    undecidedSince: clock ? (old?.undecidedSince ?? at) : null,
    raised: clock ? (old?.raised ?? null) : null,
  };
  const value = toJson(storedSchema, next);
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
 */
export async function storedReviewRule(
  trx: Trx,
  source: string,
  pr: PrFacts,
  agentLogin: string,
): Promise<NonNullable<TaskGateFacts['reviewRule']>> {
  const row = await rowOnHead(trx, source, pr);
  const reviews = externalReviews(pr, agentLogin);
  const requested = changesRequested(pr, row?.reviewDecision ?? null, agentLogin);
  const approved = reviews.some((review) => review.state === 'approved');
  if (row === null) return { approved, changesRequested: requested, decision: 'undecided' };
  const verdict = verdictOf(pr, row, requested);
  const decision =
    verdict === 'checks_pending' || verdict === 'unresolved_threads' || verdict === 'undecided'
      ? verdict
      : verdict === 'dev' || verdict === 'changes_requested'
        ? 'undecided'
        : (row.decision ?? 'undecided');
  return { approved, changesRequested: requested, decision };
}

const upper = (value: string | null): string => (value === null ? 'null' : value.toUpperCase());

/**
 * The items of github-rules tasks in External Review whose head has stayed undecided for
 * `REVIEW_RULE_UNDECIDED_MS`. Each summary is frozen in its row at the first reconcile past the
 * threshold, so a later poll or a restart keeps the item as raised.
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
    let summary = row.raised;
    if (summary === null) {
      summary = `${task.key}: GitHub has not decided the review rule of ${pr.repo}#${String(pr.number)} on ${row.headSha.slice(0, 7)} for 30 minutes in External Review (mergeStateStatus=${upper(pr.mergeState)}, mergeable=${upper(pr.mergeable)}, reviewDecision=${upper(row.reviewDecision)})`;
      const value = toJson(storedSchema, { ...row, raised: summary });
      await trx.updateTable('meta').set({ value }).where('key', '=', key).execute();
    }
    candidates.push({
      key: `${REVIEW_RULE_KEY}${String(task.id)}:${pr.repo}#${String(pr.number)}:${row.headSha}`,
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
