import { batchSchema, sourceCursorSchema, type PollContext } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { createSpurAdapter } from '../../src/spur/spur.ts';

const at = '2026-11-01T12:00:00.000Z';
const reset = '2026-11-01T13:00:00.000Z';
const session = { id: 'worker-1', project: 'demo', status: 'running', state: 'working' };
const edge = {
  cursor: 'opaque-1',
  sessionId: session.id,
  project: 'demo',
  kind: 'state',
  from: 'working',
  to: 'rate_limited',
  at,
  links: [{ label: 'board-worker', url: 'https://github.com/o/r/issues/1' }],
  rateLimitResetAt: reset,
};
const context = (cursor?: string): PollContext => ({
  observe: { prs: [], tickets: [], sessions: [] },
  signal: new AbortController().signal,
  ...(cursor === undefined ? {} : { cursor: sourceCursorSchema.parse(cursor) }),
});
const adapter = (fetch: typeof globalThis.fetch) =>
  createSpurAdapter({
    baseUrl: 'http://localhost:4310',
    intervalMs: 15_000,
    flipSmoothingMs: 0,
    now: () => Date.parse(at),
    fetch,
  });

describe('Spur transition feed', () => {
  it('reads both kinds without link filters, in order, before reconciliation', async () => {
    const calls: URL[] = [];
    const source = adapter((input) => {
      const url = new URL(String(input));
      calls.push(url);
      return Promise.resolve(
        Response.json(
          url.pathname === '/sessions'
            ? [session]
            : {
                entries: [
                  edge,
                  {
                    ...edge,
                    cursor: 'opaque-2',
                    from: 'rate_limited',
                    to: 'working',
                    rateLimitResetAt: undefined,
                  },
                ],
                nextCursor: 'opaque-2',
                hasMore: false,
              },
        ),
      );
    });
    const batch = await source.poll(context());
    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(calls.map((url) => url.pathname)).toEqual(['/sessions/transitions', '/sessions']);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({
      kinds: 'status,state',
      limit: '1000',
    });
    expect(
      batch.sessionTransitions?.map(({ from, to, at, links, rateLimitResetAt }) => ({
        from,
        to,
        at,
        links,
        rateLimitResetAt,
      })),
    ).toEqual([
      {
        from: 'working',
        to: 'rate_limited',
        at,
        links: { 'board-worker': edge.links[0]?.url },
        rateLimitResetAt: reset,
      },
      {
        from: 'rate_limited',
        to: 'working',
        at,
        links: { 'board-worker': edge.links[0]?.url },
        rateLimitResetAt: undefined,
      },
    ]);
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]?.facts).toMatchObject({ health: 'working' });
  });

  it('bounds each tick to four pages and resumes raw positions after recreation', async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/sessions') return Promise.resolve(Response.json([session]));
      const since = url.searchParams.get('since') ?? 'position-0';
      seen.push(since);
      const start = Number(since.slice('position-'.length));
      const size = Math.min(1000, 4001 - start);
      return Promise.resolve(
        Response.json({
          entries: Array.from({ length: size }, (_, index) => ({
            ...edge,
            cursor: `position-${String(start + index + 1)}`,
          })),
          nextCursor: `position-${String(start + size)}`,
          hasMore: start + size < 4001,
        }),
      );
    };
    const first = await adapter(fetcher).poll(context());
    expect(first.sessionTransitions).toHaveLength(4000);
    expect(first.cursor).toBe('position-4000');
    expect(first.items).toHaveLength(1);
    const second = await adapter(fetcher).poll(context(first.cursor));
    expect(second.sessionTransitions).toHaveLength(1);
    expect(second.cursor).toBe('position-4001');
    expect(seen).toEqual([
      'position-0',
      'position-1000',
      'position-2000',
      'position-3000',
      'position-4000',
    ]);
  });

  it('resyncs an expired cursor once and resumes strict-after the new baseline', async () => {
    const requests: URL[] = [];
    const source = adapter((input) => {
      const url = new URL(String(input));
      requests.push(url);
      return Promise.resolve(
        url.pathname === '/sessions'
          ? Response.json([session])
          : url.searchParams.get('since') === 'old'
            ? Response.json({ latestCursor: 'fresh' }, { status: 410 })
            : Response.json({ entries: [], nextCursor: 'fresh', hasMore: false }),
      );
    });
    const first = await source.poll(context('old'));
    expect(first).toMatchObject({ cursor: 'fresh', sessionTransitions: [] });
    await source.poll(context(first.cursor));
    expect(requests.filter((url) => url.pathname === '/sessions')).toHaveLength(2);
    expect(
      requests
        .filter((url) => url.pathname === '/sessions/transitions')
        .map((url) => url.searchParams.get('since')),
    ).toEqual(['old', 'fresh']);
  });

  it.each(['malformed', '500', '400', 'invalid410', 'duplicate', 'abort'])(
    'rejects a later %s page without returning progress',
    async (failure) => {
      const ctx = context('original');
      let calls = 0;
      const source = adapter((input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/sessions/transitions');
        calls++;
        if (calls === 1)
          return Promise.resolve(
            Response.json({ entries: [edge], nextCursor: edge.cursor, hasMore: true }),
          );
        if (failure === 'abort') {
          ctx.signal.throwIfAborted();
          return Promise.reject(new Error('aborted'));
        }
        if (failure === '500' || failure === '400')
          return Promise.resolve(Response.json({}, { status: Number(failure) }));
        if (failure === 'invalid410')
          return Promise.resolve(Response.json({ latestCursor: '' }, { status: 410 }));
        return Promise.resolve(
          Response.json({
            entries: failure === 'duplicate' ? [edge] : [{ ...edge, at: 'bad' }],
            nextCursor: 'later',
            hasMore: false,
          }),
        );
      });
      await expect(source.poll(ctx)).rejects.toMatchObject({ kind: 'transient' });
      expect(calls).toBe(2);
    },
  );

  it('returns known snapshot reset only during rate limiting and never infers recovery from time', async () => {
    let state = 'rate_limited';
    const source = adapter((input) =>
      Promise.resolve(
        Response.json(
          new URL(String(input)).pathname === '/sessions'
            ? [{ ...session, state, rateLimitResetAt: at }]
            : { entries: [], nextCursor: 'stable', hasMore: false },
        ),
      ),
    );
    for (let tick = 0; tick < 2; tick++)
      expect((await source.poll(context())).items[0]?.facts).toMatchObject({
        health: 'rate_limited',
        rateLimitResetAt: at,
      });
    state = 'working';
    expect((await source.poll(context())).items[0]?.facts).not.toHaveProperty('rateLimitResetAt');
  });
});
