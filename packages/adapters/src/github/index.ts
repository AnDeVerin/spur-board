import {
  AdapterError,
  type Adapter,
  type Batch,
  type Config,
  type PollContext,
  type PrEntityRef,
  type PrFacts,
  type SourceCursor,
  sourceCursorSchema,
} from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';
import {
  GithubClient,
  connectionWire,
  deniedReference,
  detailQuery,
  discoveryQuery,
  indexQuery,
  pageQuery,
  type GraphError,
  type ResponseData,
} from './client.ts';
import {
  baselineNodeWire,
  discover,
  discoveryNodeWire,
  latestUpdatedAt,
  nextPage,
  pastCursor,
  type Discovery,
} from './discovery.ts';
import { commentWire, normalizePr, projectKeyRule, type KeyRule } from './prBatch.ts';
import { indexEntry, reusable, type CachedPr, type IndexEntry } from './prIndex.ts';

const MALFORMED = 'Malformed GitHub response';
const discoveryRootWire = z.object({ pullRequests: connectionWire(discoveryNodeWire) });
const baselineRootWire = z.object({
  mergedBaseline: z.object({ nodes: z.array(baselineNodeWire) }),
});
// Pagination reads only the paged connections; normalizePr parses the PR content once merged.
const pagingWire = connectionWire(z.unknown());
// Comments page back from the newest; nodes parse as normalizePr does, so a bad history node
// fails its page instead of the merged PR.
const backPagingWire = z.object({
  nodes: z.array(commentWire),
  pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable() }),
});
const prPagingWire = z.looseObject({
  reviews: pagingWire,
  comments: backPagingWire,
  reviewThreads: pagingWire,
  reviewRequests: pagingWire,
  statusCheckRollup: z.object({ contexts: pagingWire }).nullish(),
  closingIssuesReferences: pagingWire.nullish(),
});
const aliasWire = z.object({ pullRequest: prPagingWire.nullish() }).nullish();
const pageRootWire = z.object({ pullRequest: prPagingWire.partial() });
const commentsRootWire = z.object({ pullRequest: z.object({ comments: backPagingWire }) });
type Paging = z.output<typeof pagingWire>;
type BackPaging = z.output<typeof backPagingWire>;
type FeedbackCursor = NonNullable<PollContext['feedbackCursors']>[number];
// Comment pages per PR per poll, the first one included.
const FEEDBACK_PAGES = 3;
// Aliases per request: the light index read, and the full detail read.
const INDEX_CHUNK = 50;
const DETAIL_CHUNK = 10;
// Failed requests per poll, halves included; past it the poll sends nothing more.
const MAX_FAILED_REQUESTS = 8;
type PrPaging = z.output<typeof prPagingWire>;
type PagePr = z.output<typeof pageRootWire>['pullRequest'];
type PagedField =
  'reviews' | 'reviewThreads' | 'reviewRequests' | 'contexts' | 'closingIssuesReferences';

export interface GithubSource {
  adapter: Adapter;
  reserveRemaining: number;
  repo: string;
}
export interface GithubOptions {
  token: string;
  now: () => number;
  fetch?: typeof fetch;
}
function sourceId(project: string, repo: string): string {
  return `github:${project}:${repo.toLowerCase()}`;
}
export function githubSources(config: Config, options: GithubOptions): GithubSource[] {
  const sources: GithubSource[] = [];
  for (const project of config.projects) {
    const seen = new Set<string>();
    for (const repo of project.repos) {
      const normalized = repo.toLowerCase();
      if (seen.has(normalized))
        throw new AdapterError('config', 'Duplicate GitHub repository in project');
      seen.add(normalized);
      const id = sourceId(project.id, repo);
      const client = new GithubClient(options.token, options.now, options.fetch);
      const keys = projectKeyRule(project.tracker, project.link, repo);
      // Per source: the facts of each requested PR's last full read, keyed by number.
      const cache = new Map<number, CachedPr>();
      sources.push({
        repo,
        reserveRemaining: config.github.reserveRemaining,
        adapter: {
          id,
          intervalMs: config.adapters.github.intervalMs,
          poll: (ctx) =>
            pollRepository({
              id,
              repo,
              login: project.operatorGithubLogin,
              keys,
              client,
              now: options.now,
              ctx,
              reserveRemaining: config.github.reserveRemaining,
              cache,
            }),
          pollPr: (ref, ctx) =>
            pollOnePr({ id, repo, keys, client, now: options.now, ref, signal: ctx.signal, cache }),
        },
      });
    }
  }
  return sources;
}
function scoped(errors: readonly GraphError[], root: string): GraphError[] {
  return errors.filter((error) => error.path?.[0] === root);
}
function checkAccessDenied(errors: readonly GraphError[]): boolean {
  return errors.some(
    (error) =>
      error.type === 'FORBIDDEN' &&
      error.path?.includes('statusCheckRollup') === true &&
      error.path.includes('contexts'),
  );
}
function requireCheckAccess(errors: readonly GraphError[]): void {
  if (checkAccessDenied(errors))
    throw new AdapterError('auth', 'GitHub token lacks Checks read permission');
}
function unscoped(errors: readonly GraphError[], roots: readonly string[]): boolean {
  return errors.some((error) => error.path === undefined || !roots.includes(String(error.path[0])));
}
function rejectUnscoped(errors: readonly GraphError[], roots: readonly string[]): void {
  if (unscoped(errors, roots)) throw new AdapterError('transient', 'Unscoped GitHub GraphQL error');
}
function status(error: GraphError): 'not_found' | 'no_access' {
  return error.type === 'NOT_FOUND' ? 'not_found' : 'no_access';
}
function connectionOf(pr: PagePr, field: PagedField): Paging | undefined {
  return (field === 'contexts' ? pr.statusCheckRollup?.contexts : pr[field]) ?? undefined;
}
function withoutDeniedReferences(errors: readonly GraphError[]): GraphError[] {
  return errors.filter((error) => !deniedReference(error));
}
function withConnection(pr: PrPaging, field: PagedField, connection: Paging): PrPaging {
  return field === 'contexts'
    ? { ...pr, statusCheckRollup: { ...pr.statusCheckRollup, contexts: connection } }
    : { ...pr, [field]: connection };
}
// One PR's content failure stays with that PR; every other failure still rejects the poll.
function content<T>(read: () => T): T | AdapterError {
  try {
    return read();
  } catch (error) {
    if (error instanceof AdapterError) return error;
    throw error;
  }
}
type FullPr =
  | { status: 'ok'; pr: PrPaging }
  | { status: 'denied' }
  | { status: 'malformed'; error: AdapterError };
const malformedPaging = (): FullPr => ({
  status: 'malformed',
  error: new AdapterError('transient', 'Malformed GitHub pagination'),
});
// `nextPage` throws on a page that has more but no cursor; here that is this PR's content.
function pageCursor(connection: Paging): string | undefined | null {
  const { hasNextPage, endCursor } = connection.pageInfo;
  return hasNextPage && !endCursor ? null : nextPage(connection);
}
async function fullPr(
  client: GithubClient,
  first: PrPaging,
  owner: string,
  name: string,
  number: number,
  signal: AbortSignal,
  budget: (value: NonNullable<Batch['budget']>) => void,
): Promise<FullPr> {
  let pr = first;
  for (const field of [
    'reviews',
    'reviewThreads',
    'reviewRequests',
    'contexts',
    'closingIssuesReferences',
  ] as const) {
    let target = connectionOf(pr, field);
    if (target === undefined) continue;
    let cursor = pageCursor(target);
    if (cursor === null) return malformedPaging();
    const seen = new Set<string>();
    while (cursor !== undefined) {
      if (seen.has(cursor)) return malformedPaging();
      seen.add(cursor);
      const response = await client.query(
        pageQuery(field),
        { owner, repo: name, number, after: cursor },
        signal,
      );
      budget(response.budget);
      rejectUnscoped(response.errors, ['repository']);
      requireCheckAccess(response.errors);
      const denied = response.errors.some(deniedReference);
      if (withoutDeniedReferences(response.errors).length > 0) return { status: 'denied' };
      const root = content(() =>
        parseWire(pageRootWire, response.data.repository, MALFORMED, ['data', 'repository']),
      );
      if (root instanceof AdapterError) return { status: 'malformed', error: root };
      const page = connectionOf(root.pullRequest, field);
      // A denied later page keeps the references read so far.
      if (page === undefined && denied && field === 'closingIssuesReferences') break;
      if (page === undefined) return malformedPaging();
      target = { nodes: [...target.nodes, ...page.nodes], pageInfo: page.pageInfo };
      pr = withConnection(pr, field, target);
      cursor = pageCursor(page);
      if (cursor === null) return malformedPaging();
    }
  }
  return { status: 'ok', pr };
}
function reachesCursor(nodes: BackPaging['nodes'], cursor: FeedbackCursor | undefined): boolean {
  if (cursor === undefined) return false;
  const postedAt = Date.parse(cursor.postedAt);
  return nodes.some((node) => node.id === cursor.id || Date.parse(node.createdAt) < postedAt);
}
/**
 * Reads comments back from `first` to `cursor`, or to the start of the PR, within
 * `FEEDBACK_PAGES`. A transient failure keeps the comments read so far as incomplete; every
 * other failure, and any failure after an abort, rejects the poll.
 */
async function readFeedback(
  client: GithubClient,
  first: BackPaging,
  owner: string,
  name: string,
  number: number,
  cursor: FeedbackCursor | undefined,
  signal: AbortSignal,
  budget: (value: NonNullable<Batch['budget']>) => void,
): Promise<{ nodes: BackPaging['nodes']; complete: boolean }> {
  let nodes = first.nodes;
  let page = first;
  const seen = new Set<string>();
  try {
    for (
      let pages = 1;
      page.pageInfo.hasPreviousPage && !reachesCursor(page.nodes, cursor);
      pages += 1
    ) {
      const before = page.pageInfo.startCursor;
      if (!before || seen.has(before) || pages >= FEEDBACK_PAGES) return { nodes, complete: false };
      seen.add(before);
      const response = await client.query(
        pageQuery('comments'),
        { owner, repo: name, number, before },
        signal,
      );
      budget(response.budget);
      rejectUnscoped(response.errors, ['repository']);
      if (response.errors.length > 0) return { nodes, complete: false };
      page = parseWire(commentsRootWire, response.data.repository, MALFORMED, [
        'data',
        'repository',
      ]).pullRequest.comments;
      nodes = [...page.nodes, ...nodes];
    }
    return { nodes, complete: true };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof AdapterError && error.kind === 'transient')
      return { nodes, complete: false };
    throw error;
  }
}
/** What a poll has read so far; `processPr` adds to it. */
interface Accumulator {
  complete: boolean;
  entities: Batch['entities'];
  items: Batch['items'];
  /** The last budget a response reported; none before the first answer. */
  budget: Batch['budget'];
  /** The first PR content failure, and how many requested refs it and later ones answered. */
  parseError: AdapterError | undefined;
  parseFailedRefs: number;
}
function accumulator(complete: boolean, budget?: Accumulator['budget']): Accumulator {
  return { complete, entities: [], items: [], budget, parseError: undefined, parseFailedRefs: 0 };
}
interface PrScope {
  client: GithubClient;
  repo: string;
  owner: string;
  name: string;
  keys: KeyRule;
  signal: AbortSignal;
  feedbackCursors?: PollContext['feedbackCursors'];
}
function malformed(acc: Accumulator, error: AdapterError, ref?: PrEntityRef): void {
  acc.parseError ??= error;
  acc.complete = false;
  if (ref) {
    acc.entities.push({ ref, status: 'no_access' });
    acc.parseFailedRefs += 1;
  }
}
async function processPr(
  scope: PrScope,
  acc: Accumulator,
  number: number,
  alias: string,
  data: Record<string, unknown>,
  scopedErrors: GraphError[],
  ref?: PrEntityRef,
): Promise<PrFacts | undefined> {
  const errors = withoutDeniedReferences(scopedErrors);
  requireCheckAccess(errors);
  const error = errors[0];
  if (error !== undefined) {
    const direct = error.path === undefined || error.path.length <= 2;
    if (!ref || !direct || (error.type !== 'NOT_FOUND' && error.type !== 'FORBIDDEN'))
      acc.complete = false;
    if (ref) acc.entities.push({ ref, status: direct ? status(error) : 'no_access' });
    return undefined;
  }
  const root = content(() => parseWire(aliasWire, data[alias], MALFORMED, ['data', alias]));
  if (root instanceof AdapterError) {
    malformed(acc, root, ref);
    return undefined;
  }
  const wire = root?.pullRequest;
  if (wire === null || wire === undefined) {
    if (ref) acc.entities.push({ ref, status: 'not_found' });
    else acc.complete = false;
    return undefined;
  }
  const report = (next: NonNullable<Batch['budget']>): void => {
    acc.budget = next;
  };
  const full = await fullPr(
    scope.client,
    wire,
    scope.owner,
    scope.name,
    number,
    scope.signal,
    report,
  );
  if (full.status === 'denied') {
    acc.complete = false;
    if (ref) acc.entities.push({ ref, status: 'no_access' });
    return undefined;
  }
  if (full.status === 'malformed') {
    malformed(acc, full.error, ref);
    return undefined;
  }
  const cursor = feedbackCursor(scope.feedbackCursors, scope.repo, number);
  const feedback = await readFeedback(
    scope.client,
    full.pr.comments,
    scope.owner,
    scope.name,
    number,
    cursor,
    scope.signal,
    report,
  );
  const pr = { ...full.pr, comments: { ...full.pr.comments, nodes: feedback.nodes } };
  const facts = content(() =>
    normalizePr(ref?.repo ?? scope.repo, pr, scope.keys, feedback.complete),
  );
  if (facts instanceof AdapterError) {
    malformed(acc, facts, ref);
    return undefined;
  }
  acc.items.push({ kind: 'pr', facts });
  if (ref) acc.entities.push({ ref, status: 'ok' });
  return facts;
}
function feedbackCursor(
  cursors: PollContext['feedbackCursors'],
  repo: string,
  number: number,
): FeedbackCursor | undefined {
  return cursors?.find(
    (entry) => entry.ref.number === number && entry.ref.repo.toLowerCase() === repo.toLowerCase(),
  );
}
function closingSelected(keys: KeyRule): boolean {
  return keys.type === 'issues' && keys.sources.includes('closing');
}
// Nothing parsed and no other answer: fail loudly with the path rather than go stale-blind.
function rethrowLoneParseFailure(acc: Accumulator): void {
  if (
    acc.parseError !== undefined &&
    acc.items.length === 0 &&
    acc.entities.length === acc.parseFailedRefs
  )
    throw acc.parseError;
}
/** Request outcomes of one poll, for the failure cap and the nothing-answered rule. */
interface Requests {
  failed: number;
  succeeded: number;
  /** The first transient failure, rethrown when no request of the poll succeeded. */
  firstError: AdapterError | undefined;
}
interface RequestScope {
  client: GithubClient;
  owner: string;
  name: string;
  signal: AbortSignal;
  requests: Requests;
}
/**
 * Sends one request. A transient failure (5xx, a cut-off body, a timeout) is counted and returns
 * undefined; an abort, `throttled`, `auth`, `config` or any other error rejects the poll.
 */
async function attempt(
  scope: RequestScope,
  query: string,
  variables: Record<string, string> = {},
): Promise<ResponseData | undefined> {
  const { requests, signal } = scope;
  // Read through a function: the flag can change while the request is in flight.
  const aborted = (): boolean => signal.aborted;
  if (aborted()) throw new AdapterError('transient', 'GitHub poll aborted');
  try {
    const response = await scope.client.query(
      query,
      { owner: scope.owner, repo: scope.name, ...variables },
      signal,
    );
    requests.succeeded += 1;
    return response;
  } catch (error) {
    if (aborted() || !(error instanceof AdapterError) || error.kind !== 'transient') throw error;
    requests.failed += 1;
    requests.firstError ??= error;
    return undefined;
  }
}
interface Segment {
  numbers: number[];
  /** Undefined when the request failed or was never sent. */
  response: ResponseData | undefined;
}
/**
 * Sends one chunk of aliases. A transient failure resends the chunk as two halves, depth first,
 * down to one PR; once the poll has `MAX_FAILED_REQUESTS` failures nothing more is sent.
 */
async function sendChunk(
  scope: RequestScope,
  numbers: number[],
  build: (numbers: readonly number[]) => string,
): Promise<Segment[]> {
  if (scope.requests.failed >= MAX_FAILED_REQUESTS) return [{ numbers, response: undefined }];
  const response = await attempt(scope, build(numbers));
  if (response !== undefined || numbers.length === 1) return [{ numbers, response }];
  const half = Math.ceil(numbers.length / 2);
  return [
    ...(await sendChunk(scope, numbers.slice(0, half), build)),
    ...(await sendChunk(scope, numbers.slice(half), build)),
  ];
}
function chunks(numbers: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let offset = 0; offset < numbers.length; offset += size)
    out.push(numbers.slice(offset, offset + size));
  return out;
}
const aliasesOf = (numbers: readonly number[]): string[] => numbers.map((_, i) => `pr${String(i)}`);
interface DiscoveryResult {
  ok: boolean;
  found: Discovery;
  bootstrapCursor: SourceCursor | undefined;
}
/** Lists the repository's PRs since the cursor; a transient failure leaves `ok` false. */
async function readDiscovery(
  scope: RequestScope,
  acc: Accumulator,
  ctx: PollContext,
  login: string,
): Promise<DiscoveryResult> {
  const bootstrap = ctx.cursor === undefined;
  const response = await attempt(scope, discoveryQuery(bootstrap));
  if (response === undefined)
    return { ok: false, found: discover([], ctx.cursor, login), bootstrapCursor: undefined };
  acc.budget = response.budget;
  rejectUnscoped(response.errors, ['repository']);
  let ok = scoped(response.errors, 'repository').length === 0;
  const first = ok
    ? parseWire(discoveryRootWire, response.data.repository, MALFORMED, ['data', 'repository'])
        .pullRequests
    : undefined;
  const nodes = first === undefined ? [] : [...first.nodes];
  let cursor = first === undefined || pastCursor(nodes, ctx.cursor) ? undefined : nextPage(first);
  const seenPages = new Set<string>();
  while (cursor !== undefined && ok) {
    if (seenPages.has(cursor)) throw new AdapterError('transient', 'Malformed GitHub pagination');
    seenPages.add(cursor);
    const page = await attempt(scope, pageQuery('pullRequests', bootstrap), { after: cursor });
    if (page === undefined) {
      ok = false;
      break;
    }
    acc.budget = page.budget;
    rejectUnscoped(page.errors, ['repository']);
    if (page.errors.length > 0) {
      ok = false;
      break;
    }
    const connection = parseWire(discoveryRootWire, page.data.repository, MALFORMED, [
      'data',
      'repository',
    ]).pullRequests;
    nodes.push(...connection.nodes);
    cursor = pastCursor(connection.nodes, ctx.cursor) ? undefined : nextPage(connection);
  }
  const found = discover(nodes, ctx.cursor, login);
  const bootstrapCursor =
    bootstrap && ok
      ? (latestUpdatedAt(
          parseWire(baselineRootWire, response.data.repository, MALFORMED, ['data', 'repository'])
            .mergedBaseline.nodes,
          found.cursor,
        ) ?? sourceCursorSchema.parse('1970-01-01T00:00:00.000Z'))
      : undefined;
  return { ok, found, bootstrapCursor };
}
/** Reads the light index of `numbers`; a PR left out of the map is read in full. */
async function readIndex(
  scope: RequestScope,
  acc: Accumulator,
  numbers: readonly number[],
): Promise<Map<number, IndexEntry>> {
  const entries = new Map<number, IndexEntry>();
  for (const chunk of chunks(numbers, INDEX_CHUNK)) {
    for (const { numbers: sent, response } of await sendChunk(scope, chunk, indexQuery)) {
      if (response === undefined) continue;
      acc.budget = response.budget;
      // An unscoped error leaves the whole chunk to the full read.
      if (unscoped(response.errors, aliasesOf(sent))) continue;
      for (const [i, number] of sent.entries()) {
        const alias = `pr${String(i)}`;
        if (scoped(response.errors, alias).length > 0) continue;
        const entry = indexEntry(response.data[alias]);
        if (entry !== undefined) entries.set(number, entry);
      }
    }
  }
  return entries;
}
interface PollArgs {
  id: string;
  repo: string;
  login: string;
  keys: KeyRule;
  client: GithubClient;
  now: () => number;
  ctx: PollContext;
  reserveRemaining: number;
  cache: Map<number, CachedPr>;
}
async function pollRepository({
  id,
  repo,
  login,
  keys,
  client,
  now,
  ctx,
  reserveRemaining,
  cache,
}: PollArgs): Promise<Batch> {
  const observedAt = sourceCursorSchema.parse(new Date(now()).toISOString());
  const bootstrap = ctx.cursor === undefined;
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
  const requested = ctx.observe.prs.filter((ref) => ref.repo.toLowerCase() === repo.toLowerCase());
  const byNumber = new Map<number, PrEntityRef>(requested.map((ref) => [ref.number, ref]));
  const numbers = [...byNumber.keys()];
  const closing = closingSelected(keys);
  for (const number of cache.keys()) if (!byNumber.has(number)) cache.delete(number);
  const acc = accumulator(true);
  const requests: Requests = { failed: 0, succeeded: 0, firstError: undefined };
  const request: RequestScope = { client, owner, name, signal: ctx.signal, requests };
  const discovery = await readDiscovery(request, acc, ctx, login);
  if (!discovery.ok) acc.complete = false;
  const { found } = discovery;
  const entries = await readIndex(request, acc, numbers);
  const cursorKey = (number: number): string =>
    JSON.stringify(feedbackCursor(ctx.feedbackCursors, repo, number) ?? 'none');
  const changed: number[] = [];
  for (const number of numbers) {
    const facts = reusable(cache.get(number), entries.get(number), cursorKey(number), now());
    const ref = byNumber.get(number);
    if (facts !== undefined && ref !== undefined) {
      acc.items.push({ kind: 'pr', facts });
      acc.entities.push({ ref, status: 'ok' });
      continue;
    }
    // A full read below writes a fresh entry only with this poll's fingerprint.
    cache.delete(number);
    changed.push(number);
  }
  const scope: PrScope = {
    client,
    repo,
    owner,
    name,
    keys,
    signal: ctx.signal,
    ...(ctx.feedbackCursors === undefined ? {} : { feedbackCursors: ctx.feedbackCursors }),
  };
  let discoveredOk = true;
  // A chunk given up, deferred for budget or never sent: its PRs are unread, not missing.
  const unread = (chunk: readonly number[]): void => {
    acc.complete = false;
    for (const number of chunk) {
      const ref = byNumber.get(number);
      if (ref) acc.entities.push({ ref, status: 'no_access' });
      if (found.numbers.includes(number)) discoveredOk = false;
    }
  };
  const discovered = found.numbers.filter((number) => !byNumber.has(number));
  for (const chunk of [...chunks(changed, DETAIL_CHUNK), ...chunks(discovered, DETAIL_CHUNK)]) {
    if (acc.budget !== undefined && acc.budget.remaining < reserveRemaining) {
      unread(chunk);
      continue;
    }
    const segments = await sendChunk(request, chunk, (sent) => detailQuery(sent, closing));
    // Every segment was answered before any PR pages, so their budgets come first, in order.
    for (const { response } of segments) if (response !== undefined) acc.budget = response.budget;
    for (const { numbers: sent, response } of segments) {
      if (response === undefined) {
        unread(sent);
        continue;
      }
      rejectUnscoped(response.errors, aliasesOf(sent));
      for (const [i, number] of sent.entries()) {
        const alias = `pr${String(i)}`;
        const ref = byNumber.get(number);
        const errors = scoped(response.errors, alias);
        const facts = await processPr(scope, acc, number, alias, response.data, errors, ref);
        if (facts === undefined) {
          if (found.numbers.includes(number)) discoveredOk = false;
          continue;
        }
        const entry = entries.get(number);
        if (entry !== undefined)
          cache.set(number, {
            fingerprint: entry.fingerprint,
            facts,
            cursorKey: cursorKey(number),
            readAt: now(),
          });
      }
    }
  }
  if (ctx.signal.aborted) throw new AdapterError('transient', 'GitHub poll aborted');
  if (requests.firstError !== undefined && requests.succeeded === 0) throw requests.firstError;
  rethrowLoneParseFailure(acc);
  const nextCursor = bootstrap ? discovery.bootstrapCursor : found.cursor;
  return {
    source: id,
    observedAt,
    complete: acc.complete,
    items: acc.items,
    entities: acc.entities,
    ...(discovery.ok && discoveredOk
      ? nextCursor === undefined
        ? {}
        : { cursor: nextCursor }
      : ctx.cursor === undefined
        ? {}
        : { cursor: ctx.cursor }),
    ...(acc.budget === undefined ? {} : { budget: acc.budget }),
  };
}
interface PrArgs {
  id: string;
  repo: string;
  keys: KeyRule;
  client: GithubClient;
  now: () => number;
  ref: PrEntityRef;
  signal: AbortSignal;
  cache: Map<number, CachedPr>;
}
// Reads one requested PR without discovery (A9): never complete, no cursor. It drops the PR's
// cached facts, so the next poll cannot re-emit facts older than these.
async function pollOnePr({
  id,
  repo,
  keys,
  client,
  now,
  ref,
  signal,
  cache,
}: PrArgs): Promise<Batch> {
  const observedAt = new Date(now()).toISOString();
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
  cache.delete(ref.number);
  const response = await client.query(
    detailQuery([ref.number], closingSelected(keys)),
    { owner, repo: name },
    signal,
  );
  rejectUnscoped(response.errors, ['pr0']);
  const acc = accumulator(false, response.budget);
  const scope: PrScope = { client, repo, owner, name, keys, signal };
  await processPr(
    scope,
    acc,
    ref.number,
    'pr0',
    response.data,
    scoped(response.errors, 'pr0'),
    ref,
  );
  if (signal.aborted) throw new AdapterError('transient', 'GitHub poll aborted');
  rethrowLoneParseFailure(acc);
  return {
    source: id,
    observedAt,
    complete: false,
    items: acc.items,
    entities: acc.entities,
    ...(acc.budget === undefined ? {} : { budget: acc.budget }),
  };
}
