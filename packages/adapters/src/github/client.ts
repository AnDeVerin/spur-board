import { AdapterError, type Batch } from '@spur-board/contracts';
import { classifyHttpFailure } from '../runner/http.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordValue = { [key: string]: Json };
export interface GraphError {
  message: string;
  path?: readonly (string | number)[];
  type?: string;
}

export function record(value: Json | undefined): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('transient', 'Malformed GitHub response');
  }
  return value;
}
export function list(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new AdapterError('transient', 'Malformed GitHub connection');
  return value;
}
export function connectionNodes(value: Json | undefined): RecordValue[] {
  return list(record(value).nodes).map(record);
}
export function string(value: Json | undefined): string {
  if (typeof value !== 'string') throw new AdapterError('transient', 'Malformed GitHub field');
  return value;
}

const prFields = (
  number: number,
): string => `id number url title updatedAt state isDraft mergeable mergeStateStatus
 author { login } headRefName headRefOid
 statusCheckRollup { contexts(first: 100) { nodes {
 ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: ${String(number)}) }
 ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${String(number)}) }
 } pageInfo { hasNextPage endCursor } } }
 reviews(first: 100) { nodes { author { login } state commit { oid } submittedAt } pageInfo { hasNextPage endCursor } }
 reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
 reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } asCodeOwner } pageInfo { hasNextPage endCursor } }`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } pageInfo { hasNextPage endCursor }`;
// Alias numbers are literals, so a request can contain an arbitrary set of requested PRs.
function aliases(numbers: readonly number[]): string {
  return numbers
    .map(
      (number, i) =>
        `pr${String(i)}: repository(owner: $owner, name: $repo) { pullRequest(number: ${String(number)}) { ${prFields(number)} } }`,
    )
    .join('\n');
}
export function initialQuery(numbers: readonly number[], bootstrap = false): string {
  const states = bootstrap ? 'OPEN' : 'OPEN, MERGED';
  return `query PrBatch($owner: String!, $repo: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} } } ${aliases(numbers)} }`;
}
export function detailQuery(numbers: readonly number[]): string {
  return `query PrDetails($owner: String!, $repo: String!) { rateLimit { remaining resetAt } ${aliases(numbers)} }`;
}
export function pageQuery(
  connection: 'pullRequests' | 'reviews' | 'reviewThreads' | 'reviewRequests' | 'contexts',
  bootstrap = false,
): string {
  if (connection === 'pullRequests') {
    const states = bootstrap ? 'OPEN' : 'OPEN, MERGED';
    return `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], orderBy: {field: UPDATED_AT, direction: DESC}) { ${DISCOVERY_FIELDS} } } }`;
  }
  const field =
    connection === 'contexts'
      ? `statusCheckRollup { contexts(first: 100, after: $after) { nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: $number) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: $number) } } pageInfo { hasNextPage endCursor } } }`
      : `${connection}(first: 100, after: $after) { nodes { ${connection === 'reviews' ? 'author { login } state commit { oid } submittedAt' : connection === 'reviewThreads' ? 'isResolved' : 'requestedReviewer { ... on User { login } ... on Team { name } } asCodeOwner'} } pageInfo { hasNextPage endCursor } }`;
  return `query PrPage($owner: String!, $repo: String!, $number: Int!, $after: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
}

export interface ResponseData {
  data: RecordValue;
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
    let wire: RecordValue;
    try {
      wire = record((await response.json()) as Json);
    } catch (cause) {
      throw new AdapterError('transient', 'Malformed GitHub response', { cause });
    }
    const errors =
      wire.errors === undefined
        ? []
        : list(wire.errors).map((e) => {
            const item = record(e);
            return {
              message: string(item.message),
              ...(typeof item.type === 'string' ? { type: item.type } : {}),
              ...(Array.isArray(item.path)
                ? {
                    path: item.path.filter(
                      (p): p is string | number => typeof p === 'string' || typeof p === 'number',
                    ),
                  }
                : {}),
            };
          });
    if (errors.some((error) => error.type === 'RATE_LIMITED' || /rate limit/i.test(error.message)))
      throw classifyHttpFailure({ status: 429, headers: response.headers }, Date.now());
    const data = record(wire.data);
    const rate = record(data.rateLimit);
    const remaining = rate.remaining;
    if (typeof remaining !== 'number' || !Number.isInteger(remaining) || remaining < 0)
      throw new AdapterError('transient', 'Malformed GitHub budget');
    const budget = { remaining, resetAt: string(rate.resetAt) };
    return { data, errors, budget };
  }
}
