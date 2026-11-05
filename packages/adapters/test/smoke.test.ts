import { configSchema, type Config } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSmoke, type SmokeProbes } from '../src/smoke.ts';

const at = '2026-01-02T00:00:00.000Z';
const sha = 'a'.repeat(40);
const connection = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});

function config(): Config {
  return configSchema.parse({
    projects: [
      {
        id: 'demo',
        tracker: {
          type: 'jira',
          baseUrl: 'https://jira.example.test',
          jql: 'project = DEMO',
          projectKeys: ['DEMO'],
          doneStatuses: ['Done'],
          readyStatuses: ['Ready'],
        },
        repos: ['demo/widgets'],
        operatorGithubLogin: 'operator',
      },
      {
        id: 'issues',
        tracker: { type: 'github-issues', repo: 'demo/issues', label: 'board' },
        repos: ['demo/issues'],
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'U123' },
    digest: { tz: 'UTC' },
  });
}

const pr = {
  id: 'PR_7',
  number: 7,
  url: 'https://github.com/demo/widgets/pull/7',
  title: 'DEMO-42 Add widget',
  updatedAt: at,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'BLOCKED',
  author: { login: 'operator' },
  headRefName: 'DEMO-42-widget',
  headRefOid: sha,
  statusCheckRollup: {
    contexts: connection([
      {
        __typename: 'CheckRun',
        name: 'build',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        completedAt: at,
        isRequired: true,
      },
    ]),
  },
  reviews: connection([]),
  reviewThreads: connection([]),
  reviewRequests: connection([]),
};

function fixture(
  options: {
    jiraIncomplete?: boolean;
    jiraAuth?: boolean;
    jiraBadStatus?: boolean;
    jiraMalformed?: boolean;
    githubRepositoryNotFound?: boolean;
    githubChecksForbidden?: boolean;
    secretInFacts?: string;
    secretInSpurLink?: string;
    mixedSecretInSpurLink?: string;
    invalidUtf8SecretInSpurLink?: string;
  } = {},
) {
  const calls: { url: URL; method: string }[] = [];
  const graphQueries: { repo: string; query: string }[] = [];
  let jiraPage = 0;
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (url.pathname === '/graphql') {
      if (typeof init?.body !== 'string') throw new Error('Missing GraphQL request body');
      const body = JSON.parse(init.body) as { query: string; variables: { repo: string } };
      graphQueries.push({ repo: body.variables.repo, query: body.query });
      const isWidgets = body.variables.repo === 'widgets';
      const isDetail = body.query.includes('query PrDetails');
      if (isWidgets && !isDetail && options.githubRepositoryNotFound) {
        return Promise.resolve(
          Response.json({
            data: {
              rateLimit: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z' },
              repository: null,
            },
            errors: [
              {
                type: 'NOT_FOUND',
                path: ['repository'],
                message: 'Synthetic repository unavailable',
              },
            ],
          }),
        );
      }
      if (isWidgets && isDetail && options.githubChecksForbidden) {
        return Promise.resolve(
          Response.json({
            data: {
              rateLimit: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z' },
              pr0: { pullRequest: { ...pr, statusCheckRollup: { contexts: connection([null]) } } },
            },
            errors: [
              {
                type: 'FORBIDDEN',
                path: [
                  'pr0',
                  'pullRequest',
                  'statusCheckRollup',
                  'contexts',
                  'nodes',
                  0,
                  'isRequired',
                ],
                message: 'Resource not accessible by personal access token',
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: {
            rateLimit: { remaining: 4321, resetAt: '2026-01-03T00:00:00.000Z' },
            ...(isDetail
              ? { pr0: { pullRequest: { ...pr, title: options.secretInFacts ?? pr.title } } }
              : {
                  repository: {
                    pullRequests: connection(
                      isWidgets
                        ? [
                            {
                              number: 7,
                              updatedAt: at,
                              author: { login: 'operator' },
                              state: 'OPEN',
                            },
                          ]
                        : [],
                    ),
                    mergedBaseline: connection([]),
                  },
                }),
          },
        }),
      );
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/issues/9')) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/issues')) {
      return Promise.resolve(
        Response.json([
          {
            node_id: 'issue-2',
            number: 2,
            title: 'Synthetic issue',
            state: 'open',
            assignee: null,
            labels: [{ name: 'board' }],
            milestone: null,
            html_url: 'https://github.com/demo/issues/issues/2',
            updated_at: at,
          },
        ]),
      );
    }
    if (url.hostname === 'jira.example.test') {
      if (options.jiraAuth) return Promise.resolve(new Response('', { status: 401 }));
      if (url.pathname.endsWith('/statuses'))
        return Promise.resolve(
          Response.json([
            {
              statuses: options.jiraBadStatus
                ? [{ name: 'Done' }]
                : [{ name: 'Done' }, { name: 'Ready' }],
            },
          ]),
        );
      if (url.pathname.endsWith('/field')) return Promise.resolve(Response.json([]));
      if (url.pathname.endsWith('/issue/DEMO-9'))
        return Promise.resolve(new Response('', { status: 404 }));
      if (url.pathname.endsWith('/search/jql'))
        return Promise.resolve(
          Response.json(
            options.jiraMalformed
              ? { unexpected: true }
              : {
                  issues: [
                    {
                      id: '42',
                      key: 'DEMO-42',
                      fields: {
                        summary: 'Synthetic ticket',
                        status: { name: 'Ready' },
                        assignee: null,
                        labels: [],
                        updated: at,
                      },
                    },
                  ],
                  ...(options.jiraIncomplete
                    ? { nextPageToken: `next-${String(++jiraPage)}` }
                    : {}),
                },
          ),
        );
    }
    if (url.pathname === '/sessions')
      return Promise.resolve(
        Response.json([
          {
            id: 'demo-worker-1',
            project: 'demo',
            branch: null,
            status: 'running',
            state: 'working',
            ...(options.secretInSpurLink === undefined
              ? {}
              : {
                  slots: {
                    links: [
                      {
                        label: 'path',
                        url: `https://example.test/${encodeURIComponent(options.secretInSpurLink)}`,
                      },
                      {
                        label: 'query',
                        url: `https://example.test/?${new URLSearchParams({ token: options.secretInSpurLink }).toString()}`,
                      },
                      {
                        label: 'lowercase',
                        url: `https://example.test/${encodeURIComponent(options.secretInSpurLink).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase())}`,
                      },
                    ],
                  },
                }),
            ...(options.mixedSecretInSpurLink === undefined
              ? {}
              : {
                  slots: {
                    links: [
                      {
                        label: 'percent',
                        url: `https://example.test/${options.mixedSecretInSpurLink.replaceAll(' ', '%20')}`,
                      },
                      {
                        label: 'form',
                        url: `https://example.test/?token=${options.mixedSecretInSpurLink.replaceAll(' ', '+')}`,
                      },
                      {
                        label: 'malformed',
                        url: `https://example.test/%oops/${options.mixedSecretInSpurLink.replaceAll(' ', '%20')}`,
                      },
                    ],
                  },
                }),
            ...(options.invalidUtf8SecretInSpurLink === undefined
              ? {}
              : {
                  slots: {
                    links: [
                      {
                        label: 'invalid-utf8',
                        url: `https://example.test/${options.invalidUtf8SecretInSpurLink.replaceAll(' ', '%20')}%C3`,
                      },
                    ],
                  },
                }),
          },
        ]),
      );
    throw new Error(`Unexpected fake URL ${url.pathname}`);
  };
  return { fetcher, calls, graphQueries };
}

const secrets = {
  GITHUB_TOKEN: 'github-secret',
  JIRA_EMAIL: 'operator@example.test',
  JIRA_API_TOKEN: 'jira-secret',
};

async function run(
  fake = fixture(),
  options: { probes?: SmokeProbes; secrets?: Readonly<Record<string, string>> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSmoke(config(), options.secrets ?? secrets, {
    fetch: fake.fetcher,
    writeOut: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    ...(options.probes === undefined ? {} : { probes: options.probes }),
  });
  const records = out.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    code,
    records,
    out: out.join(''),
    err: err.join(''),
    calls: fake.calls,
    graphQueries: fake.graphQueries,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('adapter smoke', () => {
  it('polls all four configured source kinds once through the runner and prints normalized facts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.records).toHaveLength(5);
    expect(
      result.records.every((record) => record['status'] === 'pass' && record['complete'] === true),
    ).toBe(true);
    expect(
      result.records.find((record) => record['source'] === 'github:demo:demo/widgets'),
    ).toMatchObject({
      items: [
        {
          kind: 'pr',
          facts: { mergeState: 'blocked', requiredChecks: [{ name: 'build', state: 'success' }] },
        },
      ],
      budget: { remaining: 4321 },
    });
    expect(result.records.find((record) => record['source'] === 'jira:demo')).toMatchObject({
      items: [{ kind: 'ticket', facts: { key: 'DEMO-42' } }],
      effectiveComplete: true,
    });
    expect(
      result.records.find((record) => record['source'] === 'github-issues:issues:demo/issues'),
    ).toMatchObject({
      items: [{ kind: 'ticket', facts: { key: 'demo/issues#2' } }],
    });
    expect(result.records.find((record) => record['source'] === 'spur')).toMatchObject({
      items: [{ kind: 'session', facts: { id: 'demo-worker-1' } }],
    });
    expect(
      result.calls.every(
        ({ url, method }) => method === 'GET' || (url.pathname === '/graphql' && method === 'POST'),
      ),
    ).toBe(true);
    expect(result.calls.filter(({ url }) => url.pathname === '/graphql')).toHaveLength(3);
    expect(result.calls.filter(({ url }) => url.pathname.endsWith('/search/jql'))).toHaveLength(1);
    const search = result.calls.find(({ url }) => url.pathname.endsWith('/search/jql'));
    expect(search?.method).toBe('GET');
    expect(search?.url.searchParams.get('jql')).toBe('project = DEMO');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with a named source for auth errors and incomplete batches', async () => {
    const auth = await run(fixture({ jiraAuth: true }));
    expect(auth.code).toBe(1);
    expect(auth.err).toContain('jira:demo:');
    const incomplete = await run(fixture({ jiraIncomplete: true }));
    expect(incomplete.code).toBe(1);
    expect(incomplete.err).toContain('jira:demo: Incomplete batch');
    const malformed = await run(fixture({ jiraMalformed: true }));
    expect(malformed.code).toBe(1);
    expect(malformed.err).toContain('jira:demo:');
  });

  it('reports a repository-root GraphQL NOT_FOUND as a named incomplete GitHub PR source', async () => {
    const result = await run(fixture({ githubRepositoryNotFound: true }));
    expect(result.code).toBe(1);
    expect(result.err).toContain('github:demo:demo/widgets: Incomplete batch');
    expect(
      result.records.find((record) => record['source'] === 'github:demo:demo/widgets'),
    ).toMatchObject({
      status: 'fail',
      reason: 'Incomplete batch',
      complete: false,
      items: [],
    });
    expect(result.graphQueries.filter(({ repo }) => repo === 'widgets')).toHaveLength(1);
    expect(result.graphQueries.find(({ repo }) => repo === 'widgets')?.query).not.toContain(
      'mergeStateStatus',
    );
    expect(result.out).not.toContain('"requiredChecks"');
  });

  it('names a GitHub check-data permission failure without exposing the GraphQL error', async () => {
    const result = await run(fixture({ githubChecksForbidden: true }));
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'github:demo:demo/widgets: GitHub token lacks Checks read permission',
    );
    expect(result.out).not.toContain('Resource not accessible by personal access token');
    expect(
      result.records.find((record) => record['source'] === 'github:demo:demo/widgets'),
    ).toMatchObject({
      status: 'fail',
      reason: 'GitHub token lacks Checks read permission',
    });
  });

  it('redacts configured values in facts and errors, including short values', async () => {
    const values = { ...secrets, EXTRA: 'short' };
    const result = await run(fixture({ secretInFacts: 'short and jira-secret' }), {
      secrets: values,
    });
    expect(result.code).toBe(0);
    for (const value of Object.values(values)) {
      expect(result.out + result.err).not.toContain(value);
    }
    expect(result.out).toContain('[REDACTED]');
    const failed = await run(fixture({ jiraBadStatus: true }), {
      secrets: { ...secrets, EXTRA: 'DEMO' },
    });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('jira:demo:');
    expect(failed.err).not.toContain('DEMO');
  });

  it('redacts URL-encoded secret values in session links', async () => {
    const value = 'value/with spaces';
    const result = await run(fixture({ secretInSpurLink: value }), {
      secrets: { ...secrets, EXTRA: value },
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(value);
    expect(result.out).not.toContain(encodeURIComponent(value));
    expect(result.out).not.toContain(
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    );
    expect(result.out).not.toContain(new URLSearchParams({ token: value }).toString().slice(6));
    expect(result.out).toContain('[REDACTED]');
  });

  it('redacts mixed literal and encoded secret values in session links', async () => {
    const value = 'a/b c';
    const result = await run(fixture({ mixedSecretInSpurLink: value }), {
      secrets: { ...secrets, EXTRA: value },
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).not.toContain(value.replaceAll(' ', '%20'));
    expect(result.out).not.toContain(value.replaceAll(' ', '+'));
    expect(result.out).toContain('[REDACTED]');
    expect(result.records.find((record) => record['source'] === 'spur')).toMatchObject({
      items: [
        {
          facts: {
            links: {
              percent: '[REDACTED]',
              form: '[REDACTED]',
              malformed: '[REDACTED]',
            },
          },
        },
      ],
    });
  });

  it('redacts a secret adjacent to an invalid UTF-8 escape run', async () => {
    const value = 'a/b ';
    const encoded = 'a/b%20%C3';
    const result = await run(fixture({ invalidUtf8SecretInSpurLink: value }), {
      secrets: { ...secrets, EXTRA: value },
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).not.toContain(encoded);
    expect(result.records.find((record) => record['source'] === 'spur')).toMatchObject({
      items: [{ facts: { links: { 'invalid-utf8': '[REDACTED]' } } }],
    });
  });

  it.each(['source', '4321', 'true', 'pass', '"'])(
    'fails closed when a secret collides with serialized output: %s',
    async (value) => {
      const result = await run(fixture(), { secrets: { ...secrets, EXTRA: value } });
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe('');
    },
  );

  it('shows missing explicit probes without treating a complete source listing as a failed batch', async () => {
    const probes: SmokeProbes = {
      prs: [{ kind: 'pr', repo: 'demo/issues', number: 9 }],
      tickets: [
        { kind: 'ticket', trackerId: 'jira:demo', key: 'DEMO-9' },
        { kind: 'ticket', trackerId: 'github-issues:issues:demo/issues', key: 'demo/issues#9' },
      ],
      sessions: [],
    };
    const result = await run(fixture(), { probes });
    expect(result.code).toBe(0);
    expect(result.records.find((record) => record['source'] === 'jira:demo')).toMatchObject({
      status: 'pass',
      complete: true,
      effectiveComplete: false,
      entities: [{ status: 'not_found' }],
    });
    expect(
      result.records.find((record) => record['source'] === 'github-issues:issues:demo/issues'),
    ).toMatchObject({
      status: 'pass',
      entities: [{ status: 'not_found' }],
    });
    expect(
      result.records.find((record) => record['source'] === 'github:issues:demo/issues'),
    ).toMatchObject({
      status: 'pass',
      entities: [{ status: 'not_found' }],
    });
  });
});
