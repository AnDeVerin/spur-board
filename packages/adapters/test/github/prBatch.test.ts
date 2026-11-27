import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  AdapterError,
  DEFAULT_LINK,
  batchSchema,
  configSchema,
  isExternalAuthor,
  prFactsSchema,
  sourceCursorSchema,
  type Adapter,
  type Batch,
  type PollContext,
} from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  GithubClient,
  detailQuery,
  discoveryQuery,
  indexQuery,
  pageQuery,
  type Json,
} from '../../src/github/client.ts';
import { githubSources } from '../../src/github/index.ts';
import { CLOSED_REFRESH_MS, OPEN_REFRESH_MS } from '../../src/github/prIndex.ts';
import { sampleLinkRules } from '../../src/github/linkSample.ts';
import { branchRuleOf, branchRuleWire } from '../../src/github/branchRule.ts';
import {
  normalizePr,
  normalizeReviewRule,
  ticketKeys,
  type KeyRule,
} from '../../src/github/prBatch.ts';

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
    closedAt: null,
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
      'f06184e198bbd46225bd3385bed0e40e08d7576a9799be044662b7730db1c5e3',
    );
    expect(query).toContain('rateLimit { cost limit remaining resetAt }');
    expect(query).toContain('pullRequests(first: 100');
    expect(query).not.toContain('pr0: repository');
    expect(query).toContain('states: [OPEN, MERGED, CLOSED]');
    expect(pageQuery('pullRequests')).toContain('states: [OPEN, MERGED, CLOSED]');
    const details = detailQuery([7]);
    expect(details).toContain('rateLimit { cost limit remaining resetAt }');
    expect(details).toContain('pr0: repository');
    const bootstrapQuery = discoveryQuery(true);
    expect(createHash('sha256').update(bootstrapQuery).digest('hex')).toBe(
      '41f7203df8ba99634d1d3cc1e94fedc348618799c19633671b354d463bc81240',
    );
    expect(bootstrapQuery).toContain('states: [OPEN]');
    expect(bootstrapQuery).toContain(
      'mergedBaseline: pullRequests(first: 1, states: [MERGED, CLOSED]',
    );
    expect(pageQuery('pullRequests', true)).toContain('states: [OPEN]');
    for (const discovery of [query, bootstrapQuery]) {
      expect(discovery).toContain('defaultBranchRef { name');
      expect(discovery).toContain('workflowRun { event workflow { id } }');
    }
    for (const other of [pageQuery('pullRequests'), pageQuery('pullRequests', true), details]) {
      expect(other).not.toContain('defaultBranchRef');
      expect(other).not.toContain('detailsUrl');
    }
    for (const page of [pageQuery('pullRequests'), pageQuery('pullRequests', true)])
      expect(page).not.toContain('workflowRun { event workflow { id } }');
    expect(details).not.toContain('closingIssuesReferences');
    expect(bootstrapQuery).not.toContain('closingIssuesReferences');
    const issuesQuery = detailQuery([7], true);
    expect(createHash('sha256').update(issuesQuery).digest('hex')).toBe(
      'e121c5963592c0e3562950f0b7cb0525bf165bdaf3e062e828ee5e929f29b716',
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
    expect(detailQuery([7])).toContain('updatedAt mergedAt closedAt state');
  });
  it('reads closedAt for a PR closed without merge only', () => {
    const closed = '2026-01-02T00:00:00.000Z';
    const edited = '2026-01-05T00:00:00.000Z';
    const facts = normalizePr(
      'demo/widgets',
      { ...wire(), state: 'CLOSED', closedAt: closed, updatedAt: edited },
      demoKeys,
      true,
    );
    expect(facts).toMatchObject({ state: 'closed', closedAt: closed, updatedAt: edited });
    expect(normalizePr('demo/widgets', wire(), demoKeys, true)).not.toHaveProperty('closedAt');
    expect(
      normalizePr(
        'demo/widgets',
        { ...wire(), state: 'MERGED', mergedAt: closed, closedAt: closed },
        demoKeys,
        true,
      ),
    ).not.toHaveProperty('closedAt');
    expect(
      normalizePr('demo/widgets', { ...wire(), state: 'CLOSED' }, demoKeys, true),
    ).not.toHaveProperty('closedAt');
  });
  it('maps review thread ids, outdated flags and first comment URLs', () => {
    const url = 'https://github.com/demo/widgets/pull/7#discussion_r1';
    const pr = {
      ...wire(),
      reviewThreads: conn([
        {
          id: 'PRRT_1',
          isResolved: false,
          isOutdated: true,
          comments: conn([{ id: 'PRRC_1', url }]),
        },
        { id: 'PRRT_2', isResolved: true, isOutdated: false, comments: conn([]) },
        // A recording of the earlier selection carries the resolved flag alone.
        { isResolved: false },
      ]),
    };
    expect(normalizePr('demo/widgets', pr, demoKeys, true).reviewThreads).toEqual([
      { resolved: false, id: 'PRRT_1', url, outdated: true },
      { resolved: true, id: 'PRRT_2', outdated: false },
      { resolved: false },
    ]);
    for (const query of [detailQuery([7]), pageQuery('reviewThreads')])
      expect(query).toContain(
        'nodes { id isResolved isOutdated comments(last: 100) { nodes { id url lastEditedAt pullRequestReview { id } } } }',
      );
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
    expect(pageQuery('contexts')).toContain(
      'startedAt completedAt checkSuite { createdAt id workflowRun { event runNumber runAttempt workflow { id } } app { id } }',
    );
    expect(detailQuery([7])).toContain(
      'startedAt completedAt checkSuite { createdAt id workflowRun { event runNumber runAttempt workflow { id } } app { id } }',
    );
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
  it('keys check reruns by workflow, app or status context', () => {
    const early = '2026-01-03T00:00:00.000Z';
    const late = '2026-01-04T00:00:00.000Z';
    const run = (conclusion: string, at: string, suite: Json): Json => ({
      __typename: 'CheckRun',
      name: 'test',
      status: 'COMPLETED',
      conclusion,
      startedAt: at,
      completedAt: at,
      checkSuite: { createdAt: at, ...(suite as Record<string, Json>) },
      isRequired: true,
    });
    const status = (state: string, at: string): Json => ({
      __typename: 'StatusContext',
      context: 'test',
      state,
      createdAt: at,
      isRequired: true,
    });
    const workflow = (id: string): Json => ({ workflowRun: { workflow: { id } }, app: null });
    const app = (id: string): Json => ({ workflowRun: null, app: { id } });
    const red = { name: 'test', state: 'failure', completedAt: early };
    const green = { name: 'test', state: 'success', completedAt: late };
    const cases: { name: string; nodes: Json[]; checks: unknown[] }[] = [
      {
        name: 'two workflows',
        nodes: [run('FAILURE', early, workflow('W_1')), run('SUCCESS', late, workflow('W_2'))],
        checks: [red, green],
      },
      {
        name: 'rerun in one workflow',
        nodes: [run('FAILURE', early, workflow('W_1')), run('SUCCESS', late, workflow('W_1'))],
        checks: [green],
      },
      {
        name: 'two apps',
        nodes: [run('FAILURE', early, app('A_1')), run('SUCCESS', late, app('A_2'))],
        checks: [red, green],
      },
      {
        name: 'rerun from one app',
        nodes: [run('FAILURE', early, app('A_1')), run('SUCCESS', late, app('A_1'))],
        checks: [green],
      },
      {
        name: 'status beside a check run',
        nodes: [status('FAILURE', early), run('SUCCESS', late, workflow('W_1'))],
        checks: [green, { name: 'test', state: 'failure', completedAt: null }],
      },
      {
        name: 'two statuses with one context',
        nodes: [status('FAILURE', early), status('SUCCESS', late)],
        checks: [{ name: 'test', state: 'success', completedAt: null }],
      },
    ];
    for (const { name, nodes, checks } of cases) {
      const pr = { ...wire(), statusCheckRollup: { contexts: conn(nodes) } };
      const facts = normalizePr('demo/widgets', pr, demoKeys, true);
      expect(facts.checks, name).toEqual(checks);
      expect(facts.requiredChecks, name).toEqual(checks);
    }
  });
  it('normalizes each checks fixture', () => {
    const cases = fixtures('checks');
    expect(cases.map((entry) => entry.name)).toEqual([
      'newer-run-done-without-check',
      'newer-run-in-progress',
      'newer-run-skipped-again',
      'newer-run-succeeded',
      'newer-runs-same-second',
    ]);
    for (const { name, value } of cases) {
      const pr = { ...wire(), statusCheckRollup: value['statusCheckRollup'] };
      expect(normalizePr('demo/widgets', pr, demoKeys, true).requiredChecks, name).toEqual(
        value['requiredChecks'],
      );
    }
  });
  it('lets only the newest suite of its workflow and event decide a skipped required check', () => {
    const early = '2026-01-03T00:00:00.000Z';
    const late = '2026-01-04T00:00:00.000Z';
    // Suite n has node id `CS_kwDOH${n}` and run number n; null has neither id nor run fields.
    const run = (n: number | null, workflowRun: Json, runNumber = n): Json =>
      workflowRun === null || runNumber === null
        ? workflowRun
        : { ...(workflowRun as Record<string, Json>), runNumber, runAttempt: 1 };
    const suiteId = (n: number | null): string | null =>
      n === null ? null : `CS_kwDOH${String(n)}`;
    const skipped = (
      required = true,
      workflowRun: Json = { event: 'pull_request', workflow: { id: 'W_1' } },
      at = early,
    ): Json => ({
      __typename: 'CheckRun',
      name: 'notify',
      status: 'COMPLETED',
      conclusion: 'SKIPPED',
      startedAt: at,
      completedAt: at,
      checkSuite: {
        id: suiteId(1),
        createdAt: early,
        workflowRun: run(1, workflowRun),
        app: { id: 'A_1' },
      },
      isRequired: required,
    });
    // The newer suite's run of the job, started before the older run recorded its skip.
    const ranAt = '2026-01-04T00:01:00.000Z';
    const newest = '2026-01-04T00:02:00.000Z';
    const slowSkip = skipped(true, undefined, '2026-01-05T00:00:00.000Z');
    const lateSkip = { name: 'notify', state: 'skipped', completedAt: '2026-01-05T00:00:00.000Z' };
    const newerRun = (
      status: string,
      conclusion: string | null,
      event = 'pull_request',
      n: number | null = 2,
      createdAt = late,
    ): Json => ({
      __typename: 'CheckRun',
      name: 'notify',
      status,
      conclusion,
      startedAt: ranAt,
      completedAt: conclusion === null ? null : ranAt,
      checkSuite: {
        id: suiteId(n),
        createdAt,
        workflowRun: run(n, { event, workflow: { id: 'W_1' } }),
        app: { id: 'A_1' },
      },
      isRequired: true,
    });
    const suite = (
      status: string,
      createdAt = late,
      workflow: string | null = 'W_1',
      event: string | null = 'pull_request',
      n: number | null = 2,
      runNumber: number | null = n,
    ): Json => ({
      id: suiteId(n),
      status,
      createdAt,
      workflowRun:
        workflow === null
          ? null
          : run(n, { ...(event === null ? {} : { event }), workflow: { id: workflow } }, runNumber),
    });
    const suites = (nodes: Json[], hasNextPage = false): Json => ({
      checkSuites: { nodes, pageInfo: { hasNextPage } },
    });
    const red = { name: 'notify', state: 'skipped', completedAt: early };
    const pending = { name: 'notify', state: 'pending', completedAt: null };
    const cases: { name: string; node: Json; others?: Json[]; commit?: Json; check: unknown }[] = [
      {
        name: 'newer suite already failed the job',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'FAILURE')],
        commit: suites([suite('IN_PROGRESS')]),
        check: { name: 'notify', state: 'failure', completedAt: ranAt },
      },
      {
        name: 'newer suite still runs the job',
        node: slowSkip,
        others: [newerRun('IN_PROGRESS', null)],
        commit: suites([suite('IN_PROGRESS')]),
        check: pending,
      },
      {
        name: 'newer suite passed the job',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS')],
        commit: suites([suite('IN_PROGRESS')]),
        check: { name: 'notify', state: 'success', completedAt: ranAt },
      },
      {
        name: 'finished newer suite passed the job',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS')],
        commit: suites([suite('COMPLETED')]),
        check: { name: 'notify', state: 'success', completedAt: ranAt },
      },
      {
        name: 'finished newer suite failed the job',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'FAILURE')],
        commit: suites([suite('COMPLETED')]),
        check: { name: 'notify', state: 'failure', completedAt: ranAt },
      },
      {
        name: 'newer run of the job from a manual dispatch',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS', 'workflow_dispatch', 3)],
        commit: suites([suite('COMPLETED', late, 'W_1', 'workflow_dispatch', 3)]),
        check: lateSkip,
      },
      {
        name: 'manual dispatch run beside an unfinished pull request run',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS', 'workflow_dispatch', 3)],
        commit: suites([
          suite('IN_PROGRESS'),
          suite('COMPLETED', late, 'W_1', 'workflow_dispatch', 3),
        ]),
        check: pending,
      },
      {
        name: 'two newer suites created together: the higher run number decides',
        node: slowSkip,
        others: [
          newerRun('COMPLETED', 'SUCCESS', 'pull_request', 2),
          newerRun('COMPLETED', 'FAILURE', 'pull_request', 3),
        ],
        commit: suites([suite('COMPLETED'), suite('IN_PROGRESS', late, 'W_1', 'pull_request', 3)]),
        check: { name: 'notify', state: 'failure', completedAt: ranAt },
      },
      {
        name: 'two newer suites created together without run numbers',
        node: slowSkip,
        others: [
          newerRun('COMPLETED', 'SUCCESS', 'pull_request', null),
          newerRun('COMPLETED', 'FAILURE', 'pull_request', null),
        ],
        commit: suites([
          suite('COMPLETED', late, 'W_1', 'pull_request', null),
          suite('IN_PROGRESS', late, 'W_1', 'pull_request', null),
        ]),
        check: lateSkip,
      },
      {
        name: 'three newer suites created together, one without a run number',
        node: slowSkip,
        others: [
          newerRun('COMPLETED', 'SUCCESS', 'pull_request', 2),
          newerRun('COMPLETED', 'FAILURE', 'pull_request', 3),
        ],
        commit: suites([
          suite('COMPLETED', late, 'W_1', 'pull_request', null),
          suite('COMPLETED'),
          suite('IN_PROGRESS', late, 'W_1', 'pull_request', 3),
        ]),
        check: lateSkip,
      },
      {
        name: 'middle suite passed the job, newest runs without it yet',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS')],
        commit: suites([
          suite('COMPLETED'),
          suite('IN_PROGRESS', newest, 'W_1', 'pull_request', 3),
        ]),
        check: pending,
      },
      {
        name: 'middle suite passed the job, newest finished without it',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS')],
        commit: suites([suite('COMPLETED'), suite('COMPLETED', newest, 'W_1', 'pull_request', 3)]),
        check: lateSkip,
      },
      {
        name: 'null suite nodes',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS')],
        commit: { checkSuites: { nodes: null, pageInfo: { hasNextPage: false } } },
        check: lateSkip,
      },
      {
        name: 'no newer suite',
        node: skipped(),
        commit: suites([suite('COMPLETED', early, 'W_1', 'pull_request', 1)]),
        check: red,
      },
      {
        name: 'other workflow',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS', late, 'W_2')]),
        check: red,
      },
      {
        name: 'suite without workflow run',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS', late, null)]),
        check: red,
      },
      {
        name: 'truncated list',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS')], true),
        check: red,
      },
      { name: 'no commit', node: skipped(), commit: null, check: red },
      { name: 'no suite list', node: skipped(), commit: { checkSuites: null }, check: red },
      { name: 'no commit selected', node: skipped(), check: red },
      {
        name: 'same creation time',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS', early, 'W_1', 'pull_request', null)]),
        check: red,
      },
      {
        name: 'skipped run without workflow',
        node: skipped(true, null),
        commit: suites([suite('IN_PROGRESS')]),
        check: red,
      },
      {
        name: 'manual dispatch of the workflow',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS', late, 'W_1', 'workflow_dispatch')]),
        check: red,
      },
      {
        name: 'newer suite without event',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS', late, 'W_1', null)]),
        check: red,
      },
      {
        name: 'skipped run without event',
        node: skipped(true, { workflow: { id: 'W_1' } }),
        commit: suites([suite('IN_PROGRESS')]),
        check: red,
      },
      {
        name: 'newer pull request run',
        node: skipped(),
        commit: suites([suite('IN_PROGRESS')]),
        check: pending,
      },
      {
        name: 'not required',
        node: skipped(false),
        commit: suites([suite('IN_PROGRESS')]),
        check: red,
      },
      {
        name: 'newer run waits',
        node: skipped(),
        commit: suites([suite('WAITING')]),
        check: pending,
      },
      {
        name: 'null suite beside a newer run',
        node: skipped(),
        commit: suites([null, suite('IN_PROGRESS')]),
        check: red,
      },
      {
        name: 'null suite beside a middle suite that passed the job',
        node: slowSkip,
        others: [newerRun('COMPLETED', 'SUCCESS')],
        commit: suites([null, suite('COMPLETED')]),
        check: lateSkip,
      },
      {
        name: 'two newer suites created together with one run number and attempt',
        node: slowSkip,
        commit: suites([
          suite('COMPLETED', late, 'W_1', 'pull_request', 2),
          suite('IN_PROGRESS', late, 'W_1', 'pull_request', 3, 2),
        ]),
        check: lateSkip,
      },
    ];
    for (const { name, node, others = [], commit, check } of cases) {
      const statusCheckRollup = {
        contexts: conn([node, ...others]),
        ...(commit === undefined ? {} : { commit }),
      };
      const facts = normalizePr('demo/widgets', { ...wire(), statusCheckRollup }, demoKeys, true);
      expect(facts.checks, name).toEqual([check]);
      expect(facts.requiredChecks, name).toEqual(name === 'not required' ? [] : [check]);
    }
  });
  it('selects the head check suites in the detail query only', () => {
    const selection =
      'commit { checkSuites(first: 100) { nodes { id status createdAt workflowRun { event runNumber runAttempt workflow { id } } } pageInfo { hasNextPage } } }';
    expect(detailQuery([7])).toContain(`statusCheckRollup { contexts(first: 100) {`);
    expect(detailQuery([7])).toContain(selection);
    expect(pageQuery('contexts')).not.toContain('checkSuites');
    expect(indexQuery([7])).not.toContain('checkSuites');
  });
  it.each([
    ['commit', { commit: null }, ['statusCheckRollup', 'commit']],
    [
      'suite list',
      { commit: { checkSuites: null } },
      ['statusCheckRollup', 'commit', 'checkSuites'],
    ],
    [
      'suite beside a newer run',
      {
        contexts: conn([
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'SKIPPED',
            completedAt: time,
            checkSuite: {
              createdAt: '2026-01-03T00:00:00.000Z',
              workflowRun: { event: 'pull_request', workflow: { id: 'W_1' } },
            },
            isRequired: true,
          },
        ]),
        commit: {
          checkSuites: {
            nodes: [
              null,
              {
                status: 'IN_PROGRESS',
                createdAt: '2026-01-04T00:00:00.000Z',
                workflowRun: { event: 'pull_request', workflow: { id: 'W_1' } },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
      ['statusCheckRollup', 'commit', 'checkSuites', 'nodes', 0],
    ],
  ])('keeps the PR complete when its head %s is denied', async (_name, denied, path) => {
    const pr = wire();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          repository: { pullRequests: conn([]) },
          pr0: {
            pullRequest: { ...pr, statusCheckRollup: { ...pr.statusCheckRollup, ...denied } },
          },
        },
        [
          {
            message: 'Resource not accessible by personal access token',
            type: 'FORBIDDEN',
            path: ['pr0', 'pullRequest', ...path],
          },
        ],
      ),
    );
    const batch = await adapter(fetcher).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect((factsFor(batch, 7) as { requiredChecks: unknown }).requiredChecks).toEqual([
      { name: 'build', state: 'skipped', completedAt: time },
    ]);
  });
  it('keeps the suite list when check contexts span two pages', async () => {
    const at = '2026-01-03T00:00:00.000Z';
    const first = {
      ...wire(),
      statusCheckRollup: {
        contexts: conn(
          [
            {
              __typename: 'CheckRun',
              name: 'notify',
              status: 'COMPLETED',
              conclusion: 'SKIPPED',
              startedAt: at,
              completedAt: at,
              checkSuite: {
                createdAt: at,
                workflowRun: { event: 'pull_request', workflow: { id: 'W_1' } },
                app: null,
              },
              isRequired: true,
            },
          ],
          'checks-next',
        ),
        commit: {
          checkSuites: {
            nodes: [
              {
                status: 'IN_PROGRESS',
                createdAt: '2026-01-04T00:00:00.000Z',
                workflowRun: { event: 'pull_request', workflow: { id: 'W_1' } },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: first } }),
      )
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: conn([
                  {
                    __typename: 'StatusContext',
                    context: 'ci/legacy',
                    state: 'SUCCESS',
                    createdAt: at,
                    isRequired: false,
                  },
                ]),
              },
            },
          },
        }),
      );
    const batch = await adapter(fetcher).poll(context());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((factsFor(batch, 7) as { requiredChecks: unknown }).requiredChecks).toEqual([
      { name: 'notify', state: 'pending', completedAt: null },
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
  it('reports a valid GraphQL budget limit and leaves out an invalid one', async () => {
    const resetAt = '2026-01-03T00:00:00.000Z';
    const poll = (limit: unknown) =>
      adapter(
        vi.fn<typeof fetch>().mockResolvedValue(
          response({
            rateLimit: { cost: 1, limit, remaining: 4321, resetAt },
            repository: { pullRequests: conn([]) },
            pr0: { pullRequest: wire() },
          }),
        ),
      ).poll(context());
    const valid = await poll(5000);
    expect(batchSchema.parse(valid)).toEqual(valid);
    expect(valid.budget).toEqual({ remaining: 4321, limit: 5000, resetAt });
    for (const limit of [0, 'x']) {
      const batch = await poll(limit);
      expect(batchSchema.parse(batch)).toEqual(batch);
      expect(batch.complete).toBe(true);
      expect(batch.budget).toEqual({ remaining: 4321, resetAt });
    }
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
  it('continues a PR review thread connection with each thread link', async () => {
    const first = wire();
    first.reviewThreads.pageInfo = { hasNextPage: true, endCursor: 'thread-next' };
    const url = 'https://github.com/demo/widgets/pull/7#discussion_r2';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: first } }),
      )
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequest: {
              reviewThreads: conn([
                {
                  id: 'PRRT_2',
                  isResolved: false,
                  isOutdated: true,
                  comments: conn([{ id: 'PRRC_2', url }]),
                },
              ]),
            },
          },
        }),
      );
    const batch = await adapter(fetcher).poll(context());
    expect(batch.items[0]?.kind === 'pr' && batch.items[0].facts.reviewThreads).toEqual([
      { resolved: false },
      { resolved: false, id: 'PRRT_2', url, outdated: true },
    ]);
    expect(sentQueries(fetcher, 'PrPage')[0]).toContain(
      'reviewThreads(first: 100, after: $after) { nodes { id isResolved isOutdated comments(last: 100) { nodes { id url lastEditedAt pullRequestReview { id } } } }',
    );
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

/** Comment `i` of a long history, one second apart, as the wire and as a held feedback entry. */
const historyAt = (i: number) => new Date(Date.parse(time) + i * 1000).toISOString();
const historyNodes = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `IC_${String(from + i)}`,
    author: { __typename: 'User', login: 'alice' },
    createdAt: historyAt(from + i),
  }));
const heldHistory = (resume: string | null, from: number, to: number) => ({
  ref,
  resume: resume === null ? null : sourceCursorSchema.parse(resume),
  feedback: Array.from({ length: to - from }, (_, i) => ({
    kind: 'comment' as const,
    id: `IC_${String(from + i)}`,
    author: { login: 'alice', type: 'user' as const },
    postedAt: historyAt(from + i),
  })),
});
const historyIds = (batch: { items: { kind: string; facts?: unknown }[] }) =>
  prFactsSchema
    .parse(batch.items[0]?.facts)
    .feedback?.filter((entry) => entry.kind === 'comment')
    .map((entry) => entry.id);

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

  const commentsPage = (nodes: Json[], startCursor: string | null = null) =>
    response({ repository: { pullRequest: { comments: back(nodes, startCursor) } } });
  const withComments = (nodes: Json[], startCursor: string) =>
    response({ pr0: { pullRequest: { ...wire(), comments: back(nodes, startCursor) } } });

  it('merges the held history within 3 comment pages and states no continuation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(withComments(historyNodes(320, 400), 'p9'))
      .mockResolvedValueOnce(commentsPage(historyNodes(280, 320), 'p8'))
      .mockResolvedValueOnce(commentsPage(historyNodes(0, 100)))
      .mockRejectedValue(new Error('unexpected request'));
    const batch = await pollPr(fetcher)(ref, {
      signal: signal(),
      continuations: [heldHistory('p1', 100, 300)],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(historyIds(batch)).toEqual(historyNodes(0, 400).map((node) => node.id));
    expect(batch.items[0]?.facts).toMatchObject({ feedbackComplete: true });
    expect(batch.items[0]).not.toHaveProperty('continuation');
    expect(batchSchema.parse(batch)).toEqual(batch);
  });

  it('states no continuation for a PR past the page budget without a held history', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(withComments(historyNodes(200, 300), 'p2'))
      .mockResolvedValueOnce(commentsPage(historyNodes(100, 200), 'p1'))
      .mockResolvedValueOnce(commentsPage(historyNodes(0, 100), 'p0'))
      .mockRejectedValue(new Error('unexpected request'));
    const batch = await pollPr(fetcher)(ref, { signal: signal() });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(historyIds(batch)).toHaveLength(300);
    expect(batch.items[0]?.facts).toMatchObject({ feedbackComplete: false });
    expect(batch.items[0]).not.toHaveProperty('continuation');
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
  it('ignores a Jira key number over 15 digits and keeps 15', async () => {
    const scan = (title: string) =>
      adapter(single(issuesPr('feature/x', conn([]), 7, title)), config()).poll(context());
    const batch = await scan('DEMO-1234567890123456 DEMO-12 fix');
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(keysOf(batch)).toEqual([['DEMO-12']]);
    expect(keysOf(await scan('DEMO-123456789012345 fix'))).toEqual([['DEMO-123456789012345']]);
    const link = { branchPattern: '^task/([A-Za-z]+-[0-9]+)' };
    expect(await poll(link, 'task/demo-1234567890123456', 'DEMO-42 Add widget')).toEqual([
      ['DEMO-42'],
    ]);
    expect(await poll(link, 'task/demo-123456789012345')).toEqual([['DEMO-123456789012345']]);
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
      'comments(last: 100) { nodes { id author { __typename login } createdAt body url lastEditedAt }',
    );
  });

  it("carries comment, review and inline-comment URLs, with each inline comment's thread id", async () => {
    const prUrl = 'https://github.com/demo/widgets/pull/7';
    const review = (id: string, i: number, lastEditedAt: string | null = null) => ({
      id,
      author: user('alice'),
      state: 'COMMENTED',
      commit: { oid: sha },
      submittedAt: postedAt(i),
      url: `${prUrl}#pullrequestreview-${String(i)}`,
      lastEditedAt,
    });
    const inline = (i: number, reviewId: string | null, lastEditedAt: string | null = null) => ({
      id: `PRRC_${String(i)}`,
      url: `${prUrl}#discussion_r${String(i)}`,
      lastEditedAt,
      pullRequestReview: reviewId === null ? null : { id: reviewId },
    });
    const pr = {
      ...prWith(
        back([
          { ...comment(1), url: `${prUrl}#issuecomment-1`, lastEditedAt: null },
          { ...comment(2), url: `${prUrl}#issuecomment-2`, lastEditedAt: postedAt(9) },
        ]),
      ),
      reviews: conn([review('PRR_a', 3), review('PRR_b', 4, postedAt(5))]),
      reviewThreads: conn([
        // The root under PRR_a, a reply under PRR_b, and a pending review's comment.
        {
          id: 'PRRT_1',
          isResolved: false,
          comments: {
            nodes: [inline(1, 'PRR_a'), inline(2, 'PRR_b', postedAt(8)), inline(3, null)],
          },
        },
        { id: 'PRRT_2', isResolved: true, comments: { nodes: [inline(4, 'PRR_b')] } },
      ]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial(pr));
    const facts = factsOf(await adapter(fetcher).poll(context()));
    const author = { login: 'alice', type: 'user' };
    expect(facts.feedback).toEqual([
      {
        kind: 'comment',
        id: 'IC_1',
        author,
        postedAt: postedAt(1),
        url: `${prUrl}#issuecomment-1`,
      },
      {
        kind: 'comment',
        id: 'IC_2',
        author,
        postedAt: postedAt(2),
        url: `${prUrl}#issuecomment-2`,
        editedAt: postedAt(9),
      },
      {
        kind: 'review',
        id: 'PRR_a',
        author,
        postedAt: postedAt(3),
        state: 'commented',
        url: `${prUrl}#pullrequestreview-3`,
        comments: [{ id: 'PRRC_1', url: `${prUrl}#discussion_r1`, threadId: 'PRRT_1' }],
      },
      {
        kind: 'review',
        id: 'PRR_b',
        author,
        postedAt: postedAt(4),
        state: 'commented',
        url: `${prUrl}#pullrequestreview-4`,
        // The newest edit of the review body and its inline comments.
        editedAt: postedAt(8),
        comments: [
          {
            id: 'PRRC_2',
            url: `${prUrl}#discussion_r2`,
            threadId: 'PRRT_1',
            editedAt: postedAt(8),
          },
          { id: 'PRRC_4', url: `${prUrl}#discussion_r4`, threadId: 'PRRT_2' },
        ],
      },
    ]);
    expect(facts.reviewThreads).toEqual([
      { resolved: false, id: 'PRRT_1', url: `${prUrl}#discussion_r1` },
      { resolved: true, id: 'PRRT_2', url: `${prUrl}#discussion_r4` },
    ]);
    expect(detailsSent(fetcher)).toContain(
      'reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(last: 100) { nodes { id url lastEditedAt pullRequestReview { id } } } }',
    );
  });

  it('gives no url or thread id when GitHub sends none, as the older recordings do', async () => {
    const pr = {
      ...prWith(back([comment(1)])),
      reviews: conn([
        {
          id: 'PRR_a',
          author: user('alice'),
          state: 'COMMENTED',
          commit: { oid: sha },
          submittedAt: postedAt(2),
        },
      ]),
      reviewThreads: conn([{ isResolved: false }]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial(pr));
    const feedback = factsOf(await adapter(fetcher).poll(context())).feedback ?? [];
    for (const entry of feedback) {
      expect(entry).not.toHaveProperty('url');
      expect(entry).not.toHaveProperty('editedAt');
      expect(entry).not.toHaveProperty('comments');
    }
    expect(feedback).toHaveLength(2);
  });

  it.each([
    ['a progress comment', 'Review completed.\n\n<!-- board-reviewer-progress:12 -->', true],
    [
      'an unavailable comment',
      'Automated review is temporarily unavailable.\n\n<!-- board-reviewer-unavailable:12:abc:f00 -->',
      true,
    ],
    [
      'a marker with trailing blank lines',
      'Review started.\n<!-- board-reviewer-progress:3 -->  \n\n',
      true,
    ],
    ['a bare marker', '<!-- board-reviewer-progress:3 -->', true],
    ['a quoted marker', 'See this:\n> <!-- board-reviewer-progress:3 -->', false],
    ['a marker followed by text', '<!-- board-reviewer-progress:3 -->\nThanks!', false],
    ['a marker inside a line', 'Note <!-- board-reviewer-progress:3 -->', false],
    ['a findings marker', 'Two findings.\n\n<!-- board-reviewer:0b9c6f3e-1 -->', false],
    ['a marker with no value', '<!-- board-reviewer-progress: -->', false],
    ['a free-form comment', 'Please rename this.', false],
    ['an empty body', '', false],
    ['no body', undefined, false],
  ])('flags reviewer status comments by their last marker line: %s', async (_, body, flagged) => {
    const pr = {
      ...prWith(back([{ ...comment(1), ...(body === undefined ? {} : { body }) }])),
      // A review carrying a status marker is still a review, never flagged.
      reviews: conn([
        {
          id: 'PRR_9',
          author: user('alice'),
          state: 'COMMENTED',
          commit: { oid: sha },
          submittedAt: postedAt(2),
          body: '<!-- board-reviewer-progress:7 -->',
        },
      ]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial(pr));
    const facts = factsOf(await adapter(fetcher).poll(context()));
    const [first, review] = facts.feedback ?? [];
    expect(first).toEqual({
      kind: 'comment',
      id: 'IC_1',
      author: { login: 'alice', type: 'user' },
      postedAt: postedAt(1),
      ...(flagged ? { statusComment: true } : {}),
    });
    expect(review).not.toHaveProperty('statusComment');
    expect(JSON.stringify(facts)).not.toContain('board-reviewer');
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
    expect(batch.items[0]).toMatchObject({ continuation: { resume: 'p0' } });
  });

  describe('comment history continuation', () => {
    const entry = (i: number) => ({
      kind: 'comment' as const,
      id: `IC_${String(i)}`,
      author: { login: 'alice', type: 'user' as const },
      postedAt: postedAt(i),
    });
    const entries = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => entry(from + i));
    const heldAs = (resume: string | null, feedback: ReturnType<typeof entry>[]) => ({
      ref,
      resume: resume === null ? null : sourceCursorSchema.parse(resume),
      feedback,
    });
    /** A regular poll context holding `feedback` with `resume`, plus any feedback cursor. */
    const holding = (
      resume: string | null,
      feedback: ReturnType<typeof entry>[],
      feedbackCursors: { ref: typeof ref; id: string; postedAt: string }[] = [],
    ) => ({
      ...withCursors(feedbackCursors),
      continuations: [heldAs(resume, feedback)],
    });
    const ids = (from: number, to: number) => range(from, to).map((node) => node.id);
    const pages = (...answers: Response[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const answer of answers) fetcher.mockResolvedValueOnce(answer);
      return fetcher.mockImplementation(() => Promise.reject(new Error('unexpected request')));
    };

    it('keeps the status flag of a held comment', async () => {
      const flagged = { ...entry(10), statusComment: true as const };
      const held = [...entries(0, 10), flagged, ...entries(11, 300)];
      const fetcher = pages(initial(prWith(back(range(250, 310), 'p2'))));
      const batch = await adapter(fetcher).poll(holding(null, held));
      const feedback = factsOf(batch).feedback ?? [];
      expect(feedback.filter((e) => e.statusComment === true)).toEqual([flagged]);
      expect(commentIds(batch)).toEqual(ids(0, 310));
    });

    it('continues from the held resume and completes at the start of the PR', async () => {
      const fetcher = pages(
        initial(prWith(back(range(250, 350), 'p2'))),
        historyPage(back(range(0, 50))),
      );
      const batch = await adapter(fetcher).poll(holding('p0', entries(50, 350)));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(variables(fetcher, 1)).toMatchObject({ before: 'p0' });
      expect(commentIds(batch)).toEqual(ids(0, 350));
      expect(factsOf(batch).feedbackComplete).toBe(true);
      expect(batch.items[0]).toMatchObject({ continuation: { resume: null } });
    });

    it('reads at most 3 comment pages per poll while it continues a history', async () => {
      const fetcher = pages(
        initial(prWith(back(range(550, 650), 'p5'))),
        historyPage(back(range(200, 300), 'p2')),
        historyPage(back(range(100, 200), 'p1')),
      );
      const batch = await adapter(fetcher).poll(holding('p3', entries(300, 600)));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(variables(fetcher, 1)).toMatchObject({ before: 'p3' });
      expect(variables(fetcher, 2)).toMatchObject({ before: 'p2' });
      expect(commentIds(batch)).toEqual(ids(100, 650));
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(batch.items[0]).toMatchObject({ continuation: { resume: 'p1' } });
    });

    it('stays complete from the held history and adds new comments', async () => {
      const fetcher = pages(initial(prWith(back(range(250, 310), 'p2'))));
      const batch = await adapter(fetcher).poll(holding(null, entries(0, 300)));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(commentIds(batch)).toEqual(ids(0, 310));
      expect(factsOf(batch).feedbackComplete).toBe(true);
      expect(batch.items[0]).toMatchObject({ continuation: { resume: null } });
    });

    it('drops the held history once the first pages reach the cursor', async () => {
      const fetcher = pages(initial(prWith(back(range(300, 350), 'p3'))));
      const batch = await adapter(fetcher).poll(
        holding('p0', entries(0, 300), [{ ref, id: 'IC_320', postedAt: postedAt(320) }]),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(commentIds(batch)).toEqual(ids(300, 350));
      expect(factsOf(batch).feedbackComplete).toBe(true);
      expect(batch.items[0]).toMatchObject({ continuation: null });
    });

    it('restarts from the newest comments when they no longer reach the held history', async () => {
      const fetcher = pages(
        initial(prWith(back(range(400, 500), 'p3'))),
        historyPage(back(range(300, 400), 'p2')),
        historyPage(back(range(200, 300), 'p1')),
      );
      const batch = await adapter(fetcher).poll(holding('p0', entries(0, 100)));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(commentIds(batch)).toEqual(ids(200, 500));
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(batch.items[0]).toMatchObject({ continuation: { resume: 'p1' } });
    });

    it('reads past the held history when the cursor moved back before it', async () => {
      const cursor = [{ ref, id: 'IC_50', postedAt: postedAt(50) }];
      const fetcher = pages(
        initial(prWith(back(range(250, 320), 'p9'))),
        historyPage(back(range(100, 200), 'p0')),
        historyPage(back(range(40, 100), 'pz')),
      );
      const batch = await adapter(fetcher).poll(holding('p1', entries(200, 300), cursor));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(variables(fetcher, 1)).toMatchObject({ before: 'p1' });
      expect(variables(fetcher, 2)).toMatchObject({ before: 'p0' });
      expect(commentIds(batch)).toEqual(ids(40, 320));
      expect(factsOf(batch).feedbackComplete).toBe(true);
      expect(batch.items[0]).toMatchObject({ continuation: { resume: 'pz' } });
    });

    it('never completes when the cursor moved back below the held history and the budget runs out', async () => {
      const cursor = [{ ref, id: 'IC_50', postedAt: postedAt(50) }];
      const fetcher = pages(
        initial(prWith(back(range(300, 400), 'p5'))),
        historyPage(back(range(250, 300), 'p4')),
        historyPage(back(range(100, 200), 'p0')),
      );
      const batch = await adapter(fetcher).poll(holding('p1', entries(200, 300), cursor));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(variables(fetcher, 2)).toMatchObject({ before: 'p1' });
      expect(commentIds(batch)).toEqual(ids(100, 400));
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(batch.items[0]).toMatchObject({ continuation: { resume: 'p0' } });
    });

    it('drops a held comment the newest pages no longer list', async () => {
      const gone = { ...entry(280), id: 'IC_gone' };
      const fetcher = pages(initial(prWith(back(range(250, 320), 'p2'))));
      const batch = await adapter(fetcher).poll(holding(null, [...entries(0, 300), gone]));
      expect(commentIds(batch)).toEqual(ids(0, 320));
      expect(factsOf(batch).feedbackComplete).toBe(true);
    });

    it.each<[string, () => Response]>([
      [
        'carries a GraphQL error',
        () =>
          response({ repository: { pullRequest: { comments: null } } }, [
            {
              message: 'Something went wrong',
              type: 'INTERNAL',
              path: ['repository', 'pullRequest', 'comments'],
            },
          ]),
      ],
      [
        'is malformed',
        () => historyPage({ nodes: 'x', pageInfo: { hasPreviousPage: false, startCursor: null } }),
      ],
      [
        'has an older page but no start position',
        () => historyPage(back(range(0, 100), null, true)),
      ],
      ['repeats the held start position', () => historyPage(back(range(0, 100), 'p0'))],
      ['is newer than the held history without overlap', () => historyPage(back(range(400, 450)))],
    ])('drops the held history when a resume page %s', async (_name, page) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(initial(prWith(back(range(250, 320), 'p9'))))
        .mockImplementationOnce(() => Promise.resolve(page()));
      const batch = await adapter(fetcher).poll(holding('p0', entries(100, 300)));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(batch.complete).toBe(true);
      expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(batch.items[0]).toMatchObject({ continuation: null });
    });

    it.each<[string, () => Response]>([
      ['answers HTTP 500', () => new Response('unavailable', { status: 500 })],
      [
        'carries an unscoped GraphQL error',
        () => response({ repository: null }, [{ message: 'Something went wrong' }]),
      ],
    ])('keeps the held history unstated when a resume page %s', async (_name, page) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(initial(prWith(back(range(250, 320), 'p9'))))
        .mockImplementationOnce(() => Promise.resolve(page()));
      const batch = await adapter(fetcher).poll(holding('p0', entries(100, 300)));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(batch.complete).toBe(true);
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(commentIds(batch)).toEqual(ids(100, 320));
      expect(batch.items[0]).not.toHaveProperty('continuation');
    });

    it.each<[string, Json, () => ReturnType<typeof context>]>([
      ['has no start position', back(range(100, 200), null, true), () => context()],
      ['repeats a start position', back(range(100, 200), 'p1'), () => context()],
      [
        'has no start position, with a held history',
        back(range(100, 200), null, true),
        () => holding('p-old', entries(0, 50)),
      ],
      [
        'repeats a start position, with a held history',
        back(range(100, 200), 'p1'),
        () => holding('p-old', entries(0, 50)),
      ],
    ])('states nothing when the oldest head page %s', async (_name, oldest, ctx) => {
      const fetcher = pages(initial(prWith(back(range(200, 300), 'p1'))), historyPage(oldest));
      const batch = await adapter(fetcher).poll(ctx());
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(commentIds(batch)).toEqual(ids(100, 300));
      expect(factsOf(batch).feedbackComplete).toBe(false);
      expect(batch.items[0]).not.toHaveProperty('continuation');
    });
  });
});

const prNumbers = (query: string): number[] =>
  [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1]));
type Operation =
  'PrBatch' | 'PrIndex' | 'PrDetails' | 'PrPage' | 'DiscoveryPage' | 'PrCommits' | 'PrBases';
/** A fetch that answers each request by its operation name and the PR numbers it names. */
function byOperation(
  answer: (
    operation: Operation,
    numbers: number[],
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) {
  return vi.fn<typeof fetch>((_input, init) => {
    const query = queryOf(init);
    return Promise.resolve(answer(operationOf(query) as Operation, prNumbers(query), init));
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
/** An index rollup: its state and each check by name and state, as the index reads them. */
const rollup = (state: string, contexts: unknown[] = []) => ({
  state,
  contexts: { totalCount: contexts.length, nodes: contexts },
});
const indexCheck = (conclusion: string) => ({
  __typename: 'CheckRun',
  name: 'build',
  status: 'COMPLETED',
  conclusion,
  completedAt: time,
});
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
      statusCheckRollup: rollup('SUCCESS'),
      reviews: { totalCount: 1, nodes: [{ id: 'PRR_1', state: 'APPROVED', lastEditedAt: null }] },
      reviewThreads: { totalCount: 1, nodes: [{ isResolved: false }] },
      reviewRequests: {
        totalCount: 1,
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'reviewer' }, asCodeOwner: true },
        ],
      },
      comments: { totalCount: 0, nodes: [] },
      edited: { nodes: [] },
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
  it('keeps the budget of the newest request after a halved chunk', async () => {
    const numbers = Array.from({ length: 11 }, (_, i) => i + 1);
    const remaining = (value: number) => ({
      rateLimit: { remaining: value, resetAt: '2026-01-03T00:00:00.000Z' },
    });
    let failed = false;
    const fetcher = byOperation((operation, sent) => {
      if (operation === 'PrBatch') return discoveryAnswer();
      if (operation === 'PrIndex') return response(aliased(sent, (n) => indexPr(n)));
      // The first half's PR pages its reviews after both halves were read.
      if (operation === 'PrPage')
        return response({ repository: { pullRequest: { reviews: conn([]) } }, ...remaining(99) });
      if (!failed) {
        failed = true;
        return failure();
      }
      return response({
        ...aliased(sent, (n) => {
          const pr = wire(n);
          if (n === 1) pr.reviews.pageInfo = { hasNextPage: true, endCursor: 'review-next' };
          return { pullRequest: pr };
        }),
        ...remaining(sent.includes(1) ? 102 : 101),
      });
    });
    const configured = config();
    configured.github.reserveRemaining = 100;
    const batch = await adapter(fetcher, configured).poll(context(numbers.map(refOf), cursor));
    expect(numbersSent(fetcher, 'PrDetails').map((sent) => sent.length)).toEqual([10, 5, 5]);
    expect(batch.budget?.remaining).toBe(99);
    expect(batch.entities.at(-1)).toEqual({ ref: refOf(11), status: 'no_access' });
    expect(batch.entities.filter((entity) => entity.status === 'ok')).toHaveLength(10);
    expect(batch.complete).toBe(false);
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

describe('PR discovery reads', () => {
  const cursor = '2026-01-01T00:00:00.000Z';
  const first = '2026-01-03T00:00:00.000Z';
  const later = '2026-01-04T00:00:00.000Z';
  /**
   * One source polled again and again: discovery lists `listed` (PR number -> `updatedAt`); the
   * index and a full read answer each PR at its listed `updatedAt` in `state`, with the index
   * rollup `rollup`; `failing` names the operation that answers 502. Each poll gets the cursor of
   * the last accepted batch, as core hands it back; `accept: false` drops a batch, so the next
   * poll gets the old cursor again.
   */
  function scenario(state: 'OPEN' | 'MERGED') {
    let t = Date.parse('2026-01-05T00:00:00.000Z');
    const answers = {
      listed: new Map<number, string>(),
      failing: undefined as Operation | undefined,
      rollup: 'SUCCESS',
    };
    const fetcher = byOperation((operation, numbers) => {
      if (operation === answers.failing) return failure();
      if (operation === 'PrBatch')
        return discoveryAnswer(
          [...answers.listed].map(([number, updatedAt]) => operatorNode(number, updatedAt)),
        );
      if (operation === 'PrIndex')
        return response(
          aliased(numbers, (n) =>
            indexPr(n, {
              updatedAt: answers.listed.get(n) ?? time,
              state,
              statusCheckRollup: rollup(answers.rollup),
            }),
          ),
        );
      return response(
        aliased(numbers, (n) => ({
          pullRequest: {
            ...wire(n),
            updatedAt: answers.listed.get(n) ?? time,
            state,
            mergedAt: state === 'MERGED' ? time : null,
          },
        })),
      );
    });
    const fresh = () => adapter(fetcher, config(), 0, () => t);
    let source = fresh();
    let accepted = cursor;
    const poll = async (prs: ReturnType<typeof refOf>[] = [], accept = true) => {
      fetcher.mockClear();
      const batch = await source.poll(context(prs, accepted));
      if (accept && batch.cursor !== undefined) accepted = batch.cursor;
      return {
        batch,
        details: numbersSent(fetcher, 'PrDetails').flat(),
        indexed: numbersSent(fetcher, 'PrIndex').flat(),
        delivered: okFacts(batch).map((facts) => facts.number),
      };
    };
    return {
      answers,
      poll,
      /** The first read has no index entry and the second gives one; later polls reuse it. */
      settle: async (accept = true) => {
        expect(await poll([], accept)).toMatchObject({ details: [9], indexed: [] });
        expect(await poll([], accept)).toMatchObject({ details: [9], indexed: [9] });
      },
      advance: (ms: number) => {
        t += ms;
      },
      restart: () => {
        source = fresh();
      },
      pollPr: async (number: number) => {
        if (source.pollPr === undefined) throw new Error('Missing pollPr');
        fetcher.mockClear();
        await source.pollPr(refOf(number), { signal: new AbortController().signal });
        return numbersSent(fetcher, 'PrDetails').flat();
      },
    };
  }

  it.each(['MERGED', 'OPEN'] as const)(
    'reuses the cached facts of an unrequested %s PR the index shows unchanged',
    async (state) => {
      const run = scenario(state);
      run.answers.listed.set(9, first);
      await run.settle();
      const read = await run.poll();

      expect(read).toMatchObject({ details: [], indexed: [9], delivered: [9] });
      expect(read.batch.entities).toEqual([]);
      expect(read.batch.complete).toBe(true);
      expect(read.batch.cursor).toBe(first);
      expect((await run.poll()).batch.items).toEqual(read.batch.items);
    },
  );

  it('reads the PR in full when its checks change at the same updatedAt', async () => {
    const run = scenario('OPEN');
    run.answers.listed.set(9, first);
    await run.poll();
    await run.poll();
    run.answers.rollup = 'FAILURE';

    expect(await run.poll()).toMatchObject({ details: [9], indexed: [9], delivered: [9] });
  });

  it('sends the facts again when core did not accept the batch of the last read', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle(false);

    const again = await run.poll();
    expect(again).toMatchObject({ details: [], delivered: [9] });
    expect(again.batch.cursor).toBe(first);
  });

  it('sends the facts again at the cursor tie after a batch core did not accept', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle();
    expect(await run.poll([], false)).toMatchObject({ details: [], delivered: [9] });

    expect(await run.poll()).toMatchObject({ details: [], delivered: [9] });
  });

  it('reads a PR in full once it is no longer requested after pollPr read it', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    expect((await run.poll([refOf(9)])).details).toEqual([9]);
    expect(await run.pollPr(9)).toEqual([9]);

    expect(await run.poll()).toMatchObject({ details: [9], delivered: [9] });
  });

  it('reads the PR again once discovery lists it newer', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle();
    run.answers.listed.set(9, later);

    expect((await run.poll()).details).toEqual([9]);
    expect(await run.poll()).toMatchObject({ details: [], delivered: [9] });
  });

  it('reads the PR again once its cached read expires', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle();
    run.advance(CLOSED_REFRESH_MS);

    expect(await run.poll()).toMatchObject({ details: [9], delivered: [9] });
  });

  it('does not read a PR last read as requested once it is no longer requested', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    expect((await run.poll([refOf(9)])).details).toEqual([9]);

    expect(await run.poll()).toMatchObject({ details: [], indexed: [9], delivered: [9] });
  });

  it('reads a PR whose last read failed', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    run.answers.failing = 'PrDetails';
    const failed = await run.poll();
    expect(failed.details).toEqual([9]);
    expect(failed.batch.cursor).toBe(cursor);
    run.answers.failing = undefined;

    expect((await run.poll()).details).toEqual([9]);
  });

  it('forgets a PR discovery stopped listing and reads it when listed again', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle();
    run.answers.listed.delete(9);
    expect(await run.poll()).toMatchObject({ details: [], indexed: [], delivered: [] });
    run.answers.listed.set(9, first);

    expect(await run.poll()).toMatchObject({ details: [9], indexed: [] });
  });

  it('keeps the cached PR when discovery fails', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle();
    run.answers.failing = 'PrBatch';
    const failed = await run.poll([refOf(8)]);
    expect(failed.details).toEqual([8]);
    expect(failed.batch.complete).toBe(false);
    run.answers.failing = undefined;

    expect(await run.poll()).toMatchObject({ details: [], delivered: [9] });
  });

  it('reads a PR in full again in a fresh instance', async () => {
    const run = scenario('MERGED');
    run.answers.listed.set(9, first);
    await run.settle();
    run.restart();

    await run.settle();
    expect(await run.poll()).toMatchObject({ details: [], delivered: [9] });
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
    [
      'review state',
      {
        reviews: {
          totalCount: 1,
          nodes: [{ id: 'PRR_1', state: 'DISMISSED', lastEditedAt: null }],
        },
      },
    ],
    ['resolved thread', { reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] } }],
    ['comment count', { comments: { totalCount: 1, nodes: [{ id: 'IC_1' }] } }],
    [
      'comment edit',
      { edited: { nodes: [{ id: 'IC_1', updatedAt: '2026-01-05T00:00:00.000Z' }] } },
    ],
    [
      'review edit',
      {
        reviews: {
          totalCount: 1,
          nodes: [{ id: 'PRR_1', state: 'APPROVED', lastEditedAt: '2026-01-05T00:00:00.000Z' }],
        },
      },
    ],
  ])('reads a PR in full again when its index %s changes', async (_name, change) => {
    const run = scenario();
    await run.poll();
    run.state.index = (n) => indexPr(n, n === 7 ? { state: 'MERGED', ...change } : {});
    await run.poll();
    expect(run.details()).toEqual([7]);
  });
  it.each(['PENDING', 'EXPECTED', 'ERROR', 'SOMETHING_NEW'])(
    'reads an open PR in full again while its rollup is %s',
    async (state) => {
      const run = scenario();
      run.state.index = (n) => indexPr(n, { statusCheckRollup: rollup(state) });
      await run.poll([refOf(8)]);
      await run.poll([refOf(8)]);
      expect(run.details()).toEqual([8]);
    },
  );
  it('reads a failed open PR in full and reports a check that finished since', async () => {
    const run = scenario();
    run.state.index = (n) => indexPr(n, { statusCheckRollup: rollup('FAILURE') });
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
  it('reads in full again when a skipped required check reruns under a SUCCESS rollup', async () => {
    const run = scenario();
    const skipped = wire(8);
    skipped.statusCheckRollup.contexts.nodes = [
      { ...indexCheck('SKIPPED'), completedAt: '2026-01-01T00:00:00.000Z', isRequired: true },
    ];
    run.state.index = (n) =>
      indexPr(n, { statusCheckRollup: rollup('SUCCESS', [indexCheck('SKIPPED')]) });
    run.state.detail = () => skipped;
    const first = await run.poll([refOf(8)]);
    expect((factsFor(first, 8) as { requiredChecks: unknown }).requiredChecks).toEqual([
      { name: 'build', state: 'skipped', completedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const passed = wire(8);
    passed.statusCheckRollup.contexts.nodes = [
      { ...indexCheck('SUCCESS'), completedAt: '2026-01-01T00:00:00.000Z', isRequired: true },
    ];
    run.state.index = (n) =>
      indexPr(n, { statusCheckRollup: rollup('SUCCESS', [indexCheck('SUCCESS')]) });
    run.state.detail = () => passed;
    const second = await run.poll([refOf(8)]);
    expect(run.details()).toEqual([8]);
    expect((factsFor(second, 8) as { requiredChecks: unknown }).requiredChecks).toEqual([
      { name: 'build', state: 'success', completedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });
  it('reads a skipped required check pending while a newer run of its workflow runs, then its result', async () => {
    const run = scenario();
    const fixture = (name: string) => {
      const entry = fixtures('checks').find((value) => value.name === name);
      if (entry === undefined) throw new Error(`Missing fixture ${name}`);
      return { ...wire(8), statusCheckRollup: entry.value['statusCheckRollup'] };
    };
    const required = (batch: Batch) =>
      (factsFor(batch, 8) as { requiredChecks: unknown }).requiredChecks;
    run.state.index = (n) =>
      indexPr(n, { statusCheckRollup: rollup('SUCCESS', [indexCheck('SKIPPED')]) });
    run.state.detail = () => fixture('newer-run-in-progress');
    const first = await run.poll([refOf(8)]);
    expect(run.details()).toEqual([8]);
    expect(required(first)).toEqual([
      { name: 'Slack notification', state: 'pending', completedAt: null },
    ]);
    run.state.detail = () => fixture('newer-run-succeeded');
    const second = await run.poll([refOf(8)]);
    expect(run.details()).toEqual([8]);
    expect(required(second)).toEqual([
      { name: 'Slack notification', state: 'success', completedAt: '2026-11-20T13:45:49Z' },
    ]);
  });
  it('reads an open PR in full again while a check is skipped, which could become required unseen', async () => {
    const run = scenario();
    run.state.index = (n) =>
      indexPr(n, { statusCheckRollup: rollup('SUCCESS', [indexCheck('SKIPPED')]) });
    await run.poll([refOf(8)]);
    await run.poll([refOf(8)]);
    expect(run.details()).toEqual([8]);
  });
  it('re-emits an open PR whose checks are all neutral or successful', async () => {
    const run = scenario();
    run.state.index = (n) =>
      indexPr(n, {
        statusCheckRollup: rollup('SUCCESS', [
          indexCheck('NEUTRAL'),
          { ...indexCheck('SUCCESS'), name: 'lint' },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
        ]),
      });
    await run.poll([refOf(8)]);
    await run.poll([refOf(8)]);
    expect(run.details()).toEqual([]);
  });
  it('reads an open PR in full again when the index lists only part of its checks', async () => {
    const run = scenario();
    run.state.index = (n) =>
      indexPr(n, {
        statusCheckRollup: {
          ...rollup('SUCCESS', [indexCheck('SUCCESS')]),
          contexts: { totalCount: 101, nodes: [indexCheck('SUCCESS')] },
        },
      });
    await run.poll([refOf(8)]);
    await run.poll([refOf(8)]);
    expect(run.details()).toEqual([8]);
  });
  it.each([
    [
      'reviews',
      { totalCount: 101, nodes: [{ id: 'PRR_1', state: 'APPROVED', lastEditedAt: null }] },
    ],
    ['reviewThreads', { totalCount: 101, nodes: [{ isResolved: false }] }],
    [
      'reviewRequests',
      {
        totalCount: 101,
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'reviewer' }, asCodeOwner: true },
        ],
      },
    ],
  ])('reads a PR in full again when the index lists only part of its %s', async (field, conn) => {
    const run = scenario();
    run.state.index = (n) => indexPr(n, { ...(n === 7 ? { state: 'MERGED' } : {}), [field]: conn });
    await run.poll();
    await run.poll();
    expect(run.details()).toEqual([7, 8]);
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
  it('reads in full again when the held history changes', async () => {
    const run = scenario();
    const holding = (resume: string | null) => ({
      continuations: [heldHistory(resume, 0, 10)].map((held) => ({ ...held, ref: refOf(7) })),
    });
    await run.poll(undefined, holding(null));
    await run.poll(undefined, holding(null));
    expect(run.details()).toEqual([]);
    await run.poll(undefined, holding('p0'));
    expect(run.details()).toEqual([7]);
  });
  it('re-emits a complete merged history from the cache without a continuation', async () => {
    const run = scenario();
    run.state.detail = (n) =>
      n === 7 ? { ...merged(n), comments: back(historyNodes(250, 320), 'p9') } : wire(n);
    const held = {
      continuations: [{ ...heldHistory(null, 0, 300), ref: refOf(7) }],
    };
    const first = await run.poll(undefined, held);
    expect(run.details()).toEqual([7, 8]);
    expect(first.items.find((item) => factsFor(first, 7) === item.facts)).toMatchObject({
      continuation: { resume: null },
    });
    expect(factsFor(first, 7)).toMatchObject({ feedbackComplete: true });
    const second = await run.poll(undefined, held);
    expect(run.details()).toEqual([]);
    expect(factsFor(second, 7)).toEqual(factsFor(first, 7));
    for (const item of second.items) expect(item).not.toHaveProperty('continuation');
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

describe('persisted terminal PR policy', () => {
  const terminal = (state: 'merged' | 'closed') => [{ ref, state }];
  const discovery = (state = 'MERGED', cost = 2) =>
    response({
      rateLimit: { cost, remaining: 4000, resetAt: '2026-01-03T00:00:00.000Z' },
      repository: {
        pullRequests: conn([{ number: 7, updatedAt: time, author: { login: 'operator' }, state }]),
      },
    });
  it('suppresses merged cursor ties before index/detail work, including a recreated adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(discovery()));
    for (let i = 0; i < 3; i++) {
      const source = adapter(fetcher);
      const batch = await source.poll({ ...context([], time), terminalPrs: terminal('merged') });
      expect(batch.items).toEqual([]);
      expect(batch.entities).toEqual([]);
      expect(batch.usage).toEqual({ points: 2 });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sentQueries(fetcher).join(' ')).not.toContain('pullRequest(number:');
  });
  it('uses only identity and state for a due unchanged closed PR', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(discovery('CLOSED'))
      .mockResolvedValueOnce(
        response({
          rateLimit: { cost: 3, remaining: 50, resetAt: '2026-01-03T00:00:00.000Z' },
          pr0: { pullRequest: { number: 7, state: 'CLOSED' } },
        }),
      );
    const batch = await adapter(fetcher).poll({
      ...context([], time),
      terminalPrs: terminal('closed'),
      prRechecks: [ref],
    });
    expect(batch.prProbes).toEqual([{ ref, status: 'closed' }]);
    expect(batch.items).toEqual([]);
    expect(batch.entities).toEqual([]);
    expect(batch.complete).toBe(true);
    expect(batch.usage).toEqual({ points: 5 });
    const query = sentQueries(fetcher, 'PrStates')[0];
    expect(query).toContain('pullRequest(number: 7) { number state }');
    for (const field of ['comments', 'reviews', 'contexts', 'reviewThreads'])
      expect(query).not.toContain(field);
    expect(sentQueries(fetcher)).toHaveLength(2);
  });
  it.each(['OPEN', 'MERGED', 'FUTURE_STATE'])(
    'fully reads a due probe that reports %s',
    async (state) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(discovery('CLOSED'))
        .mockResolvedValueOnce(response({ pr0: { pullRequest: { number: 7, state } } }))
        .mockResolvedValueOnce(
          response({
            pr0: { pullRequest: { ...wire(), state: state === 'MERGED' ? 'MERGED' : 'OPEN' } },
          }),
        );
      const batch = await adapter(fetcher).poll({
        ...context([], time),
        terminalPrs: terminal('closed'),
        prRechecks: [ref],
      });
      expect(batch.prProbes).toEqual([{ ref, status: 'refreshed' }]);
      expect(batch.items).toHaveLength(1);
      expect(sentQueries(fetcher, 'PrDetails')).toHaveLength(1);
      expect(sentQueries(fetcher, 'PrIndex')).toEqual([]);
    },
  );
  it('refreshes closed PRs reopened in discovery even for another author and before a probe is due', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequests: conn([
              { number: 7, updatedAt: time, state: 'OPEN', author: { login: 'someone' } },
            ]),
          },
        }),
      )
      .mockResolvedValueOnce(response({ pr0: { pullRequest: wire() } }));
    const batch = await adapter(fetcher).poll({
      ...context([], time),
      terminalPrs: terminal('closed'),
    });
    expect(batch.items).toHaveLength(1);
    expect(batch.prProbes).toEqual([{ ref, status: 'refreshed' }]);
    expect(sentQueries(fetcher, 'PrStates')).toEqual([]);
  });
  it('refreshes a closed PR merged in discovery before its probe deadline, then suppresses final facts', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(discovery('MERGED'))
      .mockResolvedValueOnce(
        response({ pr0: { pullRequest: { ...wire(), state: 'MERGED', mergedAt: time } } }),
      )
      .mockResolvedValueOnce(discovery('MERGED'));
    const batch = await adapter(fetcher).poll({
      ...context([], time),
      terminalPrs: terminal('closed'),
    });
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({ kind: 'pr', facts: { state: 'merged' } });
    expect(batch.prProbes).toEqual([{ ref, status: 'refreshed' }]);
    expect(sentQueries(fetcher, 'PrStates')).toEqual([]);
    expect(sentQueries(fetcher, 'PrDetails')).toHaveLength(1);
    const next = await adapter(fetcher).poll({
      ...context([], time),
      terminalPrs: terminal('merged'),
    });
    expect(next.items).toEqual([]);
    expect(sentQueries(fetcher)).toHaveLength(1);
    expect(sentQueries(fetcher).join(' ')).not.toContain('pullRequest(number:');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps malformed/denied/missing probes separate from ordinary absence', async () => {
    for (const value of [null, { pullRequest: null }, { pullRequest: { number: 7 } }]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(discovery('CLOSED'))
        .mockResolvedValueOnce(response({ pr0: value }));
      const batch = await adapter(fetcher).poll({
        ...context([], time),
        terminalPrs: terminal('closed'),
        prRechecks: [ref],
      });
      expect(batch.complete).toBe(false);
      expect(batch.prProbes).toEqual([{ ref, status: 'no_access' }]);
      expect(batch.entities).toEqual([]);
      expect(batch.items).toEqual([]);
    }
  });
  it('sums discovery pages, index and detail cost independently of remaining budget changes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          rateLimit: { cost: 2, remaining: 5000, resetAt: '2026-01-03T00:00:00.000Z' },
          repository: { pullRequests: conn([], 'next') },
        }),
      )
      .mockResolvedValueOnce(
        response({
          rateLimit: { cost: 4, remaining: 2000, resetAt: '2026-01-03T00:00:00.000Z' },
          repository: { pullRequests: conn([]) },
        }),
      )
      .mockResolvedValueOnce(
        response({
          rateLimit: { cost: 3, remaining: 7000, resetAt: '2026-01-03T00:00:00.000Z' },
          pr0: null,
        }),
      )
      .mockResolvedValueOnce(
        response({
          rateLimit: { cost: 5, remaining: 3000, resetAt: '2026-01-03T00:00:00.000Z' },
          pr0: { pullRequest: wire() },
        }),
      );
    const batch = await adapter(fetcher).poll(context([ref], time));
    expect(batch.usage).toEqual({ points: 14 });
    expect(batch.budget?.remaining).toBe(3000);
    expect(batch.items).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('keeps the original abort reason while exposing only already reported usage', async () => {
    let entered: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(discovery('CLOSED', 2))
      .mockImplementation((_url, init) => {
        entered();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('Request aborted'));
          });
        });
      });
    const source = adapter(fetcher);
    const controller = new AbortController();
    const pending = source.poll({
      ...context([], time),
      terminalPrs: terminal('closed'),
      prRechecks: [ref],
      signal: controller.signal,
    });
    await reading;
    expect(source.takeUsage?.()).toEqual({ points: 2 });
    const reason = new Error('Stop this poll');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(source.takeUsage?.()).toBeUndefined();
  });
  it('retains valid costs when PR parsing rejects and drains them before the next attempt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        response({
          rateLimit: { cost: 4, remaining: 1, resetAt: '2026-01-03T00:00:00.000Z' },
          pr0: { pullRequest: {} },
        }),
      ),
    );
    const source = adapter(fetcher);
    for (let i = 0; i < 2; i++)
      await expect(
        source.pollPr?.(ref, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ usage: { points: 4 } });
  });
});

const fixtures = (dir: string) => {
  const url = new URL(`fixtures/${dir}/`, import.meta.url);
  return readdirSync(url)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name: name.replace(/\.json$/, ''),
      value: JSON.parse(readFileSync(new URL(name, url), 'utf8')) as Record<string, unknown>,
    }));
};

describe('approvalRule github-rules', () => {
  const issuesRule: KeyRule = { type: 'prefixes', prefixes: [] };
  const ruled = (approvalRule?: 'any-approval' | 'github-rules') =>
    configSchema.parse({
      projects: [
        {
          id: 'demo',
          tracker: { type: 'github-issues', repo: 'demo/widgets', label: 'board' },
          repos: ['demo/widgets'],
          operatorGithubLogin: 'operator',
          columns: [
            { id: 'todo' },
            { id: 'dev' },
            { id: 'external-review', ...(approvalRule === undefined ? {} : { approvalRule }) },
            { id: 'done' },
          ],
        },
      ],
      operator: { slack: 'U123' },
      digest: { tz: 'UTC' },
    });
  const connections = (query: string) => (query.match(/\((?:first|last): /g) ?? []).length;

  it('normalizes each review-rule fixture', () => {
    const cases = fixtures('review-rule');
    expect(cases.map((entry) => entry.name)).toEqual([
      'awaiting-code-owners',
      'behind',
      'blocked-code-owner',
      'changes-requested-rerequested',
      'changes-requested',
      'conflicting',
      'draft',
      'new-head',
      'no-required-checks',
      'required-check-absent',
      'ruleset-only',
      'satisfied',
      'unknown',
      'unresolved-threads',
    ]);
    for (const { name, value } of cases) {
      expect(normalizePr('o/r', value['response'], issuesRule, true), name).toMatchObject(
        value['facts'] as object,
      );
      expect(normalizeReviewRule(value['response']), name).toEqual(value['reviewRule']);
    }
  });

  it('merges branch protection and rulesets of each branch-rule fixture', () => {
    const rule = (name: string) => {
      const entry = fixtures('branch-rule').find((fixture) => fixture.name === name);
      const data = entry?.value['data'] as { repository: { defaultBranchRef: unknown } };
      return branchRuleOf(branchRuleWire.parse(data.repository.defaultBranchRef));
    };
    // Recorded once, read-only, from a repository whose default branch has rulesets only.
    expect(rule('live-default-branch')).toEqual({
      sources: ['ruleset'],
      approvals: 1,
      codeOwners: false,
      conversationResolution: true,
      requiredChecks: ['ci-ok'],
    });
    expect(rule('branch-protection')).toEqual({
      sources: ['branch-protection'],
      approvals: 2,
      codeOwners: true,
      conversationResolution: false,
      requiredChecks: ['build', 'test'],
    });
    const none = {
      sources: [],
      approvals: null,
      codeOwners: false,
      conversationResolution: false,
      requiredChecks: [],
    };
    expect(rule('none')).toEqual(none);
    expect(branchRuleOf(null)).toEqual(none);
    // Rules past the one page read may require a check or a review: unreadable, not partial.
    expect(rule('truncated')).toBeNull();
    const truncated = fixtures('branch-rule').find((fixture) => fixture.name === 'truncated');
    const data = truncated?.value['data'] as { repository: { defaultBranchRef: unknown } };
    expect(
      normalizeReviewRule({
        ...wire(),
        reviewDecision: 'APPROVED',
        baseRef: data.repository.defaultBranchRef,
      }),
    ).toEqual({ reviewDecision: 'approved', rule: null });
    expect(branchRuleOf({ rules: { nodes: [], pageInfo: { hasNextPage: false } } })).toEqual(none);
    // No rulesets at all reads as none; rules without pageInfo may run past the page read.
    expect(branchRuleOf({ rules: null })).toEqual(none);
    expect(branchRuleOf({ refUpdateRule: null })).toEqual(none);
    expect(branchRuleOf({ rules: { nodes: [] } })).toBeNull();
    expect(branchRuleOf({ rules: { nodes: [], pageInfo: null } })).toBeNull();
    expect(
      branchRuleOf({
        refUpdateRule: {
          requiredApprovingReviewCount: 1,
          requiredStatusCheckContexts: ['ci', null],
        },
        rules: {
          nodes: [
            null,
            {
              type: 'PULL_REQUEST',
              parameters: {
                __typename: 'PullRequestParameters',
                requiredApprovingReviewCount: 3,
                requireCodeOwnerReview: true,
              },
            },
            {
              type: 'REQUIRED_STATUS_CHECKS',
              parameters: {
                __typename: 'RequiredStatusChecksParameters',
                requiredStatusChecks: [{ context: 'ci' }, { context: 'e2e' }],
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    ).toEqual({
      sources: ['branch-protection', 'ruleset'],
      approvals: 3,
      codeOwners: true,
      conversationResolution: false,
      requiredChecks: ['ci', 'e2e'],
    });
  });

  it('keeps the default queries byte-identical and selects the rule only with the flag', () => {
    for (const query of [detailQuery([7]), detailQuery([7], true), indexQuery([7])]) {
      expect(query).not.toContain('reviewDecision');
      expect(query).not.toContain('baseRef');
    }
    expect(detailQuery([7], false, false)).toBe(detailQuery([7]));
    expect(indexQuery([7], false)).toBe(indexQuery([7]));
    expect(detailQuery([7], false, true)).toContain('reviewDecision baseRef { refUpdateRule {');
    expect(detailQuery([7], false, true)).toContain('rules(first: 100)');
    expect(detailQuery([7], false, true)).toContain('} pageInfo { hasNextPage } }');
    expect(indexQuery([7], true)).toContain('reviewDecision');
    expect(indexQuery([7], true)).not.toContain('baseRef');
  });

  it('github-rules connection budget: the index adds none, the detail one per PR', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    const ten = fifty.slice(0, 10);
    expect(connections(indexQuery(fifty))).toBe(6 * 50);
    expect(connections(indexQuery(fifty, true))).toBe(connections(indexQuery(fifty)));
    expect(connections(detailQuery(ten, false, true))).toBe(connections(detailQuery(ten)) + 10);
  });

  it.each([undefined, 'any-approval'] as const)(
    'approvalRule %s: the source sends the default queries and items carry no review rule',
    async (approvalRule) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        response({
          repository: { pullRequests: conn([]) },
          pr0: {
            pullRequest: {
              ...wire(),
              reviewDecision: 'APPROVED',
              baseRef: { refUpdateRule: null },
            },
          },
        }),
      );
      const batch = await adapter(fetcher, ruled(approvalRule)).poll(context());
      expect(batch.items).toHaveLength(1);
      expect(batch.items[0]).not.toHaveProperty('reviewRule');
      // A github-issues tracker repo also reads the issues each PR closes.
      expect(detailsSent(fetcher)).toBe(detailQuery([7], true));
    },
  );

  it('approvalRule github-rules: a denied branch rule keeps the PR facts and sends the rule unreadable', async () => {
    const detail = readFileSync(
      new URL('fixtures/branch-rule/denied-pr-detail.json', import.meta.url),
      'utf8',
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) =>
        Promise.resolve(
          operationOf(queryOf(init)) === 'PrDetails'
            ? new Response(detail, { status: 200 })
            : response({ repository: { pullRequests: conn([]) } }),
        ),
      );
    const batch = await adapter(fetcher, ruled('github-rules')).poll(context());
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(batch.items).toEqual([
      {
        kind: 'pr',
        facts: expect.objectContaining({ number: 7, mergeState: 'clean' }) as unknown,
        reviewRule: { reviewDecision: 'approved', rule: null },
      },
    ]);
    // Any other error under the PR still drops it.
    const other = JSON.parse(detail) as { errors: { type: string }[] };
    for (const entry of other.errors) entry.type = 'INTERNAL';
    fetcher.mockImplementation((_input, init) =>
      Promise.resolve(
        operationOf(queryOf(init)) === 'PrDetails'
          ? new Response(JSON.stringify(other), { status: 200 })
          : response({ repository: { pullRequests: conn([]) } }),
      ),
    );
    const failed = await adapter(fetcher, ruled('github-rules')).poll(context());
    expect(failed.items).toEqual([]);
    expect(failed.complete).toBe(false);
  });

  it('approvalRule github-rules: a full read carries the review rule and a reuse sends it again', async () => {
    let t = Date.parse('2026-01-02T00:00:00.000Z');
    const pr = {
      ...wire(),
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      baseRef: {
        refUpdateRule: { requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ['build'] },
        rules: { nodes: [], pageInfo: { hasNextPage: false } },
      },
      reviewThreads: conn([{ isResolved: true }]),
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
        ]),
      },
    };
    const index = {
      number: 7,
      updatedAt: time,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      headRefOid: sha,
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: {
        state: 'SUCCESS',
        contexts: {
          totalCount: 1,
          nodes: [
            {
              __typename: 'CheckRun',
              name: 'build',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              completedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      },
      reviews: { totalCount: 1, nodes: [{ id: 'PRR_1', state: 'APPROVED', lastEditedAt: null }] },
      reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] },
      reviewRequests: {
        totalCount: 1,
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'reviewer' }, asCodeOwner: true },
        ],
      },
      comments: { totalCount: 0, nodes: [] },
      edited: { nodes: [] },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const query = queryOf(init);
      const operation = operationOf(query);
      if (operation === 'PrIndex')
        return Promise.resolve(response({ pr0: { pullRequest: index } }));
      if (operation === 'PrDetails') return Promise.resolve(response({ pr0: { pullRequest: pr } }));
      return Promise.resolve(response({ repository: { pullRequests: conn([]) } }));
    });
    const source = adapter(fetcher, ruled('github-rules'), 0, () => t);
    const first = await source.poll(context());
    expect(batchSchema.parse(first)).toEqual(first);
    expect(first.items[0]).toMatchObject({
      kind: 'pr',
      reviewRule: {
        reviewDecision: 'review_required',
        rule: {
          sources: ['branch-protection'],
          approvals: 1,
          codeOwners: false,
          conversationResolution: false,
          requiredChecks: ['build'],
        },
      },
    });
    expect(sentQueries(fetcher, 'PrDetails')[0]).toBe(detailQuery([7], true, true));
    expect(sentQueries(fetcher, 'PrIndex')[0]).toBe(indexQuery([7], true));
    t += 60_000;
    // The index shows the PR unchanged, so its facts and review rule are reused without a full read.
    const second = await source.poll(context());
    expect(sentQueries(fetcher, 'PrDetails')).toHaveLength(1);
    expect(second.items).toEqual([first.items[0]]);
    // A new review decision changes the index fingerprint and forces a full read.
    index.reviewDecision = 'APPROVED';
    pr.reviewDecision = 'APPROVED';
    t += 60_000;
    const third = await source.poll(context());
    expect(sentQueries(fetcher, 'PrDetails')).toHaveLength(2);
    expect(third.items[0]).toMatchObject({ reviewRule: { reviewDecision: 'approved' } });
  });
});

describe('approval watch', () => {
  const cursor = '2026-01-01T00:00:00.000Z';
  const MINUTE = 60_000;
  type Fixture = { detail: Record<string, unknown>; commits?: unknown; pairs: unknown[] | null };
  const watched = fixtures('approval-watch');
  const fixture = (name: string): Fixture => {
    const entry = watched.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`Missing fixture ${name}`);
    return structuredClone(entry.value) as Fixture;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  /** The index alias of PR `number` on a fixture's detail, unchanged while the detail is. */
  const indexOf = (detail: Record<string, unknown>, number: number) => {
    const reviews = (detail['reviews'] as { nodes: { id: string }[] }).nodes;
    return indexPr(number, {
      updatedAt: detail['updatedAt'],
      state: detail['state'],
      headRefOid: detail['headRefOid'],
      statusCheckRollup: null,
      reviews: {
        totalCount: reviews.length,
        nodes: reviews.map(({ id }) => ({ id, state: 'APPROVED', lastEditedAt: null })),
      },
      reviewThreads: { totalCount: 0, nodes: [] },
      reviewRequests: { totalCount: 0, nodes: [] },
    });
  };
  /**
   * One source on fixture `name`, polled again and again: each answer can change between polls,
   * and `sent(operation)` counts the requests of the last poll.
   */
  function scenario(name: string) {
    let t = Date.parse('2026-01-02T00:00:00.000Z');
    const loaded = fixture(name);
    const state = {
      detail: loaded.detail,
      // The commits answer; `init` carries the request signal for an answer that hangs.
      commits: (() => json(loaded.commits)) as (init?: RequestInit) => Response | Promise<Response>,
      detailStatus: 200,
      remaining: 4321,
      discovered: [] as Json[],
      base: 'main',
      // A `PrBases` answer in place of the one built from `base`.
      bases: undefined as (() => Response) | undefined,
    };
    const rate = () => ({ remaining: state.remaining, resetAt: '2026-01-03T00:00:00.000Z' });
    const fetcher = byOperation((operation, numbers, init) => {
      if (operation === 'PrBatch') return discoveryAnswer(state.discovered);
      if (operation === 'PrIndex')
        return response({
          ...aliased(numbers, (number) => indexOf(state.detail, number)),
          rateLimit: rate(),
        });
      if (operation === 'PrDetails')
        return state.detailStatus === 200
          ? response({
              ...aliased(numbers, (number) => ({ pullRequest: { ...state.detail, number } })),
              rateLimit: rate(),
            })
          : failure(state.detailStatus);
      if (operation === 'PrCommits') return state.commits(init);
      if (operation === 'PrBases' && state.bases !== undefined) return state.bases();
      if (operation === 'PrBases')
        return response({
          ...aliased(numbers, () => ({ pullRequest: { baseRefName: state.base } })),
          rateLimit: rate(),
        });
      return failure();
    });
    const source = adapter(fetcher, config(), 0, () => t);
    return {
      loaded,
      state,
      source,
      advance: (ms: number) => {
        t += ms;
      },
      poll: (prs = [refOf(7)], extra: Partial<PollContext> = {}) => {
        fetcher.mockClear();
        return source.poll({ ...context(prs, cursor), ...extra });
      },
      sent: (operation: Operation) => numbersSent(fetcher, operation).length,
    };
  }
  const pairsOf = (batch: { items: unknown[] }) =>
    (batch.items[0] as { approvalPairs?: unknown } | undefined)?.approvalPairs;

  it('has a fixture for each case', () => {
    expect(watched.map((entry) => entry.name)).toEqual([
      'approved-on-base',
      'base-merge-cli-14450',
      'head-missing',
      'mode-change',
      'octopus',
      'on-head',
      'rebased',
      'root-file',
      'too-large',
      'two-approvals',
      'unwatched-only',
      'watched-changed',
    ]);
  });
  it('reads no commits for an approval on the head', async () => {
    const run = scenario('on-head');
    const batch = await run.poll();
    expect(run.sent('PrDetails')).toBe(1);
    expect(run.sent('PrCommits')).toBe(0);
    expect(batch.items[0]).not.toHaveProperty('approvalPairs');
  });
  it.each([
    ['counts commits and top-level entries after an older approval', 'watched-changed'],
    ['reports unwatched entries', 'unwatched-only'],
    ['lists a changed root file bare and a directory with a slash', 'root-file'],
    ['answers two approvals on different commits from one commits read', 'two-approvals'],
    ['marks an approval rewritten away history_rewritten', 'rebased'],
    // Each change and each ancestor a walk of oids alone, or of two parents, would miss.
    ['lists a root script whose mode alone changed', 'mode-change'],
    [
      'counts after an approved commit that landed on the base, outside the list',
      'approved-on-base',
    ],
    ['walks every parent of an octopus merge', 'octopus'],
  ])('%s', async (_title, name) => {
    const run = scenario(name);
    const batch = await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch.complete).toBe(true);
    expect(pairsOf(batch)).toEqual(run.loaded.pairs);
  });
  it('leaves base-branch merges out of commits and entries', async () => {
    // A live read-only capture of cli/cli#14450, approved before its two merges from trunk.
    const run = scenario('base-merge-cli-14450');
    const batch = await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    expect(pairsOf(batch)).toEqual(run.loaded.pairs);
    const [pair] = run.loaded.pairs as { commitsAfter: number; changed: string[] }[];
    // Four commits follow the approval; the two merges count for neither commits nor entries.
    expect(pair?.commitsAfter).toBe(2);
    for (const merged of ['.github/', 'README.md', 'acceptance/', 'skills/', 'CLAUDE.md', 'docs/'])
      expect(pair?.changed).not.toContain(merged);
  });
  it('marks a PR with more than 100 commits pr_too_large', async () => {
    const run = scenario('too-large');
    const commits = (run.loaded.commits as { data: { repository: unknown } }).data.repository as {
      pullRequest: { commits: { totalCount: number; nodes: { commit: { oid: string } }[] } };
    };
    expect(commits.pullRequest.commits.totalCount).toBe(101);
    // The head is not listed either: the overflow decides first.
    expect(commits.pullRequest.commits.nodes.map((node) => node.commit.oid)).not.toContain(
      run.state.detail['headRefOid'],
    );
    const batch = await run.poll();
    expect(pairsOf(batch)).toEqual(run.loaded.pairs);
  });
  const watchedCommits = () =>
    (fixture('watched-changed').commits as { data: Record<string, unknown> }).data;
  /** The watched-changed commits with the head's parents cut to none of its one. */
  const truncatedParents = () => {
    const commits = fixture('watched-changed').commits as {
      data: {
        repository: {
          pullRequest: { commits: { nodes: { commit: { parents: { nodes: unknown[] } } }[] } };
        };
      };
    };
    const head = commits.data.repository.pullRequest.commits.nodes.at(-1);
    if (head !== undefined) head.commit.parents.nodes = [];
    return json(commits);
  };
  it.each<[string, () => Response]>([
    ['head-missing', () => json(fixture('head-missing').commits)],
    ['a commit with fewer parents listed than its totalCount', truncatedParents],
    [
      'a NOT_FOUND error on the pull request',
      () =>
        json({
          data: { rateLimit: watchedCommits()['rateLimit'], repository: { pullRequest: null } },
          errors: [
            { type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Not found' },
          ],
        }),
    ],
    [
      'an error without a path',
      () => json({ data: watchedCommits(), errors: [{ type: 'SOMETHING', message: 'x' }] }),
    ],
    [
      'a malformed commits list',
      () =>
        json({
          data: {
            rateLimit: watchedCommits()['rateLimit'],
            repository: {
              pullRequest: {
                commits: { totalCount: 2, pageInfo: { hasPreviousPage: false }, nodes: 'x' },
              },
            },
          },
        }),
    ],
  ])(
    'sends no second PrCommits within 15 minutes after an unreadable read: %s',
    async (_n, answer) => {
      const run = scenario('watched-changed');
      run.state.commits = answer;
      const first = await run.poll();
      expect(run.sent('PrCommits')).toBe(1);
      expect(first.complete).toBe(true);
      expect(first.items).toHaveLength(1);
      expect(pairsOf(first)).toBeUndefined();
      run.advance(14 * MINUTE);
      const waiting = await run.poll();
      expect(run.sent('PrDetails')).toBe(0);
      expect(run.sent('PrCommits')).toBe(0);
      expect(pairsOf(waiting)).toBeUndefined();
      run.advance(MINUTE);
      await run.poll();
      expect(run.sent('PrCommits')).toBe(1);
    },
  );
  it.each<[string, () => Response]>([
    ['502', () => failure(502)],
    ['a non-JSON body', () => new Response('not json', { status: 200 })],
    ['no rateLimit', () => json({ data: { repository: watchedCommits()['repository'] } })],
  ])('retries a transient commits failure on the next poll: %s', async (_name, answer) => {
    const run = scenario('watched-changed');
    run.state.commits = answer;
    const first = await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    expect(first.complete).toBe(true);
    expect(pairsOf(first)).toBeUndefined();
    run.advance(MINUTE);
    const second = await run.poll();
    expect(run.sent('PrDetails')).toBe(0);
    expect(run.sent('PrCommits')).toBe(1);
    expect(second.complete).toBe(true);
  });
  const cutOff = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      }),
      { status: 502 },
    );
  // Approval history is best effort: no error of its reads costs the batch, and an on-demand
  // read waiting on the queue cuts the pass short instead of waiting for it.
  it.each<[string, (run: ReturnType<typeof scenario>) => Promise<Batch>, 'none' | 'cached']>([
    [
      'a PrCommits 502 whose body is cut off after the headers',
      (run) => {
        run.state.commits = cutOff;
        return run.poll();
      },
      'none',
    ],
    [
      'a PrCommits fetch that rejects',
      (run) => {
        run.state.commits = () => Promise.reject(new TypeError('fetch failed'));
        return run.poll();
      },
      'none',
    ],
    [
      'a PrBases 502 whose body is cut off after the headers',
      async (run) => {
        await run.poll();
        // A full read with cached pairs checks the base.
        run.state.detail = { ...run.state.detail, updatedAt: '2026-01-05T00:00:00Z' };
        run.state.bases = cutOff;
        run.advance(MINUTE);
        const batch = await run.poll();
        expect(run.sent('PrBases')).toBe(1);
        return batch;
      },
      'cached',
    ],
    [
      'a PrCommits answer whose rateLimit.resetAt is not a datetime',
      (run) => {
        run.state.commits = () =>
          json({ data: { ...watchedCommits(), rateLimit: { remaining: 4000, resetAt: 'soon' } } });
        return run.poll();
      },
      'cached',
    ],
    [
      'a PrBases answer whose rateLimit.resetAt is not a datetime',
      async (run) => {
        await run.poll();
        run.state.detail = { ...run.state.detail, updatedAt: '2026-01-05T00:00:00Z' };
        run.state.bases = () =>
          response({
            ...aliased([7], () => ({ pullRequest: { baseRefName: run.state.base } })),
            rateLimit: { remaining: 4000, resetAt: 'soon' },
          });
        run.advance(MINUTE);
        const batch = await run.poll();
        expect(run.sent('PrBases')).toBe(1);
        return batch;
      },
      'cached',
    ],
    [
      'an on-demand read queued while the PrCommits read is in flight',
      async (run) => {
        vi.useFakeTimers();
        try {
          const waiting = new AbortController();
          run.state.commits = (init) => hanging('https://api.github.com/graphql', init);
          const poll = run.poll([refOf(7)], { optionalSignal: waiting.signal });
          const state = settle(poll);
          await vi.advanceTimersByTimeAsync(0);
          expect(run.sent('PrCommits')).toBe(1);
          waiting.abort();
          // Well inside the 4 s request timeout: the pass does not wait for the read.
          await vi.advanceTimersByTimeAsync(0);
          expect(state.settled).toBe(true);
          return await poll;
        } finally {
          vi.useRealTimers();
        }
      },
      'none',
    ],
  ])('keeps the batch after %s', async (_name, read, pairs) => {
    const run = scenario('watched-changed');
    const batch = await read(run);
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref: refOf(7), status: 'ok' }]);
    expect(batch.items).toHaveLength(1);
    expect(pairsOf(batch)).toEqual(pairs === 'cached' ? run.loaded.pairs : undefined);
  });
  it('classifies a 502 cut off after the headers as transient on a required read', async () => {
    const client = new GithubClient(
      'token',
      Date.now,
      vi.fn(() => Promise.resolve(cutOff())),
    );
    const read = client.query(detailQuery([7]), {}, new AbortController().signal);
    await expect(read).rejects.toMatchObject({ kind: 'transient' });
  });
  it('omits pairs on a failed or malformed commits read and keeps the batch complete', async () => {
    for (const answer of [() => failure(503), () => json({ data: { rateLimit: {}, x: 1 } })]) {
      const run = scenario('watched-changed');
      run.state.commits = answer;
      const batch = await run.poll();
      expect(batchSchema.parse(batch)).toEqual(batch);
      expect(batch.complete).toBe(true);
      expect(batch.entities).toEqual([{ ref: refOf(7), status: 'ok' }]);
      expect(batch.items).toHaveLength(1);
      expect(pairsOf(batch)).toBeUndefined();
    }
  });
  it('sends cached pairs again on the reuse path without a second commits read', async () => {
    const run = scenario('watched-changed');
    const first = await run.poll();
    run.advance(MINUTE);
    const second = await run.poll();
    expect(run.sent('PrDetails')).toBe(0);
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(second)).toEqual(pairsOf(first));
    expect(pairsOf(second)).toEqual(run.loaded.pairs);
  });
  it('pollPr sends no PrCommits and no approvalPairs', async () => {
    const run = scenario('watched-changed');
    await run.poll();
    const one = await run.source.pollPr?.(refOf(7), { signal: new AbortController().signal });
    expect(run.sent('PrCommits')).toBe(1);
    expect(one?.items[0]).not.toHaveProperty('approvalPairs');
    // The next poll reads the PR in full again, and its pairs still come from the pair cache.
    const next = await run.poll();
    expect(run.sent('PrDetails')).toBe(1);
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(next)).toEqual(run.loaded.pairs);
  });
  it('sends no PrCommits for a discovered PR core does not request', async () => {
    const run = scenario('watched-changed');
    run.state.discovered = [operatorNode(7)];
    const batch = await run.poll([]);
    expect(run.sent('PrDetails')).toBe(1);
    expect(run.sent('PrCommits')).toBe(0);
    expect(batch.items).toHaveLength(1);
    expect(pairsOf(batch)).toBeUndefined();
  });
  it('stops below three times the reserve with rate_limit and reads on reuse when the budget returns', async () => {
    const run = scenario('watched-changed');
    // Above the 1000 reserve, so the detail read runs; below 3000, so the commits read waits.
    run.state.remaining = 2999;
    const low = await run.poll();
    expect(run.sent('PrDetails')).toBe(1);
    expect(run.sent('PrCommits')).toBe(0);
    expect(low.complete).toBe(true);
    const { approvedSha, headSha } =
      (run.loaded.pairs as { approvedSha: string; headSha: string }[])[0] ?? {};
    expect(pairsOf(low)).toEqual([{ approvedSha, headSha, notCounted: 'rate_limit' }]);
    run.state.remaining = 3000;
    run.advance(MINUTE);
    const back = await run.poll();
    expect(run.sent('PrDetails')).toBe(0);
    expect(run.sent('PrCommits')).toBe(1);
    expect(pairsOf(back)).toEqual(run.loaded.pairs);
  });
  it.each([
    ['fails', (run: ReturnType<typeof scenario>) => (run.state.detailStatus = 502)],
    ['is deferred', (run: ReturnType<typeof scenario>) => (run.state.remaining = 999)],
  ])('keeps cached pairs when the detail read %s', async (_name, block) => {
    const run = scenario('watched-changed');
    await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    // A changed index forces a full read, which this poll does not get.
    run.state.detail = { ...run.state.detail, updatedAt: '2026-01-05T00:00:00Z' };
    block(run);
    run.advance(MINUTE);
    const blocked = await run.poll();
    expect(blocked.items).toEqual([]);
    expect(run.sent('PrCommits')).toBe(0);
    run.state.detailStatus = 200;
    run.state.remaining = 4321;
    run.advance(MINUTE);
    const read = await run.poll();
    expect(run.sent('PrDetails')).toBe(1);
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(read)).toEqual(run.loaded.pairs);
  });
  it('drops cached pairs on a new head, a closed PR or an unlinked PR', async () => {
    const run = scenario('watched-changed');
    const initial = run.state.detail;
    await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    // A new head: its pairs are read afresh.
    run.state.detail = { ...initial, headRefOid: 'c'.repeat(40) };
    run.advance(MINUTE);
    await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    // Closed: no read, and the pairs go; reopened, they are read again.
    run.state.detail = { ...initial, state: 'CLOSED', closedAt: time };
    run.advance(MINUTE);
    const closed = await run.poll();
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(closed)).toBeUndefined();
    run.state.detail = initial;
    run.advance(MINUTE);
    await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    // No longer requested: no read; requested again, the pairs are read again.
    run.advance(MINUTE);
    await run.poll([]);
    expect(run.sent('PrCommits')).toBe(0);
    run.advance(MINUTE);
    const relinked = await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    expect(pairsOf(relinked)).toEqual(run.loaded.pairs);
  });
  it('reads the pairs again after a retarget and keeps them while the base stays', async () => {
    const run = scenario('watched-changed');
    type Commits = {
      data: {
        repository: { pullRequest: { baseRefName: string; commits: { totalCount: number } } };
      };
    };
    const onMain = run.loaded.commits as Commits;
    const large = structuredClone(onMain);
    large.data.repository.pullRequest.commits.totalCount = 105;
    run.state.commits = () => json(large);
    const first = await run.poll();
    const { approvedSha, headSha } =
      (run.loaded.pairs as { approvedSha: string; headSha: string }[])[0] ?? {};
    expect(pairsOf(first)).toEqual([{ approvedSha, headSha, notCounted: 'pr_too_large' }]);
    const initial = run.state.detail;
    // A full read with the base unchanged checks the base and keeps the pairs.
    run.state.detail = { ...initial, updatedAt: '2026-01-05T00:00:00Z' };
    run.advance(MINUTE);
    const same = await run.poll();
    expect(run.sent('PrDetails')).toBe(1);
    expect(run.sent('PrBases')).toBe(1);
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(same)).toEqual(pairsOf(first));
    // Retargeted with the head and the approval kept: the shorter list is read again.
    const onRelease = structuredClone(onMain);
    onRelease.data.repository.pullRequest.baseRefName = 'release';
    run.state.detail = { ...initial, updatedAt: '2026-01-06T00:00:00Z' };
    run.state.base = 'release';
    run.state.commits = () => json(onRelease);
    run.advance(MINUTE);
    const retargeted = await run.poll();
    expect(run.sent('PrBases')).toBe(1);
    expect(run.sent('PrCommits')).toBe(1);
    expect(pairsOf(retargeted)).toEqual(run.loaded.pairs);
    // A reused poll checks nothing.
    run.advance(MINUTE);
    const reused = await run.poll();
    expect(run.sent('PrBases')).toBe(0);
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(reused)).toEqual(run.loaded.pairs);
  });
  it.each<[string, () => Response, number]>([
    [
      'an HTTP 429 with retry-after',
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      2 * MINUTE,
    ],
    [
      'a GraphQL rate limit with no retry time',
      () =>
        json({
          data: watchedCommits(),
          errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
        }),
      MINUTE,
    ],
    ['an HTTP 401', () => failure(401), 15 * MINUTE],
  ])('keeps the batch and pauses approval-watch reads after %s', async (_name, answer, pauseMs) => {
    const run = scenario('watched-changed');
    run.state.commits = answer;
    const first = await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    expect(first.complete).toBe(true);
    expect(first.entities).toEqual([{ ref: refOf(7), status: 'ok' }]);
    expect(first.items).toHaveLength(1);
    expect(pairsOf(first)).toBeUndefined();
    run.state.commits = () => json(run.loaded.commits);
    run.advance(pauseMs - 1);
    const paused = await run.poll();
    expect(run.sent('PrCommits')).toBe(0);
    expect(pairsOf(paused)).toBeUndefined();
    run.advance(1);
    const resumed = await run.poll();
    expect(run.sent('PrCommits')).toBe(1);
    expect(pairsOf(resumed)).toEqual(run.loaded.pairs);
  });
  const pairsFor = (batch: { items: unknown[] }, number: number) =>
    (
      batch.items.find(
        (item) => (item as { facts: { number: number } }).facts.number === number,
      ) as { approvalPairs?: unknown } | undefined
    )?.approvalPairs;
  it('starts no approval-watch read 2 s after its first and reads the rest next poll', async () => {
    const run = scenario('watched-changed');
    const answer = run.state.commits;
    run.state.commits = () => {
      run.advance(2_000);
      return answer();
    };
    const both = [refOf(7), refOf(8)];
    const first = await run.poll(both);
    expect(run.sent('PrCommits')).toBe(1);
    expect(first.complete).toBe(true);
    expect(pairsFor(first, 7)).toEqual(run.loaded.pairs);
    expect(pairsFor(first, 8)).toBeUndefined();
    run.advance(MINUTE);
    const second = await run.poll(both);
    // Only PR 8 still misses its pairs.
    expect(run.sent('PrCommits')).toBe(1);
    expect(pairsFor(second, 7)).toEqual(run.loaded.pairs);
    expect(pairsFor(second, 8)).toEqual(run.loaded.pairs);
  });
  it('times a commits read out after 4 s and keeps the batch', async () => {
    vi.useFakeTimers();
    try {
      const run = scenario('watched-changed');
      run.state.commits = (init) => hanging('https://api.github.com/graphql', init);
      const poll = run.poll();
      const state = settle(poll);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      const batch = await poll;
      expect(batch.complete).toBe(true);
      expect(batch.items).toHaveLength(1);
      expect(pairsOf(batch)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
