import { configSchema, sourceCursorSchema, type Adapter } from '@spur-board/contracts';
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
    ).toEqual({ numbers: [1, 3], cursor: newer });
    expect(
      discover([node(4, '2025-12-31T00:00:00.000Z')], sourceCursorSchema.parse(old), 'operator'),
    ).toEqual({ numbers: [], cursor: old });
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
      'mergedBaseline: pullRequests(first: 1, states: [MERGED]',
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
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ repository: { pullRequests: conn(nodes) } }))
      .mockResolvedValueOnce(
        response(
          Object.fromEntries(nodes.slice(0, 50).map((_, index) => [`pr${String(index)}`, null])),
        ),
      )
      .mockResolvedValueOnce(response({ pr0: null }));
    await adapter(fetcher).poll(context);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const queries = fetcher.mock.calls
      .slice(1)
      .map((call) => (JSON.parse(call[1]?.body as string) as { query: string }).query);
    expect(queries[0]?.match(/: repository\(/g)).toHaveLength(50);
    expect(queries[1]?.match(/: repository\(/g)).toHaveLength(1);
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
