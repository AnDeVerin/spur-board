import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardData, type BoardData } from '../src/board/data.ts';

type OpId = 'config.get' | 'status.get' | 'inbox.operator';
type Route = (input: Record<string, unknown>) => Promise<Response>;

const envelope = (value: unknown) => Response.json({ ok: true, requestId: 'r1', value });
const failure = () => Promise.resolve(Response.json({ broken: true }, { status: 500 }));
const config = (...projects: string[]) => ({
  projects: projects.map((id) => ({
    id,
    columns: [
      { id: 'todo', executor: { kind: 'dispatcher', name: null } },
      { id: 'done', executor: { kind: 'dispatcher', name: null } },
    ],
    dispatcher: { mode: 'on' },
    spurProjects: [],
    ticketBrowseBase: null,
  })),
  web: { publicOrigin: null, spurUiOrigin: null },
});
const task = (project: string, n: number) => ({
  key: `${project.toUpperCase()}-${String(n)}`,
  project,
  column: 'todo',
  columnEnteredAt: null,
  membership: 'active',
  state: 'open',
  prCount: 0,
  sessionCount: 0,
  openBlocks: 0,
  blocks: [],
  turn: null,
  prSummary: null,
  links: { ticket: null, prs: [], sessions: [] },
});
const status = (project: string) => ({
  items: [],
  warmingUp: false,
  spurUnavailable: null,
  hostLoad: null,
  host: null,
  services: [],
  transport: [],
  sources: [],
  tasks: [task(project, 1), task(project, 2)],
  columnGroups: [{ id: 'todo', columns: ['todo', 'triage', 'ready-for-dev'] }],
  projectBlocks: [],
  unlinkedPrs: [],
  unlinkedSessions: [],
  hiddenUnlinkedPrs: 0,
  hiddenUnlinkedSessions: 0,
  bindings: { columns: [], operators: [], defaultAddressee: null },
  daemon: { version: '0.4.0', startedAt: '2026-01-05T08:00:00.000Z', lastDispatchAt: null },
});
const inbox = (count: number) => ({
  items: Array.from({ length: count }, (_, i) => ({
    id: `B${String(i + 1)}`,
    project: 'a',
    kind: 'block',
    severity: 'attention',
    text: 'Pick one',
    at: '2026-11-15T14:00:00.000Z',
    task: null,
  })),
  handled: [],
});
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
/** Fake daemon: the three reads by route, and an event stream the test writes to. */
function daemon() {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const routes: Record<OpId, Route> = {
    'config.get': () => Promise.resolve(envelope(config('a', 'b'))),
    'status.get': (input) => Promise.resolve(envelope(status(String(input['project'])))),
    'inbox.operator': () => Promise.resolve(envelope(inbox(2))),
  };
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let streamFails = false;
  const fetcher: typeof fetch = (url, init) => {
    const path = url instanceof Request ? url.url : url.toString();
    if (path === '/v1/events') {
      calls.push({ path, input: {} });
      if (streamFails) return Promise.resolve(new Response(null, { status: 502 }));
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              stream = value;
            },
          }),
        ),
      );
    }
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      input: Record<string, unknown>;
    };
    calls.push({ path, input: body.input });
    const route = routes[path.replace('/v1/ops/', '') as OpId] as Route | undefined;
    return route ? route(body.input) : Promise.resolve(new Response(null, { status: 404 }));
  };
  return {
    fetcher,
    calls,
    routes,
    count: (op: OpId | 'events') =>
      calls.filter(({ path }) => path === (op === 'events' ? '/v1/events' : `/v1/ops/${op}`))
        .length,
    reads: () => calls.filter(({ path }) => path !== '/v1/events').map(({ path }) => path.slice(8)),
    send(value: string) {
      stream.enqueue(new TextEncoder().encode(value));
    },
    endStream() {
      stream.close();
    },
    failStream(value: boolean) {
      streamFails = value;
    },
  };
}
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
/** Body reads and parsing cross a few macrotasks; fake timers leave setImmediate real. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const hello = (instance = 'one') => `event: hello\ndata: {"head":1,"instance":"${instance}"}\n\n`;
const started: BoardData[] = [];
function start(
  d: ReturnType<typeof daemon>,
  storage = memoryStorage(),
  now: () => number = () => 0,
) {
  const data = createBoardData({ fetch: d.fetcher, storage: () => storage, now });
  started.push(data);
  data.start();
  return data;
}
afterEach(() => {
  for (const data of started.splice(0)) data.stop();
  vi.useRealTimers();
});

describe('board data', () => {
  it('reads config, then status for the chosen project, and the inbox', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    const snapshot = data.snapshot();
    expect(snapshot.project).toBe('a');
    expect(snapshot.status?.tasks.map((row) => row.key)).toEqual(['A-1', 'A-2']);
    expect(snapshot.inbox?.items).toHaveLength(2);
    expect(snapshot.readFailed).toBe(false);
    expect(d.reads().indexOf('status.get')).toBeGreaterThan(d.reads().indexOf('config.get'));
    expect(d.calls.find(({ path }) => path === '/v1/ops/status.get')?.input).toEqual({
      project: 'a',
      detail: true,
    });
    expect(d.calls.find(({ path }) => path === '/v1/ops/config.get')?.input).toEqual({});
  });

  it('notifies subscribers with a new snapshot object on each change', async () => {
    const d = daemon();
    const data = createBoardData({ fetch: d.fetcher, storage: memoryStorage, now: () => 0 });
    started.push(data);
    const seen: unknown[] = [];
    const unsubscribe = data.subscribe(() => seen.push(data.snapshot()));
    const first = data.snapshot();
    expect(data.snapshot()).toBe(first);
    data.start();
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    unsubscribe();
    const count = seen.length;
    d.send(hello());
    await settle();
    expect(seen).toHaveLength(count);
  });

  it('project choice survives reload and falls back', async () => {
    const d = daemon();
    const storage = memoryStorage();
    const first = start(d, storage);
    await settle();
    first.choose('b');
    expect(storage.values.get('board-project')).toBe('b');
    first.choose('zzz');
    expect(storage.values.get('board-project')).toBe('b');
    first.stop();

    const reload = daemon();
    const second = start(reload, storage);
    await settle();
    expect(second.snapshot().project).toBe('b');
    expect(reload.calls.find(({ path }) => path === '/v1/ops/status.get')?.input).toEqual({
      project: 'b',
      detail: true,
    });

    const unknown = daemon();
    const third = start(unknown, memoryStorage({ 'board-project': 'zzz' }));
    await settle();
    expect(third.snapshot().project).toBe('a');
    expect(
      unknown.calls.filter(({ path }) => path === '/v1/ops/status.get').map(({ input }) => input),
    ).toEqual([{ project: 'a', detail: true }]);
  });

  it('ignores storage that throws', async () => {
    const d = daemon();
    const broken = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const data = createBoardData({ fetch: d.fetcher, storage: () => broken, now: () => 0 });
    started.push(data);
    data.start();
    await settle();
    expect(data.snapshot().project).toBe('a');
    data.choose('b');
    await settle();
    expect(data.snapshot().project).toBe('b');
  });

  it("switching project never shows the previous project's cards", async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    const held = deferred();
    d.routes['status.get'] = (input) =>
      input['project'] === 'a' ? held.promise : Promise.resolve(envelope(status('b')));
    d.send(hello());
    await settle();
    expect(d.count('status.get')).toBe(2);
    data.choose('b');
    expect(data.snapshot()).toMatchObject({
      project: 'b',
      status: undefined,
      lastGoodAt: undefined,
    });
    held.resolve(envelope(status('a')));
    await settle();
    expect(data.snapshot().status?.tasks.map((row) => row.key)).toEqual(['B-1', 'B-2']);
    expect(d.calls.at(-1)?.input).toEqual({ project: 'b', detail: true });
  });

  it('keeps a late answer for the old project off the new one', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    const heldA = deferred();
    const heldB = deferred();
    d.routes['status.get'] = (input) => (input['project'] === 'a' ? heldA.promise : heldB.promise);
    d.send(hello());
    await settle();
    data.choose('b');
    heldA.resolve(envelope(status('a')));
    await settle();
    expect(data.snapshot().status).toBeUndefined();
    heldB.resolve(envelope(status('b')));
    await settle();
    expect(data.snapshot().status?.tasks.map((row) => row.key)).toEqual(['B-1', 'B-2']);
  });

  it('invalidate refetch scope', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    start(d);
    await settle();
    d.send(hello());
    await settle();
    d.calls.length = 0;
    d.send('event: invalidate\ndata: {"projects":["other"],"tasks":[]}\n\n');
    await settle();
    await vi.advanceTimersByTimeAsync(399);
    expect(d.reads()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(d.reads()).toEqual(['inbox.operator']);
    d.calls.length = 0;
    d.send('event: invalidate\ndata: {"projects":["_board"],"tasks":[]}\n\n');
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(d.reads()).toEqual(['inbox.operator']);
    d.calls.length = 0;
    d.send('event: invalidate\ndata: {"projects":["a"],"tasks":["A-1"]}\n\n');
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(d.reads().sort()).toEqual(['config.get', 'inbox.operator', 'status.get']);
    expect(d.reads().indexOf('status.get')).toBeGreaterThan(d.reads().indexOf('config.get'));
  });

  it('changed hello and reset re-read all three', async () => {
    const d = daemon();
    start(d);
    await settle();
    d.send(hello('one'));
    await settle();
    d.calls.length = 0;
    d.send(hello('one'));
    await settle();
    expect(d.reads()).toEqual([]);
    d.send(hello('two'));
    await settle();
    expect(d.reads().sort()).toEqual(['config.get', 'inbox.operator', 'status.get']);
    d.calls.length = 0;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(d.reads().sort()).toEqual(['config.get', 'inbox.operator', 'status.get']);
  });

  it('keeps the last inbox and no read failure when only the inbox fails', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    d.routes['inbox.operator'] = failure;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(data.snapshot().inbox?.items).toHaveLength(2);
    expect(data.snapshot().readFailed).toBe(false);
  });

  it('a failed first read leaves no status and marks the read failed', async () => {
    const d = daemon();
    d.routes['status.get'] = failure;
    const data = start(d);
    await settle();
    expect(data.snapshot()).toMatchObject({ readFailed: true, status: undefined, project: 'a' });
    const down = daemon();
    down.routes['config.get'] = failure;
    const blind = start(down);
    await settle();
    expect(blind.snapshot()).toMatchObject({
      readFailed: true,
      config: undefined,
      project: undefined,
    });
    expect(down.count('status.get')).toBe(0);
  });

  it('stale banner shows the time of last good data', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = Date.UTC(2026, 10, 15, 14, 52);
    const goodAt = now;
    const d = daemon();
    const data = start(d, memoryStorage(), () => now);
    await settle();
    expect(data.snapshot()).toMatchObject({ lastGoodAt: goodAt, everLive: false });
    d.send(hello());
    await settle();
    expect(data.snapshot()).toMatchObject({ stream: 'live', everLive: true });
    now += 60_000;
    d.failStream(true);
    d.routes['status.get'] = failure;
    d.endStream();
    await settle();
    for (const delay of [500, 1000, 2000, 4000]) {
      expect(data.snapshot().stream).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }
    expect(data.snapshot()).toMatchObject({
      stream: 'offline',
      readFailed: true,
      lastGoodAt: goodAt,
    });
    expect(data.snapshot().status?.tasks).toHaveLength(2);

    const probe = daemon();
    const probed = start(probe, memoryStorage(), () => goodAt);
    await settle();
    probe.send(hello());
    await settle();
    probe.failStream(true);
    probe.endStream();
    await settle();
    for (const delay of [500, 1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }
    expect(probed.snapshot()).toMatchObject({ stream: 'offline', readFailed: false });
    // First load, the first hello and the offline probe.
    expect(probe.count('status.get')).toBe(3);
  });

  it('re-reads everything when the stream comes back while a read had failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const data = start(d);
    await settle();
    d.send(hello());
    await settle();
    d.routes['status.get'] = failure;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(data.snapshot().readFailed).toBe(true);
    d.routes['status.get'] = (input) => Promise.resolve(envelope(status(String(input['project']))));
    d.endStream();
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(data.snapshot().stream).toBe('reconnecting');
    d.calls.length = 0;
    // The same hello: the stream asks for no refresh, the controller re-reads on its own.
    d.send(hello());
    await settle();
    expect(d.reads().sort()).toEqual(['config.get', 'inbox.operator', 'status.get']);
    expect(data.snapshot().readFailed).toBe(false);
  });

  it('retry is busy until the reads issued after the press settle', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    const heldConfig = deferred();
    const heldStatus = deferred();
    const heldInbox = deferred();
    d.routes['config.get'] = () => heldConfig.promise;
    d.routes['status.get'] = () => heldStatus.promise;
    d.routes['inbox.operator'] = () => heldInbox.promise;
    d.calls.length = 0;
    data.retry();
    data.retry();
    expect(data.snapshot().retrying).toBe(true);
    await settle();
    expect(d.reads().sort()).toEqual(['config.get', 'inbox.operator']);
    heldInbox.resolve(envelope(inbox(1)));
    heldConfig.resolve(envelope(config('a', 'b')));
    await settle();
    expect(data.snapshot().retrying).toBe(true);
    expect(d.reads()).toContain('status.get');
    heldStatus.resolve(Response.json({ broken: true }, { status: 500 }));
    await settle();
    expect(data.snapshot()).toMatchObject({ retrying: false, readFailed: true });
  });

  it('retry reconnects a stream waiting in backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const data = start(d);
    await settle();
    d.failStream(true);
    d.endStream();
    await settle();
    expect(d.count('events')).toBe(1);
    data.retry();
    await settle();
    expect(d.count('events')).toBe(2);
  });

  it('fetches only the four paths', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const data = start(d);
    await settle();
    d.send(hello());
    d.send('event: invalidate\ndata: {"projects":["a"],"tasks":[]}\n\n');
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    data.retry();
    await settle();
    data.choose('b');
    await settle();
    expect(new Set(d.calls.map(({ path }) => path))).toEqual(
      new Set(['/v1/ops/config.get', '/v1/ops/status.get', '/v1/ops/inbox.operator', '/v1/events']),
    );
  });

  it('stop ends every read and the stream', async () => {
    const d = daemon();
    const held = deferred();
    d.routes['config.get'] = () => held.promise;
    const data = start(d);
    const seen: unknown[] = [];
    data.subscribe(() => seen.push(data.snapshot()));
    data.stop();
    held.resolve(envelope(config('a')));
    await settle();
    expect(data.snapshot().config).toBeUndefined();
    data.start();
    expect(d.count('config.get')).toBe(1);
  });
});
