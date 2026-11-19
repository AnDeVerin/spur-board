// A base branch's review rule, read from its branch protection (`refUpdateRule`) and the rules of
// the active rulesets that apply to it (`rules`), for the PR detail read and `board doctor`.
import { AdapterError, type ReviewRule } from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';
import { BRANCH_RULE_FIELDS, GithubClient } from './client.ts';

// Every field is nullish: a rule type or parameter type this reader does not know parses and is
// ignored.
const parametersWire = z
  .object({
    __typename: z.string(),
    requiredApprovingReviewCount: z.int().min(0).nullish(),
    requireCodeOwnerReview: z.boolean().nullish(),
    requiredReviewThreadResolution: z.boolean().nullish(),
    requiredStatusChecks: z.array(z.object({ context: z.string() })).nullish(),
  })
  .nullish();
export const branchRuleWire = z.object({
  refUpdateRule: z
    .object({
      requiredApprovingReviewCount: z.int().min(0).nullish(),
      requiresCodeOwnerReviews: z.boolean().nullish(),
      requiresConversationResolution: z.boolean().nullish(),
      requiredStatusCheckContexts: z.array(z.string().nullable()).nullish(),
    })
    .nullish(),
  rules: z
    .object({
      nodes: z.array(z.object({ type: z.string(), parameters: parametersWire }).nullable()),
    })
    .nullish(),
});
export type BranchRuleWire = z.output<typeof branchRuleWire>;

/**
 * The merged rule: the largest approval count, a code owner review or resolved conversations
 * when any source requires one, and every required check once. A ruleset counts as a source only
 * through a pull request or required status checks rule.
 */
export function branchRuleOf(wire: BranchRuleWire | null | undefined): ReviewRule {
  const protection = wire?.refUpdateRule ?? null;
  const nodes = wire?.rules?.nodes ?? [];
  const parametersOf = (type: string, typename: string) =>
    nodes.flatMap((node) =>
      node?.type === type && node.parameters?.__typename === typename ? [node.parameters] : [],
    );
  const pullRequests = parametersOf('PULL_REQUEST', 'PullRequestParameters');
  const statusChecks = parametersOf('REQUIRED_STATUS_CHECKS', 'RequiredStatusChecksParameters');
  const counts = [
    protection?.requiredApprovingReviewCount,
    ...pullRequests.map((rule) => rule.requiredApprovingReviewCount),
  ].filter((count): count is number => typeof count === 'number');
  const checks = [
    ...(protection?.requiredStatusCheckContexts ?? []),
    ...statusChecks.flatMap((rule) =>
      (rule.requiredStatusChecks ?? []).map((check) => check.context),
    ),
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);
  return {
    sources: [
      ...(protection === null ? [] : ['branch-protection' as const]),
      ...(pullRequests.length + statusChecks.length === 0 ? [] : ['ruleset' as const]),
    ],
    approvals: counts.length === 0 ? null : Math.max(...counts),
    codeOwners:
      protection?.requiresCodeOwnerReviews === true ||
      pullRequests.some((rule) => rule.requireCodeOwnerReview === true),
    conversationResolution:
      protection?.requiresConversationResolution === true ||
      pullRequests.some((rule) => rule.requiredReviewThreadResolution === true),
    requiredChecks: [...new Set(checks)],
  };
}

const defaultBranchWire = z.object({
  defaultBranchRef: branchRuleWire.extend({ name: z.string().min(1) }).nullable(),
});

/**
 * Reads the review rule of `repo`'s default branch; null when the repository has no default
 * branch. Any GraphQL error rejects with a transient `AdapterError`.
 */
export async function readBranchRule(
  repo: string,
  {
    token,
    now,
    fetch: fetcher,
    signal,
  }: { token: string; now: () => number; fetch?: typeof fetch; signal: AbortSignal },
): Promise<{ branch: string; rule: ReviewRule } | null> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
  const response = await new GithubClient(token, now, fetcher).query(
    `query BranchRule($owner: String!, $repo: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { defaultBranchRef { name ${BRANCH_RULE_FIELDS} } } }`,
    { owner, repo: name },
    signal,
  );
  if (response.errors.length > 0) throw new AdapterError('transient', 'GitHub rule read failed');
  const root = parseWire(
    defaultBranchWire,
    response.data['repository'],
    'Malformed GitHub response',
    ['data', 'repository'],
  );
  const branch = root.defaultBranchRef;
  return branch === null ? null : { branch: branch.name, rule: branchRuleOf(branch) };
}
