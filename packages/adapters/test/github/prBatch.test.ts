import { createHash } from 'node:crypto';
import {
  AdapterError,
  DEFAULT_LINK,
  batchSchema,
  configSchema,
  prFactsSchema,
  sourceCursorSchema,
  type Adapter,
} from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import { initialQuery, pageQuery, type Json } from '../../src/github/client.ts';
import { githubSources } from '../../src/github/index.ts';
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
function wire(number = 7) {
  return {
    id: `PR_${String(number)}`,
    number,
    url: `https://github.com/demo/widgets/pull/${String(number)}`,
    title: 'DEMO-42 Add widget',
    updatedAt: time,
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
      { author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: sha }, submittedAt: time },
    ]),
    reviewThreads: conn([{ isResolved: false }]),
    reviewRequests: conn([{ requestedReviewer: { login: 'reviewer' }, asCodeOwner: true }]),
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
function adapter(fetcher: typeof fetch, configured = config(), index = 0): Adapter {
  const source = githubSources(configured, { token: 'synthetic', fetch: fetcher })[index];
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
  it('pins the initial query and asks for rateLimit, discovery and aliases together', () => {
    const query = initialQuery([7]);
    expect(createHash('sha256').update(query).digest('hex')).toBe(
      '25df11570dc57ad0f8a29ec4ec2d33eb3c16ef806cd6293927af54fae8b4a1b7',
    );
    expect(query).toContain('rateLimit { remaining resetAt }');
    expect(query).toContain('pullRequests(first: 100');
    expect(query).toContain('pr0: repository');
    const bootstrapQuery = initialQuery([7], true);
    expect(createHash('sha256').update(bootstrapQuery).digest('hex')).toBe(
      '646584d0b3ceaa43a09b6369cbca172ec7da659619a7e5e36c655aa3402edb18',
    );
    expect(bootstrapQuery).toContain('states: [OPEN]');
    expect(pageQuery('pullRequests', true)).toContain('states: [OPEN]');
    expect(query).not.toContain('closingIssuesReferences');
    expect(bootstrapQuery).not.toContain('closingIssuesReferences');
    const issuesQuery = initialQuery([7], true, true);
    expect(createHash('sha256').update(issuesQuery).digest('hex')).toBe(
      '404835daed309e393a0ae4d50766c469229aff6eec62ce10d4925e1b97fea19b',
    );
    expect(issuesQuery).toContain('closingIssuesReferences(first: 100)');
  });
  it('normalizes latest required checks, reviews and configured keys', () => {
    const facts = normalizePr('demo/widgets', wire(), demoKeys);
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
  it('keeps the latest review opinion after a comment-only review', () => {
    const pr = wire();
    pr.reviews.nodes.push({
      author: { login: 'reviewer' },
      state: 'COMMENTED',
      commit: { oid: sha },
      submittedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(normalizePr('demo/widgets', pr, demoKeys).reviews).toEqual([
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
    expect(normalizePr('demo/widgets', pr, demoKeys).requiredChecks).toEqual([
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
    expect(normalizePr('demo/widgets', pr, demoKeys).requiredChecks).toEqual([
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
    expect(normalizePr('demo/widgets', head, demoKeys).requiredChecks).toEqual([
      { name: 'build', state: 'failure', completedAt: time },
    ]);
    expect(initialQuery([7])).not.toContain('commits(first: 1)');
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
    const sources = githubSources(configured, { token: 'synthetic' });
    expect(sources.map((s) => [s.adapter.id, s.adapter.intervalMs, s.reserveRemaining])).toEqual([
      ['github:demo:demo/widgets', 1234, 22],
      ['github:demo:demo/api', 1234, 22],
      ['github:other:demo/widgets', 1234, 22],
    ]);
    expect(() =>
      githubSources(config(['demo/widgets', 'DEMO/WIDGETS']), { token: 'synthetic' }),
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
  it('records observedAt before the first request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
        vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
        return Promise.resolve(
          response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: wire() } }),
        );
      });
      const batch = await adapter(fetcher).poll(context());
      expect(batch.observedAt).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
  it('continues a PR review connection and reports the last budget', async () => {
    const first = wire();
    first.reviews.pageInfo = { hasNextPage: true, endCursor: 'review-next' };
    const newerReview = {
      author: { login: 'reviewer' },
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
  it('names read:org for a pathless team-name scope denial on a detail query', async () => {
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
          errors: [
            {
              type: 'INSUFFICIENT_SCOPES',
              message: "Field 'name' requires read:org or read:discussion scope",
            },
          ],
        }),
      );
    await expect(adapter(fetcher).poll(context([]))).rejects.toMatchObject({
      kind: 'auth',
      message: 'GitHub token needs read:org for team review requests',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('names read:org before normalizing a team reviewer with its name withheld', async () => {
    const partial = {
      ...wire(),
      reviewRequests: conn([{ requestedReviewer: {}, asCodeOwner: false }]),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ repository: { pullRequests: conn([]) }, pr0: { pullRequest: partial } }, [
        {
          type: 'INSUFFICIENT_SCOPES',
          path: ['pr0', 'pullRequest', 'reviewRequests', 'nodes', 0, 'requestedReviewer', 'name'],
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
      { kind: 'pr', facts: normalizePr('demo/widgets', wire(), demoKeys) },
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
        { author: { login: 'reviewer' }, state: 'FUTURE', commit: { oid: sha }, submittedAt: time },
      ]),
    };
    const facts = normalizePr('demo/widgets', pr, demoKeys);
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
    expect(bodyQuery(fetcher)).toContain('closingIssuesReferences(first: 100)');
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
    expect(bodyQuery(titleFirst)).not.toContain('closingIssuesReferences');
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
    expect(bodyQuery(sibling)).not.toContain('closingIssuesReferences');
  });
  it('links a Jira PR by projectKeys when link is unset', async () => {
    const fetcher = single(issuesPr('DEMO-42-widget', conn([closingRef(12)]), 7, 'fix: #13 x'));
    const batch = await adapter(fetcher, config()).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(keysOf(batch)).toEqual([['DEMO-42']]);
    expect(bodyQuery(fetcher)).toBe(initialQuery([7], true));
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
    expect(bodyQuery(fetcher)).not.toContain('closingIssuesReferences');
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
      { token: 'synthetic', fetch: fetcher, signal: new AbortController().signal },
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
