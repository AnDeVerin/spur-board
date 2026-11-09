import { AdapterError, batchSchema, type PollContext } from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRunner, type AdapterRunner, type PollFailure } from '../../src/runner/runner.ts';
import { createSpurAdapter, type SpurNotice } from '../../src/spur/spur.ts';
import { createFakeCore } from '../../src/testing.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const defaults = {
  sources: { authRetryMs: 900_000, goneAfterPolls: 3 },
  thresholds: { staleMultiplier: 3, blockOpenMs: 86_400_000 },
};
const wire = {
  id: 'demo-worker-1',
  project: 'demo',
  branch: 'work-1',
  status: 'running',
  state: 'waiting',
  lastActivityAt: '2025-12-31T23:59:00.000Z',
  slots: {
    links: [
      { label: 'pr', url: 'https://github.com/demo/app/pull/42' },
      { label: 'board-worker', url: 'https://github.com/demo/app/issues/1' },
    ],
  },
};
const at = (ms: number) => new Date(T0 + ms).toISOString();
const response = (body: unknown, status = 200, instanceId?: string) =>
  Response.json(body, {
    status,
    headers: instanceId ? { 'x-spur-lifecycle-instance-id': instanceId } : {},
  });
function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(input instanceof Request ? input.url : input);
}
const context = (ids: string[] = []): PollContext => ({
  observe: {
    prs: [],
    tickets: [],
    sessions: ids.map((id) => ({ kind: 'session', id })),
  },
  signal: new AbortController().signal,
});
const adapterOptions = {
  baseUrl: 'http://127.0.0.1:4310',
  intervalMs: 15_000,
  flipSmoothingMs: 30_000,
};
const runners: AdapterRunner[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Spur adapter', () => {
  it('normalizes live sessions and strips unrelated wire fields', async () => {
    const requested: URL[] = [];
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      requested.push(requestUrl(input));
      return Promise.resolve(
        response([{ ...wire, unrelated: 'ignored', slots: { ...wire.slots, title: 'ignored' } }]),
      );
    });
    const adapter = createSpurAdapter({ ...adapterOptions, fetch: fetcher });
    const batch = await adapter.poll(context([wire.id]));

    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch).toEqual({
      source: 'spur',
      observedAt: at(0),
      complete: true,
      items: [
        {
          kind: 'session',
          facts: {
            id: wire.id,
            spurProject: 'demo',
            branch: 'work-1',
            pr: { repo: 'demo/app', number: 42 },
            links: {
              pr: 'https://github.com/demo/app/pull/42',
              'board-worker': 'https://github.com/demo/app/issues/1',
            },
            lifecycle: 'running',
            health: 'waiting',
            healthSince: at(0),
            lastActivityAt: wire.lastActivityAt,
            endedAt: null,
            endReason: null,
          },
        },
      ],
      entities: [{ ref: { kind: 'session', id: wire.id }, status: 'ok' }],
    });
    expect(requested[0]?.href).toBe('http://127.0.0.1:4310/sessions');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown health value and reports each new value once', async () => {
    const notices: SpurNotice[] = [];
    const states = ['future_state', 'future_state', 'another_state', 'another_state'];
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response([{ ...wire, state: states.shift() }])),
      onNotice: (notice) => {
        notices.push(notice);
      },
    });
    const first = await adapter.poll(context());
    await adapter.poll(context());
    await adapter.poll(context());
    await adapter.poll(context());

    expect(first.items[0]?.kind === 'session' && first.items[0].facts.health).toBe('future_state');
    expect(notices).toEqual([
      { kind: 'unknown_state', value: 'future_state' },
      { kind: 'unknown_state', value: 'another_state' },
    ]);
  });

  it('waits for an unknown-value notice before returning the batch', async () => {
    let release: () => void = () => undefined;
    let settled = false;
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response([{ ...wire, state: 'future_state' }])),
      onNotice: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const poll = adapter.poll(context()).then((batch) => {
      settled = true;
      return batch;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    release();
    await expect(poll).resolves.toMatchObject({ source: 'spur', complete: true });
  });

  it('retries a notice whose durable callback rejected', async () => {
    let calls = 0;
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response([{ ...wire, state: 'future_state' }])),
      onNotice: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('store unavailable'));
        return undefined;
      },
    });
    await expect(adapter.poll(context())).rejects.toThrow('store unavailable');
    await expect(adapter.poll(context())).resolves.toMatchObject({ source: 'spur' });
    expect(calls).toBe(2);
  });

  it('reports an unknown health value immediately after a known error', async () => {
    let state = 'error';
    const notices: SpurNotice[] = [];
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response([{ ...wire, state }])),
      onNotice: (notice) => {
        notices.push(notice);
      },
    });
    await adapter.poll(context());
    vi.setSystemTime(T0 + 1);
    state = 'future_state';
    const batch = await adapter.poll(context());
    const item = batch.items[0];

    expect(item?.kind === 'session' && item.facts.health).toBe('future_state');
    expect(item?.kind === 'session' && item.facts.healthSince).toBe(at(1));
    expect(notices).toEqual([{ kind: 'unknown_state', value: 'future_state' }]);
  });

  it.each(['id', 'project', 'status', 'state'])(
    'fails the poll when required %s is missing',
    async (field) => {
      const malformed = Object.fromEntries(Object.entries(wire).filter(([key]) => key !== field));
      const adapter = createSpurAdapter({
        ...adapterOptions,
        fetch: () => Promise.resolve(response([malformed])),
      });
      await expect(adapter.poll(context())).rejects.toMatchObject({
        kind: 'transient',
        message: `Invalid Spur response at 0.${field}`,
      });
    },
  );

  it('passes extra fields on a session, its slots and its links', async () => {
    const extra = {
      ...wire,
      extra: { nested: true },
      slots: {
        ...wire.slots,
        other: [1],
        links: wire.slots.links.map((link) => ({ ...link, kind: 'x' })),
      },
    };
    const poll = (body: unknown) =>
      createSpurAdapter({
        ...adapterOptions,
        fetch: () => Promise.resolve(response([body])),
      }).poll(context());
    const [plain, extended] = [await poll(wire), await poll(extra)];
    expect(extended.items).toEqual(plain.items);
    expect(plain.items).toHaveLength(1);
  });

  it('resolves ended linked sessions and a vanished session without polling completed lists', async () => {
    const ids = ['done-1', 'killed-1', 'gone-1'];
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === '/sessions') return Promise.resolve(response([]));
      if (path === '/sessions/done-1')
        return Promise.resolve(response({ ...wire, id: 'done-1', status: 'completed' }));
      if (path === '/sessions/killed-1')
        return Promise.resolve(response({ ...wire, id: 'killed-1', status: 'killed' }));
      return Promise.resolve(response({ error: 'missing' }, 404));
    });
    const adapter = createSpurAdapter({ ...adapterOptions, fetch: fetcher });
    const batch = await adapter.poll(context(ids));

    expect(batchSchema.parse(batch)).toEqual(batch);
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([
      { ref: { kind: 'session', id: ids[0] }, status: 'ok' },
      { ref: { kind: 'session', id: ids[1] }, status: 'ok' },
      { ref: { kind: 'session', id: ids[2] }, status: 'not_found' },
    ]);
    expect(
      batch.items.map(
        (item) => item.kind === 'session' && [item.facts.endReason, item.facts.endedAt],
      ),
    ).toEqual([
      ['complete', at(0)],
      ['kill', at(0)],
    ]);
    expect(fetcher.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      '/sessions',
      '/sessions/done-1',
      '/sessions/killed-1',
      '/sessions/gone-1',
    ]);
  });

  it('keeps a missing linked session live when its detail has a non-ended lifecycle', async () => {
    let status = 'running';
    const notices: SpurNotice[] = [];
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: (input) =>
        Promise.resolve(
          requestUrl(input).pathname === '/sessions'
            ? response([])
            : response({ ...wire, id: 'late-1', status }),
        ),
      onNotice: (notice) => {
        notices.push(notice);
      },
    });
    const first = await adapter.poll(context(['late-1']));
    expect(batchSchema.parse(first)).toEqual(first);
    expect(first.complete).toBe(true);
    expect(first.entities).toEqual([{ ref: { kind: 'session', id: 'late-1' }, status: 'ok' }]);
    expect(first.items[0]?.kind === 'session' && first.items[0].facts.endReason).toBeNull();
    expect(notices).toEqual([]);

    status = 'budget_limited';
    const unknown = await adapter.poll(context(['late-1']));
    await adapter.poll(context(['late-1']));
    expect(batchSchema.parse(unknown)).toEqual(unknown);
    expect(unknown.items[0]?.kind === 'session' && unknown.items[0].facts.lifecycle).toBe(
      'budget_limited',
    );
    expect(unknown.items[0]?.kind === 'session' && unknown.items[0].facts.endedAt).toBeNull();
    expect(notices).toEqual([{ kind: 'unknown_status', value: 'budget_limited' }]);
  });

  it('continues smoothing a non-ended detail across polls outside the live list', async () => {
    let listed = true;
    let state = 'waiting';
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: (input) =>
        Promise.resolve(
          requestUrl(input).pathname === '/sessions'
            ? response(listed ? [{ ...wire, state }] : [])
            : response({ ...wire, state }),
        ),
    });
    const health = async () => {
      const batch = await adapter.poll(context([wire.id]));
      const item = batch.items[0];
      if (item?.kind !== 'session') throw new Error('Missing session detail');
      return [item.facts.health, item.facts.healthSince];
    };

    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 15_000);
    listed = false;
    state = 'error';
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 30_000);
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 45_000);
    expect(await health()).toEqual(['error', at(15_000)]);
  });

  it('rejects an unresolved detail instead of publishing absence', async () => {
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: (input) =>
        Promise.resolve(
          requestUrl(input).pathname === '/sessions'
            ? response([])
            : response({ error: 'unavailable' }, 503),
        ),
    });
    await expect(adapter.poll(context(['missing-1']))).rejects.toMatchObject({ kind: 'transient' });
  });

  it('suppresses brief error and promotes a sustained change at 30 seconds', async () => {
    let state = 'waiting';
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response([{ ...wire, state }])),
    });
    const health = async () => {
      const batch = await adapter.poll(context());
      const item = batch.items[0];
      if (item?.kind !== 'session') throw new Error('Missing session');
      return [item.facts.health, item.facts.healthSince];
    };
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 1);
    state = 'error';
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 20_000);
    state = 'waiting';
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 30_000);
    state = 'error';
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 59_999);
    expect(await health()).toEqual(['waiting', at(0)]);
    vi.setSystemTime(T0 + 60_000);
    expect(await health()).toEqual(['error', at(30_000)]);
  });

  it('detects a restart and clears a pending health change before smoothing', async () => {
    let state = 'waiting';
    let instance = 'first';
    const notices: SpurNotice[] = [];
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response([{ ...wire, state }], 200, instance)),
      onNotice: (notice) => {
        notices.push(notice);
      },
    });
    await adapter.poll(context());
    vi.setSystemTime(T0 + 1);
    state = 'error';
    await adapter.poll(context());
    vi.setSystemTime(T0 + 15_000);
    instance = 'second';
    const restart = await adapter.poll(context());
    expect(restart.items[0]?.kind === 'session' && restart.items[0].facts.health).toBe('waiting');
    vi.setSystemTime(T0 + 30_001);
    const early = await adapter.poll(context());
    expect(early.items[0]?.kind === 'session' && early.items[0].facts.health).toBe('waiting');
    vi.setSystemTime(T0 + 45_000);
    const settled = await adapter.poll(context());
    expect(settled.items[0]?.kind === 'session' && settled.items[0].facts.health).toBe('error');
    expect(settled.items[0]?.kind === 'session' && settled.items[0].facts.healthSince).toBe(
      at(15_000),
    );
    expect(notices).toEqual([
      { kind: 'restart', previousInstanceId: 'first', instanceId: 'second' },
    ]);
  });

  it('forgets health for a session absent from a complete live list', async () => {
    let listed = true;
    let state = 'waiting';
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: () => Promise.resolve(response(listed ? [{ ...wire, state }] : [])),
    });
    await adapter.poll(context());
    vi.setSystemTime(T0 + 15_000);
    listed = false;
    await adapter.poll(context());
    vi.setSystemTime(T0 + 30_000);
    listed = true;
    state = 'error';
    const batch = await adapter.poll(context());

    expect(batch.items[0]?.kind === 'session' && batch.items[0].facts.health).toBe('error');
    expect(batch.items[0]?.kind === 'session' && batch.items[0].facts.healthSince).toBe(at(30_000));
  });

  it('times out a request after five seconds', async () => {
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    const poll = adapter.poll(context());
    const assertion = expect(poll).rejects.toMatchObject<Partial<AdapterError>>({
      kind: 'transient',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('keeps the five-second timeout active while reading the response body', async () => {
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: (_input, init) => {
        const result = response([]);
        vi.spyOn(result, 'json').mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
            }),
        );
        return Promise.resolve(result);
      },
    });
    const assertion = expect(adapter.poll(context())).rejects.toMatchObject({ kind: 'transient' });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('cancels an in-flight request without returning a batch', async () => {
    const controller = new AbortController();
    const adapter = createSpurAdapter({
      ...adapterOptions,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    const assertion = expect(
      adapter.poll({ ...context(), signal: controller.signal }),
    ).rejects.toThrow('Spur poll aborted');
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['refused', 'timeout', 'server error'] as const)(
    'becomes blind after 45 seconds of %s and recovers on success',
    async (failure) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let calls = 0;
      const fetcher: typeof fetch = (_input, init) => {
        calls += 1;
        if (calls > 2) return Promise.resolve(response([wire]));
        if (failure === 'refused') return Promise.reject(new Error('ECONNREFUSED'));
        if (failure === 'server error') return Promise.resolve(response({ error: 'down' }, 503));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      };
      const core = createFakeCore();
      const runner = startRunner({
        entries: [{ adapter: createSpurAdapter({ ...adapterOptions, fetch: fetcher }) }],
        core,
        config: defaults,
      });
      runners.push(runner);
      await vi.advanceTimersByTimeAsync(45_001);
      expect(core.observed).toHaveLength(0);
      expect(core.states.at(-1)?.state.blind?.reason).toBe('stale');
      await vi.advanceTimersByTimeAsync(70_000);
      expect(core.observed.length).toBeGreaterThan(0);
      expect(core.states.at(-1)?.state.blind).toBeUndefined();
    },
  );
});

describe('Spur data from a live board', () => {
  // The shapes the board saw when the spur source stopped advancing (#275).
  const listed = [
    wire,
    {
      id: 'other-1',
      project: 'other-project',
      branch: 'fix/issue-1',
      status: 'stopped',
      state: 'stale',
      stopReason: 'stale_timeout',
      lastActivityAt: '2025-12-31T17:00:00.000Z',
      slots: { title: 'Elsewhere', links: [{ label: 'tracker', url: 'https://example.com/1' }] },
    },
    {
      id: 'retained-1',
      project: 'retained-project',
      branch: 'retained-1',
      status: 'completed',
      state: 'stopped',
      retainInList: true,
      lastActivityAt: '2025-12-01T20:00:00.000Z',
      slots: { title: 'Retained', titleSource: 'manual', links: [] },
    },
  ];
  const ended = (id: string, status: 'completed' | 'killed') => ({
    id,
    project: 'demo',
    branch: `work-${id}`,
    status,
    state: status === 'completed' ? 'stopped' : 'killed',
    lastActivityAt: '2025-12-31T23:00:00.000Z',
    slots: { links: [{ label: 'pr', url: `https://github.com/demo/app/pull/${id.slice(-1)}` }] },
  });
  const linked = ['done-1', 'done-2', 'done-3', 'killed-4'];

  it('advances the source through ended linked sessions and a Spur restart', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let lists = 0;
    const fetcher = (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === '/sessions') {
        lists += 1;
        return Promise.resolve(response(listed, 200, lists === 1 ? 'instance-a' : 'instance-b'));
      }
      const id = url.pathname.split('/').at(-1) ?? '';
      return Promise.resolve(response(ended(id, id.startsWith('killed') ? 'killed' : 'completed')));
    };
    const core = createFakeCore({ context: () => context([wire.id, ...linked]) });
    const failures: PollFailure[] = [];
    const runner = startRunner({
      entries: [{ adapter: createSpurAdapter({ ...adapterOptions, fetch: fetcher }) }],
      core,
      config: defaults,
      onFailure: (failure) => failures.push(failure),
    });
    runners.push(runner);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(failures).toEqual([]);
    expect(core.observed.map((call) => call.observation.state.lastCompleteAt)).toEqual([
      at(0),
      at(15_000),
    ]);
    const sessions = core.observed[1]?.batch.items.flatMap((item) =>
      item.kind === 'session' ? [item.facts] : [],
    );
    expect(
      sessions?.map(({ id, lifecycle, health, endReason }) => [id, lifecycle, health, endReason]),
    ).toEqual([
      [wire.id, 'running', 'waiting', null],
      ['other-1', 'stopped', 'stale', null],
      ['retained-1', 'completed', 'stopped', null],
      ['done-1', 'completed', 'stopped', 'complete'],
      ['done-2', 'completed', 'stopped', 'complete'],
      ['done-3', 'completed', 'stopped', 'complete'],
      ['killed-4', 'killed', 'killed', 'kill'],
    ]);
  });
});
