import {
  AdapterError,
  type Adapter,
  type Batch,
  type Config,
  type PollContext,
  type PrEntityRef,
} from '@spur-board/contracts';
import {
  GithubClient,
  initialQuery,
  detailQuery,
  pageQuery,
  list,
  record,
  type GraphError,
  type Json,
  type RecordValue,
} from './client.ts';
import { discover, discoveryNodes, nextPage } from './discovery.ts';
import { normalizePr } from './prBatch.ts';

export interface GithubSource {
  adapter: Adapter;
  reserveRemaining: number;
  repo: string;
}
export interface GithubOptions {
  token: string;
  fetch?: typeof fetch;
}
export function sourceId(project: string, repo: string): string {
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
      const client = new GithubClient(options.token, options.fetch);
      const prefixes = project.tracker.type === 'jira' ? project.tracker.projectKeys : [];
      sources.push({
        repo,
        reserveRemaining: config.github.reserveRemaining,
        adapter: {
          id,
          intervalMs: config.adapters.github.intervalMs,
          poll: (ctx) =>
            pollRepository({ id, repo, login: project.operatorGithubLogin, prefixes, client, ctx }),
        },
      });
    }
  }
  return sources;
}
function scoped(errors: readonly GraphError[], root: string): GraphError[] {
  return errors.filter((error) => error.path?.[0] === root);
}
function rejectUnscoped(errors: readonly GraphError[], roots: readonly string[]): void {
  if (errors.some((error) => error.path === undefined || !roots.includes(String(error.path[0])))) {
    throw new AdapterError('transient', 'Unscoped GitHub GraphQL error');
  }
}
function status(error: GraphError): 'not_found' | 'no_access' {
  return error.type === 'NOT_FOUND' ? 'not_found' : 'no_access';
}
function aliasPr(data: RecordValue, alias: string): Json | undefined {
  const value = data[alias];
  return value === null || value === undefined ? null : nested(data, alias, 'pullRequest');
}
function nested(value: RecordValue, ...path: string[]): Json | undefined {
  let current: Json | undefined = value;
  for (const field of path) current = record(current)[field];
  return current;
}
function contexts(pr: RecordValue): RecordValue | undefined {
  const commits = list(record(pr.commits).nodes);
  if (commits.length === 0) return undefined;
  const value = record(record(commits[0]).commit).statusCheckRollup;
  return value === null || value === undefined ? undefined : record(record(value).contexts);
}
async function fullPr(
  client: GithubClient,
  pr: RecordValue,
  owner: string,
  name: string,
  number: number,
  signal: AbortSignal,
  budget: (value: NonNullable<Batch['budget']>) => void,
): Promise<RecordValue | undefined> {
  for (const field of ['reviews', 'reviewThreads', 'reviewRequests', 'contexts'] as const) {
    const target = field === 'contexts' ? contexts(pr) : record(pr[field]);
    if (target === undefined) continue;
    let cursor = nextPage(target);
    const seen = new Set<string>();
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new AdapterError('transient', 'Malformed GitHub pagination');
      seen.add(cursor);
      const response = await client.query(
        pageQuery(field),
        { owner, repo: name, number, after: cursor },
        signal,
      );
      budget(response.budget);
      rejectUnscoped(response.errors, ['repository']);
      if (response.errors.length > 0) return undefined;
      const pagePr = record(nested(response.data, 'repository', 'pullRequest'));
      const page = field === 'contexts' ? contexts(pagePr) : record(pagePr[field]);
      if (page === undefined) throw new AdapterError('transient', 'Malformed GitHub pagination');
      const nodes = list(target.nodes);
      nodes.push(...list(page.nodes));
      cursor = nextPage(page);
      target.pageInfo = page.pageInfo ?? null;
    }
  }
  return pr;
}
interface PollArgs {
  id: string;
  repo: string;
  login: string;
  prefixes: readonly string[];
  client: GithubClient;
  ctx: PollContext;
}
async function pollRepository({
  id,
  repo,
  login,
  prefixes,
  client,
  ctx,
}: PollArgs): Promise<Batch> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
  const requested = ctx.observe.prs.filter((ref) => ref.repo.toLowerCase() === repo.toLowerCase());
  const byNumber = new Map<number, PrEntityRef>(requested.map((ref) => [ref.number, ref]));
  const numbers = [...byNumber.keys()];
  const response = await client.query(initialQuery(numbers), { owner, repo: name }, ctx.signal);
  let budget = response.budget;
  let complete = true;
  const roots = ['repository', ...numbers.map((_, i) => `pr${String(i)}`)];
  rejectUnscoped(response.errors, roots);
  const entities: Batch['entities'] = [];
  const items: Batch['items'] = [];
  let discoveryOk = scoped(response.errors, 'repository').length === 0;
  const first = discoveryOk ? nested(response.data, 'repository', 'pullRequests') : undefined;
  const nodes = first === undefined ? [] : discoveryNodes(first);
  let cursor = first === undefined ? undefined : nextPage(first);
  const seenPages = new Set<string>();
  while (cursor !== undefined && discoveryOk) {
    if (seenPages.has(cursor)) throw new AdapterError('transient', 'Malformed GitHub pagination');
    seenPages.add(cursor);
    const page = await client.query(
      pageQuery('pullRequests'),
      { owner, repo: name, after: cursor },
      ctx.signal,
    );
    budget = page.budget;
    rejectUnscoped(page.errors, ['repository']);
    if (page.errors.length > 0) {
      discoveryOk = false;
      break;
    }
    const connection = nested(page.data, 'repository', 'pullRequests');
    nodes.push(...discoveryNodes(connection));
    cursor = nextPage(connection);
  }
  if (!discoveryOk) complete = false;
  const found = discover(nodes, ctx.cursor, login);
  const process = async (
    number: number,
    wire: Json | undefined,
    errors: GraphError[],
    ref?: PrEntityRef,
  ): Promise<boolean> => {
    const error = errors[0];
    if (error !== undefined) {
      const direct = error.path === undefined || error.path.length <= 2;
      if (!ref || !direct || (error.type !== 'NOT_FOUND' && error.type !== 'FORBIDDEN'))
        complete = false;
      if (ref) entities.push({ ref, status: direct ? status(error) : 'no_access' });
      return false;
    }
    if (wire === null || wire === undefined) {
      if (ref) entities.push({ ref, status: 'not_found' });
      else complete = false;
      return false;
    }
    const full = await fullPr(client, record(wire), owner, name, number, ctx.signal, (next) => {
      budget = next;
    });
    if (full === undefined) {
      complete = false;
      if (ref) entities.push({ ref, status: 'no_access' });
      return false;
    }
    const facts = normalizePr(ref?.repo ?? repo, full, prefixes);
    items.push({ kind: 'pr', facts });
    if (ref) entities.push({ ref, status: 'ok' });
    return true;
  };
  let discoveredOk = true;
  for (const [i, number] of numbers.entries()) {
    const alias = `pr${String(i)}`;
    const errors = scoped(response.errors, alias);
    const wire = aliasPr(response.data, alias);
    if (
      !(await process(number, wire, errors, byNumber.get(number))) &&
      found.numbers.includes(number)
    )
      discoveredOk = false;
  }
  const discovered = found.numbers.filter((number) => !byNumber.has(number));
  if (discovered.length > 0) {
    const detail = await client.query(detailQuery(discovered), { owner, repo: name }, ctx.signal);
    budget = detail.budget;
    rejectUnscoped(
      detail.errors,
      discovered.map((_, i) => `pr${String(i)}`),
    );
    for (const [i, number] of discovered.entries()) {
      const alias = `pr${String(i)}`;
      const wire = aliasPr(detail.data, alias);
      if (!(await process(number, wire, scoped(detail.errors, alias)))) discoveredOk = false;
    }
  }
  if (ctx.signal.aborted) throw new AdapterError('transient', 'GitHub poll aborted');
  return {
    source: id,
    observedAt: new Date().toISOString(),
    complete,
    items,
    entities,
    ...(discoveryOk && discoveredOk
      ? found.cursor === undefined
        ? {}
        : { cursor: found.cursor }
      : ctx.cursor === undefined
        ? {}
        : { cursor: ctx.cursor }),
    budget,
  };
}
