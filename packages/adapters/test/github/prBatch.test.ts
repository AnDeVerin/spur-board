import { createHash } from 'node:crypto';
import {
  AdapterError,
  DEFAULT_LINK,
  batchSchema,
  configSchema,
  isExternalAuthor,
  prFactsSchema,
  sourceCursorSchema,
  type Adapter,
} from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  detailQuery,
  discoveryQuery,
  indexQuery,
  pageQuery,
  type Json,
} from '../../src/github/client.ts';
import { githubSources } from '../../src/github/index.ts';
import { CLOSED_REFRESH_MS, OPEN_REFRESH_MS } from '../../src/github/prIndex.ts';
import { sampleLinkRules } from '../../src/github/linkSample.ts';
import { normalizePr, ticketKeys, type KeyRule } from '../../src/github/prBatch.ts';

const sha = 'a'.repeat(40);
const demoKeys: KeyRule = { type: 'prefixes', prefixes: ['DEMO'] };
const time = '2026-01-02T00:00:00.000Z';
const ref = { kind: 'pr' as const, repo: 'demo/widgets', number: 7 };
const conn = (nodes: Json[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
// A comment page read back from the newest; `startCursor` set means older pages remain.
const back = (
  nodes: Json[],
  startCursor: string | null = null,
  hasPreviousPage = startCursor !== null,
) => ({
  nodes,
  pageInfo: { hasPreviousPage, startCursor },
});
function wire(number = 7) {
  return {
    id: `PR_${String(number)}`,
    number,
    url: `https://github.com/demo/widgets/pull/${String(number)}`,
    title: 'DEMO-42 Add widget',
    updatedAt: time,
    mergedAt: null,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'BLOCKED',
    author: { login: 'operator' },
    headRefName: 'DEMO-42-widget',
    headRefOid: sha,
    statusCheckRollup: {
      contexts: conn([
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-01-01T00:00:00.000Z',
          isRequired: true,
        },
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SKIPPED',
          completedAt: time,
          isRequired: true,
        },
        {
          __typename: 'CheckRun',
          name: 'optional',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          completedAt: time,
          isRequired: false,
        },
      ]),
    },
    reviews: conn([
      {
        id: 'PRR_1',
        author: { __typename: 'User', login: 'reviewer' },
        state: 'APPROVED',
        commit: { oid: sha },
        submittedAt: time,
      },
    ]),
    comments: back([]),
    reviewThreads: conn([{ isResolved: false }]),
    reviewRequests: conn([
      { requestedReviewer: { __typename: 'User', login: 'reviewer' }, asCodeOwner: true },
    ]),
  };
}
function config(repos = ['demo/widgets'], link?: Record<string, unknown>) {
  return configSchema.parse({
    projects: [
      {
        id: 'demo',
        tracker: {
          type: 'jira',
          baseUrl: 'https://jira.example.test',
          jql: 'project = DEMO',
          doneStatuses: ['Done'],
          readyStatuses: ['Ready'],
          projectKeys: ['DEMO'],
        },
        repos,
        ...(link === undefined ? {} : { link }),
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'U123' },
    digest: { tz: 'UTC' },
  });
}
const response = (data: unknown, errors?: unknown[]) => {
  const repository = (data as { repository?: object }).repository;
  return new Response(
    JSON.stringify({
      data: {
        rateLimit: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z' },
        ...(data as object),
        ...(repository ? { repository: { mergedBaseline: { nodes: [] }, ...repository } } : {}),
      },
      ...(errors ? { errors } : {}),
    }),
    { status: 200 },
  );
};
const isAlias = (root: unknown): boolean => /^pr\d+$/.test(String(root));
const operationOf = (query: string): string | undefined => /^query (\w+)/.exec(query)?.[1];
function queryOf(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('Missing GraphQL body');
  return (JSON.parse(body) as { query: string }).query;
}
/** Every query the adapter sent through `routed`, by the mock it wraps. */
const sent = new WeakMap<typeof fetch, string[]>();
type Combined = { data?: Record<string, unknown> | null; errors?: { path?: unknown[] }[] };
/**
 * Answers the split PR poll from a mock written for one combined `PrBatch` answer. Discovery
 * takes the `repository` root and its errors; the index and the first `PrDetails` read take the
 * `pr<i>` roots and their errors. The full PR wire lacks the index fields, so every requested
 * PR is read in full. Any other request, or an answer with no `pr<i>` root, passes through.
 */
function routed(fetcher: typeof fetch): typeof fetch {
  const queries: string[] = [];
  sent.set(fetcher, queries);
  let aliases: string | undefined;
  return async (input, init) => {
    const query = queryOf(init);
    const operation = operationOf(query);
    queries.push(query);
    if (aliases !== undefined && (operation === 'PrIndex' || operation === 'PrDetails')) {
      const body = aliases;
      if (operation === 'PrDetails') aliases = undefined;
      return new Response(body, { status: 200 });
    }
    const answer = await fetcher(input, init);
    if (operation !== 'PrBatch' || !answer.ok) return answer;
    let combined: Combined;
    try {
      combined = (await answer.clone().json()) as Combined;
    } catch {
      return answer;
    }
    const data = combined.data;
    if (!data || !Object.keys(data).some(isAlias)) return answer;
    const part = (alias: boolean): string => {
      const errors = (combined.errors ?? []).filter((error) => isAlias(error.path?.[0]) === alias);
      const roots = Object.entries(data).filter(
        ([root]) => root === 'rateLimit' || isAlias(root) === alias,
      );
      return JSON.stringify({
        data: Object.fromEntries(roots),
        ...(errors.length > 0 ? { errors } : {}),
      });
    };
    aliases = part(true);
    return new Response(part(false), { status: 200, headers: answer.headers });
  };
}
/** The queries sent through `routed`, optionally only those of one operation. */
function sentQueries(fetcher: typeof fetch, operation?: string): string[] {
  const queries = sent.get(fetcher) ?? [];
  return operation === undefined
    ? queries
    : queries.filter((query) => operationOf(query) === operation);
}
const detailsSent = (fetcher: typeof fetch): string => {
  const query = sentQueries(fetcher, 'PrDetails')[0];
  if (query === undefined) throw new Error('No PrDetails request');
  return query;
};
function adapter(
  fetcher: typeof fetch,
  configured = config(),
  index = 0,
  now: () => number = () => Date.now(),
): Adapter {
  const source = githubSources(configured, { token: 'synthetic', now, fetch: routed(fetcher) })[
    index
  ];
  if (source === undefined) throw new Error('Missing GitHub source');
  return source.adapter;
}
function issuesConfig(repos = ['demo/widgets'], link?: Record<string, unknown>) {
  return configSchema.parse({
    projects: [
      {
        id: 'demo',
        tracker: {
          type: 'github-issues',
          repo: 'demo/widgets',
          label: 'board',
        },
        repos,
        ...(link === undefined ? {} : { link }),
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'U123' },
    digest: { tz: 'UTC' },
  });
}
const closingRef = (number: number, repo = 'demo/widgets') => ({
  number,
  repository: { nameWithOwner: repo },
});
function issuesPr(branch: string, closing: unknown, number = 7, title?: string) {
  return {
    ...wire(number),
    headRefName: branch,
    closingIssuesReferences: closing,
    ...(title === undefined ? {} : { title }),
  };
}
const keysOf = (batch: { items: { kind: string; facts?: unknown }[] }) =>
  batch.items.map((item) => (item.facts as { ticketKeys: string[] }).ticketKeys);
function bodyQuery(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): string {
  const body = fetcher.mock.calls[call]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Missing GraphQL body');
  return (JSON.parse(body) as { query: string }).query;
}
const context = (prs = [ref], cursor?: string) => ({
  observe: { prs, tickets: [], sessions: [] },
  ...(cursor ? { cursor: sourceCursorSchema.parse(cursor) } : {}),
  signal: new AbortController().signal,
});

describe('GitHub PR batch', () => {
  it('pins the discovery and detail queries', () => {
    const query = discoveryQuery();
    expect(createHash('sha256').update(query).digest('hex')).toBe(
      '284d2507ec8443328149d3ce5a183b4f60c443a95a960735b9a1ce898c9770a7',
    );
    expect(query).toContain('rateLimit { remaining resetAt }');
    expect(query).toContain('pullRequests(first: 100');
    expect(query).not.toContain('pr0: repository');
    const details = detailQuery([7]);
    expect(details).toContain('rateLimit { remaining resetAt }');
    expect(details).toContain('pr0: repository');
    const bootstrapQuery = discoveryQuery(true);
    expect(createHash('sha256').update(bootstrapQuery).digest('hex')).toBe(
      'b76634b2684ca242cfdc55a11849db1f7a1c189c65f3eacf8c707b1917091cc3',
    );
    expect(bootstrapQuery).toContain('states: [OPEN]');
    expect(pageQuery('pullRequests', true)).toContain('states: [OPEN]');
    expect(details).not.toContain('closingIssuesReferences');
    expect(bootstrapQuery).not.toContain('closingIssuesReferences');
    const issuesQuery = detailQuery([7], true);
    expect(createHash('sha256').update(issuesQuery).digest('hex')).toBe(
      '1297d9d60dfdb7f3831959c37e5423e5a920c1e105a78267823a0676e9c9cec1',
    );
    expect(issuesQuery).toContain('closingIssuesReferences(first: 100)');
    for (const selection of [details, pageQuery('reviewRequests')]) {
      expect(selection).toContain('requestedReviewer { __typename');
      for (const fragment of [
        '... on Bot { login }',
        '... on Mannequin { login }',
        '... on User { login }',
        '... on Team { slug }',
        '... on EnterpriseTeam { slug }',
      ])
        expect(selection).toContain(fragment);
    }
  });
  it('maps each requested reviewer type to its kind and id', () => {
    const pr = {
      ...wire(),
      reviewRequests: conn([
        { requestedReviewer: { __typename: 'User', login: 'octocat' }, asCodeOwner: false },
        { requestedReviewer: { __typename: 'Mannequin', login: 'imported' }, asCodeOwner: false },
        {
          requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' },
          asCodeOwner: false,
        },
        { requestedReviewer: { __typename: 'Team', slug: 'core' }, asCodeOwner: true },
        {
          requestedReviewer: { __typename: 'EnterpriseTeam', slug: 'platform' },
          asCodeOwner: false,
        },
        // A requested team the token cannot see, as GitHub returns it with no error.
        { requestedReviewer: null, asCodeOwner: true },
      ]),
    };
    expect(normalizePr('demo/widgets', pr, demoKeys, true).reviewRequests).toEqual([
      { kind: 'user', id: 'octocat', asCodeOwner: false },
      { kind: 'user', id: 'imported', asCodeOwner: false },
      { kind: 'bot', id: 'copilot-pull-request-reviewer', asCodeOwner: false },
      { kind: 'team', id: 'core', asCodeOwner: true },
      { kind: 'team', id: 'platform', asCodeOwner: false },
    ]);
  });
  it('normalizes latest required checks, reviews and configured keys', () => {
    const facts = normalizePr('demo/widgets', wire(), demoKeys, true);
    expect(prFactsSchema.parse(facts)).toEqual(facts);
    expect(facts.mergeable).toBe('unknown');
    expect(facts.mergeState).toBe('blocked');
    expect(facts.requiredChecks).toEqual([{ name: 'build', state: 'skipped', completedAt: time }]);
    expect(facts.checks.map((c) => [c.name, c.state])).toEqual([
      ['build', 'skipped'],
      ['optional', 'cancelled'],
    ]);
    expect(facts.reviews).toEqual([
      { reviewer: 'reviewer', state: 'approved', commitSha: sha, submittedAt: time },
    ]);
    expect(facts.ticketKeys).toEqual(['DEMO-42']);
    expect(ticketKeys('XDEMO-42 DEMO-420x', 'OTHER-1', ['DEMO'])).toEqual([]);
  });
  it('reads mergedAt for a merged PR only', () => {
    const merged = '2026-01-02T00:00:00.000Z';
    expect(normalizePr('demo/widgets', wire(), demoKeys, true)).not.toHaveProperty('mergedAt');
    const facts = normalizePr(
      'demo/widgets',
      { ...wire(), state: 'MERGED', mergedAt: merged, updatedAt: '2026-01-05T00:00:00.000Z' },
      demoKeys,
      true,
    );
    expect(facts).toMatchObject({ state: 'merged', mergedAt: merged });
    expect(
      normalizePr('demo/widgets', { ...wire(), state: 'MERGED' }, demoKeys, true),
    ).not.toHaveProperty('mergedAt');
    expect(detailQuery([7])).toContain('updatedAt mergedAt state');
  });
  it('keeps the latest review opinion after a comment-only review', () => {
    const pr = wire();
    pr.reviews.nodes.push({
      id: 'PRR_2',
      author: { __typename: 'User', login: 'reviewer' },
      state: 'COMMENTED',
      commit: { oid: sha },
      submittedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(normalizePr('demo/widgets', pr, demoKeys, true).reviews).toEqual([
      { reviewer: 'reviewer', state: 'approved', commitSha: sha, submittedAt: time },
    ]);
  });
  it('extracts lowercase configured ticket keys as uppercase at full boundaries', () => {
    expect(ticketKeys('demo-42 and xdemo-7', 'feature/proj-123-fix', ['DEMO', 'PROJ'])).toEqual([
      'DEMO-42',
      'PROJ-123',
    ]);
    expect(ticketKeys('demo-42x', 'other-1', ['DEMO'])).toEqual([]);
  });
  it('selects a newer pending rerun over an older completed check', () => {
    const pr = wire();
    pr.statusCheckRollup.contexts.nodes.push({
      __typename: 'CheckRun',
      name: 'build',
      status: 'IN_PROGRESS',
      conclusion: null,
      startedAt: '2026-01-03T00:00:00.000Z',
      completedAt: null,
      checkSuite: { createdAt: '2026-01-03T00:00:00.000Z' },
      isRequired: true,
    });
    expect(normalizePr('demo/widgets', pr, demoKeys, true).requiredChecks).toEqual([
      { name: 'build', state: 'pending', completedAt: null },
    ]);
    expect(pageQuery('contexts')).toContain('startedAt completedAt checkSuite { createdAt }');
  });
  it('uses check-suite creation time for a queued rerun without a start time', () => {
    const pr = wire();
    pr.statusCheckRollup.contexts.nodes.push({
      __typename: 'CheckRun',
      name: 'build',
      status: 'QUEUED',
      conclusion: null,
      startedAt: null,
      completedAt: null,
      checkSuite: { createdAt: '2026-01-04T00:00:00.000Z' },
      isRequired: true,
    });
    expect(normalizePr('demo/widgets', pr, demoKeys, true).requiredChecks).toEqual([
      { name: 'build', state: 'pending', completedAt: null },
    ]);
  });
  it('reads checks from the PR head on a multi-commit branch', () => {
    const olderCommit = {
      commit: {
        statusCheckRollup: {
          contexts: conn([
            {
              __typename: 'CheckRun',
              name: 'build',
              status: 'COMPLETED',
              conclusion: 'SKIPPED',
              completedAt: time,
              isRequired: true,
            },
          ]),
        },
      },
    };
    const head = {
      ...wire(),
      commits: conn([olderCommit, { commit: { oid: sha } }]),
      statusCheckRollup: {
        contexts: conn([
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            completedAt: time,
            isRequired: true,
          },
        ]),
      },
    };
    expect(normalizePr('demo/widgets', head, demoKeys, true).requiredChecks).toEqual([
      { name: 'build', state: 'failure', completedAt: time },
    ]);
    expect(detailQuery([7])).not.toContain('commits(first: 1)');
    expect(pageQuery('contexts')).not.toContain('commits(first: 1)');
    expect(pageQuery('contexts')).toContain(
      'statusCheckRollup { contexts(first: 100, after: $after)',
    );
  });
  it('registers unique project sources with interval, reserve and duplicate rejection', () => {
    const configured = config(['demo/widgets', 'demo/api']);
    configured.adapters.github.intervalMs = 1234;
    configured.github.reserveRemaining = 22;
    const firstProject = configured.projects[0];
    if (firstProject === undefined) throw new Error('Missing project');
    configured.projects.push({ ...firstProject, id: 'other', repos: ['demo/widgets'] });
    const sources = githubSources(configured, { token: 'synthetic', now: () => Date.now() });
    expect(sources.map((s) => [s.adapter.id, s.adapter.intervalMs, s.reserveRemaining])).toEqual([
      ['github:demo:demo/widgets', 1234, 22],
      ['github:demo:demo/api', 1234, 22],
      ['github:other:demo/widgets', 1234, 22],
    ]);
    expect(() =>
      githubSources(config(['demo/widgets', 'DEMO/WIDGETS']), {
        token: 'synthetic',
        now: () => Date.now(),
      }),
    ).toThrow(AdapterError);
  });
  it('delivers normalized facts and the last GraphQL budget', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() } }),
      );
    const batch = await adapter(fetcher).poll(context());
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(batch.items).toHaveLength(1);
    expect(batch.budget?.remaining).toBe(4321);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('records observedAt from the injected now before the first request', async () => {
    let t = Date.parse('2031-01-01T00:00:00.000Z');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      t = Date.parse('2031-01-02T00:00:00.000Z');
      return Promise.resolve(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() } }),
      );
    });
    const batch = await adapter(fetcher, config(), 0, () => t).poll(context());
    expect(batch.observedAt).toBe('2031-01-01T00:00:00.000Z');
  });
  it('continues a PR review connection and reports the last budget', async () => {
    const first = wire();
    first.reviews.pageInfo = { hasNextPage: true, endCursor: 'review-next' };
    const newerReview = {
      id: 'PRR_2',
      author: { __typename: 'User', login: 'reviewer' },
      state: 'CHANGES_REQUESTED',
      commit: { oid: sha },
      submittedAt: '2026-01-03T00:00:00.000Z',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: first } }),
      )
      .mockResolvedValueOnce(
        response({
          repository: { pullRequest: { reviews: conn([newerReview]) } },
          rateLimit: { remaining: 4000, resetAt: '2026-01-03T00:00:00.000Z' },
        }),
      );
    const batch = await adapter(fetcher).poll(context());
    expect(batch.items[0]?.kind === 'pr' && batch.items[0].facts.reviews).toEqual([
      {
        reviewer: 'reviewer',
        state: 'changes_requested',
        commitSha: sha,
        submittedAt: newerReview.submittedAt,
      },
    ]);
    expect(batch.budget?.remaining).toBe(4000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('omits a PR with a scoped connection-page error and keeps other facts', async () => {
    const first = wire();
    first.reviews.pageInfo = { hasNextPage: true, endCursor: 'review-next' };
    const other = { ...ref, number: 8 };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: { pullRequests: conn([]) },
          pr0: { pullRequest: first },
          pr1: { pullRequest: wire(8) },
        }),
      )
      .mockResolvedValueOnce(
        response({ repository: { pullRequest: { reviews: null } } }, [
          { message: 'page denied', path: ['repository', 'pullRequest', 'reviews'] },
        ]),
      );
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([
      { ref, status: 'no_access' },
      { ref: other, status: 'ok' },
    ]);
    expect(batch.items).toHaveLength(1);
  });
  it.each([
    ['NOT_FOUND', 'not_found'],
    ['FORBIDDEN', 'no_access'],
  ])('resolves a direct %s alias as %s with a complete batch', async (type, expected) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ repository: { pullRequests: conn([]) }, pr0: null }, [
          { message: type, type, path: ['pr0', 'pullRequest'] },
        ]),
      );
    const batch = await adapter(fetcher).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: expected }]);
    expect(batch.items).toEqual([]);
  });
  it('classifies a scoped check-context denial as a safe authentication error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() } }, [
        {
          message: 'Resource not accessible by personal access token',
          type: 'FORBIDDEN',
          path: ['pr0', 'pullRequest', 'statusCheckRollup', 'contexts', 'nodes', 0, 'isRequired'],
        },
      ]),
    );
    await expect(adapter(fetcher).poll(context())).rejects.toMatchObject({
      kind: 'auth',
      message: 'GitHub token lacks Checks read permission',
    });
  });
  it('classifies a paged check-context denial as the same safe authentication error', async () => {
    const first = wire();
    first.statusCheckRollup.contexts.pageInfo = { hasNextPage: true, endCursor: 'checks-next' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: first } }),
      )
      .mockResolvedValueOnce(
        response({ repository: { pullRequest: { statusCheckRollup: { contexts: null } } } }, [
          {
            message: 'Resource not accessible by personal access token',
            type: 'FORBIDDEN',
            path: ['repository', 'pullRequest', 'statusCheckRollup', 'contexts', 'nodes', 0],
          },
        ]),
      );
    await expect(adapter(fetcher).poll(context())).rejects.toMatchObject({
      kind: 'auth',
      message: 'GitHub token lacks Checks read permission',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps unrelated deep FORBIDDEN alias errors as incomplete observations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() } }, [
        {
          message: 'Synthetic review data denied',
          type: 'FORBIDDEN',
          path: ['pr0', 'pullRequest', 'reviews', 'nodes', 0],
        },
      ]),
    );
    const batch = await adapter(fetcher).poll(context());
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([{ ref, status: 'no_access' }]);
  });
  it('keeps a generic alias error incomplete and other facts intact', async () => {
    const other = { ...ref, number: 8 };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          { repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() }, pr1: null },
          [{ message: 'temporary', type: 'INTERNAL', path: ['pr1'] }],
        ),
      );
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([
      { ref, status: 'ok' },
      { ref: other, status: 'no_access' },
    ]);
    expect(batch.items).toHaveLength(1);
  });
  it('delivers a bot review request beside the other PRs', async () => {
    const other = { ...ref, number: 8 };
    const bot = {
      ...wire(),
      reviewRequests: conn([
        {
          requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' },
          asCodeOwner: false,
        },
      ]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        repository: { pullRequests: conn([]) },
        pr0: { pullRequest: bot },
        pr1: { pullRequest: wire(8) },
      }),
    );
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([
      { ref, status: 'ok' },
      { ref: other, status: 'ok' },
    ]);
    expect(batch.items).toHaveLength(2);
    expect(batch.items[0]?.kind === 'pr' && batch.items[0].facts.reviewRequests).toEqual([
      { kind: 'bot', id: 'copilot-pull-request-reviewer', asCodeOwner: false },
    ]);
  });
  it.each<[string, (pr: Record<string, unknown>) => Record<string, unknown>]>([
    [
      'a reviewer the query reads as empty',
      (pr) => ({ ...pr, reviewRequests: conn([{ requestedReviewer: {}, asCodeOwner: false }]) }),
    ],
    [
      'an unknown reviewer type',
      (pr) => ({
        ...pr,
        reviewRequests: conn([
          { requestedReviewer: { __typename: 'FutureReviewer' }, asCodeOwner: false },
        ]),
      }),
    ],
    [
      'a missing reviews connection',
      (pr) => {
        const copy = { ...pr };
        delete copy['reviews'];
        return copy;
      },
    ],
  ])('applies the other PRs when PR 7 fails to parse: %s', async (_name, broken) => {
    const other = { ...ref, number: 8 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        repository: { pullRequests: conn([]) },
        pr0: { pullRequest: broken(wire()) as Json },
        pr1: { pullRequest: wire(8) },
      }),
    );
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([
      { ref, status: 'no_access' },
      { ref: other, status: 'ok' },
    ]);
    expect(batch.items.map((item) => item.kind === 'pr' && item.facts.number)).toEqual([8]);
  });
  it.each<[string, Json]>([
    ['an omitted connection', {}],
    ['a missing pageInfo', { reviewRequests: { nodes: [] } }],
    ['a repeated cursor', { reviewRequests: conn([], 'rr-next') }],
    [
      'more pages without a cursor',
      { reviewRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
    ],
  ])('omits a PR whose follow-up review-request page is malformed: %s', async (_name, page) => {
    const other = { ...ref, number: 8 };
    const first = wire();
    first.reviewRequests.pageInfo = { hasNextPage: true, endCursor: 'rr-next' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: { pullRequests: conn([]) },
          pr0: { pullRequest: first },
          pr1: { pullRequest: wire(8) },
        }),
      )
      .mockResolvedValueOnce(response({ repository: { pullRequest: page } }));
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([
      { ref, status: 'no_access' },
      { ref: other, status: 'ok' },
    ]);
    expect(batch.items.map((item) => item.kind === 'pr' && item.facts.number)).toEqual([8]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('omits a PR whose first review-request page has more pages but no cursor', async () => {
    const other = { ...ref, number: 8 };
    const first = wire();
    first.reviewRequests.pageInfo = { hasNextPage: true, endCursor: null };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      response({
        repository: { pullRequests: conn([]) },
        pr0: { pullRequest: first },
        pr1: { pullRequest: wire(8) },
      }),
    );
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([
      { ref, status: 'no_access' },
      { ref: other, status: 'ok' },
    ]);
    expect(batch.items.map((item) => item.kind === 'pr' && item.facts.number)).toEqual([8]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('holds the cursor when a discovered PR fails to parse', async () => {
    const cursor = '2026-01-01T00:00:00.000Z';
    const discovered = (number: number) => ({
      number,
      updatedAt: time,
      author: { login: 'operator' },
      state: 'OPEN',
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([discovered(9), discovered(10)]) } }),
      )
      .mockResolvedValueOnce(
        response({
          pr0: {
            pullRequest: {
              ...wire(9),
              reviewRequests: conn([{ requestedReviewer: {}, asCodeOwner: false }]),
            },
          },
          pr1: { pullRequest: wire(10) },
        }),
      );
    const ctx = context([], cursor);
    const batch = await adapter(fetcher).poll(ctx);
    expect(batch.cursor).toBe(ctx.cursor);
    expect(batch.items.map((item) => item.kind === 'pr' && item.facts.number)).toEqual([10]);
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([]);
  });
  it('keeps a not_found answer beside a PR that fails to parse', async () => {
    const other = { ...ref, number: 8 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        repository: { pullRequests: conn([]) },
        pr0: null,
        pr1: {
          pullRequest: {
            ...wire(8),
            reviewRequests: conn([{ requestedReviewer: {}, asCodeOwner: false }]),
          },
        },
      }),
    );
    const batch = await adapter(fetcher).poll(context([ref, other]));
    expect(batch.complete).toBe(false);
    expect(batch.entities).toEqual([
      { ref, status: 'not_found' },
      { ref: other, status: 'no_access' },
    ]);
    expect(batch.items).toEqual([]);
  });
  it('does not return a batch after the poll signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() } }),
      );
    await expect(
      adapter(fetcher).poll({ ...context(), signal: controller.signal }),
    ).rejects.toThrow('GitHub poll aborted');
  });
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'throttled'],
  ])('classifies HTTP %i as %s', async (code, kind) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('failure', { status: code }));
    await expect(adapter(fetcher).poll(context())).rejects.toMatchObject({ kind });
  });
  it('classifies an HTTP 200 GraphQL rate-limit error as throttled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ type: 'RATE_LIMITED', message: 'Rate limit exceeded' }],
        }),
        {
          status: 200,
          headers: { 'x-ratelimit-reset': '1767225600' },
        },
      ),
    );
    await expect(adapter(fetcher).poll(context())).rejects.toMatchObject({
      kind: 'throttled',
      retryAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
  it('keeps an unrelated null-data scope denial generic', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: null,
        errors: [
          { type: 'INSUFFICIENT_SCOPES', message: "Field 'description' requires read:org scope" },
        ],
      }),
    );
    await expect(adapter(fetcher).poll(context())).rejects.toMatchObject({
      kind: 'auth',
      message: 'GitHub token lacks a required GraphQL read scope',
    });
  });
  it.each([
    "Field 'name' requires read:org or read:discussion scope",
    "Field 'slug' requires read:org or read:discussion scope",
  ])('names read:org for a pathless team scope denial on a detail query: %s', async (message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequests: conn([
              { number: 7, updatedAt: time, author: { login: 'operator' }, state: 'OPEN' },
            ]),
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: null,
          errors: [{ type: 'INSUFFICIENT_SCOPES', message }],
        }),
      );
    await expect(adapter(fetcher).poll(context([]))).rejects.toMatchObject({
      kind: 'auth',
      message: 'GitHub token needs read:org for team review requests',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('names read:org before normalizing a team reviewer with its slug withheld', async () => {
    const partial = {
      ...wire(),
      reviewRequests: conn([{ requestedReviewer: {}, asCodeOwner: false }]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: partial } }, [
        {
          type: 'INSUFFICIENT_SCOPES',
          path: ['pr0', 'pullRequest', 'reviewRequests', 'nodes', 0, 'requestedReviewer', 'slug'],
          message: 'Synthetic review data denied',
        },
      ]),
    );
    await expect(adapter(fetcher).poll(context())).rejects.toMatchObject({
      kind: 'auth',
      message: 'GitHub token needs read:org for team review requests',
    });
  });
  it('passes extra wire fields at every level', async () => {
    const pr = wire();
    const extended = {
      ...pr,
      extraField: { nested: [1] },
      statusCheckRollup: {
        state: 'SUCCESS',
        contexts: {
          ...pr.statusCheckRollup.contexts,
          totalCount: 3,
          nodes: pr.statusCheckRollup.contexts.nodes.map((node) => ({
            ...(node as object),
            detailsUrl: 'https://example.test',
          })),
        },
      },
      reviews: { ...pr.reviews, totalCount: 1 },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            rateLimit: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z', cost: 1 },
            repository: {
              id: 'R_1',
              pullRequests: { ...conn([]), totalCount: 0 },
              mergedBaseline: { nodes: [], totalCount: 0 },
            },
            pr0: { pullRequest: extended, id: 'R_1' },
          },
          extensions: { cost: 1 },
        }),
      ),
    );
    const batch = await adapter(fetcher).poll(context());
    expect(batch.items).toEqual([
      { kind: 'pr', facts: normalizePr('demo/widgets', wire(), demoKeys, true) },
    ]);
  });
  it('fails the poll naming the missing PR field without its value', async () => {
    const missing: Partial<ReturnType<typeof wire>> = wire();
    delete missing.title;
    const mistyped = { ...wire(), title: { leak: 'raw-sentinel' } };
    for (const pr of [missing, mistyped]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: pr } }),
        );
      const error = await adapter(fetcher)
        .poll(context())
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(error).toBeInstanceOf(AdapterError);
      expect(error).toMatchObject({
        kind: 'transient',
        message: 'Malformed GitHub PR response at title',
      });
      expect((error as AdapterError).message).not.toContain('raw-sentinel');
      expect((error as AdapterError).cause).toBeUndefined();
    }
  });
  it("keeps today's mapping for unknown enum values", () => {
    const pr = {
      ...wire(),
      state: 'FUTURE',
      mergeable: 'FUTURE',
      mergeStateStatus: 'FUTURE',
      statusCheckRollup: {
        contexts: conn([
          {
            __typename: 'CheckRun',
            name: 'completed',
            status: 'COMPLETED',
            conclusion: 'FUTURE',
            completedAt: time,
          },
          {
            __typename: 'CheckRun',
            name: 'running',
            status: 'FUTURE',
            conclusion: null,
            completedAt: null,
          },
          { __typename: 'StatusContext', context: 'status', state: 'FUTURE', createdAt: time },
        ]),
      },
      reviews: conn([
        {
          id: 'PRR_1',
          author: { __typename: 'User', login: 'reviewer' },
          state: 'FUTURE',
          commit: { oid: sha },
          submittedAt: time,
        },
      ]),
    };
    const facts = normalizePr('demo/widgets', pr, demoKeys, true);
    expect(facts).toMatchObject({ state: 'open', mergeable: 'unknown', mergeState: 'unknown' });
    expect(facts.checks.map((check) => [check.name, check.state])).toEqual([
      ['completed', 'error'],
      ['running', 'pending'],
      ['status', 'failure'],
    ]);
    expect(facts.reviews).toEqual([]);
  });
  it('reports an error-free null alias as not_found', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ repository: { pullRequests: conn([]) }, pr0: null }));
    const batch = await adapter(fetcher).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'not_found' }]);
    expect(batch.items).toEqual([]);
  });
});

/** A fetch that never answers; it rejects with the signal's reason once the signal aborts. */
const hanging: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason as Error);
    });
  });

/** Records how `promise` settles without awaiting it. */
function settle(promise: Promise<unknown>): { settled: boolean; error?: unknown } {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

describe('GitHub request timeout', () => {
  it('fails a request with no answer as timed out after 30 s', async () => {
    vi.useFakeTimers();
    try {
      // No requested PR, so the lone discovery request is the poll.
      const poll = settle(adapter(hanging).poll(context([])));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(poll.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll.error).toBeInstanceOf(AdapterError);
      expect(poll.error).toMatchObject({ kind: 'transient', message: 'GitHub request timed out' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts mid-request as a stop, not a timeout', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const poll = settle(adapter(hanging).poll({ ...context(), signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(10_000);
      const reason = new Error('stop');
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(poll.error).toBe(reason);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(poll.error).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GitHub on-demand PR', () => {
  const signal = () => new AbortController().signal;
  function pollPr(fetcher: typeof fetch, now?: () => number) {
    const source = adapter(fetcher, config(), 0, now);
    if (source.pollPr === undefined) throw new Error('Missing pollPr');
    return source.pollPr.bind(source);
  }

  it('reads only the requested PR, never complete and without a cursor', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ pr0: { pullRequest: wire() } }));
    const batch = await pollPr(fetcher, () => Date.parse(time))(ref, { signal: signal() });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(bodyQuery(fetcher)).toBe(detailQuery([7]));
    expect(bodyQuery(fetcher)).not.toContain('pullRequests(');
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch).toMatchObject({
      source: 'github:demo:demo/widgets',
      observedAt: time,
      complete: false,
      entities: [{ ref, status: 'ok' }],
      budget: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z' },
    });
    expect(batch).not.toHaveProperty('cursor');
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]?.facts).toMatchObject({ repo: 'demo/widgets', number: 7 });
  });

  it('answers not_found for a null alias', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ pr0: null }));
    const batch = await pollPr(fetcher)(ref, { signal: signal() });
    expect(batch).toMatchObject({ complete: false, entities: [{ ref, status: 'not_found' }] });
    expect(batch.items).toEqual([]);
  });

  it('rejects after its signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ pr0: { pullRequest: wire() } }));
    await expect(pollPr(fetcher)(ref, { signal: controller.signal })).rejects.toThrow(
      'GitHub poll aborted',
    );
  });

  it('rejects a lone malformed PR naming the field', async () => {
    const missing: Partial<ReturnType<typeof wire>> = wire();
    delete missing.title;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ pr0: { pullRequest: missing } }));
    await expect(pollPr(fetcher)(ref, { signal: signal() })).rejects.toMatchObject({
      kind: 'transient',
      message: 'Malformed GitHub PR response at title',
    });
  });
});

const single = (pr: unknown, errors?: unknown[]) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: pr } }, errors),
    );

describe('GitHub Issues PR keys', () => {
  it('links every same-repo closing reference in config casing', async () => {
    const fetcher = single(
      issuesPr(
        'claude-99-other',
        conn([closingRef(13, 'Demo/Widgets'), closingRef(12, 'Demo/Widgets')]),
      ),
    );
    const batch = await adapter(fetcher, issuesConfig()).poll(context());
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(keysOf(batch)).toEqual([['demo/widgets#12', 'demo/widgets#13']]);
    expect(detailsSent(fetcher)).toContain('closingIssuesReferences(first: 100)');
  });
  it('falls back to the branch pattern', async () => {
    const poll = async (branch: string, configured = issuesConfig()) =>
      keysOf(await adapter(single(issuesPr(branch, conn([]))), configured).poll(context()));
    expect(await poll('claude-12-slug')).toEqual([['demo/widgets#12']]);
    const custom = issuesConfig(['demo/widgets'], { branchPattern: '^task/([1-9][0-9]*)$' });
    expect(await poll('task/12', custom)).toEqual([['demo/widgets#12']]);
    expect(await poll('claude-12-slug', custom)).toEqual([[]]);
  });
  it('reads the issue number from a conventional title', async () => {
    const poll = async (title: string) =>
      keysOf(
        await adapter(single(issuesPr('feature/x', conn([]), 7, title)), issuesConfig()).poll(
          context(),
        ),
      );
    expect(await poll('fix(core): #12 x')).toEqual([['demo/widgets#12']]);
    expect(await poll('feat!: #12 x')).toEqual([['demo/widgets#12']]);
    expect(await poll('Fix: #12 x')).toEqual([[]]);
    expect(await poll('fix(core): 12 x')).toEqual([[]]);
  });
  it('takes the first source that yields a number', async () => {
    const poll = async (fetcher: typeof fetch, configured = issuesConfig()) =>
      keysOf(await adapter(fetcher, configured).poll(context()));
    const title = 'fix: #13 x';
    expect(await poll(single(issuesPr('claude-12-x', conn([closingRef(14)]), 7, title)))).toEqual([
      ['demo/widgets#14'],
    ]);
    expect(await poll(single(issuesPr('claude-12-x', conn([]), 7, title)))).toEqual([
      ['demo/widgets#12'],
    ]);
    expect(await poll(single(issuesPr('feature/x', conn([]), 7, title)))).toEqual([
      ['demo/widgets#13'],
    ]);
    const titleFirst = single(issuesPr('claude-12-x', undefined, 7, title));
    expect(
      await poll(titleFirst, issuesConfig(['demo/widgets'], { sources: ['title', 'branch'] })),
    ).toEqual([['demo/widgets#13']]);
    expect(detailsSent(titleFirst)).not.toContain('closingIssuesReferences');
    const branchOnly = single(issuesPr('claude-12-x', conn([closingRef(13)])));
    expect(await poll(branchOnly, issuesConfig(['demo/widgets'], { sources: ['branch'] }))).toEqual(
      [['demo/widgets#12']],
    );
  });
  it.each([
    ['branch', issuesPr(`claude-12-${'x'.repeat(290)}`, conn([]))],
    ['title', issuesPr('feature/x', conn([]), 7, `fix: #12 ${'x'.repeat(260)}`)],
  ])('skips a %s longer than 255 characters', async (_name, pr) => {
    expect(keysOf(await adapter(single(pr), issuesConfig()).poll(context()))).toEqual([[]]);
  });
  it('ignores cross-repo references and non-tracker repos', async () => {
    const cross = single(issuesPr('feature/x', conn([closingRef(12, 'other/repo')])));
    expect(keysOf(await adapter(cross, issuesConfig()).poll(context()))).toEqual([[]]);
    const sibling = single(issuesPr('claude-12-x', conn([closingRef(12)])));
    const apiRef = { ...ref, repo: 'demo/api' };
    const batch = await adapter(sibling, issuesConfig(['demo/widgets', 'demo/api']), 1).poll(
      context([apiRef]),
    );
    expect(batch.entities).toEqual([{ ref: apiRef, status: 'ok' }]);
    expect(keysOf(batch)).toEqual([[]]);
    expect(detailsSent(sibling)).not.toContain('closingIssuesReferences');
  });
  it('links a Jira PR by projectKeys when link is unset', async () => {
    const fetcher = single(issuesPr('DEMO-42-widget', conn([closingRef(12)]), 7, 'fix: #13 x'));
    const batch = await adapter(fetcher, config()).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(keysOf(batch)).toEqual([['DEMO-42']]);
    expect(sentQueries(fetcher)).toEqual([discoveryQuery(true), indexQuery([7]), detailQuery([7])]);
    const defaults = config(['demo/widgets'], {
      sources: [...DEFAULT_LINK.sources],
      branchPattern: DEFAULT_LINK.branchPattern,
      titlePattern: DEFAULT_LINK.titlePattern,
    });
    const both = single(issuesPr('DEMO-1-x', conn([]), 7, 'DEMO-2 y'));
    expect(keysOf(await adapter(both, defaults).poll(context()))).toEqual([['DEMO-2', 'DEMO-1']]);
  });
  const denied = (path: (string | number)[]) => ({
    message: 'Resource not accessible by personal access token',
    type: 'FORBIDDEN',
    path,
  });
  it.each([
    [
      'node',
      () =>
        single(issuesPr('feature/x', conn([null, closingRef(12)])), [
          denied(['pr0', 'pullRequest', 'closingIssuesReferences', 'nodes', 0]),
        ]),
    ],
    [
      'connection',
      () =>
        single(issuesPr('claude-12-x', null), [
          denied(['pr0', 'pullRequest', 'closingIssuesReferences']),
        ]),
    ],
    [
      'page',
      () =>
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            response({
              repository: { pullRequests: conn([]) },
              pr0: { pullRequest: issuesPr('feature/x', conn([closingRef(12)], 'refs-next')) },
            }),
          )
          .mockResolvedValueOnce(
            response({ repository: { pullRequest: { closingIssuesReferences: null } } }, [
              denied(['repository', 'pullRequest', 'closingIssuesReferences']),
            ]),
          ),
    ],
  ])('ignores a denied closing reference: %s', async (_name, fetcher) => {
    const batch = await adapter(fetcher(), issuesConfig()).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(keysOf(batch)).toEqual([['demo/widgets#12']]);
  });
  it('advances the cursor past a denied closing reference', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequests: conn([
              { number: 7, updatedAt: time, author: { login: 'operator' }, state: 'OPEN' },
            ]),
          },
        }),
      )
      .mockResolvedValueOnce(
        response({ pr0: { pullRequest: issuesPr('claude-12-x', null) } }, [
          denied(['pr0', 'pullRequest', 'closingIssuesReferences']),
        ]),
      );
    const batch = await adapter(fetcher, issuesConfig()).poll(
      context([], '2026-01-01T00:00:00.000Z'),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodyQuery(fetcher, 1)).toContain('closingIssuesReferences(first: 100)');
    expect(batch.complete).toBe(true);
    expect(keysOf(batch)).toEqual([['demo/widgets#12']]);
    expect(batch.cursor).toBe('2026-01-02T00:00:00.000Z');
  });
  it('continues closing references', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: { pullRequests: conn([]) },
          pr0: { pullRequest: issuesPr('feature/x', conn([closingRef(13)], 'refs-next')) },
        }),
      )
      .mockResolvedValueOnce(
        response({
          repository: { pullRequest: { closingIssuesReferences: conn([closingRef(12)]) } },
        }),
      );
    const batch = await adapter(fetcher, issuesConfig()).poll(context());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodyQuery(fetcher, 1)).toBe(pageQuery('closingIssuesReferences'));
    expect(pageQuery('closingIssuesReferences')).toContain(
      'closingIssuesReferences(first: 100, after: $after)',
    );
    expect(keysOf(batch)).toEqual([['demo/widgets#12', 'demo/widgets#13']]);
  });
  it('drops an out-of-range issue number', async () => {
    const fetcher = single(issuesPr('claude-1234567890123456-x', conn([])));
    const custom = issuesConfig(['demo/widgets'], { branchPattern: '^claude-([0-9]+)' });
    const batch = await adapter(fetcher, custom).poll(context());
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(keysOf(batch)).toEqual([[]]);
    const title = single(issuesPr('feature/x', conn([]), 7, 'fix: #1234567890123456 x'));
    expect(keysOf(await adapter(title, issuesConfig()).poll(context()))).toEqual([[]]);
  });
});

describe('Jira PR keys', () => {
  const poll = async (link: Record<string, unknown>, branch: string, title = 'Add widget') =>
    keysOf(
      await adapter(
        single(issuesPr(branch, conn([]), 7, title)),
        config(['demo/widgets'], link),
      ).poll(context()),
    );
  it('reads an uppercased key with a projectKeys prefix from a custom branch pattern', async () => {
    const link = { branchPattern: '^task/([A-Za-z]+-[0-9]+)' };
    expect(await poll(link, 'task/demo-12')).toEqual([['DEMO-12']]);
    expect(await poll(link, 'task/other-12', 'DEMO-42 Add widget')).toEqual([['DEMO-42']]);
  });
  it('links nothing when the capture is not a key', async () => {
    expect(await poll({ branchPattern: '^claude-([0-9]+)' }, 'claude-12-x')).toEqual([[]]);
  });
  it('takes the first source that yields a key', async () => {
    expect(await poll({ sources: ['title', 'branch'] }, 'DEMO-1-x', 'DEMO-2 y')).toEqual([
      ['DEMO-2'],
    ]);
  });
  it('skips a title longer than 255 characters for a custom pattern', async () => {
    const link = { titlePattern: '^\\[([A-Z]+-[0-9]+)\\]' };
    expect(await poll(link, 'feature/x', '[DEMO-7] fix')).toEqual([['DEMO-7']]);
    expect(await poll(link, 'feature/x', `[DEMO-7] ${'x'.repeat(260)}`)).toEqual([[]]);
  });
  it('skips closing and never selects closing references', async () => {
    const fetcher = single(issuesPr('feature/x', conn([closingRef(12)]), 7, 'DEMO-7 fix'));
    const batch = await adapter(
      fetcher,
      config(['demo/widgets'], { sources: ['closing', 'title'] }),
    ).poll(context());
    expect(keysOf(batch)).toEqual([['DEMO-7']]);
    expect(detailsSent(fetcher)).not.toContain('closingIssuesReferences');
  });
});

describe('link rule sample', () => {
  const samplePr = (
    number: number,
    branch: string,
    options: { title?: string; login?: string | null; closing?: unknown } = {},
  ) => ({
    number,
    title: options.title ?? 'Add widget',
    headRefName: branch,
    author: options.login === null ? null : { login: options.login ?? 'operator' },
    ...(options.closing === undefined ? {} : { closingIssuesReferences: options.closing }),
  });
  const sampleFetch = (nodes: unknown[], errors?: unknown[]) =>
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ repository: { pullRequests: { nodes } } }, errors));
  const sample = (fetcher: typeof fetch, configured = issuesConfig()) => {
    const project = configured.projects[0];
    if (project === undefined) throw new Error('Missing project');
    return sampleLinkRules(
      { repo: 'demo/widgets', login: 'Operator', tracker: project.tracker, link: project.link },
      {
        token: 'synthetic',
        now: () => Date.now(),
        fetch: fetcher,
        signal: new AbortController().signal,
      },
    );
  };

  it('counts operator PRs whose branch, title or closing reference yields an issue', async () => {
    const fetcher = sampleFetch([
      samplePr(1, 'claude-12-x', { closing: conn([]) }),
      samplePr(2, 'feature/title', { title: 'fix: #13 widget', closing: conn([]) }),
      samplePr(3, 'feature/closing', { closing: conn([closingRef(14)]) }),
      samplePr(4, 'feature/none', { closing: conn([closingRef(15, 'other/repo')]) }),
      samplePr(5, 'feature/ghost', { closing: null }),
    ]);
    await expect(sample(fetcher)).resolves.toEqual({
      sampled: 5,
      unmatched: [
        { number: 4, branch: 'feature/none' },
        { number: 5, branch: 'feature/ghost' },
      ],
    });
  });

  it('samples at most 10 operator PRs and skips other authors', async () => {
    const nodes = [
      samplePr(100, 'feature/other', { login: 'someone' }),
      samplePr(101, 'feature/ghost', { login: null }),
      ...Array.from({ length: 12 }, (_, i) => samplePr(i + 1, `feature/${String(i + 1)}`)),
    ];
    const result = await sample(
      sampleFetch(nodes),
      issuesConfig(['demo/widgets'], { sources: ['branch', 'title'] }),
    );
    expect(result.sampled).toBe(10);
    expect(result.unmatched.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(
      sample(sampleFetch([]), issuesConfig(['demo/widgets'], { sources: ['branch'] })),
    ).resolves.toEqual({ sampled: 0, unmatched: [] });
  });

  it('drops a denied closing reference and rejects other GraphQL errors', async () => {
    const denied = sampleFetch(
      [samplePr(7, 'feature/x', { closing: conn([null, closingRef(12)]) })],
      [
        {
          message: 'Resource not accessible by personal access token',
          type: 'FORBIDDEN',
          path: ['repository', 'pullRequests', 'nodes', 0, 'closingIssuesReferences', 'nodes', 0],
        },
      ],
    );
    await expect(sample(denied)).resolves.toEqual({ sampled: 1, unmatched: [] });
    const missing = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ repository: null }, [
          { message: 'Could not resolve to a Repository', type: 'NOT_FOUND', path: ['repository'] },
        ]),
      );
    await expect(sample(missing)).rejects.toMatchObject({ kind: 'transient' });
    const malformed = sampleFetch([{ number: 7 }]);
    await expect(sample(malformed)).rejects.toBeInstanceOf(AdapterError);
  });

  it('samples a Jira project by projectKeys without closing references', async () => {
    const fetcher = sampleFetch([samplePr(1, 'DEMO-12-x'), samplePr(2, 'feature/x')]);
    await expect(sample(fetcher, config())).resolves.toEqual({
      sampled: 2,
      unmatched: [{ number: 2, branch: 'feature/x' }],
    });
    expect(bodyQuery(fetcher)).not.toContain('closingIssuesReferences');
  });

  it('selects closing references only when link.sources lists closing', async () => {
    const closing = sampleFetch([]);
    await sample(closing);
    const query = bodyQuery(closing);
    expect(query).toContain('query LinkSample');
    expect(query).toContain('rateLimit { remaining resetAt }');
    expect(query).toContain('first: 50');
    expect(query).toContain('states: [OPEN, MERGED]');
    expect(query).toContain('orderBy: {field: UPDATED_AT, direction: DESC}');
    expect(query).toContain('closingIssuesReferences(first: 100)');
    const plain = sampleFetch([]);
    await sample(plain, issuesConfig(['demo/widgets'], { sources: ['branch', 'title'] }));
    expect(bodyQuery(plain)).not.toContain('closingIssuesReferences');
    expect(bodyQuery(plain)).toContain('states: [OPEN, MERGED]');
  });
});

describe('PR feedback', () => {
  const BASE = Date.parse('2026-01-01T00:00:00.000Z');
  const postedAt = (i: number) => new Date(BASE + i * 1000).toISOString();
  const user = (login: string) => ({ __typename: 'User', login });
  const comment = (i: number, author: Json = user('alice')) => ({
    id: `IC_${String(i)}`,
    author,
    createdAt: postedAt(i),
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => comment(from + i));
  const ref8 = { kind: 'pr' as const, repo: 'demo/widgets', number: 8 };
  function prWith(comments: Json, number = 7) {
    return { ...wire(number), comments };
  }
  const initial = (...prs: unknown[]) =>
    response({
      repository: { pullRequests: conn([]) },
      ...Object.fromEntries(prs.map((pr, i) => [`pr${String(i)}`, { pullRequest: pr }])),
    });
  // A comment history page; its default budget is the same 4321 as every other response.
  const historyPage = (comments: Json, remaining?: number) =>
    response({
      repository: { pullRequest: { comments } },
      ...(remaining === undefined
        ? {}
        : { rateLimit: { remaining, resetAt: '2026-01-03T00:00:00.000Z' } }),
    });
  function variables(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number): unknown {
    const body = fetcher.mock.calls[call]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Missing GraphQL body');
    return (JSON.parse(body) as { variables: unknown }).variables;
  }
  function factsOf(batch: { items: { kind: string; facts?: unknown }[] }) {
    const item = batch.items[0];
    if (item?.kind !== 'pr') throw new Error('Missing PR item');
    return prFactsSchema.parse(item.facts);
  }
  const commentIds = (batch: { items: { kind: string; facts?: unknown }[] }) =>
    (factsOf(batch).feedback ?? []).filter((e) => e.kind === 'comment').map((e) => e.id);
  const withCursors = (
    feedbackCursors: { ref: typeof ref; id: string; postedAt: string }[],
    prs = [ref],
  ) => ({ ...context(prs), feedbackCursors });

  it('maps comment and review authors to user or bot', async () => {
    const pr = {
      ...prWith(
        back([
          comment(1, user('operator')),
          comment(2, { __typename: 'Bot', login: 'renovate' }),
          comment(3, user('alice')),
          comment(4, { __typename: 'Mannequin', login: 'old' }),
          comment(5, null),
        ]),
      ),
      reviews: conn([
        {
          id: 'PRR_9',
          author: { __typename: 'Bot', login: 'ci-bot' },
          state: 'COMMENTED',
          commit: { oid: sha },
          submittedAt: postedAt(6),
        },
        // A pending review has no submit time and is not feedback yet.
        {
          id: 'PRR_10',
          author: user('alice'),
          state: 'PENDING',
          commit: { oid: sha },
          submittedAt: null,
        },
      ]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial(pr));
    const facts = factsOf(await adapter(fetcher).poll(context()));
    expect(facts.feedback).toEqual([
      {
        kind: 'comment',
        id: 'IC_1',
        author: { login: 'operator', type: 'user' },
        postedAt: postedAt(1),
      },
      {
        kind: 'comment',
        id: 'IC_2',
        author: { login: 'renovate', type: 'bot' },
        postedAt: postedAt(2),
      },
      {
        kind: 'comment',
        id: 'IC_3',
        author: { login: 'alice', type: 'user' },
        postedAt: postedAt(3),
      },
      {
        kind: 'comment',
        id: 'IC_4',
        author: { login: 'old', type: 'user' },
        postedAt: postedAt(4),
      },
      { kind: 'comment', id: 'IC_5', author: null, postedAt: postedAt(5) },
      {
        kind: 'review',
        id: 'PRR_9',
        author: { login: 'ci-bot', type: 'bot' },
        postedAt: postedAt(6),
        state: 'commented',
      },
    ]);
    expect(facts.feedbackComplete).toBe(true);
    const external = (facts.feedback ?? []).filter((entry) => isExternalAuthor(entry, 'operator'));
    expect(external.map((entry) => entry.author?.login ?? null)).toEqual(['alice', 'old', null]);
    expect(detailsSent(fetcher)).toContain(
      'comments(last: 100) { nodes { id author { __typename login } createdAt }',
    );
    expect(detailsSent(fetcher)).not.toContain('body');
  });

  it('keeps the state of every review in feedback, not only the latest per reviewer', async () => {
    const approval = (id: string, minute: number) => ({
      id,
      author: user('alice'),
      state: 'APPROVED',
      commit: { oid: sha },
      submittedAt: postedAt(minute),
    });
    const pr = {
      ...prWith(back([])),
      reviews: conn([approval('PRR_1', 1), approval('PRR_2', 2)]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial(pr));
    const facts = factsOf(await adapter(fetcher).poll(context()));
    expect(facts.reviews).toEqual([
      { reviewer: 'alice', state: 'approved', commitSha: sha, submittedAt: postedAt(2) },
    ]);
    expect(facts.feedback?.map(({ id, state }) => [id, state])).toEqual([
      ['PRR_1', 'approved'],
      ['PRR_2', 'approved'],
    ]);
  });

  it('sorts feedback by time, then id, whatever order the pages arrive in', () => {
    const pr = prWith(
      back([comment(3), { ...comment(2), id: 'IC_b' }, { ...comment(2), id: 'IC_a' }]),
    );
    const facts = normalizePr('demo/widgets', pr, demoKeys, true);
    expect(facts.feedback?.map((entry) => entry.id)).toEqual(['IC_a', 'IC_b', 'IC_3', 'PRR_1']);
  });

  it('reads a comment burst longer than one page back to the start of the PR', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initial(prWith(back(range(50, 150), 'c-100'))))
      .mockResolvedValueOnce(historyPage(back(range(0, 50)), 4000));
    const batch = await adapter(fetcher).poll(context());
    expect(commentIds(batch)).toEqual(range(0, 150).map((node) => node.id));
    expect(factsOf(batch).feedbackComplete).toBe(true);
    expect(bodyQuery(fetcher, 1)).toBe(pageQuery('comments'));
    expect(pageQuery('comments')).toContain('comments(last: 100, before: $before)');
    expect(variables(fetcher, 1)).toEqual({
      owner: 'demo',
      repo: 'widgets',
      number: 7,
      before: 'c-100',
    });
    expect(batch.budget?.remaining).toBe(4000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an id on page 2', { ref, id: 'IC_15', postedAt: postedAt(0) }],
    ['a time only', { ref, id: 'IC_gone', postedAt: postedAt(15) }],
    // The time-only cursor core derives from a shadow submit.
    ['a submit time', { ref, id: '', postedAt: postedAt(15) }],
    [
      'a repo in another letter case',
      { ref: { ...ref, repo: 'Demo/Widgets' }, id: 'IC_15', postedAt: postedAt(15) },
    ],
  ])('stops paging at the cursor (%s)', async (_name, cursor) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initial(prWith(back(range(20, 30), 'p2'))))
      .mockResolvedValueOnce(historyPage(back(range(10, 20), 'p1')))
      .mockResolvedValue(historyPage(back(range(0, 10))));
    const batch = await adapter(fetcher).poll(withCursors([cursor]));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(factsOf(batch).feedbackComplete).toBe(true);
    expect(commentIds(batch)).toEqual(range(10, 30).map((node) => node.id));
  });

  it('reads no history page when the first page holds the cursor', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initial(prWith(back(range(20, 30), 'p2'))));
    const batch = await adapter(fetcher).poll(
      withCursors([{ ref, id: 'IC_25', postedAt: postedAt(25) }]),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(factsOf(batch).feedbackComplete).toBe(true);
  });

  it.each<[string, () => Response, number, string[]]>([
    ['answers HTTP 500', () => new Response('unavailable', { status: 500 }), 4321, []],
    [
      'carries a scoped comments error',
      () =>
        response(
          {
            repository: { pullRequest: { comments: null } },
            rateLimit: { remaining: 4000, resetAt: '2026-01-03T00:00:00.000Z' },
          },
          [
            {
              message: 'Something went wrong',
              type: 'INTERNAL',
              path: ['repository', 'pullRequest', 'comments'],
            },
          ],
        ),
      4000,
      [],
    ],
    [
      'is malformed',
      () => historyPage({ nodes: 'x', pageInfo: { hasPreviousPage: false, startCursor: null } }),
      4321,
      [],
    ],
    [
      'has a comment author without a login',
      () =>
        historyPage(back([...range(0, 49), { ...comment(49), author: { __typename: 'User' } }])),
      4321,
      [],
    ],
    [
      'has a comment with an invalid time',
      () => historyPage(back([...range(0, 49), { ...comment(49), createdAt: 'invalid' }])),
      4321,
      [],
    ],
    [
      'has no rateLimit',
      () =>
        new Response(
          JSON.stringify({
            data: { repository: { pullRequest: { comments: back(range(0, 50)) } } },
          }),
          { status: 200 },
        ),
      4321,
      [],
    ],
    [
      'has an older page but no start cursor',
      () => historyPage(back(range(0, 50), null, true)),
      4321,
      range(0, 50).map((node) => node.id),
    ],
  ])(
    'keeps the PR with incomplete feedback when a history page %s',
    async (_name, page, remaining, older) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(initial(prWith(back(range(50, 150), 'c-100'))))
        .mockImplementationOnce(() => Promise.resolve(page()));
      const batch = await adapter(fetcher).poll(context());
      expect(batch.complete).toBe(true);
      expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(commentIds(batch)).toEqual([...older, ...range(50, 150).map((node) => node.id)]);
      expect(batch.budget?.remaining).toBe(remaining);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each<[string, (controller: AbortController) => Promise<Response>, object]>([
    [
      'HTTP 429',
      () =>
        Promise.resolve(
          new Response('', { status: 429, headers: { 'x-ratelimit-reset': '1767225600' } }),
        ),
      { kind: 'throttled', retryAt: new Date('2026-01-01T00:00:00.000Z') },
    ],
    [
      'a GraphQL rate-limit error',
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: null,
              errors: [{ type: 'RATE_LIMITED', message: 'Rate limit exceeded' }],
            }),
            { status: 200, headers: { 'x-ratelimit-reset': '1767225600' } },
          ),
        ),
      { kind: 'throttled', retryAt: new Date('2026-01-01T00:00:00.000Z') },
    ],
    ['HTTP 401', () => Promise.resolve(new Response('', { status: 401 })), { kind: 'auth' }],
    [
      'an abort before the request',
      (controller) => {
        controller.abort();
        return Promise.reject(controller.signal.reason as Error);
      },
      { name: 'AbortError' },
    ],
    [
      'an abort while the body is read',
      (controller) => {
        controller.abort();
        return Promise.resolve(new Response('{', { status: 200 }));
      },
      { kind: 'transient' },
    ],
  ])('rejects the poll on %s during history paging', async (_name, failure, expected) => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        initial(prWith(back(range(50, 150), 'c-100')), prWith(back(range(50, 150), 'c-100'), 8)),
      )
      .mockImplementationOnce(() => failure(controller))
      .mockImplementation(() => Promise.resolve(historyPage(back(range(0, 50)))));
    const poll = adapter(fetcher).poll({ ...context([ref, ref8]), signal: controller.signal });
    await expect(poll).rejects.toMatchObject(expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops at 3 comment pages and marks feedback incomplete', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initial(prWith(back(range(200, 300), 'p2'))))
      .mockResolvedValueOnce(historyPage(back(range(100, 200), 'p1'), 4100))
      .mockResolvedValueOnce(historyPage(back(range(0, 100), 'p0'), 4000))
      .mockResolvedValue(historyPage(back([]), 3900));
    const batch = await adapter(fetcher).poll(context());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(variables(fetcher, 2)).toMatchObject({ before: 'p1' });
    expect(factsOf(batch).feedbackComplete).toBe(false);
    expect(commentIds(batch)).toHaveLength(300);
    expect(batch.budget?.remaining).toBe(4000);
  });
});

const prNumbers = (query: string): number[] =>
  [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1]));
type Operation = 'PrBatch' | 'PrIndex' | 'PrDetails' | 'PrPage' | 'DiscoveryPage';
/** A fetch that answers each request by its operation name and the PR numbers it names. */
function byOperation(answer: (operation: Operation, numbers: number[]) => Response) {
  return vi.fn<typeof fetch>((_input, init) => {
    const query = queryOf(init);
    return Promise.resolve(answer(operationOf(query) as Operation, prNumbers(query)));
  });
}
/** The PR numbers of each request of one operation, in the order they were sent. */
function numbersSent(fetcher: ReturnType<typeof byOperation>, operation: Operation): number[][] {
  return fetcher.mock.calls
    .map((call) => queryOf(call[1]))
    .filter((query) => operationOf(query) === operation)
    .map(prNumbers);
}
const aliased = (numbers: number[], value: (number: number) => unknown) =>
  Object.fromEntries(numbers.map((number, i) => [`pr${String(i)}`, value(number)]));
const discoveryAnswer = (nodes: Json[] = []) =>
  response({ repository: { pullRequests: conn(nodes) } });
const operatorNode = (number: number, updatedAt = '2026-01-03T00:00:00.000Z') => ({
  number,
  updatedAt,
  author: { login: 'operator' },
  state: 'OPEN',
});
const refOf = (number: number) => ({ ...ref, number });
function indexPr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: {
      number,
      updatedAt: time,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      headRefOid: sha,
      statusCheckRollup: { state: 'SUCCESS' },
      reviews: { totalCount: 1, nodes: [{ id: 'PRR_1', state: 'APPROVED' }] },
      reviewThreads: { totalCount: 1, nodes: [{ isResolved: false }] },
      reviewRequests: {
        totalCount: 1,
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'reviewer' }, asCodeOwner: true },
        ],
      },
      comments: { totalCount: 0, nodes: [] },
      ...overrides,
    },
  };
}
const failure = (status = 502) => new Response('failure', { status });
const okFacts = (batch: { items: { kind: string; facts?: unknown }[] }) =>
  batch.items.map((item) => item.facts as { number: number; title: string });
const factsFor = (batch: { items: { kind: string; facts?: unknown }[] }, number: number) =>
  batch.items.find((item) => (item.facts as { number: number }).number === number)?.facts;

describe('PR poll chunks', () => {
  const cursor = '2026-01-01T00:00:00.000Z';
  it('gives up only the PR whose chunk keeps failing', async () => {
    const fetcher = byOperation((operation, numbers) => {
      if (operation === 'PrBatch') return discoveryAnswer([operatorNode(9)]);
      if (operation === 'PrIndex') return response(aliased(numbers, (n) => indexPr(n)));
      if (numbers.includes(7)) return failure();
      return response(aliased(numbers, (n) => ({ pullRequest: wire(n) })));
    });
    const ctx = context([refOf(7), refOf(8)], cursor);
    const batch = await adapter(fetcher).poll(ctx);
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch.entities).toEqual([
      { ref: refOf(7), status: 'no_access' },
      { ref: refOf(8), status: 'ok' },
    ]);
    expect(okFacts(batch).map((facts) => facts.number)).toEqual([8, 9]);
    expect(batch.cursor).toBe('2026-01-03T00:00:00.000Z');
    expect(batch.complete).toBe(false);
    expect(numbersSent(fetcher, 'PrDetails')).toEqual([[7, 8], [7], [8], [9]]);
  });
  it('halves a chunk after one 502', async () => {
    const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
    let failed = false;
    const fetcher = byOperation((operation, sent) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex') return response(aliased(sent, (n) => indexPr(n)));
      if (!failed) {
        failed = true;
        return failure();
      }
      return response(aliased(sent, (n) => ({ pullRequest: wire(n) })));
    });
    const batch = await adapter(fetcher).poll(context(numbers.map(refOf), cursor));
    expect(numbersSent(fetcher, 'PrDetails').map((sent) => sent.length)).toEqual([10, 5, 5]);
    expect(batch.entities.every((entity) => entity.status === 'ok')).toBe(true);
    expect(batch.entities).toHaveLength(10);
    expect(batch.complete).toBe(true);
  });
  it('treats a cut-off body like a 5xx', async () => {
    const fetcher = byOperation((operation, numbers) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex') return response(aliased(numbers, (n) => indexPr(n)));
      if (numbers.includes(7)) return new Response('{"data":{"rateLimit"', { status: 200 });
      return response(aliased(numbers, (n) => ({ pullRequest: wire(n) })));
    });
    const batch = await adapter(fetcher).poll(context([refOf(7), refOf(8)], cursor));
    expect(batch.entities).toEqual([
      { ref: refOf(7), status: 'no_access' },
      { ref: refOf(8), status: 'ok' },
    ]);
    expect(batch.complete).toBe(false);
    expect(numbersSent(fetcher, 'PrDetails')).toEqual([[7, 8], [7], [8]]);
  });
  it('applies details when discovery returns 502', async () => {
    const fetcher = byOperation((operation, numbers) => {
      if (operation === 'PrBatch') return failure();
      if (operation === 'PrIndex') return response(aliased(numbers, (n) => indexPr(n)));
      return response(aliased(numbers, (n) => ({ pullRequest: wire(n) })));
    });
    const ctx = context([refOf(7)], cursor);
    const batch = await adapter(fetcher).poll(ctx);
    expect(batch.entities).toEqual([{ ref: refOf(7), status: 'ok' }]);
    expect(okFacts(batch).map((facts) => facts.number)).toEqual([7]);
    expect(batch.complete).toBe(false);
    expect(batch.cursor).toBe(ctx.cursor);
  });
  it('rejects a lone discovery 502', async () => {
    const fetcher = byOperation(() => failure());
    await expect(adapter(fetcher).poll(context([], cursor))).rejects.toMatchObject({
      kind: 'transient',
      message: 'HTTP 502',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reads every PR in full after an unscoped index error, without rejecting', async () => {
    const fetcher = byOperation((operation, numbers) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex')
        return response(
          aliased(numbers, () => null),
          [{ message: 'Field does not exist' }],
        );
      return response(aliased(numbers, (n) => ({ pullRequest: wire(n) })));
    });
    const batch = await adapter(fetcher).poll(context([refOf(7)], cursor));
    expect(batch.entities).toEqual([{ ref: refOf(7), status: 'ok' }]);
    expect(batch.complete).toBe(true);
    expect(numbersSent(fetcher, 'PrDetails')).toEqual([[7]]);
  });
  it('stops after MAX_FAILED_REQUESTS', async () => {
    const numbers = Array.from({ length: 51 }, (_, i) => i + 1);
    let indexDown = false;
    const fetcher = byOperation((operation, sent) => {
      if (operation === 'PrBatch') return discoveryAnswer(indexDown ? [operatorNode(99)] : []);
      if (operation === 'PrIndex')
        return indexDown
          ? failure()
          : response(aliased(sent, (n) => indexPr(n, { state: 'MERGED' })));
      return response(
        aliased(sent, (n) => ({ pullRequest: { ...wire(n), state: 'MERGED', mergedAt: time } })),
      );
    });
    const source = adapter(fetcher);
    const first = await source.poll(context(numbers.map(refOf), cursor));
    expect(first.entities.every((entity) => entity.status === 'ok')).toBe(true);
    indexDown = true;
    fetcher.mockClear();
    const ctx = context(numbers.map(refOf), cursor);
    const batch = await source.poll(ctx);
    const failed = await Promise.all(
      fetcher.mock.results.map(async (result) =>
        result.type === 'return' ? !(await result.value).ok : false,
      ),
    );
    expect(failed.filter(Boolean)).toHaveLength(8);
    // Discovery, then eight failed index requests and nothing after them.
    expect(failed).toEqual([false, ...Array<boolean>(8).fill(true)]);
    expect(numbersSent(fetcher, 'PrIndex').map((sent) => sent.length)).toEqual([
      50, 25, 13, 7, 4, 2, 1, 1,
    ]);
    expect(batch.entities).toHaveLength(51);
    expect(batch.entities.every((entity) => entity.status === 'no_access')).toBe(true);
    expect(batch.items).toEqual([]);
    expect(batch.cursor).toBe(ctx.cursor);
    expect(batch.complete).toBe(false);
  });
  it('rejects with the first transient error when every request fails', async () => {
    let calls = 0;
    const fetcher = byOperation(() => failure(calls++ === 0 ? 503 : 502));
    await expect(adapter(fetcher).poll(context([refOf(7)], cursor))).rejects.toMatchObject({
      kind: 'transient',
      message: 'HTTP 503',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects a throttled chunk without resending', async () => {
    const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
    const fetcher = byOperation((operation, sent) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex') return response(aliased(sent, (n) => indexPr(n)));
      return failure(429);
    });
    await expect(adapter(fetcher).poll(context(numbers.map(refOf), cursor))).rejects.toMatchObject({
      kind: 'throttled',
    });
    expect(numbersSent(fetcher, 'PrDetails')).toHaveLength(1);
  });
  it('rejects after abort during halving', async () => {
    const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
    const controller = new AbortController();
    let details = 0;
    const fetcher = byOperation((operation, sent) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex') return response(aliased(sent, (n) => indexPr(n)));
      details += 1;
      if (details === 2) controller.abort(new Error('stop'));
      return failure();
    });
    const ctx = { ...context(numbers.map(refOf), cursor), signal: controller.signal };
    await expect(adapter(fetcher).poll(ctx)).rejects.toThrow();
    expect(numbersSent(fetcher, 'PrDetails').map((sent) => sent.length)).toEqual([10, 5]);
  });
});

describe('PR index cache', () => {
  const cursor = '2026-01-01T00:00:00.000Z';
  const merged = (number: number) => ({ ...wire(number), state: 'MERGED', mergedAt: time });
  /**
   * One source polled again and again: `index` and `detail` give this poll's answers, and
   * `detailCalls` counts the PRs read in full since the last `reset`.
   */
  function scenario() {
    let t = Date.parse('2026-01-02T00:00:00.000Z');
    const state = {
      index: (n: number): unknown => indexPr(n, n === 7 ? { state: 'MERGED' } : {}),
      detail: (n: number): unknown => (n === 7 ? merged(n) : wire(n)),
      indexStatus: 200,
      remaining: 4321,
    };
    const fetcher = byOperation((operation, numbers) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex') {
        if (state.indexStatus !== 200) return failure(state.indexStatus);
        return response({
          ...aliased(numbers, state.index),
          rateLimit: { remaining: state.remaining, resetAt: '2026-01-03T00:00:00.000Z' },
        });
      }
      if (operation === 'PrPage') return failure();
      return response(aliased(numbers, (n) => ({ pullRequest: state.detail(n) })));
    });
    const source = adapter(fetcher, config(), 0, () => t);
    return {
      state,
      source,
      advance: (ms: number) => {
        t += ms;
      },
      poll: (prs = [refOf(7), refOf(8)], extra: object = {}) => {
        fetcher.mockClear();
        return source.poll({ ...context(prs, cursor), ...extra });
      },
      details: () => numbersSent(fetcher, 'PrDetails').flat(),
      indexes: () => numbersSent(fetcher, 'PrIndex').flat(),
    };
  }

  it('re-emits an unchanged merged PR and an open PR with a green rollup', async () => {
    const run = scenario();
    const first = await run.poll();
    expect(run.details()).toEqual([7, 8]);
    const second = await run.poll();
    expect(run.indexes()).toEqual([7, 8]);
    expect(run.details()).toEqual([]);
    expect(batchSchema.parse(second)).toEqual(second);
    expect(second.entities).toEqual([
      { ref: refOf(7), status: 'ok' },
      { ref: refOf(8), status: 'ok' },
    ]);
    expect(factsFor(second, 7)).toEqual(factsFor(first, 7));
    expect(factsFor(second, 8)).toEqual(factsFor(first, 8));
    expect(second.complete).toBe(true);
  });
  it.each([
    ['updatedAt', { updatedAt: '2026-01-05T00:00:00.000Z' }],
    ['head', { headRefOid: 'b'.repeat(40) }],
    ['review state', { reviews: { totalCount: 1, nodes: [{ id: 'PRR_1', state: 'DISMISSED' }] } }],
    ['resolved thread', { reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] } }],
    ['comment count', { comments: { totalCount: 1, nodes: [{ id: 'IC_1' }] } }],
  ])('reads a PR in full again when its index %s changes', async (_name, change) => {
    const run = scenario();
    await run.poll();
    run.state.index = (n) => indexPr(n, n === 7 ? { state: 'MERGED', ...change } : {});
    await run.poll();
    expect(run.details()).toEqual([7]);
  });
  it.each(['PENDING', 'EXPECTED', 'ERROR', 'SOMETHING_NEW'])(
    'reads an open PR in full again while its rollup is %s',
    async (rollup) => {
      const run = scenario();
      run.state.index = (n) => indexPr(n, { statusCheckRollup: { state: rollup } });
      await run.poll([refOf(8)]);
      await run.poll([refOf(8)]);
      expect(run.details()).toEqual([8]);
    },
  );
  it('reads a failed open PR in full and reports a check that finished since', async () => {
    const run = scenario();
    run.state.index = (n) => indexPr(n, { statusCheckRollup: { state: 'FAILURE' } });
    await run.poll([refOf(8)]);
    const finished = wire(8);
    finished.statusCheckRollup.contexts.nodes = [
      {
        __typename: 'CheckRun',
        name: 'build',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        completedAt: '2026-01-04T00:00:00.000Z',
        isRequired: true,
      },
    ];
    run.state.detail = () => finished;
    const second = await run.poll([refOf(8)]);
    expect(run.details()).toEqual([8]);
    expect((factsFor(second, 8) as { requiredChecks: unknown }).requiredChecks).toEqual([
      { name: 'build', state: 'failure', completedAt: '2026-01-04T00:00:00.000Z' },
    ]);
  });
  it('reads in full again after the open and the closed refresh', async () => {
    const run = scenario();
    await run.poll();
    run.advance(OPEN_REFRESH_MS - 1);
    await run.poll();
    expect(run.details()).toEqual([]);
    run.advance(1);
    await run.poll();
    expect(run.details()).toEqual([8]);
    run.advance(CLOSED_REFRESH_MS - OPEN_REFRESH_MS - 1);
    await run.poll([refOf(7)]);
    expect(run.details()).toEqual([]);
    run.advance(1);
    await run.poll([refOf(7)]);
    expect(run.details()).toEqual([7]);
  });
  it('reads in full again when the feedback cursor moves', async () => {
    const run = scenario();
    const at = (id: string) => ({
      feedbackCursors: [{ ref: refOf(7), id, postedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await run.poll(undefined, at('IC_1'));
    await run.poll(undefined, at('IC_1'));
    expect(run.details()).toEqual([]);
    await run.poll(undefined, at('IC_2'));
    expect(run.details()).toEqual([7]);
  });
  it('reads in full again when the cached feedback was incomplete', async () => {
    const run = scenario();
    run.state.detail = (n) => ({ ...merged(n), comments: back([], 'older') });
    const first = await run.poll([refOf(7)]);
    expect((factsFor(first, 7) as { feedbackComplete: boolean }).feedbackComplete).toBe(false);
    await run.poll([refOf(7)]);
    expect(run.details()).toEqual([7]);
  });
  it('reads in full again after pollPr read the PR', async () => {
    const run = scenario();
    await run.poll();
    await run.source.pollPr?.(refOf(7), { signal: new AbortController().signal });
    await run.poll();
    expect(run.details()).toEqual([7]);
  });
  it('drops the cache entry when a full read has no fingerprint from its poll', async () => {
    const run = scenario();
    const titled = (title: string) => () => ({ ...merged(7), title });
    run.state.detail = titled('first');
    await run.poll([refOf(7)]);
    run.state.indexStatus = 502;
    run.state.detail = titled('second');
    const second = await run.poll([refOf(7)]);
    expect(run.details()).toEqual([7]);
    expect(second.entities).toEqual([{ ref: refOf(7), status: 'ok' }]);
    run.state.indexStatus = 200;
    run.state.detail = titled('third');
    const third = await run.poll([refOf(7)]);
    expect(run.details()).toEqual([7]);
    expect((factsFor(third, 7) as { title: string }).title).toBe('third');
  });
  it('defers details below the reserve and keeps the index', async () => {
    const run = scenario();
    await run.poll();
    run.state.remaining = 500;
    run.state.index = (n) =>
      indexPr(n, n === 7 ? { state: 'MERGED' } : { updatedAt: '2026-01-05T00:00:00.000Z' });
    const batch = await run.poll();
    expect(run.indexes()).toEqual([7, 8]);
    expect(run.details()).toEqual([]);
    expect(batch.entities).toEqual([
      { ref: refOf(7), status: 'ok' },
      { ref: refOf(8), status: 'no_access' },
    ]);
    expect(batch.complete).toBe(false);
    expect(batch.budget?.remaining).toBe(500);
  });
});
