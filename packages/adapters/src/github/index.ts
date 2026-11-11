import {
  AdapterError,
  type Adapter,
  type Batch,
  type Config,
  type PollContext,
  type PrEntityRef,
  sourceCursorSchema,
} from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';
import {
  GithubClient,
  connectionWire,
  deniedReference,
  detailQuery,
  initialQuery,
  pageQuery,
  type GraphError,
} from './client.ts';
import {
  baselineNodeWire,
  discover,
  discoveryNodeWire,
  latestUpdatedAt,
  nextPage,
  pastCursor,
} from './discovery.ts';
import { normalizePr, projectKeyRule, type KeyRule } from './prBatch.ts';

const MALFORMED = 'Malformed GitHub response';
const discoveryRootWire = z.object({ pullRequests: connectionWire(discoveryNodeWire) });
const baselineRootWire = z.object({
  mergedBaseline: z.object({ nodes: z.array(baselineNodeWire) }),
});
// Pagination reads only the paged connections; normalizePr parses the PR content once merged.
const pagingWire = connectionWire(z.unknown());
const prPagingWire = z.looseObject({
  reviews: pagingWire,
  reviewThreads: pagingWire,
  reviewRequests: pagingWire,
  statusCheckRollup: z.object({ contexts: pagingWire }).nullish(),
  closingIssuesReferences: pagingWire.nullish(),
});
const aliasWire = z.object({ pullRequest: prPagingWire.nullish() }).nullish();
const pageRootWire = z.object({ pullRequest: prPagingWire.partial() });
type Paging = z.output<typeof pagingWire>;
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
            }),
          pollPr: (ref, ctx) =>
            pollOnePr({ id, repo, keys, client, now: options.now, ref, signal: ctx.signal }),
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
function rejectUnscoped(errors: readonly GraphError[], roots: readonly string[]): void {
  if (errors.some((error) => error.path === undefined || !roots.includes(String(error.path[0])))) {
    throw new AdapterError('transient', 'Unscoped GitHub GraphQL error');
  }
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
/** What a poll has read so far; `processPr` adds to it. */
interface Accumulator {
  complete: boolean;
  entities: Batch['entities'];
  items: Batch['items'];
  budget: NonNullable<Batch['budget']>;
  /** The first PR content failure, and how many requested refs it and later ones answered. */
  parseError: AdapterError | undefined;
  parseFailedRefs: number;
}
function accumulator(complete: boolean, budget: Accumulator['budget']): Accumulator {
  return { complete, entities: [], items: [], budget, parseError: undefined, parseFailedRefs: 0 };
}
interface PrScope {
  client: GithubClient;
  repo: string;
  owner: string;
  name: string;
  keys: KeyRule;
  signal: AbortSignal;
}
function malformed(acc: Accumulator, error: AdapterError, ref?: PrEntityRef): false {
  acc.parseError ??= error;
  acc.complete = false;
  if (ref) {
    acc.entities.push({ ref, status: 'no_access' });
    acc.parseFailedRefs += 1;
  }
  return false;
}
async function processPr(
  scope: PrScope,
  acc: Accumulator,
  number: number,
  alias: string,
  data: Record<string, unknown>,
  scopedErrors: GraphError[],
  ref?: PrEntityRef,
): Promise<boolean> {
  const errors = withoutDeniedReferences(scopedErrors);
  requireCheckAccess(errors);
  const error = errors[0];
  if (error !== undefined) {
    const direct = error.path === undefined || error.path.length <= 2;
    if (!ref || !direct || (error.type !== 'NOT_FOUND' && error.type !== 'FORBIDDEN'))
      acc.complete = false;
    if (ref) acc.entities.push({ ref, status: direct ? status(error) : 'no_access' });
    return false;
  }
  const root = content(() => parseWire(aliasWire, data[alias], MALFORMED, ['data', alias]));
  if (root instanceof AdapterError) return malformed(acc, root, ref);
  const wire = root?.pullRequest;
  if (wire === null || wire === undefined) {
    if (ref) acc.entities.push({ ref, status: 'not_found' });
    else acc.complete = false;
    return false;
  }
  const full = await fullPr(
    scope.client,
    wire,
    scope.owner,
    scope.name,
    number,
    scope.signal,
    (next) => {
      acc.budget = next;
    },
  );
  if (full.status === 'denied') {
    acc.complete = false;
    if (ref) acc.entities.push({ ref, status: 'no_access' });
    return false;
  }
  if (full.status === 'malformed') return malformed(acc, full.error, ref);
  const facts = content(() => normalizePr(ref?.repo ?? scope.repo, full.pr, scope.keys));
  if (facts instanceof AdapterError) return malformed(acc, facts, ref);
  acc.items.push({ kind: 'pr', facts });
  if (ref) acc.entities.push({ ref, status: 'ok' });
  return true;
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
interface PollArgs {
  id: string;
  repo: string;
  login: string;
  keys: KeyRule;
  client: GithubClient;
  now: () => number;
  ctx: PollContext;
}
async function pollRepository({
  id,
  repo,
  login,
  keys,
  client,
  now,
  ctx,
}: PollArgs): Promise<Batch> {
  const observedAt = sourceCursorSchema.parse(new Date(now()).toISOString());
  const bootstrap = ctx.cursor === undefined;
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
  const requested = ctx.observe.prs.filter((ref) => ref.repo.toLowerCase() === repo.toLowerCase());
  const byNumber = new Map<number, PrEntityRef>(requested.map((ref) => [ref.number, ref]));
  const numbers = [...byNumber.keys()];
  const closing = closingSelected(keys);
  const response = await client.query(
    initialQuery(numbers, bootstrap, closing),
    { owner, repo: name },
    ctx.signal,
  );
  const acc = accumulator(true, response.budget);
  const roots = ['repository', ...numbers.map((_, i) => `pr${String(i)}`)];
  rejectUnscoped(response.errors, roots);
  let discoveryOk = scoped(response.errors, 'repository').length === 0;
  const first = discoveryOk
    ? parseWire(discoveryRootWire, response.data.repository, MALFORMED, ['data', 'repository'])
        .pullRequests
    : undefined;
  const nodes = first === undefined ? [] : [...first.nodes];
  let cursor = first === undefined || pastCursor(nodes, ctx.cursor) ? undefined : nextPage(first);
  const seenPages = new Set<string>();
  while (cursor !== undefined && discoveryOk) {
    if (seenPages.has(cursor)) throw new AdapterError('transient', 'Malformed GitHub pagination');
    seenPages.add(cursor);
    const page = await client.query(
      pageQuery('pullRequests', bootstrap),
      { owner, repo: name, after: cursor },
      ctx.signal,
    );
    acc.budget = page.budget;
    rejectUnscoped(page.errors, ['repository']);
    if (page.errors.length > 0) {
      discoveryOk = false;
      break;
    }
    const connection = parseWire(discoveryRootWire, page.data.repository, MALFORMED, [
      'data',
      'repository',
    ]).pullRequests;
    nodes.push(...connection.nodes);
    cursor = pastCursor(connection.nodes, ctx.cursor) ? undefined : nextPage(connection);
  }
  if (!discoveryOk) acc.complete = false;
  const found = discover(nodes, ctx.cursor, login);
  const bootstrapCursor =
    bootstrap && discoveryOk
      ? (latestUpdatedAt(
          parseWire(baselineRootWire, response.data.repository, MALFORMED, ['data', 'repository'])
            .mergedBaseline.nodes,
          found.cursor,
        ) ?? sourceCursorSchema.parse('1970-01-01T00:00:00.000Z'))
      : undefined;
  const scope: PrScope = { client, repo, owner, name, keys, signal: ctx.signal };
  let discoveredOk = true;
  for (const [i, number] of numbers.entries()) {
    const alias = `pr${String(i)}`;
    const errors = scoped(response.errors, alias);
    if (
      !(await processPr(scope, acc, number, alias, response.data, errors, byNumber.get(number))) &&
      found.numbers.includes(number)
    )
      discoveredOk = false;
  }
  const discovered = found.numbers.filter((number) => !byNumber.has(number));
  for (let offset = 0; offset < discovered.length; offset += 50) {
    const chunk = discovered.slice(offset, offset + 50);
    const detail = await client.query(
      detailQuery(chunk, closing),
      { owner, repo: name },
      ctx.signal,
    );
    acc.budget = detail.budget;
    rejectUnscoped(
      detail.errors,
      chunk.map((_, i) => `pr${String(i)}`),
    );
    for (const [i, number] of chunk.entries()) {
      const alias = `pr${String(i)}`;
      if (!(await processPr(scope, acc, number, alias, detail.data, scoped(detail.errors, alias))))
        discoveredOk = false;
    }
  }
  if (ctx.signal.aborted) throw new AdapterError('transient', 'GitHub poll aborted');
  rethrowLoneParseFailure(acc);
  const nextCursor = bootstrap ? bootstrapCursor : found.cursor;
  return {
    source: id,
    observedAt,
    complete: acc.complete,
    items: acc.items,
    entities: acc.entities,
    ...(discoveryOk && discoveredOk
      ? nextCursor === undefined
        ? {}
        : { cursor: nextCursor }
      : ctx.cursor === undefined
        ? {}
        : { cursor: ctx.cursor }),
    budget: acc.budget,
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
}
// Reads one requested PR without discovery (A9): never complete, no cursor.
async function pollOnePr({ id, repo, keys, client, now, ref, signal }: PrArgs): Promise<Batch> {
  const observedAt = new Date(now()).toISOString();
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
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
    budget: acc.budget,
  };
}
