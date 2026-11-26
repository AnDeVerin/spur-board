import { AdapterError, type Batch } from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure, withTimeout } from '../runner/http.ts';
import { parseWire } from '../runner/wire.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MALFORMED = 'Malformed GitHub response';
const graphErrorWire = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  type: z.string().optional(),
});
export type GraphError = z.output<typeof graphErrorWire>;
// A closing reference the token cannot read never links, so it costs the PR nothing.
export function deniedReference(error: GraphError): boolean {
  return (
    (error.type === 'FORBIDDEN' || error.type === 'NOT_FOUND') &&
    error.path?.includes('closingIssuesReferences') === true
  );
}
// A denied base branch rule of a PR (`baseRef` and below) leaves the PR's other fields readable.
export function deniedBranchRule(error: GraphError): boolean {
  return (
    (error.type === 'FORBIDDEN' || error.type === 'NOT_FOUND') && error.path?.[2] === 'baseRef'
  );
}
// A denied head commit or check suite list of a PR (`statusCheckRollup.commit` and below) leaves
// its check runs readable; no skipped check then waits for a newer run.
export function deniedSuites(error: GraphError): boolean {
  return (
    (error.type === 'FORBIDDEN' || error.type === 'NOT_FOUND') &&
    error.path?.[2] === 'statusCheckRollup' &&
    error.path[3] === 'commit'
  );
}
// GraphQL errors are classified before `data` is read: a denied root arrives as null.
export const graphEnvelopeWire = z.object({
  errors: z.array(graphErrorWire).optional(),
  data: z.unknown(),
});
// Each root is parsed by its caller once its scoped errors are handled.
const dataWire = z.looseObject({
  rateLimit: z.object({ remaining: z.int().nonnegative(), resetAt: z.string() }),
});
const pageInfoWire = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
export function connectionWire<T extends z.ZodType>(node: T) {
  return z.object({ nodes: z.array(node), pageInfo: pageInfoWire });
}

/** Whether `error` denies a requested team's slug in `query`, which must select it. */
export function teamScopeDenied(error: GraphError, query: string): boolean {
  if (error.type !== 'INSUFFICIENT_SCOPES' || !query.includes('... on Team { slug }')) return false;
  if (error.path !== undefined)
    return (
      error.path.includes('reviewRequests') &&
      error.path.includes('requestedReviewer') &&
      error.path.at(-1) === 'slug'
    );
  // GitHub's message for a slug denial is unverified, so a pathless one may name either field.
  return (
    /\b(?:slug|name)\b/i.test(error.message) && /\bread:(?:org|discussion)\b/i.test(error.message)
  );
}

// Every member of the RequestedReviewer union, so none arrives as an empty object.
const REVIEWER_FIELDS =
  'requestedReviewer { __typename ... on Bot { login } ... on Mannequin { login } ... on User { login } ... on Team { slug } ... on EnterpriseTeam { slug } } asCodeOwner';
const REVIEW_FIELDS =
  'id author { __typename login } state commit { oid } submittedAt url lastEditedAt';
// Comments are read newest first, back from the end of the PR. The body is read only to tell a
// reviewer status comment (`isStatusComment` in prBatch.ts) and never leaves the adapter.
const COMMENT_FIELDS =
  'nodes { id author { __typename login } createdAt body url lastEditedAt } pageInfo { hasPreviousPage startCursor }';
// Each thread's newest 100 inline comments, thread replies included, give each review its inline
// comments with their URL and thread id; a review is found by id, never through `replyTo`. A
// thread has no URL of its own; its first listed comment's URL links it.
const THREAD_FIELDS =
  'id isResolved isOutdated comments(last: 100) { nodes { id url lastEditedAt pullRequestReview { id } } }';
const CLOSING_FIELDS =
  'nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor }';
// A base branch's review rule as `branchRuleWire` (branchRule.ts) parses it: its branch protection
// and the first 100 rules of the rulesets that apply to it. A branch with more rules reads as a
// rule the token could not read (`branchRuleOf`), since a rule past the page may be the one that
// holds the merge.
export const BRANCH_RULE_FIELDS =
  'refUpdateRule { pattern requiredApprovingReviewCount requiresCodeOwnerReviews requiresConversationResolution requiredStatusCheckContexts } rules(first: 100) { nodes { type parameters { __typename ... on PullRequestParameters { requiredApprovingReviewCount requireCodeOwnerReview requiredReviewThreadResolution } ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } pageInfo { hasNextPage } }';
// `closing` adds the issues a PR closes; only the tracker repo of a github-issues project
// whose `link.sources` lists `closing` selects them. `reviewRule` adds GitHub's review decision
// and the base branch's review rule; only a source of a project whose External Review sets
// `approvalRule: github-rules` selects them.
const prFields = (
  number: number,
  closing = false,
  reviewRule = false,
): string => `id number url title updatedAt mergedAt closedAt state isDraft mergeable mergeStateStatus
 author { login } headRefName headRefOid${reviewRule ? `\n reviewDecision baseRef { ${BRANCH_RULE_FIELDS} }` : ''}
 statusCheckRollup { contexts(first: 100) { nodes {
 ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt workflowRun { workflow { id } } app { id } } isRequired(pullRequestNumber: ${String(number)}) }
 ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${String(number)}) }
 } pageInfo { hasNextPage endCursor } } commit { checkSuites(first: 100) { nodes { status createdAt workflowRun { workflow { id } } } pageInfo { hasNextPage } } } }
 reviews(first: 100) { nodes { ${REVIEW_FIELDS} } pageInfo { hasNextPage endCursor } }
 comments(last: 100) { ${COMMENT_FIELDS} }
 reviewThreads(first: 100) { nodes { ${THREAD_FIELDS} } pageInfo { hasNextPage endCursor } }
 reviewRequests(first: 100) { nodes { ${REVIEWER_FIELDS} } pageInfo { hasNextPage endCursor } }${closing ? `\n closingIssuesReferences(first: 100) { ${CLOSING_FIELDS} }` : ''}`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } pageInfo { hasNextPage endCursor }`;
// The fields the index compares to tell whether a PR changed since its last full read. Each
// check is listed without `isRequired`, the costly field: GitHub's SUCCESS rollup also covers
// skipped checks, so only the checks themselves show a skipped required check that reran.
// `edited`, the comment updated last, and each review's `lastEditedAt` show an edit of a comment
// or a review body; an inline comment's edit shows only at the next refresh (`OPEN_REFRESH_MS`).
const INDEX_CONTEXTS =
  'contexts(first: 100) { totalCount nodes { ... on CheckRun { __typename name status conclusion completedAt } ... on StatusContext { __typename context state } } }';
const INDEX_FIELDS = `number updatedAt state isDraft mergeable mergeStateStatus headRefOid statusCheckRollup { state ${INDEX_CONTEXTS} } reviews(first: 100) { totalCount nodes { id state lastEditedAt } } reviewThreads(first: 100) { totalCount nodes { isResolved } } reviewRequests(first: 100) { totalCount nodes { ${REVIEWER_FIELDS} } } comments(last: 1) { totalCount nodes { id } } edited: comments(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { id updatedAt } }`;
// Alias numbers are literals, so a request can contain an arbitrary set of requested PRs.
function aliases(numbers: readonly number[], fields: (number: number) => string): string {
  return numbers
    .map(
      (number, i) =>
        `pr${String(i)}: repository(owner: $owner, name: $repo) { pullRequest(number: ${String(number)}) { ${fields(number)} } }`,
    )
    .join('\n');
}
// Bootstrap lists open PRs only, so no closed or merged history is read. Later polls also list
// merged and closed PRs: a merge or a close moves `updatedAt`, so discovery returns the PR once
// and its detail read brings the new state to core, linked or not (#221). The bootstrap baseline
// reads the newest merged or closed PR's `updatedAt` only, so the first cursor sits past all the
// history later polls can list; the alias keeps its name to match the recorded request text.
const discoveryStates = (bootstrap: boolean): string =>
  bootstrap ? 'OPEN' : 'OPEN, MERGED, CLOSED';
// The default-branch head's check runs, with the event that triggered each run's workflow, and
// commit statuses; only the first discovery request selects them (`defaultBranchFact`).
export const DEFAULT_BRANCH_FIELDS =
  'defaultBranchRef { name target { __typename ... on Commit { oid statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt detailsUrl checkSuite { createdAt workflowRun { event workflow { id } } } } ... on StatusContext { __typename context state createdAt targetUrl } } pageInfo { hasNextPage } } } } } }';
// Discovery has no aliases; the trailing double space keeps the recorded request text.
export function discoveryQuery(bootstrap = false): string {
  const states = discoveryStates(bootstrap);
  const baseline = bootstrap
    ? ' mergedBaseline: pullRequests(first: 1, states: [MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { updatedAt } }'
    : '';
  return `query PrBatch($owner: String!, $repo: String!) { rateLimit { cost limit remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} }${baseline} ${DEFAULT_BRANCH_FIELDS} }  }`;
}
export function stateQuery(numbers: readonly number[]): string {
  return `query PrStates($owner: String!, $repo: String!) { rateLimit { cost limit remaining resetAt } ${aliases(numbers, () => 'number state')} }`;
}
// `reviewRule` adds GitHub's review decision to the index, so a change of it forces a full read.
export function indexQuery(numbers: readonly number[], reviewRule = false): string {
  const fields = reviewRule ? `${INDEX_FIELDS} reviewDecision` : INDEX_FIELDS;
  return `query PrIndex($owner: String!, $repo: String!) { rateLimit { cost limit remaining resetAt } ${aliases(numbers, () => fields)} }`;
}
export function detailQuery(
  numbers: readonly number[],
  closing = false,
  reviewRule = false,
): string {
  return `query PrDetails($owner: String!, $repo: String!) { rateLimit { cost limit remaining resetAt } ${aliases(numbers, (number) => prFields(number, closing, reviewRule))} }`;
}
export function pageQuery(
  connection:
    | 'pullRequests'
    | 'reviews'
    | 'reviewThreads'
    | 'reviewRequests'
    | 'contexts'
    | 'closingIssuesReferences'
    | 'comments',
  bootstrap = false,
): string {
  if (connection === 'comments')
    return `query PrPage($owner: String!, $repo: String!, $number: Int!, $before: String!) { rateLimit { cost limit remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { comments(last: 100, before: $before) { ${COMMENT_FIELDS} } } } }`;
  if (connection === 'pullRequests') {
    const states = discoveryStates(bootstrap);
    return `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { rateLimit { cost limit remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} } } }`;
  }
  const field =
    connection === 'closingIssuesReferences'
      ? `closingIssuesReferences(first: 100, after: $after) { ${CLOSING_FIELDS} }`
      : connection === 'contexts'
        ? `statusCheckRollup { contexts(first: 100, after: $after) { nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt workflowRun { workflow { id } } app { id } } isRequired(pullRequestNumber: $number) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: $number) } } pageInfo { hasNextPage endCursor } } }`
        : `${connection}(first: 100, after: $after) { nodes { ${connection === 'reviews' ? REVIEW_FIELDS : connection === 'reviewThreads' ? THREAD_FIELDS : REVIEWER_FIELDS} } pageInfo { hasNextPage endCursor } }`;
  return `query PrPage($owner: String!, $repo: String!, $number: Int!, $after: String!) { rateLimit { cost limit remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
}
// A tree's top-level entries; the approval watch compares a commit's with its first parent's.
// `mode` shows a change that keeps the blob, such as `chmod +x` on a root script.
const TREE_FIELDS = 'tree { entries { name type mode oid } }';
// The PR's last 100 commits with their parents and root trees (`approvalWatch.ts`). The list
// leaves out base-branch history, so a merge from the base names a parent outside it, whose
// tree is selected inline here. Every parent is selected, so an octopus merge loses none. The
// list depends on the base branch, so the read also names it.
export function commitsQuery(): string {
  return `query PrCommits($owner: String!, $repo: String!, $number: Int!) { rateLimit { cost limit remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { baseRefName commits(last: 100) { totalCount pageInfo { hasPreviousPage } nodes { commit { oid ${TREE_FIELDS} parents(first: 100) { totalCount nodes { oid ${TREE_FIELDS} } } } } } } } }`;
}
// The base branch of each PR; the approval watch compares it with the base its commits read
// named, since a retarget changes the commits list without changing the head.
export function basesQuery(numbers: readonly number[]): string {
  return `query PrBases($owner: String!, $repo: String!) { rateLimit { cost limit remaining resetAt } ${aliases(numbers, () => 'baseRefName')} }`;
}

/**
 * The failure that GraphQL `errors` mean for the whole request, in rule order: a rate limit is
 * `throttled`, a denied team slug or any missing scope is `auth`. Null when no rule applies.
 */
export function graphqlFailure(
  errors: readonly GraphError[],
  query: string,
  headers: Headers,
  now: number,
): AdapterError | null {
  if (errors.some((error) => error.type === 'RATE_LIMITED' || /rate limit/i.test(error.message)))
    return classifyHttpFailure({ status: 429, headers }, now);
  if (errors.some((error) => teamScopeDenied(error, query)))
    return new AdapterError('auth', 'GitHub token needs read:org for team review requests');
  if (errors.some((error) => error.type === 'INSUFFICIENT_SCOPES'))
    return new AdapterError('auth', 'GitHub token lacks a required GraphQL read scope');
  return null;
}
/** Whether the token was denied the check runs of a status rollup. */
export function checkAccessDenied(errors: readonly GraphError[]): boolean {
  return errors.some(
    (error) =>
      error.type === 'FORBIDDEN' &&
      error.path?.includes('statusCheckRollup') === true &&
      error.path.includes('contexts'),
  );
}

export interface ResponseData {
  data: z.output<typeof dataWire>;
  errors: GraphError[];
  budget: NonNullable<Batch['budget']>;
}
export class GithubClient {
  private points: number | undefined;
  takeUsage(): Batch['usage'] {
    const points = this.points;
    this.points = undefined;
    return points === undefined ? undefined : { points };
  }
  private readonly token: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  constructor(token: string, now: () => number, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.now = now;
    this.fetcher = fetcher;
  }
  async query(
    query: string,
    variables: Record<string, string | number>,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<ResponseData> {
    const { response, body } = await withTimeout(
      signal,
      'GitHub request timed out',
      async (timed) => {
        let response: Response;
        try {
          response = await this.fetcher('https://api.github.com/graphql', {
            method: 'POST',
            signal: timed,
            headers: {
              authorization: `Bearer ${this.token}`,
              'content-type': 'application/json',
              accept: 'application/vnd.github+json',
            },
            body: JSON.stringify({ query, variables }),
          });
        } catch (cause) {
          if (timed.aborted) throw cause;
          throw new AdapterError('transient', 'GitHub request failed', { cause });
        }
        if (!response.ok) {
          // A body cut off after the headers is a network failure like the fetch itself.
          let text: string;
          try {
            text = await response.text();
          } catch (cause) {
            if (timed.aborted) throw cause;
            throw new AdapterError('transient', 'GitHub request failed', { cause });
          }
          throw classifyHttpFailure(
            { status: response.status, headers: response.headers, body: text },
            this.now(),
          );
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (cause) {
          throw new AdapterError('transient', MALFORMED, { cause });
        }
        return { response, body };
      },
      timeoutMs,
    );
    // Capture a valid reported cost before classifying GraphQL errors or parsing PR facts.
    const cost = z
      .object({ data: z.object({ rateLimit: z.object({ cost: z.int().nonnegative() }) }) })
      .safeParse(body);
    if (cost.success) this.points = (this.points ?? 0) + cost.data.data.rateLimit.cost;
    const wire = parseWire(graphEnvelopeWire, body, MALFORMED);
    const errors = wire.errors ?? [];
    const failure = graphqlFailure(errors, query, response.headers, this.now());
    if (failure !== null) throw failure;
    const data = parseWire(dataWire, wire.data, MALFORMED, ['data']);
    // A missing or invalid limit is left out; remaining and resetAt still count.
    const limit = z
      .object({ rateLimit: z.object({ limit: z.int().positive() }) })
      .safeParse(wire.data);
    const budget = limit.success
      ? { ...data.rateLimit, limit: limit.data.rateLimit.limit }
      : data.rateLimit;
    return { data, errors, budget };
  }
}
