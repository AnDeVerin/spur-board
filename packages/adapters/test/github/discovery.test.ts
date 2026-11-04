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
const response = (data: object, errors?: object[]) =>
  new Response(
    JSON.stringify({
      data: { rateLimit: { remaining: 90, resetAt: '2026-01-03T00:00:00.000Z' }, ...data },
      ...(errors ? { errors } : {}),
    }),
  );
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
function adapter(fetcher: typeof fetch): Adapter {
  const source = githubSources(config(), { token: 'synthetic', fetch: fetcher })[0];
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
});
