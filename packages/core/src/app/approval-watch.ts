import {
  prApprovalPairSchema,
  type ApprovalNotCounted,
  type PrApprovalPair,
  type PrFacts,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { parseJson, toJson } from '../store/json.ts';
import type { Trx } from './board-utils.ts';

// One `meta` row per (approved commit, head) pair of an open PR holds what changed after the
// approval, as the GitHub adapter read it from the PR's commits. A hint only: no gate, move, turn
// or journal event reads it; `status.get` and `task.get` show it. Rows of older heads stay until
// the PR is no longer open, so a force-push back to an old head finds its pair again.

const [countedPair, notCountedPair] = prApprovalPairSchema.options;
const storedSchema = z.union([
  countedPair.omit({ approvedSha: true, headSha: true }),
  notCountedPair.omit({ approvedSha: true, headSha: true }),
]);
type Stored = z.output<typeof storedSchema>;

const prPrefix = (fact: Pick<PrFacts, 'repo' | 'number'>): string =>
  `approval-watch:${fact.repo.toLowerCase()}#${String(fact.number)}:`;
const pairKey = (fact: Pick<PrFacts, 'repo' | 'number'>, approved: string, head: string): string =>
  `${prPrefix(fact)}${approved.toLowerCase()}:${head.toLowerCase()}`;

/** The stored value of `text`; null when it is not JSON or has another shape. */
const parseStored = (text: string): Stored | null => {
  try {
    return parseJson(storedSchema, text);
  } catch {
    return null;
  }
};

/**
 * Records the approval pairs one PR item carries. A PR that is not open drops every row of the PR,
 * matched by an exact key prefix (`_` and `%` can appear in a repo name, and the trailing `:` keeps
 * `#1:` apart from `#10:`). A pair for another head is ignored, a `rate_limit` pair never replaces
 * a stored row, and an unchanged row is not rewritten. Nothing reads the result as a change.
 */
export async function recordApprovalPairs(
  trx: Trx,
  fact: PrFacts,
  pairs: readonly PrApprovalPair[] | undefined,
): Promise<void> {
  if (fact.state !== 'open') {
    const prefix = prPrefix(fact);
    await trx
      .deleteFrom('meta')
      .where(sql<boolean>`substr(key, 1, ${prefix.length}) = ${prefix}`)
      .execute();
    return;
  }
  const head = fact.headSha.toLowerCase();
  for (const pair of pairs ?? []) {
    if (pair.headSha.toLowerCase() !== head) continue;
    const key = pairKey(fact, pair.approvedSha, pair.headSha);
    const next: Stored =
      'notCounted' in pair
        ? { notCounted: pair.notCounted }
        : { commitsAfter: pair.commitsAfter, changed: pair.changed };
    const value = toJson(storedSchema, next);
    const row = await trx
      .selectFrom('meta')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    if (row !== undefined && 'notCounted' in next && next.notCounted === 'rate_limit') continue;
    if (row?.value === value) continue;
    await trx
      .insertInto('meta')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();
  }
}

/** One latest approval as `status.get` and `task.get` show it. */
export interface ApprovalView {
  author: string;
  sha: string;
  onHead: boolean;
  commitsAfter?: number;
  changedAfter?: string[];
  watchedAfter?: string[];
  notCounted?: ApprovalNotCounted;
}

const bare = (entry: string): string => entry.replace(/\/$/, '');

/** The part of `changed` that `watch` names, with or without a trailing `/`; all without `watch`. */
function watched(changed: readonly string[], watch: readonly string[] | undefined): string[] {
  if (watch === undefined) return [...changed];
  const names = new Set(watch.map(bare));
  return changed.filter((entry) => names.has(bare(entry)));
}

/**
 * The latest approvals of an open PR in review order, each with what changed after it. An
 * approval on the head changed nothing; an older one shows its stored pair, and a missing or
 * unreadable row shows none of the fields (not read yet). Empty for a PR that is not open.
 */
export async function approvalViews(
  db: Trx,
  fact: PrFacts,
  watch: readonly string[] | undefined,
): Promise<ApprovalView[]> {
  if (fact.state !== 'open') return [];
  const approvals = fact.reviews.filter((review) => review.state === 'approved');
  const offHead = approvals.filter((review) => review.commitSha !== fact.headSha);
  const keys = [...new Set(offHead.map((review) => pairKey(fact, review.commitSha, fact.headSha)))];
  const rows =
    keys.length === 0
      ? []
      : await db.selectFrom('meta').select(['key', 'value']).where('key', 'in', keys).execute();
  const stored = new Map(rows.map((row) => [row.key, parseStored(row.value)]));
  return approvals.map((review): ApprovalView => {
    const base = { author: review.reviewer, sha: review.commitSha };
    if (review.commitSha === fact.headSha)
      return { ...base, onHead: true, commitsAfter: 0, changedAfter: [], watchedAfter: [] };
    const row = stored.get(pairKey(fact, review.commitSha, fact.headSha)) ?? null;
    if (row === null) return { ...base, onHead: false };
    if ('notCounted' in row) return { ...base, onHead: false, notCounted: row.notCounted };
    return {
      ...base,
      onHead: false,
      commitsAfter: row.commitsAfter,
      changedAfter: [...row.changed],
      watchedAfter: watched(row.changed, watch),
    };
  });
}
