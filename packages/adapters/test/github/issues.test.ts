import { describe, expect, it, vi } from 'vitest';
import { AdapterError, batchSchema, type PollContext } from '@spur-board/contracts';
import { createGithubIssuesAdapter } from '../../src/github/issues.ts';

const id = 'github-issues:board:acme/board';
const labelTracker = { type: 'github-issues', repo: 'acme/board', label: 'on-board' } as const;
const at = '2026-11-01T12:00:00Z';
const NOW = Date.parse('2031-05-01T10:00:00.000Z');
const now = () => NOW;

function issue(number: number, label = 'on-board') {
  return {
    node_id: `issue-node-${String(number)}`,
    number,
    title: `Issue ${String(number)}`,
    state: 'open',
    assignee: null,
    labels: [{ name: label }],
    milestone: null,
    html_url: `https://github.com/acme/board/issues/${String(number)}`,
    updated_at: at,
  };
}

function context(tickets: PollContext['observe']['tickets'] = []): PollContext {
  return {
    observe: { prs: [], tickets, sessions: [] },
    signal: new AbortController().signal,
  };
}

function labelAdapter(fetcher: typeof fetch) {
  return createGithubIssuesAdapter({
    id,
    tracker: labelTracker,
    token: 'test',
    intervalMs: 60_000,
    now,
    fetch: fetcher,
  });
}

function linked(body: unknown, next: string): Response {
  return Response.json(body, { headers: { link: `<${next}>; rel="next"` } });
}

/** Routes each request by exact pathname; an unrouted path answers 404. */
function routed(routes: Record<string, () => Response>) {
  const urls: URL[] = [];
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    urls.push(url);
    const route = routes[url.pathname];
    return Promise.resolve(route === undefined ? new Response('', { status: 404 }) : route());
  });
  return { fetcher, urls };
}

function lookups(urls: URL[]): number {
  return urls.filter((url) => url.pathname === '/repos/acme/board').length;
}

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

describe('GitHub Issues source', () => {
  it('reads every label page, excludes pull requests, and keeps stable node ids', async () => {
    const next = 'https://api.github.com/repos/acme/board/issues?page=2';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([issue(1), { ...issue(2), pull_request: { url: 'https://example.test' } }], {
          headers: { link: `<${next}>; rel="next"` },
        }),
      )
      .mockResolvedValueOnce(Response.json([issue(3)]));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context());
    expect(batchSchema.safeParse(batch).success).toBe(true);
    expect(batch.observedAt).toBe(new Date(NOW).toISOString());
    expect(batch.complete).toBe(true);
    expect(batch.items.map((entry) => entry.kind === 'ticket' && entry.facts.id)).toEqual([
      'issue-node-1',
      'issue-node-3',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resolves a key-only manual include outside the filter', async () => {
    const pending = { kind: 'ticket', trackerId: id, key: 'acme/board#9' } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json(issue(9, 'different')));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context([pending]));
    expect(batchSchema.safeParse(batch).success).toBe(true);
    expect(batch.entities).toEqual([{ ref: pending, status: 'ok' }]);
    expect(batch.items[0]).toMatchObject({
      kind: 'ticket',
      facts: { id: 'issue-node-9', key: pending.key, inFilter: false },
    });
  });

  it('reports a missing key without inventing ticket facts', async () => {
    const pending = { kind: 'ticket', trackerId: id, key: 'acme/board#9' } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context([pending]));
    expect(batch.entities).toEqual([{ ref: pending, status: 'not_found' }]);
    expect(batch.items).toEqual([]);
  });

  it('reports an inaccessible key without dropping its requested identity', async () => {
    const pending = { kind: 'ticket', trackerId: id, key: 'acme/board#9' } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response('', { status: 403 }));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context([pending]));
    expect(batch.entities).toEqual([{ ref: pending, status: 'no_access' }]);
    expect(batch.items).toEqual([]);
  });

  it('keeps the first page but marks a failed later page incomplete', async () => {
    const next = 'https://api.github.com/repos/acme/board/issues?page=2';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([issue(1)], {
          headers: { link: `<${next}>; rel="next"` },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context());
    expect(batch.complete).toBe(false);
    expect(batch.items).toHaveLength(1);
  });

  it('does not send credentials to an unexpected pagination URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json([issue(1)], {
        headers: { link: '<https://example.test/collect>; rel="next"' },
      }),
    );
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context());
    expect(batch.complete).toBe(false);
    expect(batch.items).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('follows a same-repository /repositories/<id> next link', async () => {
    const next = 'https://api.github.com/repositories/42/issues?state=open&per_page=100&page=2';
    const { fetcher, urls } = routed({
      '/repos/acme/board/issues': () => linked([issue(1)], next),
      '/repos/acme/board': () => Response.json({ id: 42 }),
      '/repositories/42/issues': () => Response.json([issue(2)]),
    });
    const adapter = labelAdapter(fetcher);
    const batch = await adapter.poll(context());
    expect(batchSchema.safeParse(batch).success).toBe(true);
    expect(batch.complete).toBe(true);
    expect(batch.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await adapter.poll(context());
    expect(lookups(urls)).toBe(1);
  });

  it.each([
    ['another host', 'https://example.test/repositories/42/issues?page=2', false],
    ['another repository id', 'https://api.github.com/repositories/43/issues?page=2', true],
    ['another path', 'https://api.github.com/repositories/42/pulls?page=2', false],
    ['another repository', 'https://api.github.com/repos/other/repo/issues?page=2', false],
    ['an invalid URL', 'not a url', false],
  ])('rejects a next link to %s and keeps the fetched page', async (_name, next, lookup) => {
    const { fetcher, urls } = routed({
      '/repos/acme/board/issues': () => linked([issue(1)], next),
      '/repos/acme/board': () => Response.json({ id: 42 }),
    });
    const batch = await labelAdapter(fetcher).poll(context());
    expect(batch.complete).toBe(false);
    expect(batch.items).toHaveLength(1);
    expect(urls.map(String)).not.toContain(next);
    expect(urls.every((url) => url.origin === 'https://api.github.com')).toBe(true);
    expect(lookups(urls)).toBe(lookup ? 1 : 0);
  });

  it('re-reads the repository id after a mismatch', async () => {
    const ids = [42, 43];
    let linkId = 42;
    const { fetcher, urls } = routed({
      '/repos/acme/board/issues': () =>
        linked([issue(1)], `https://api.github.com/repositories/${String(linkId)}/issues?page=2`),
      '/repos/acme/board': () => Response.json({ id: ids.shift() }),
      '/repositories/42/issues': () => Response.json([issue(2)]),
      '/repositories/43/issues': () => Response.json([issue(3)]),
    });
    const adapter = labelAdapter(fetcher);
    expect((await adapter.poll(context())).complete).toBe(true);
    linkId = 43;
    expect((await adapter.poll(context())).complete).toBe(false);
    const third = await adapter.poll(context());
    expect(third.complete).toBe(true);
    expect(third.items).toHaveLength(2);
    expect(lookups(urls)).toBe(2);
  });

  it('marks the batch incomplete when the repository lookup fails', async () => {
    const { fetcher, urls } = routed({
      '/repos/acme/board/issues': () =>
        linked([issue(1)], 'https://api.github.com/repositories/42/issues?page=2'),
      '/repos/acme/board': () => new Response('', { status: 500 }),
      '/repositories/42/issues': () => Response.json([issue(2)]),
    });
    const batch = await labelAdapter(fetcher).poll(context());
    expect(batch.complete).toBe(false);
    expect(batch.items).toHaveLength(1);
    expect(urls.map((url) => url.pathname)).not.toContain('/repositories/42/issues');
  });

  it.each([
    ['follows', 42],
    ['rejects', 43],
  ])('%s /repositories/<id> milestone pages', async (verb, linkId) => {
    const { fetcher, urls } = routed({
      '/repos/acme/board/milestones': () =>
        linked(
          [{ title: 'M0', number: 1 }],
          `https://api.github.com/repositories/${String(linkId)}/milestones?state=all&per_page=100&page=2`,
        ),
      '/repos/acme/board': () => Response.json({ id: 42 }),
      '/repositories/42/milestones': () => Response.json([{ title: 'M1', number: 3 }]),
      '/repos/acme/board/issues': () => Response.json([]),
    });
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: { type: 'github-issues', repo: 'acme/board', milestone: 'M1' },
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    if (verb === 'follows') {
      await adapter.poll(context());
      expect(
        urls
          .find((url) => url.pathname === '/repos/acme/board/issues')
          ?.searchParams.get('milestone'),
      ).toBe('3');
    } else {
      await expect(adapter.poll(context())).rejects.toMatchObject({ kind: 'transient' });
      expect(urls.map((url) => url.pathname)).not.toContain('/repositories/43/milestones');
    }
  });

  it.each(['lookup', 'later page'])('rejects a throttled %s with retryAt', async (failing) => {
    const throttled = () => new Response('', { status: 429, headers: { 'retry-after': '60' } });
    const { fetcher } = routed({
      '/repos/acme/board/issues': () =>
        linked([issue(1)], 'https://api.github.com/repositories/42/issues?page=2'),
      '/repos/acme/board': failing === 'lookup' ? throttled : () => Response.json({ id: 42 }),
      '/repositories/42/issues': throttled,
    });
    const error: unknown = await labelAdapter(fetcher)
      .poll(context())
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toMatchObject({ kind: 'throttled' });
    expect(error instanceof AdapterError && error.retryAt instanceof Date).toBe(true);
    expect(error instanceof AdapterError ? error.retryAt?.getTime() : undefined).toBe(NOW + 60_000);
  });

  it('resolves a configured milestone title to its number', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ title: 'M1', number: 3 }]))
      .mockResolvedValueOnce(Response.json([]));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: { type: 'github-issues', repo: 'acme/board', milestone: 'M1' },
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    await adapter.poll(context());
    expect(fetcher.mock.calls[1]?.[0]).toContain('milestone=3');
  });

  it('lists every open issue without a filter and keeps a detail-fetched issue in the filter', async () => {
    const { fetcher, urls } = routed({
      '/repos/acme/board/issues': () =>
        Response.json([
          issue(1, 'x'),
          { ...issue(2), pull_request: { url: 'https://example.test' } },
          { ...issue(3), labels: [] },
        ]),
      '/repos/acme/board/issues/9': () =>
        Response.json({ ...issue(9), state: 'closed', milestone: { title: 'M1' } }),
    });
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: { type: 'github-issues', repo: 'acme/board' },
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const first = await adapter.poll(context());
    expect(batchSchema.safeParse(first).success).toBe(true);
    const listing = urls.find((url) => url.pathname === '/repos/acme/board/issues');
    expect(listing?.searchParams.get('state')).toBe('open');
    expect(listing?.searchParams.get('per_page')).toBe('100');
    expect(listing?.searchParams.get('labels')).toBeNull();
    expect(listing?.searchParams.get('milestone')).toBeNull();
    expect(urls.some((url) => url.pathname.endsWith('/milestones'))).toBe(false);
    expect(first.items.map((entry) => entry.kind === 'ticket' && entry.facts.id)).toEqual([
      'issue-node-1',
      'issue-node-3',
    ]);

    urls.length = 0;
    const ref = { kind: 'ticket', trackerId: id, id: 'issue-node-9', key: 'acme/board#9' } as const;
    const second = await adapter.poll(context([ref]));
    expect(batchSchema.safeParse(second).success).toBe(true);
    expect(second.entities).toEqual([{ ref, status: 'ok' }]);
    expect(urls.map((url) => url.pathname)).toContain('/repos/acme/board/issues/9');
    expect(
      second.items.find((entry) => entry.kind === 'ticket' && entry.facts.id === 'issue-node-9'),
    ).toMatchObject({ kind: 'ticket', facts: { status: 'closed', inFilter: true } });
  });

  it('passes extra fields and an unknown issue state', async () => {
    const extended = {
      ...issue(1),
      state: 'archived',
      state_reason: 'completed',
      user: { login: 'someone', id: 5 },
      labels: [{ name: 'on-board', color: 'ffffff' }],
      assignee: { login: 'operator', id: 6 },
    };
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([extended])),
    });
    const batch = await adapter.poll(context());
    expect(batchSchema.safeParse(batch).success).toBe(true);
    expect(batch.items[0]).toMatchObject({
      kind: 'ticket',
      facts: { status: 'archived', assignee: 'operator', labels: ['on-board'] },
    });
  });

  it('fails the poll naming a missing issue field', async () => {
    const malformed: Partial<ReturnType<typeof issue>> = issue(1);
    delete malformed.title;
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([malformed])),
    });
    await expect(adapter.poll(context())).rejects.toMatchObject({
      kind: 'transient',
      message: 'Malformed GitHub issue response at title',
    });
  });

  it('keeps a non-array listing page as an incomplete batch', async () => {
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ message: 'odd' })),
    });
    const batch = await adapter.poll(context());
    expect(batch.complete).toBe(false);
    expect(batch.items).toEqual([]);
  });

  it('lists open issues as members and reads a tracked closed issue by detail', async () => {
    const closed = (number: number) => ({ ...issue(number), state: 'closed' });
    const urls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.pathname === '/repos/acme/board/issues')
        return Promise.resolve(
          Response.json(
            url.searchParams.get('state') === 'open' ? [issue(1)] : [issue(1), closed(2)],
          ),
        );
      if (url.pathname === '/repos/acme/board/issues/3')
        return Promise.resolve(Response.json(closed(3)));
      return Promise.resolve(new Response('', { status: 404 }));
    });
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const first = await adapter.poll(context());
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      kind: 'ticket',
      facts: { id: 'issue-node-1', inFilter: true },
    });
    expect(urls[0]?.searchParams.get('state')).toBe('open');

    urls.length = 0;
    const open = {
      kind: 'ticket',
      trackerId: id,
      id: 'issue-node-1',
      key: 'acme/board#1',
    } as const;
    const gone = {
      kind: 'ticket',
      trackerId: id,
      id: 'issue-node-3',
      key: 'acme/board#3',
    } as const;
    const second = await adapter.poll(context([open, gone]));
    expect(batchSchema.safeParse(second).success).toBe(true);
    expect(second.entities).toEqual([
      { ref: open, status: 'ok' },
      { ref: gone, status: 'ok' },
    ]);
    expect(
      second.items.find((entry) => entry.kind === 'ticket' && entry.facts.id === 'issue-node-3'),
    ).toMatchObject({ kind: 'ticket', facts: { status: 'closed', inFilter: true } });
    expect(urls.map((url) => url.pathname)).not.toContain('/repos/acme/board/issues/1');
    expect(urls.map((url) => url.pathname)).toContain('/repos/acme/board/issues/3');
  });

  it('reports a deleted tracked issue as not_found on 410', async () => {
    const ref = { kind: 'ticket', trackerId: id, id: 'issue-node-4', key: 'acme/board#4' } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response('', { status: 410 }));
    const adapter = createGithubIssuesAdapter({
      id,
      tracker: labelTracker,
      token: 'test',
      intervalMs: 60_000,
      now,
      fetch: fetcher,
    });
    const batch = await adapter.poll(context([ref]));
    expect(batchSchema.safeParse(batch).success).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'not_found' }]);
    expect(batch.items).toEqual([]);
  });

  it('reports the REST budget of the last response', async () => {
    const next = 'https://api.github.com/repos/acme/board/issues?page=2';
    const reset = '1767225600';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([issue(1)], {
          headers: {
            link: `<${next}>; rel="next"`,
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': reset,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json([issue(2)], {
          headers: { 'x-ratelimit-remaining': '4998', 'x-ratelimit-reset': reset },
        }),
      )
      .mockResolvedValueOnce(Response.json([]));
    const adapter = labelAdapter(fetcher);
    const batch = await adapter.poll(context());
    expect(batch.budget).toEqual({ remaining: 4998, resetAt: '2026-01-01T00:00:00.000Z' });
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect((await adapter.poll(context())).budget).toBeUndefined();
  });

  it.each([
    ['no rate-limit headers', {}],
    [
      'a non-numeric remaining',
      { 'x-ratelimit-remaining': 'many', 'x-ratelimit-reset': '1767225600' },
    ],
    ['a non-numeric reset', { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': 'soon' }],
    [
      'a reset past the year 9999',
      { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '999999999999' },
    ],
  ])('omits the budget without valid rate-limit headers: %s', async (_name, headers) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([issue(1)], { headers }));
    const batch = await labelAdapter(fetcher).poll(context());
    expect(batch.complete).toBe(true);
    expect(batch).not.toHaveProperty('budget');
    expect(batchSchema.safeParse(batch).success).toBe(true);
  });
});

describe('GitHub Issues request timeout', () => {
  it('fails a milestone lookup with no answer as timed out after 30 s', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createGithubIssuesAdapter({
        id,
        tracker: { type: 'github-issues', repo: 'acme/board', milestone: 'M1' },
        token: 'test',
        intervalMs: 60_000,
        now,
        fetch: hanging,
      });
      const poll = settle(adapter.poll(context()));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(poll.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll.error).toBeInstanceOf(AdapterError);
      expect(poll.error).toMatchObject({
        kind: 'transient',
        message: 'GitHub issue request timed out',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a label listing abort as a poll abort, not a timeout', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const poll = settle(labelAdapter(hanging).poll({ ...context(), signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(poll.error).toMatchObject({ kind: 'transient', message: 'GitHub issue poll aborted' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(poll.error).toMatchObject({ message: 'GitHub issue poll aborted' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
