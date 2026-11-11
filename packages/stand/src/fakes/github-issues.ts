// A fake of GitHub Issues over REST, driven by `stand fake github issue ...`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouteResult } from '../control.ts';
import { FakeViolation, type FakeModule, type FakeRequest } from './fetch.ts';

const API = 'https://api.github.com';
const GRAPHQL_URL = `${API}/graphql`;
const PAGE_SIZE = 100;
const REPO_ID_BASE = 100_000;
// The headers the adapter sends, written out here on purpose, as the query shapes are.
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

interface Issue {
  number: number;
  nodeId: string;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  milestone: string | null;
  updatedAt: string;
}

interface Repo {
  name: string;
  id: number;
  issues: Map<number, Issue>;
  /** Milestone titles in creation order; a milestone's number is its index plus one. */
  milestones: string[];
}

const target = {
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  number: z.int().positive(),
};
const issueControlSchema = z.discriminatedUnion('verb', [
  z.strictObject({ ...target, verb: z.literal('issue-open'), title: z.string().min(1).optional() }),
  z.strictObject({ ...target, verb: z.literal('issue-close') }),
  z.strictObject({ ...target, verb: z.literal('issue-label'), labels: z.array(z.string().min(1)) }),
  z.strictObject({
    ...target,
    verb: z.literal('issue-milestone'),
    milestone: z.string().min(1).nullable(),
  }),
]);
const ISSUE_VERBS = new Set<string>(
  issueControlSchema.options.map((option) => option.shape.verb.value),
);

/** The query keys a path takes: each required key with its one value, and the optional keys. */
interface QueryRule {
  required: Readonly<Record<string, string>>;
  optional: readonly string[];
}
const MILESTONES_QUERY: QueryRule = {
  required: { state: 'all', per_page: String(PAGE_SIZE) },
  optional: ['page'],
};
const ISSUES_QUERY: QueryRule = {
  required: { state: 'open', per_page: String(PAGE_SIZE) },
  optional: ['labels', 'milestone', 'page'],
};
const NO_QUERY: QueryRule = { required: {}, optional: [] };

/** Checks the query against its rule and returns its values; anything else is a violation. */
function readQuery(url: URL, rule: QueryRule): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (values.has(key)) throw new FakeViolation(`Query parameter ${key} is repeated.`);
    if (!(key in rule.required) && !rule.optional.includes(key))
      throw new FakeViolation(`Unknown query parameter ${key} on ${url.pathname}.`);
    values.set(key, value);
  }
  for (const [key, value] of Object.entries(rule.required))
    if (values.get(key) !== value)
      throw new FakeViolation(`Expected ${key}=${value} on ${url.pathname}.`);
  const page = values.get('page');
  if (page !== undefined && !/^[1-9]\d*$/.test(page))
    throw new FakeViolation(`Query parameter page=${page} is not a page number.`);
  return values;
}

function checkHeaders(request: FakeRequest): void {
  if (request.method !== 'GET')
    throw new FakeViolation(`GitHub Issues takes GET, got ${request.method}.`);
  for (const [name, value] of Object.entries(HEADERS))
    if (request.headers.get(name) !== value)
      throw new FakeViolation(`Expected header ${name}: ${value}.`);
  if (!/^Bearer \S+$/.test(request.headers.get('authorization') ?? ''))
    throw new FakeViolation('Expected a Bearer authorization header.');
}

/** Issues of the configured repositories, with the verbs that change them. */
export function createGithubIssuesFake(options: {
  now: () => number;
  repos: readonly string[];
}): FakeModule {
  const { now } = options;
  const repos = new Map<string, Repo>();
  const iso = (ms: number): string => new Date(ms).toISOString();

  function fresh(): void {
    repos.clear();
    options.repos.forEach((name, index) => {
      repos.set(name.toLowerCase(), {
        name,
        id: REPO_ID_BASE + index,
        issues: new Map(),
        milestones: [],
      });
    });
  }
  fresh();

  /** Moves `updatedAt` strictly forward, so two verbs in one millisecond still differ. */
  function touch(issue: Issue): void {
    issue.updatedAt = iso(Math.max(now(), Date.parse(issue.updatedAt) + 1));
  }

  function issueView(repo: Repo, issue: Issue) {
    const milestone = issue.milestone;
    return {
      node_id: issue.nodeId,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      html_url: `https://github.stand.invalid/${repo.name}/issues/${String(issue.number)}`,
      updated_at: issue.updatedAt,
      labels: issue.labels.map((name) => ({ name })),
      assignee: null,
      milestone:
        milestone === null
          ? null
          : { title: milestone, number: repo.milestones.indexOf(milestone) + 1 },
    };
  }

  /** One page of `items`, with a GitHub `link` header whose next page is on `/repositories/<id>`. */
  function paged(repo: Repo, url: URL, kind: string, items: readonly unknown[]) {
    const page = Number(url.searchParams.get('page') ?? '1');
    const last = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const link = (to: number): string => {
      const next = new URL(`${API}/repositories/${String(repo.id)}/${kind}`);
      for (const [key, value] of url.searchParams)
        if (key !== 'page') next.searchParams.set(key, value);
      next.searchParams.set('page', String(to));
      return next.href;
    };
    const links =
      page < last ? [`<${link(page + 1)}>; rel="next"`, `<${link(last)}>; rel="last"`] : [];
    return {
      status: 200,
      body: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      ...(links.length === 0 ? {} : { headers: { link: links.join(', ') } }),
    };
  }

  function listIssues(repo: Repo, url: URL) {
    const query = readQuery(url, ISSUES_QUERY);
    const labels = query.get('labels')?.split(',');
    const milestone = query.get('milestone');
    let title: string | undefined;
    if (milestone !== undefined) {
      title = /^[1-9]\d*$/.test(milestone) ? repo.milestones[Number(milestone) - 1] : undefined;
      if (title === undefined) throw new FakeViolation(`Unknown milestone ${milestone}.`);
    }
    const items = [...repo.issues.values()]
      .filter(
        (issue) =>
          issue.state === 'open' &&
          (labels === undefined || labels.every((label) => issue.labels.includes(label))) &&
          (title === undefined || issue.milestone === title),
      )
      // GitHub's default order: newest first.
      .sort((a, b) => b.number - a.number)
      .map((issue) => issueView(repo, issue));
    return () => paged(repo, url, 'issues', items);
  }

  function listMilestones(repo: Repo, url: URL) {
    readQuery(url, MILESTONES_QUERY);
    const items = repo.milestones.map((title, index) => ({ title, number: index + 1 }));
    return () => paged(repo, url, 'milestones', items);
  }

  function repoByName(owner: string, name: string): Repo {
    const repo = repos.get(`${owner}/${name}`.toLowerCase());
    if (repo === undefined) throw new FakeViolation(`Unknown repository ${owner}/${name}.`);
    return repo;
  }

  function route(url: URL): () => { status: number; body: unknown } {
    let segments: string[];
    try {
      segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
    } catch {
      throw new FakeViolation(`Malformed path ${url.pathname}.`);
    }
    const [root, ...rest] = segments;
    if (root === 'repositories' && rest.length === 2) {
      const [id, kind] = rest;
      const repo = [...repos.values()].find((candidate) => String(candidate.id) === id);
      if (repo === undefined) throw new FakeViolation(`Unknown repository id ${id ?? ''}.`);
      if (kind === 'issues') return listIssues(repo, url);
      if (kind === 'milestones') return listMilestones(repo, url);
    }
    if (root === 'repos' && rest.length >= 2 && rest.length <= 4) {
      const [owner = '', name = '', kind, number] = rest;
      const repo = repoByName(owner, name);
      if (kind === undefined) {
        readQuery(url, NO_QUERY);
        return () => ({ status: 200, body: { id: repo.id } });
      }
      if (kind === 'issues' && number === undefined) return listIssues(repo, url);
      if (kind === 'milestones' && number === undefined) return listMilestones(repo, url);
      if (kind === 'issues' && number !== undefined && /^[1-9]\d*$/.test(number)) {
        readQuery(url, NO_QUERY);
        return () => {
          const issue = repo.issues.get(Number(number));
          return issue === undefined
            ? { status: 404, body: { message: 'Not Found' } }
            : { status: 200, body: issueView(repo, issue) };
        };
      }
    }
    throw new FakeViolation(
      `Unknown GitHub REST path ${url.pathname}: if the adapter changed on purpose, update packages/stand/src/fakes/github-issues.ts.`,
    );
  }

  function control(verb: string, args: unknown): RouteResult | undefined {
    if (!ISSUE_VERBS.has(verb)) return undefined;
    const parsed = issueControlSchema.safeParse({ ...(args as object), verb });
    if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
    const command = parsed.data;
    const repo = repos.get(command.repo.toLowerCase());
    if (repo === undefined)
      return {
        status: 400,
        body: { error: 'Unknown repository.', repos: [...repos.values()].map((r) => r.name) },
      };
    const name = `${repo.name}#${String(command.number)}`;
    let issue = repo.issues.get(command.number);
    if (command.verb === 'issue-open') {
      if (issue === undefined) {
        issue = {
          number: command.number,
          nodeId: `I_${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 20)}`,
          title: command.title ?? `Stand issue ${String(command.number)}`,
          state: 'open',
          labels: [],
          milestone: null,
          updatedAt: iso(now()),
        };
        repo.issues.set(command.number, issue);
        return {
          status: 200,
          body: { issue: name, state: issue.state, updatedAt: issue.updatedAt },
        };
      }
      if (issue.state === 'open') return { status: 409, body: { error: `Issue ${name} is open.` } };
      issue.state = 'open';
      if (command.title !== undefined) issue.title = command.title;
    } else {
      if (issue === undefined) return { status: 404, body: { error: `No issue ${name}.` } };
      switch (command.verb) {
        case 'issue-close':
          if (issue.state === 'closed')
            return { status: 409, body: { error: `Issue ${name} is closed.` } };
          issue.state = 'closed';
          break;
        case 'issue-label':
          issue.labels = [...new Set(command.labels)];
          break;
        case 'issue-milestone':
          if (command.milestone !== null && !repo.milestones.includes(command.milestone))
            repo.milestones.push(command.milestone);
          issue.milestone = command.milestone;
          break;
      }
    }
    touch(issue);
    return { status: 200, body: { issue: name, state: issue.state, updatedAt: issue.updatedAt } };
  }

  return {
    system: 'github',
    // Every other GitHub API URL, so an unknown REST call lands in the violation log.
    claims: (url) => url.origin === API && url.href !== GRAPHQL_URL,
    prepare(request) {
      checkHeaders(request);
      return route(request.url);
    },
    control,
    reset: fresh,
  };
}
