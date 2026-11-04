import { describe, expect, it, vi } from 'vitest';
import { batchSchema, type PollContext } from '@spur-board/contracts';
import { createGithubIssuesAdapter } from '../../src/github/issues.ts';

const id = 'github-issues:board:acme/board';
const labelTracker = { type: 'github-issues', repo: 'acme/board', label: 'on-board' } as const;
const at = '2026-11-01T12:00:00Z';

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
      fetch: fetcher,
    });
    const batch = await adapter.poll(context());
    expect(batchSchema.safeParse(batch).success).toBe(true);
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
      fetch: fetcher,
    });
    const batch = await adapter.poll(context());
    expect(batch.complete).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
      fetch: fetcher,
    });
    await adapter.poll(context());
    expect(fetcher.mock.calls[1]?.[0]).toContain('milestone=3');
  });
});
