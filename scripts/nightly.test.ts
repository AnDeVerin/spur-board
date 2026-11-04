import { describe, expect, it } from 'vitest';
import { reportNightlyFailure } from './nightly.ts';

describe('nightly issue reporting', () => {
  it('creates one labeled issue, then comments on it for a second failure', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let issueCreated = false;
    const fetcher: typeof fetch = (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ path, method, body });
      if (path.endsWith('/issues') && method === 'GET') {
        return Promise.resolve(
          Response.json(
            issueCreated ? [{ number: 7, title: 'Nightly published package smoke failed' }] : [],
          ),
        );
      }
      if (path.endsWith('/labels/ci-nightly'))
        return Promise.resolve(new Response(null, { status: 404 }));
      if (path.endsWith('/issues') && method === 'POST') issueCreated = true;
      return Promise.resolve(Response.json({}));
    };
    const base = { repository: 'owner/repo', token: 'test-token', fetcher };
    expect(await reportNightlyFailure({ ...base, runUrl: 'https://example.test/first' })).toBe(
      'created',
    );
    expect(await reportNightlyFailure({ ...base, runUrl: 'https://example.test/second' })).toBe(
      'updated',
    );
    expect(
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/issues')),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comments')),
    ).toHaveLength(1);
    expect(calls.find((call) => call.path.endsWith('/comments'))?.body).toEqual({
      body: 'The published package failed its nightly install smoke.\n\nRun: https://example.test/second',
    });
  });

  it('fails closed when the API cannot list existing issues', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(null, { status: 500 }));
    await expect(
      reportNightlyFailure({
        repository: 'owner/repo',
        token: 'test-token',
        runUrl: 'https://example.test/run',
        fetcher,
      }),
    ).rejects.toThrow('GitHub API GET');
  });
});
