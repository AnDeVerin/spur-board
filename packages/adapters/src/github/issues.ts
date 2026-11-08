import {
  AdapterError,
  type Adapter,
  type Batch,
  type Config,
  type TicketEntityRef,
  type TicketFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure } from '../runner/http.ts';
import { parseWire } from '../runner/wire.ts';

// The PR adapter alone reads `branchPattern`; the issues adapter takes trackers without it.
type Tracker = Omit<
  Extract<Config['projects'][number]['tracker'], { type: 'github-issues' }>,
  'branchPattern'
>;

export interface GithubIssuesOptions {
  id: string;
  tracker: Tracker;
  token: string;
  intervalMs: number;
  fetch?: typeof fetch;
}

class GithubIssuesHttpError extends AdapterError {
  readonly status: number;
  constructor(status: number, failure: AdapterError) {
    super(failure.kind, failure.message, { retryAt: failure.retryAt });
    this.status = status;
  }
}

const MALFORMED = 'Malformed GitHub issue response';
const text = z.string().min(1);
const issueWire = z.object({
  node_id: text,
  number: z.int().positive(),
  title: text,
  state: text,
  html_url: text,
  updated_at: text.refine((value) => !Number.isNaN(Date.parse(value))),
  labels: z.array(z.object({ name: text })),
  assignee: z.object({ login: text }).nullish(),
  milestone: z.object({ title: text }).nullish(),
  pull_request: z.unknown().optional(),
});
type IssueWire = z.output<typeof issueWire>;
const milestoneWire = z.object({ title: z.string(), number: z.int().positive() });

function issueNumber(ref: TicketEntityRef, repo: string): number {
  const match = /^(.+)#([1-9]\d*)$/.exec(ref.key);
  if (match?.[1]?.toLowerCase() !== repo.toLowerCase())
    throw new AdapterError('config', 'Requested issue is outside its configured repository');
  const value = Number(match[2]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new AdapterError('transient', MALFORMED);
  return value;
}

function normalize(
  issue: IssueWire,
  trackerId: string,
  repo: string,
  inFilter: boolean,
): TicketFacts {
  if (issue.pull_request !== undefined)
    throw new AdapterError('transient', 'A pull request cannot be a tracker ticket');
  return {
    trackerId,
    id: issue.node_id,
    key: `${repo}#${String(issue.number)}`,
    title: issue.title,
    status: issue.state,
    assignee: issue.assignee?.login ?? null,
    sprint: issue.milestone?.title ?? null,
    labels: issue.labels.map((label) => label.name),
    inFilter,
    url: issue.html_url,
    updatedAt: new Date(issue.updated_at).toISOString(),
  };
}

function matchesFilter(issue: IssueWire, tracker: Tracker): boolean {
  if (tracker.label !== undefined)
    return issue.labels.some((label) => label.name === tracker.label);
  return issue.milestone?.title === tracker.milestone;
}

/** Lists open filter issues and resolves requested tickets missing from that listing. */
export function createGithubIssuesAdapter(options: GithubIssuesOptions): Adapter {
  const transport = options.fetch ?? fetch;
  const [owner, name] = options.tracker.repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid GitHub Issues repository');
  const root = `https://api.github.com/repos/${owner}/${name}`;

  async function request(
    url: string,
    signal: AbortSignal,
  ): Promise<{ value: unknown; next?: string }> {
    let response: Response;
    try {
      response = await transport(url, {
        signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch {
      throw new AdapterError('transient', 'GitHub issue request failed');
    }
    if (!response.ok) {
      const failure = classifyHttpFailure(
        { status: response.status, headers: response.headers, body: await response.text() },
        Date.now(),
      );
      throw new GithubIssuesHttpError(response.status, failure);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new AdapterError('transient', 'Malformed GitHub issue response');
    }
    const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (next !== undefined) {
      let pageUrl: URL;
      try {
        pageUrl = new URL(next);
      } catch {
        throw new AdapterError('transient', 'Malformed GitHub issue pagination');
      }
      const issuePath = new URL(root).pathname + '/issues';
      const milestonePath = new URL(root).pathname + '/milestones';
      if (
        pageUrl.origin !== 'https://api.github.com' ||
        (pageUrl.pathname !== issuePath && pageUrl.pathname !== milestonePath)
      )
        throw new AdapterError('transient', 'Malformed GitHub issue pagination');
    }
    return { value, ...(next === undefined ? {} : { next }) };
  }

  async function pages(
    url: string,
    signal: AbortSignal,
    allowPartial = false,
  ): Promise<{ values: unknown[]; complete: boolean }> {
    const results: unknown[] = [];
    const seen = new Set<string>();
    let next: string | undefined = url;
    while (next !== undefined) {
      if (seen.has(next)) throw new AdapterError('transient', 'GitHub issue pagination repeated');
      seen.add(next);
      let page: Awaited<ReturnType<typeof request>>;
      try {
        page = await request(next, signal);
      } catch (error) {
        if (allowPartial && error instanceof AdapterError && error.kind === 'transient')
          return { values: results, complete: false };
        throw error;
      }
      results.push(
        ...parseWire(z.array(z.unknown()), page.value, 'Malformed GitHub issue listing'),
      );
      next = page.next;
    }
    return { values: results, complete: true };
  }

  async function milestoneNumber(signal: AbortSignal): Promise<number | undefined> {
    if (options.tracker.milestone === undefined) return undefined;
    let milestones: unknown[];
    try {
      milestones = (await pages(`${root}/milestones?state=all&per_page=100`, signal)).values;
    } catch (error) {
      if (error instanceof GithubIssuesHttpError && error.status === 404)
        throw new AdapterError('config', 'GitHub Issues repository is unavailable');
      throw error;
    }
    const match = parseWire(z.array(milestoneWire), milestones, MALFORMED).find(
      (entry) => entry.title === options.tracker.milestone,
    );
    if (match === undefined)
      throw new AdapterError('config', 'Configured GitHub milestone is missing');
    return match.number;
  }

  return {
    id: options.id,
    intervalMs: options.intervalMs,
    async poll(ctx): Promise<Batch> {
      const observedAt = new Date().toISOString();
      const milestone = await milestoneNumber(ctx.signal);
      const filter = new URL(`${root}/issues`);
      filter.searchParams.set('state', 'open');
      filter.searchParams.set('per_page', '100');
      if (options.tracker.label !== undefined)
        filter.searchParams.set('labels', options.tracker.label);
      if (milestone !== undefined) filter.searchParams.set('milestone', String(milestone));
      let listed: unknown[] = [];
      let complete = true;
      try {
        const result = await pages(filter.toString(), ctx.signal, true);
        listed = result.values;
        complete = result.complete;
      } catch (error) {
        if (error instanceof GithubIssuesHttpError && error.status === 404)
          throw new AdapterError('config', 'GitHub Issues repository is unavailable');
        if (error instanceof AdapterError && error.kind === 'transient') complete = false;
        else throw error;
      }
      const facts = new Map<number, TicketFacts>();
      for (const value of listed) {
        const issue = parseWire(issueWire, value, MALFORMED);
        if (issue.pull_request !== undefined) continue;
        facts.set(issue.number, normalize(issue, options.id, options.tracker.repo, true));
      }
      const entities: Batch['entities'] = [];
      for (const ref of ctx.observe.tickets) {
        if (ref.trackerId !== options.id)
          throw new AdapterError('transient', 'Ticket request belongs to another source');
        const issueNo = issueNumber(ref, options.tracker.repo);
        let fact = facts.get(issueNo);
        if (fact === undefined) {
          try {
            const detail = parseWire(
              issueWire,
              (await request(`${root}/issues/${String(issueNo)}`, ctx.signal)).value,
              MALFORMED,
            );
            if (detail.pull_request !== undefined) {
              entities.push({ ref, status: 'not_found' });
              continue;
            }
            fact = normalize(
              detail,
              options.id,
              options.tracker.repo,
              matchesFilter(detail, options.tracker),
            );
            facts.set(issueNo, fact);
          } catch (error) {
            if (
              error instanceof GithubIssuesHttpError &&
              (error.status === 404 || error.status === 410)
            ) {
              entities.push({ ref, status: 'not_found' });
              continue;
            }
            if (
              error instanceof GithubIssuesHttpError &&
              error.status === 403 &&
              error.kind === 'auth'
            ) {
              entities.push({ ref, status: 'no_access' });
              continue;
            }
            throw error;
          }
        }
        if (ref.id !== undefined && fact.id !== ref.id)
          throw new AdapterError('transient', 'GitHub returned a different issue id');
        entities.push({ ref, status: 'ok' });
      }
      if (ctx.signal.aborted) throw new AdapterError('transient', 'GitHub issue poll aborted');
      return {
        source: options.id,
        observedAt,
        complete,
        items: [...facts.values()].map((item) => ({ kind: 'ticket', facts: item })),
        entities,
      };
    },
  };
}
