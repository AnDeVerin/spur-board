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
// GraphQL errors are classified before `data` is read: a denied root arrives as null.
const envelopeWire = z.object({ errors: z.array(graphErrorWire).optional(), data: z.unknown() });
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

function teamScopeDenied(error: GraphError, query: string): boolean {
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
const REVIEW_FIELDS = 'id author { __typename login } state commit { oid } submittedAt';
// Comments are read newest first, back from the end of the PR.
const COMMENT_FIELDS =
  'nodes { id author { __typename login } createdAt } pageInfo { hasPreviousPage startCursor }';
const CLOSING_FIELDS =
  'nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor }';
// `closing` adds the issues a PR closes; only the tracker repo of a github-issues project
// whose `link.sources` lists `closing` selects them.
const prFields = (
  number: number,
  closing = false,
): string => `id number url title updatedAt mergedAt state isDraft mergeable mergeStateStatus
 author { login } headRefName headRefOid
 statusCheckRollup { contexts(first: 100) { nodes {
 ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: ${String(number)}) }
 ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${String(number)}) }
 } pageInfo { hasNextPage endCursor } } }
 reviews(first: 100) { nodes { ${REVIEW_FIELDS} } pageInfo { hasNextPage endCursor } }
 comments(last: 100) { ${COMMENT_FIELDS} }
 reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
 reviewRequests(first: 100) { nodes { ${REVIEWER_FIELDS} } pageInfo { hasNextPage endCursor } }${closing ? `\n closingIssuesReferences(first: 100) { ${CLOSING_FIELDS} }` : ''}`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } pageInfo { hasNextPage endCursor }`;
// The fields the index compares to tell whether a PR changed since its last full read.
const INDEX_FIELDS = `number updatedAt state isDraft mergeable mergeStateStatus headRefOid statusCheckRollup { state } reviews(first: 100) { totalCount nodes { id state } } reviewThreads(first: 100) { totalCount nodes { isResolved } } reviewRequests(first: 100) { totalCount nodes { ${REVIEWER_FIELDS} } } comments(last: 1) { totalCount nodes { id } }`;
// Alias numbers are literals, so a request can contain an arbitrary set of requested PRs.
function aliases(numbers: readonly number[], fields: (number: number) => string): string {
  return numbers
    .map(
      (number, i) =>
        `pr${String(i)}: repository(owner: $owner, name: $repo) { pullRequest(number: ${String(number)}) { ${fields(number)} } }`,
    )
    .join('\n');
}
// Discovery has no aliases; the trailing double space keeps the recorded request text.
export function discoveryQuery(bootstrap = false): string {
  const states = bootstrap ? 'OPEN' : 'OPEN, MERGED';
  const baseline = bootstrap
    ? ' mergedBaseline: pullRequests(first: 1, states: [MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { updatedAt } }'
    : '';
  return `query PrBatch($owner: String!, $repo: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} }${baseline} }  }`;
}
export function indexQuery(numbers: readonly number[]): string {
  return `query PrIndex($owner: String!, $repo: String!) { rateLimit { remaining resetAt } ${aliases(numbers, () => INDEX_FIELDS)} }`;
}
export function detailQuery(numbers: readonly number[], closing = false): string {
  return `query PrDetails($owner: String!, $repo: String!) { rateLimit { remaining resetAt } ${aliases(numbers, (number) => prFields(number, closing))} }`;
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
    return `query PrPage($owner: String!, $repo: String!, $number: Int!, $before: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { comments(last: 100, before: $before) { ${COMMENT_FIELDS} } } } }`;
  if (connection === 'pullRequests') {
    const states = bootstrap ? 'OPEN' : 'OPEN, MERGED';
    return `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} } } }`;
  }
  const field =
    connection === 'closingIssuesReferences'
      ? `closingIssuesReferences(first: 100, after: $after) { ${CLOSING_FIELDS} }`
      : connection === 'contexts'
        ? `statusCheckRollup { contexts(first: 100, after: $after) { nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: $number) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: $number) } } pageInfo { hasNextPage endCursor } } }`
        : `${connection}(first: 100, after: $after) { nodes { ${connection === 'reviews' ? REVIEW_FIELDS : connection === 'reviewThreads' ? 'isResolved' : REVIEWER_FIELDS} } pageInfo { hasNextPage endCursor } }`;
  return `query PrPage($owner: String!, $repo: String!, $number: Int!, $after: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
}

export interface ResponseData {
  data: z.output<typeof dataWire>;
  errors: GraphError[];
  budget: NonNullable<Batch['budget']>;
}
export class GithubClient {
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
        if (!response.ok)
          throw classifyHttpFailure(
            { status: response.status, headers: response.headers, body: await response.text() },
            this.now(),
          );
        let body: unknown;
        try {
          body = await response.json();
        } catch (cause) {
          throw new AdapterError('transient', MALFORMED, { cause });
        }
        return { response, body };
      },
    );
    const wire = parseWire(envelopeWire, body, MALFORMED);
    const errors = wire.errors ?? [];
    if (errors.some((error) => error.type === 'RATE_LIMITED' || /rate limit/i.test(error.message)))
      throw classifyHttpFailure({ status: 429, headers: response.headers }, this.now());
    if (errors.some((error) => teamScopeDenied(error, query)))
      throw new AdapterError('auth', 'GitHub token needs read:org for team review requests');
    if (errors.some((error) => error.type === 'INSUFFICIENT_SCOPES'))
      throw new AdapterError('auth', 'GitHub token lacks a required GraphQL read scope');
    const data = parseWire(dataWire, wire.data, MALFORMED, ['data']);
    return { data, errors, budget: data.rateLimit };
  }
}
