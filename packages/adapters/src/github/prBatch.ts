import { AdapterError, prFactsSchema, type Config, type PrFacts } from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';

const KEPT_REVIEWS = ['approved', 'changes_requested', 'dismissed'];
const actor = z.object({ login: z.string().optional() }).nullish();
const checkRunWire = z
  .object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullish(),
    completedAt: z.string().nullable(),
    checkSuite: z.object({ createdAt: z.string() }).nullish(),
    isRequired: z.boolean().nullish(),
  })
  .refine((run) => run.status !== 'COMPLETED' || run.conclusion !== null, {
    path: ['conclusion'],
  });
const statusContextWire = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  createdAt: z.string(),
  isRequired: z.boolean().nullish(),
});
const contextWire = z.discriminatedUnion('__typename', [checkRunWire, statusContextWire]);
// A kept review must name its commit.
const reviewWire = z
  .object({
    author: actor,
    state: z.string(),
    commit: z.object({ oid: z.string() }).nullable(),
    submittedAt: z.string().nullish(),
  })
  .refine(
    (review) =>
      review.commit !== null ||
      !review.author?.login ||
      review.submittedAt == null ||
      !KEPT_REVIEWS.includes(review.state.toLowerCase()),
    { path: ['commit'] },
  );
const nodes = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node) });
// Vendor enums stay strings; normalizePr maps unknown values.
const prWire = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  author: actor,
  headRefName: z.string(),
  headRefOid: z.string(),
  statusCheckRollup: z.object({ contexts: nodes(contextWire) }).nullish(),
  reviews: nodes(reviewWire),
  reviewThreads: nodes(z.object({ isResolved: z.boolean() })),
  reviewRequests: nodes(
    z.object({
      requestedReviewer: z.object({ login: z.string().nullish(), name: z.string().nullish() }),
      asCodeOwner: z.boolean(),
    }),
  ),
  // Selected only for a github-issues tracker repo; a denied issue arrives as a null node.
  closingIssuesReferences: z
    .object({
      nodes: z.array(
        z
          .object({
            number: z.int().positive(),
            repository: z.object({ nameWithOwner: z.string() }).nullish(),
          })
          .nullable(),
      ),
    })
    .nullish(),
});
type ContextWire = z.output<typeof contextWire>;
type ReviewWire = z.output<typeof reviewWire>;
type ClosingWire = z.output<typeof prWire>['closingIssuesReferences'];

/** How a source turns a PR into task keys: Jira prefixes, or a github-issues tracker repo. */
export type KeyRule =
  | { type: 'prefixes'; prefixes: readonly string[] }
  | {
      type: 'issues';
      repo: string;
      sources: Config['projects'][number]['link']['sources'];
      branch: RegExp;
      title: RegExp;
    };

function checkState(node: ContextWire): PrFacts['checks'][number]['state'] {
  if (node.__typename === 'StatusContext') {
    const state = node.state.toLowerCase();
    return state === 'success'
      ? 'success'
      : state === 'pending'
        ? 'pending'
        : state === 'expected'
          ? 'expected'
          : 'failure';
  }
  if (node.status !== 'COMPLETED') return 'pending';
  const value = node.conclusion?.toLowerCase();
  const allowed: PrFacts['checks'][number]['state'][] = [
    'success',
    'neutral',
    'skipped',
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'stale',
  ];
  return allowed.find((state) => state === value) ?? 'error';
}
function latestChecks(nodes: readonly ContextWire[]): {
  checks: PrFacts['checks'];
  requiredChecks: PrFacts['requiredChecks'];
} {
  const latest = new Map<
    string,
    { check: PrFacts['checks'][number]; required: boolean; at: string }
  >();
  for (const node of nodes) {
    const status = node.__typename === 'StatusContext';
    const name = status ? node.context : node.name;
    const completedAt = status ? null : node.completedAt;
    const at = status
      ? node.createdAt
      : (node.startedAt ?? node.checkSuite?.createdAt ?? completedAt ?? '');
    const old = latest.get(name);
    if (old !== undefined && old.at > at) continue;
    latest.set(name, {
      check: { name, state: checkState(node), completedAt },
      required: node.isRequired === true,
      at,
    });
  }
  const values = [...latest.values()].sort((a, b) => a.check.name.localeCompare(b.check.name));
  return {
    checks: values.map((v) => v.check),
    requiredChecks: values.filter((v) => v.required).map((v) => v.check),
  };
}
function latestReviews(nodes: readonly ReviewWire[]): PrFacts['reviews'] {
  const latest = new Map<string, PrFacts['reviews'][number]>();
  for (const node of nodes) {
    const reviewer = node.author?.login;
    if (!reviewer || node.submittedAt == null || node.commit === null) continue;
    const state = node.state.toLowerCase();
    if (!KEPT_REVIEWS.includes(state)) continue;
    const review = {
      reviewer,
      state,
      commitSha: node.commit.oid,
      submittedAt: node.submittedAt,
    } as PrFacts['reviews'][number];
    const old = latest.get(reviewer);
    if (old === undefined || old.submittedAt <= review.submittedAt) latest.set(reviewer, review);
  }
  return [...latest.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}
export function ticketKeys(title: string, branch: string, prefixes: readonly string[]): string[] {
  const keys = new Set<string>();
  const allowed = new Set(prefixes);
  for (const match of `${title} ${branch}`.matchAll(
    /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)-([1-9][0-9]*)(?![A-Za-z0-9_])/gi,
  )) {
    const prefix = match[1]?.toUpperCase();
    const number = match[2];
    if (prefix !== undefined && number !== undefined && allowed.has(prefix))
      keys.add(`${prefix}-${number}`);
  }
  return [...keys];
}
const ISSUE_NUMBER = /^[1-9][0-9]{0,14}$/;
// The longest ref name GitHub accepts; a longer branch or title never reaches a pattern.
const MAX_MATCHED_LENGTH = 255;
function matchedNumber(text: string, pattern: RegExp): number | undefined {
  if (text.length > MAX_MATCHED_LENGTH) return undefined;
  const number = pattern.exec(text)?.[1];
  return number !== undefined && ISSUE_NUMBER.test(number) ? Number(number) : undefined;
}
// The first source in `rule.sources` that yields a number gives the keys.
function issueKeys(
  title: string,
  branch: string,
  refs: ClosingWire,
  rule: Extract<KeyRule, { type: 'issues' }>,
): string[] {
  const repo = rule.repo.toLowerCase();
  for (const source of rule.sources) {
    const numbers = new Set<number>();
    if (source === 'closing') {
      for (const node of refs?.nodes ?? []) {
        if (
          node?.repository?.nameWithOwner.toLowerCase() === repo &&
          ISSUE_NUMBER.test(String(node.number))
        )
          numbers.add(node.number);
      }
    } else {
      const number =
        source === 'branch' ? matchedNumber(branch, rule.branch) : matchedNumber(title, rule.title);
      if (number !== undefined) numbers.add(number);
    }
    if (numbers.size > 0)
      return [...numbers].sort((a, b) => a - b).map((number) => `${rule.repo}#${String(number)}`);
  }
  return [];
}
export function normalizePr(repo: string, value: unknown, rule: KeyRule): PrFacts {
  const wire = parseWire(prWire, value, 'Malformed GitHub PR response');
  const checks = latestChecks(wire.statusCheckRollup?.contexts.nodes ?? []);
  const state = wire.state === 'MERGED' ? 'merged' : wire.state === 'CLOSED' ? 'closed' : 'open';
  const mergeable =
    wire.mergeable === 'MERGEABLE'
      ? 'mergeable'
      : wire.mergeable === 'CONFLICTING'
        ? 'conflicting'
        : 'unknown';
  const rawMerge = wire.mergeStateStatus.toLowerCase();
  const mergeState = (
    ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unstable'].includes(rawMerge)
      ? rawMerge
      : 'unknown'
  ) as PrFacts['mergeState'];
  const title = wire.title;
  const headBranch = wire.headRefName;
  const facts = {
    repo,
    number: wire.number,
    url: wire.url,
    title,
    author: wire.author?.login,
    headSha: wire.headRefOid,
    headBranch,
    state,
    draft: wire.isDraft,
    mergeable,
    mergeState,
    ...checks,
    reviews: latestReviews(wire.reviews.nodes),
    reviewThreads: wire.reviewThreads.nodes.map((node) => ({ resolved: node.isResolved })),
    reviewRequests: wire.reviewRequests.nodes.map((node) => ({
      reviewer: node.requestedReviewer.login ?? node.requestedReviewer.name,
      asCodeOwner: node.asCodeOwner,
    })),
    ticketKeys:
      rule.type === 'prefixes'
        ? ticketKeys(title, headBranch, rule.prefixes)
        : issueKeys(title, headBranch, wire.closingIssuesReferences, rule),
    updatedAt: wire.updatedAt,
  };
  const parsed = prFactsSchema.safeParse(facts);
  if (!parsed.success)
    throw new AdapterError('transient', 'Malformed GitHub PR facts', { cause: parsed.error });
  return parsed.data;
}
