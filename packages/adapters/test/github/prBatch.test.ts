import { createHash } from 'node:crypto';
import {
  AdapterError,
  batchSchema,
  configSchema,
  prFactsSchema,
  sourceCursorSchema,
  type Adapter,
} from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import { initialQuery, pageQuery, type Json } from '../../src/github/client.ts';
import { githubSources } from '../../src/github/index.ts';
import { normalizePr, ticketKeys } from '../../src/github/prBatch.ts';

const sha = 'a'.repeat(40);
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
function config(repos = ['demo/widgets']) {
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
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'U123' },
    digest: { tz: 'UTC' },
  });
}
const response = (data: unknown, errors?: unknown[]) =>
  new Response(
    JSON.stringify({
      data: {
        rateLimit: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z' },
        ...(data as object),
      },
      ...(errors ? { errors } : {}),
    }),
    { status: 200 },
  );
function adapter(fetcher: typeof fetch): Adapter {
  const source = githubSources(config(), { token: 'synthetic', fetch: fetcher })[0];
  if (source === undefined) throw new Error('Missing GitHub source');
  return source.adapter;
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
  });
  it('normalizes latest required checks, reviews and configured keys', () => {
    const facts = normalizePr('demo/widgets', wire(), ['DEMO']);
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
    expect(normalizePr('demo/widgets', pr, ['DEMO']).requiredChecks).toEqual([
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
    expect(normalizePr('demo/widgets', pr, ['DEMO']).requiredChecks).toEqual([
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
    expect(normalizePr('demo/widgets', head, ['DEMO']).requiredChecks).toEqual([
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
});
