import { AdapterError, type Batch } from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure } from '../runner/http.ts';
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

function teamNameScopeDenied(error: GraphError, query: string): boolean {
  if (error.type !== 'INSUFFICIENT_SCOPES' || !query.includes('... on Team { name }')) return false;
  if (error.path !== undefined)
    return (
      error.path.includes('reviewRequests') &&
      error.path.includes('requestedReviewer') &&
      error.path.at(-1) === 'name'
    );
  return /\bname\b/i.test(error.message) && /\bread:(?:org|discussion)\b/i.test(error.message);
}

const CLOSING_FIELDS =
  'nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor }';
// `closing` adds the issues a PR closes; only the tracker repo of a github-issues project
// whose `link.sources` lists `closing` selects them.
const prFields = (
  number: number,
  closing = false,
): string => `id number url title updatedAt state isDraft mergeable mergeStateStatus
 author { login } headRefName headRefOid
 statusCheckRollup { contexts(first: 100) { nodes {
 ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: ${String(number)}) }
 ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${String(number)}) }
 } pageInfo { hasNextPage endCursor } } }
 reviews(first: 100) { nodes { author { login } state commit { oid } submittedAt } pageInfo { hasNextPage endCursor } }
 reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
 reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } asCodeOwner } pageInfo { hasNextPage endCursor } }${closing ? `\n closingIssuesReferences(first: 100) { ${CLOSING_FIELDS} }` : ''}`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } pageInfo { hasNextPage endCursor }`;
// Alias numbers are literals, so a request can contain an arbitrary set of requested PRs.
function aliases(numbers: readonly number[], closing = false): string {
  return numbers
    .map(
      (number, i) =>
        `pr${String(i)}: repository(owner: $owner, name: $repo) { pullRequest(number: ${String(number)}) { ${prFields(number, closing)} } }`,
    )
    .join('\n');
}
export function initialQuery(
  numbers: readonly number[],
  bootstrap = false,
  closing = false,
): string {
  const states = bootstrap ? 'OPEN' : 'OPEN, MERGED';
  const baseline = bootstrap
    ? ' mergedBaseline: pullRequests(first: 1, states: [MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { updatedAt } }'
    : '';
  return `query PrBatch($owner: String!, $repo: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} }${baseline} } ${aliases(numbers, closing)} }`;
}
export function detailQuery(numbers: readonly number[], closing = false): string {
  return `query PrDetails($owner: String!, $repo: String!) { rateLimit { remaining resetAt } ${aliases(numbers, closing)} }`;
}
export function pageQuery(
  connection:
    | 'pullRequests'
    | 'reviews'
    | 'reviewThreads'
    | 'reviewRequests'
    | 'contexts'
    | 'closingIssuesReferences',
  bootstrap = false,
): string {
  if (connection === 'pullRequests') {
    const states = bootstrap ? 'OPEN' : 'OPEN, MERGED';
    return `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} } } }`;
  }
  const field =
    connection === 'closingIssuesReferences'
      ? `closingIssuesReferences(first: 100, after: $after) { ${CLOSING_FIELDS} }`
      : connection === 'contexts'
        ? `statusCheckRollup { contexts(first: 100, after: $after) { nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: $number) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: $number) } } pageInfo { hasNextPage endCursor } } }`
        : `${connection}(first: 100, after: $after) { nodes { ${connection === 'reviews' ? 'author { login } state commit { oid } submittedAt' : connection === 'reviewThreads' ? 'isResolved' : 'requestedReviewer { ... on User { login } ... on Team { name } } asCodeOwner'} } pageInfo { hasNextPage endCursor } }`;
  return `query PrPage($owner: String!, $repo: String!, $number: Int!, $after: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
}

export interface ResponseData {
  data: z.output<typeof dataWire>;
  errors: GraphError[];
  budget: NonNullable<Batch['budget']>;
}
export class GithubClient {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }
  async query(
    query: string,
    variables: Record<string, string | number>,
    signal: AbortSignal,
  ): Promise<ResponseData> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.github.com/graphql', {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new AdapterError('transient', 'GitHub request failed', { cause });
    }
    if (!response.ok)
      throw classifyHttpFailure(
        { status: response.status, headers: response.headers, body: await response.text() },
        Date.now(),
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new AdapterError('transient', MALFORMED, { cause });
    }
    const wire = parseWire(envelopeWire, body, MALFORMED);
    const errors = wire.errors ?? [];
    if (errors.some((error) => error.type === 'RATE_LIMITED' || /rate limit/i.test(error.message)))
      throw classifyHttpFailure({ status: 429, headers: response.headers }, Date.now());
    if (errors.some((error) => teamNameScopeDenied(error, query)))
      throw new AdapterError('auth', 'GitHub token needs read:org for team review requests');
    if (errors.some((error) => error.type === 'INSUFFICIENT_SCOPES'))
      throw new AdapterError('auth', 'GitHub token lacks a required GraphQL read scope');
    const data = parseWire(dataWire, wire.data, MALFORMED, ['data']);
    return { data, errors, budget: data.rateLimit };
  }
}
