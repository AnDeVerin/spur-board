import {
  AdapterError,
  batchSchema,
  configSchema,
  sourceCursorSchema,
  type Adapter,
  type Batch,
} from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import { discover, nextPage } from '../../src/github/discovery.ts';
import { githubSources } from '../../src/github/index.ts';

const old = '2026-01-01T00:00:00.000Z';
const newer = '2026-01-02T00:00:00.000Z';
const node = (number: number, updatedAt: string, login = 'operator', state = 'OPEN') => ({
  number,
  updatedAt,
  author: { login },
  state,
});
const conn = (nodes: unknown[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const response = (data: object, errors?: object[]) => {
  const repository = (data as { repository?: object }).repository;
  return new Response(
    JSON.stringify({
      data: {
        rateLimit: { remaining: 90, resetAt: '2026-01-03T00:00:00.000Z' },
        ...data,
        ...(repository ? { repository: { mergedBaseline: { nodes: [] }, ...repository } } : {}),
      },
      ...(errors ? { errors } : {}),
    }),
  );
};
function config() {
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
        },
        repos: ['demo/widgets'],
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'U123' },
    digest: { tz: 'UTC' },
    // The mocks report 90 requests left; no reserve, so detail reads are never deferred.
    github: { reserveRemaining: 0 },
  });
}
function adapter(fetcher: typeof fetch, now: () => number = () => Date.now()): Adapter {
  const source = githubSources(config(), { token: 'synthetic', now, fetch: fetcher })[0];
  if (source === undefined) throw new Error('Missing GitHub source');
  return source.adapter;
}
const context = {
  observe: { prs: [], tickets: [], sessions: [] },
  cursor: sourceCursorSchema.parse(old),
  signal: new AbortController().signal,
};

describe('GitHub discovery', () => {
  it('revisits equal timestamps, includes merged own PRs and filters other authors', () => {
    expect(
      discover(
        [node(1, old), node(2, newer, 'someone'), node(3, newer, 'operator', 'MERGED')],
        sourceCursorSchema.parse(old),
        'operator',
      ),
    ).toEqual({
      numbers: [1, 3],
      states: new Map([
        [1, 'OPEN'],
        [2, 'OPEN'],
        [3, 'MERGED'],
      ]),
      cursor: newer,
    });
    expect(
      discover([node(4, '2025-12-31T00:00:00.000Z')], sourceCursorSchema.parse(old), 'operator'),
    ).toEqual({ numbers: [], states: new Map(), cursor: old });
  });
  it('rejects malformed pagination', () => {
    expect(() =>
      nextPage({ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } }),
    ).toThrow();
  });
  it('reads all discovery pages and reports the last response budget', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([node(1, old, 'someone')], 'next') } }),
      )
      .mockResolvedValueOnce(
        response({
          repository: { pullRequests: conn([node(2, newer, 'someone')]) },
          rateLimit: { remaining: 80, resetAt: '2026-01-03T00:00:00.000Z' },
        }),
      );
    const batch = await adapter(fetcher).poll(context);
    expect(batch.cursor).toBe(newer);
    expect(batch.complete).toBe(true);
    expect(batch.budget?.remaining).toBe(80);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.body as string).toContain('rateLimit');
  });
  it('stops after the page crosses the saved cursor', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      response({
        repository: {
          pullRequests: conn(
            [node(1, newer, 'someone'), node(2, '2025-12-31T00:00:00.000Z')],
            'unused',
          ),
        },
      }),
    );
    const batch = await adapter(fetcher).poll(context);
    expect(batch.complete).toBe(true);
    expect(batch.cursor).toBe(newer);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.body as string).toContain('states: [OPEN, MERGED, CLOSED]');
  });
  it('continues through equal timestamps at the cursor', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([node(1, old, 'someone')], 'next') } }),
      )
      .mockResolvedValueOnce(response({ repository: { pullRequests: conn([]) } }));
    await adapter(fetcher).poll(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('bootstraps from open PRs and uses the empty-repository boundary', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ repository: { pullRequests: conn([], 'next') } }))
      .mockResolvedValueOnce(response({ repository: { pullRequests: conn([]) } }));
    const batch = await adapter(fetcher).poll({ ...context, cursor: undefined });
    expect(batch.complete).toBe(true);
    expect(batch.cursor).toBe('1970-01-01T00:00:00.000Z');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) {
      expect(call[1]?.body as string).toContain('states: [OPEN]');
    }
    expect(fetcher.mock.calls[0]?.[1]?.body as string).toContain(
      'mergedBaseline: pullRequests(first: 1, states: [MERGED, CLOSED]',
    );
  });
  it('uses GitHub timestamps when the poll host clock is ahead of a later merge', async () => {
    const now = () => Date.parse('2030-01-01T00:00:00.000Z');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequests: conn([]),
            mergedBaseline: { nodes: [{ updatedAt: old }] },
          },
        }),
      )
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([node(7, newer, 'operator', 'MERGED')]) } }),
      )
      .mockResolvedValueOnce(response({ pr0: null }));
    const source = adapter(fetcher, now);
    const first = await source.poll({ ...context, cursor: undefined });
    expect(first.observedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(first.cursor).toBe(old);
    await source.poll({ ...context, cursor: first.cursor });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[1]?.body as string).toContain('pullRequest(number: 7)');
  });
  it('chunks newly discovered PR details into bounded queries', async () => {
    const nodes = Array.from({ length: 51 }, (_, index) => node(index + 1, newer));
    const nulls = (count: number) =>
      response(
        Object.fromEntries(Array.from({ length: count }, (_, i) => [`pr${String(i)}`, null])),
      );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ repository: { pullRequests: conn(nodes) } }))
      .mockImplementation(() => Promise.resolve(nulls(10)));
    await adapter(fetcher).poll(context);
    expect(fetcher).toHaveBeenCalledTimes(7);
    const queries = fetcher.mock.calls
      .slice(1)
      .map((call) => (JSON.parse(call[1]?.body as string) as { query: string }).query);
    expect(queries.map((query) => query.match(/: repository\(/g)?.length)).toEqual([
      10, 10, 10, 10, 10, 1,
    ]);
  });
  it('reads an own PR closed without a merge in the same detail chunk as other discovered PRs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequests: conn([node(1, newer), node(2, newer, 'operator', 'CLOSED')]),
          },
        }),
      )
      .mockResolvedValueOnce(response({ pr0: null, pr1: null }));
    await adapter(fetcher).poll(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const detail = (JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string) as { query: string })
      .query;
    expect(detail.match(/: repository\(/g)?.length).toBe(2);
    expect(detail).toContain('pullRequest(number: 1)');
    expect(detail).toContain('pullRequest(number: 2)');
  });
  it('keeps the prior cursor when a newly discovered PR detail fails', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: conn([node(7, newer, 'operator', 'MERGED')]) } }),
      )
      .mockResolvedValueOnce(
        response({ pr0: null }, [{ message: 'temporary', type: 'INTERNAL', path: ['pr0'] }]),
      );
    const batch = await adapter(fetcher).poll(context);
    expect(batch.complete).toBe(false);
    expect(batch.cursor).toBe(old);
    expect(batch.items).toEqual([]);
  });
  it('keeps the prior cursor after a scoped discovery-page error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ repository: { pullRequests: conn([], 'next') } }))
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: null } }, [
          { message: 'page failed', path: ['repository', 'pullRequests'] },
        ]),
      );
    const batch = await adapter(fetcher).poll(context);
    expect(batch.complete).toBe(false);
    expect(batch.cursor).toBe(old);
    expect(batch.budget?.remaining).toBe(90);
  });
  it('passes extra fields and an unknown PR state', async () => {
    const extended = { ...node(7, newer, 'operator', 'FUTURE'), title: 'extra', isDraft: true };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ repository: { pullRequests: { ...conn([extended]), totalCount: 1 } } }),
      )
      .mockResolvedValueOnce(response({ pr0: null }));
    await adapter(fetcher).poll(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.body as string).toContain('pullRequest(number: 7)');
  });
  it('fails the poll naming a discovery node without updatedAt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      response({
        repository: { pullRequests: conn([{ number: 7, author: { login: 'operator' } }]) },
      }),
    );
    await expect(adapter(fetcher).poll(context)).rejects.toMatchObject({
      kind: 'transient',
      message: 'Malformed GitHub response at data.repository.pullRequests.nodes.0.updatedAt',
    });
  });
  it('skips a PR whose author GitHub returns as null', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          repository: {
            pullRequests: conn([{ ...node(7, newer), author: null }, node(8, newer)]),
          },
        }),
      )
      .mockResolvedValueOnce(response({ pr0: null }));
    await adapter(fetcher).poll(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const detail = fetcher.mock.calls[1]?.[1]?.body as string;
    expect(detail).toContain('pullRequest(number: 8)');
    expect(detail).not.toContain('pullRequest(number: 7)');
  });
});

describe('default branch head', () => {
  const sha = 'a'.repeat(40);
  const runUrl = 'https://github.com/demo/widgets/actions/runs/1/job/2';
  const run = (
    name: string,
    conclusion: string | null,
    event: string | null,
    { status = 'COMPLETED', startedAt = old, url = runUrl } = {},
  ) => ({
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    startedAt,
    completedAt: status === 'COMPLETED' ? startedAt : null,
    detailsUrl: url,
    checkSuite: { createdAt: old, workflowRun: event === null ? null : { event } },
  });
  const commitStatus = (context: string, state: string, targetUrl: string | null = null) => ({
    __typename: 'StatusContext',
    context,
    state,
    createdAt: old,
    targetUrl,
  });
  const branchRef = (nodes: unknown[], hasNextPage = false) => ({
    name: 'main',
    target: {
      __typename: 'Commit',
      oid: sha,
      statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage } } },
    },
  });
  const red = { state: 'red', branch: 'main', sha, check: 'build', url: runUrl };
  const green = { state: 'green', branch: 'main', sha };
  async function pollWith(
    defaultBranchRef: unknown,
    errors?: object[],
    pullRequests: unknown = conn([node(1, newer, 'someone')]),
  ): Promise<{ batch: Batch; fetcher: ReturnType<typeof vi.fn<typeof fetch>> }> {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ repository: { pullRequests, defaultBranchRef } }, errors));
    return { batch: await adapter(fetcher).poll(context), fetcher };
  }
  const branchOf = async (nodes: unknown[], hasNextPage = false): Promise<unknown> =>
    (await pollWith(branchRef(nodes, hasNextPage))).batch.defaultBranch;
  const operations = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>): string[] =>
    fetcher.mock.calls.map(([, init]) => /query (\w+)/.exec(init?.body as string)?.[1] ?? 'none');

  it('reads a red default-branch head from the discovery request alone', async () => {
    const { batch, fetcher } = await pollWith(branchRef([run('build', 'FAILURE', 'push')]));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = fetcher.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain('defaultBranchRef');
    expect(body).toContain('workflowRun { event }');
    expect(batch.defaultBranch).toEqual(red);
    expect(batch.complete).toBe(true);
    expect(batchSchema.parse(batch)).toEqual(batch);
  });

  it('sends the same requests for a red, a green and a missing default branch', async () => {
    const runs = [
      await pollWith(branchRef([run('build', 'FAILURE', 'push')])),
      await pollWith(branchRef([run('build', 'SUCCESS', 'push')])),
      await pollWith(null),
    ];
    expect(runs.map(({ batch }) => batch.defaultBranch)).toEqual([red, green, undefined]);
    for (const { fetcher } of runs) expect(operations(fetcher)).toEqual(['PrBatch']);
  });

  it('keeps discovery complete when the default branch is denied or malformed', async () => {
    const contextsPath = [
      'repository',
      'defaultBranchRef',
      'target',
      'statusCheckRollup',
      'contexts',
    ];
    const denied = {
      name: 'main',
      target: { __typename: 'Commit', oid: sha, statusCheckRollup: { contexts: null } },
    };
    const cases: [unknown, object[] | undefined][] = [
      [denied, [{ message: 'denied', type: 'FORBIDDEN', path: contextsPath }]],
      [null, [{ message: 'gone', type: 'NOT_FOUND', path: ['repository', 'defaultBranchRef'] }]],
      [{ name: 'main', target: { __typename: 'Tree', oid: sha } }, undefined],
      [
        { ...branchRef([]), target: { __typename: 'Commit', oid: sha, statusCheckRollup: null } },
        undefined,
      ],
      [null, undefined],
    ];
    for (const [ref, errors] of cases) {
      const { batch, fetcher } = await pollWith(ref, errors);
      expect(batch.complete).toBe(true);
      expect(batch.cursor).toBe(newer);
      expect(batch).not.toHaveProperty('defaultBranch');
      expect(operations(fetcher)).toEqual(['PrBatch']);
    }
  });

  it('keeps the default-branch fact when the PR listing fails', async () => {
    const { batch } = await pollWith(
      branchRef([run('build', 'FAILURE', 'push')]),
      [{ message: 'listing failed', path: ['repository', 'pullRequests'] }],
      null,
    );
    expect(batch.complete).toBe(false);
    expect(batch.cursor).toBe(old);
    expect(batch.defaultBranch).toEqual(red);
  });

  it('leaves a running head out', async () => {
    expect(await branchOf([run('build', null, 'push', { status: 'IN_PROGRESS' })])).toBeUndefined();
    expect(
      await branchOf([run('build', 'SUCCESS', 'push'), commitStatus('ci/ext', 'PENDING')]),
    ).toBeUndefined();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        pr0: null,
        repository: { defaultBranchRef: branchRef([run('build', 'FAILURE', 'push')]) },
      }),
    );
    const source = adapter(fetcher);
    const ref = { kind: 'pr' as const, repo: 'demo/widgets', number: 7 };
    const batch = await source.pollPr?.(ref, { signal: new AbortController().signal });
    expect(batch?.entities).toEqual([{ ref, status: 'not_found' }]);
    expect(batch).not.toHaveProperty('defaultBranch');
    expect(fetcher.mock.calls[0]?.[1]?.body as string).not.toContain('defaultBranchRef');
  });

  it('a scope error on the default branch fails the poll with auth', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ repository: { pullRequests: conn([]), defaultBranchRef: null } }, [
        {
          message: 'scope',
          type: 'INSUFFICIENT_SCOPES',
          path: ['repository', 'defaultBranchRef'],
        },
      ]),
    );
    const poll = adapter(fetcher).poll(context);
    await expect(poll).rejects.toBeInstanceOf(AdapterError);
    await expect(poll).rejects.toMatchObject({ kind: 'auth' });
  });

  it('nulls a run url that is not http', async () => {
    for (const url of ['not a url', 'javascript:alert(1)']) {
      const { batch } = await pollWith(branchRef([run('build', 'FAILURE', 'push', { url })]));
      expect(batch.defaultBranch).toEqual({ ...red, url: null });
      expect(batch.complete).toBe(true);
      expect(batchSchema.safeParse(batch).success).toBe(true);
    }
  });

  it('counts only push-workflow check runs and commit statuses', async () => {
    const later = '2026-01-01T01:00:00.000Z';
    const extUrl = 'https://ci.example.test/builds/9';
    const pushOk = run('build', 'SUCCESS', 'push');
    expect(await branchOf([pushOk, run('nightly', 'FAILURE', 'schedule')])).toEqual(green);
    expect(await branchOf([run('nightly', 'FAILURE', 'schedule')])).toBeUndefined();
    expect(await branchOf([run('build', 'FAILURE', 'workflow_dispatch'), pushOk])).toEqual(green);
    expect(await branchOf([run('scanner', 'FAILURE', null), pushOk])).toEqual(green);
    expect(await branchOf([commitStatus('ci/ext', 'FAILURE', extUrl), pushOk])).toEqual({
      ...red,
      check: 'ci/ext',
      url: extUrl,
    });
    expect(await branchOf([commitStatus('ci/ext', 'ERROR', null)])).toEqual({
      ...red,
      check: 'ci/ext',
      url: null,
    });
    expect(
      await branchOf([
        run('build', 'FAILURE', 'push'),
        run('build', 'SUCCESS', 'push', { startedAt: later }),
      ]),
    ).toEqual(green);
    expect(
      await branchOf([
        run('build', 'SUCCESS', 'schedule', { startedAt: later }),
        run('build', 'FAILURE', 'push'),
      ]),
    ).toEqual(red);
    expect(await branchOf([pushOk], true)).toBeUndefined();
    expect(await branchOf([pushOk, run('lint', 'FAILURE', 'push')], true)).toEqual({
      ...red,
      check: 'lint',
    });
  });
});
