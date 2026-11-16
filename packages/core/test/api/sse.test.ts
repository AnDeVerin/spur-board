import { connect } from 'node:net';
import { configSchema, type ActorId, type Config } from '@spur-board/contracts';
import { statusOutputSchema } from '@spur-board/contracts/browser';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit } from '../../src/app/board-utils.ts';
import { dispatchOperation } from '../../src/app/operations.ts';
import { createEventHub, installEventStream, type EventSink } from '../../src/api/sse.ts';
import { createOperationRegistry, type Store } from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { openTempStore } from '../support/store.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const twoProjects = configSchema.parse({
  projects: [
    {
      id: 'a',
      tracker: { type: 'github-issues', repo: 'o/a' },
      repos: ['o/a'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'spura', role: 'worker' }],
    },
    {
      id: 'b',
      tracker: { type: 'github-issues', repo: 'o/b' },
      repos: ['o/b'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'spurb', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
const at = '2026-11-04T08:00:00.000Z';
const instance = '7d4f3a10-0000-4000-8000-000000000001';
const STATUS_KEYS = ['hostLoad', 'sources', 'spurUnavailable', 'transport', 'warmingUp'];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function newStore(): Store {
  const { store } = openTempStore('sse-');
  cleanups.push(() => store.close());
  return store;
}

/** Commits `count` journal rows in one transaction; returns the last event id. */
async function emitEvents(
  store: Store,
  count: number,
  project = 'proj',
  taskId: number | null = null,
): Promise<number> {
  await store.transaction(async (trx) => {
    for (let index = 0; index < count; index += 1)
      await emit(trx, 'comment_added', project, taskId, at, {
        comment: `C${String(index)}`,
        addressee: 'operator',
      });
  });
  return head(store);
}

async function head(store: Store): Promise<number> {
  const row = await store.db
    .selectFrom('event')
    .select((eb) => eb.fn.max('id').as('head'))
    .executeTakeFirst();
  return row?.head ?? 0;
}

async function fullStatus(store: Store): Promise<ReturnType<typeof statusOutputSchema.parse>> {
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  return statusOutputSchema.parse(
    await dispatchOperation({ store, clock, config, registry }, 'status.get', {}, 'operator'),
  );
}

function sinkStub(options: { end?: () => Promise<void> } = {}) {
  const chunks: string[] = [];
  const drains: (() => void)[] = [];
  let accept = true;
  let onWrite: ((chunk: string) => void) | undefined;
  const sink = {
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      onWrite?.(chunk);
      return accept;
    }),
    end: vi.fn(options.end ?? (() => Promise.resolve())),
    destroy: vi.fn(() => Promise.resolve()),
    once: vi.fn((_event: 'drain', listener: () => void) => {
      drains.push(listener);
    }),
  } satisfies EventSink;
  return {
    sink,
    chunks,
    block() {
      accept = false;
    },
    drain() {
      accept = true;
      for (const listener of drains.splice(0)) listener();
    },
    onWrite(listener: (chunk: string) => void) {
      onWrite = listener;
    },
  };
}

function hubFor(
  store: Store,
  overrides: Partial<Parameters<typeof createEventHub>[0]> = {},
): ReturnType<typeof createEventHub> {
  const hub = createEventHub({
    db: store.db,
    config,
    instance,
    readStatus: () => fullStatus(store),
    ...overrides,
  });
  cleanups.push(() => hub.close());
  return hub;
}

async function open(
  hub: ReturnType<typeof createEventHub>,
  sink: EventSink,
  lastId?: string,
  caller: ActorId = 'operator',
) {
  const subscription = await hub.subscribe(caller, lastId, sink);
  if (subscription === 'full') throw new Error('Expected a subscription');
  return subscription;
}

/** Lets the hub's promise chains (Kysely reads) settle; setImmediate is not faked. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const hello = (h: number) =>
  `event: hello\nid: ${String(h)}\ndata: {"head":${String(h)},"instance":"${instance}"}\n\n`;
const reset = (h: number) => `event: reset\nid: ${String(h)}\ndata: {"head":${String(h)}}\n\n`;
const invalidate = (h: number, projects: string[], tasks: string[]) =>
  `event: invalidate\nid: ${String(h)}\ndata: ${JSON.stringify({ head: h, projects, tasks })}\n\n`;

describe('event hub', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('hello carries head and instance; equal cursor gets no reset', async () => {
    const store = newStore();
    const empty = sinkStub();
    await open(hubFor(store), empty.sink);
    expect(empty.chunks).toEqual([hello(0)]);
    const last = await emitEvents(store, 3);
    const stub = sinkStub();
    await open(hubFor(store), stub.sink, String(last));
    expect(stub.chunks).toEqual([hello(last)]);
  });

  it.each([
    { name: 'future', lastId: (h: number) => String(h + 1), resets: true },
    { name: 'non-decimal', lastId: () => 'abc', resets: true },
    { name: 'past', lastId: (h: number) => String(h - 1), resets: false },
    { name: 'absent', lastId: () => undefined, resets: false },
  ])('answers a $name Last-Event-ID', async ({ lastId, resets }) => {
    const store = newStore();
    const last = await emitEvents(store, 2);
    const stub = sinkStub();
    await open(hubFor(store), stub.sink, lastId(last));
    expect(stub.chunks).toEqual(resets ? [hello(last), reset(last)] : [hello(last)]);
  });

  it('sends one invalidate for a committed block.answer and none for a rolled back write', async () => {
    const store = newStore();
    await store.db
      .insertInto('task')
      .values({ ...sampleRows.task, membership: 'active', archive_reason: null })
      .execute();
    await store.db
      .insertInto('block')
      .values({
        ...sampleRows.block,
        type: 'needs_input',
        state: 'open',
        outcome: null,
        outcome_reason: null,
        unblocked_at: null,
        unblocked_by: null,
        addressee_role: 'operator',
      })
      .execute();
    const stub = sinkStub();
    await open(hubFor(store), stub.sink);
    const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
    await dispatchOperation(
      { store, clock, config, registry },
      'block.answer',
      { block: 'B1', text: 'Answer' },
      'operator',
    );
    await advance(300);
    const last = await head(store);
    expect(stub.chunks.slice(1)).toEqual([invalidate(last, ['proj'], ['o/r#101'])]);

    await expect(
      store.transaction(async (trx) => {
        await emit(trx, 'comment_added', 'proj', null, at, { comment: 'X', addressee: 'operator' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await advance(1_000);
    expect(stub.chunks.slice(1)).toEqual([invalidate(last, ['proj'], ['o/r#101'])]);
  });

  it('coalesces a tick into one invalidate and reads a full batch again at once', async () => {
    const store = newStore();
    const stub = sinkStub();
    await open(hubFor(store), stub.sink);
    const fifty = await emitEvents(store, 50);
    await advance(300);
    expect(stub.chunks.slice(1)).toEqual([invalidate(fifty, ['proj'], [])]);

    const last = await emitEvents(store, 501);
    expect(vi.getTimerCount()).toBe(3);
    await advance(300);
    expect(vi.getTimerCount()).toBe(3);
    expect(stub.chunks.slice(2)).toEqual([
      invalidate(last - 1, ['proj'], []),
      invalidate(last, ['proj'], []),
    ]);
  });

  it('reports a failed poll, writes nothing and delivers after recovery', async () => {
    const store = newStore();
    const onError = vi.fn();
    const stub = sinkStub();
    await open(hubFor(store, { onError }), stub.sink);
    const last = await emitEvents(store, 1);
    await store.db.schema.alterTable('event').renameTo('event_x').execute();
    await advance(300);
    expect(onError).toHaveBeenCalledWith({ err: expect.any(Error) as unknown, step: 'poll' });
    expect(stub.chunks).toEqual([hello(0)]);
    await store.db.schema.alterTable('event_x').renameTo('event').execute();
    await advance(300);
    expect(stub.chunks.slice(1)).toEqual([invalidate(last, ['proj'], [])]);
  });

  it('filters invalidate by the projects the caller can see', async () => {
    const store = newStore();
    const stub = sinkStub();
    await open(hubFor(store, { config: twoProjects }), stub.sink, undefined, 'agent:spura/s1');
    await emitEvents(store, 1, 'b');
    await advance(300);
    expect(stub.chunks).toEqual([hello(0)]);
    await emitEvents(store, 1, 'a');
    await emitEvents(store, 1, 'b');
    const last = await emitEvents(store, 1, '_board');
    await advance(300);
    expect(stub.chunks.slice(1)).toEqual([invalidate(last, ['a', '_board'], [])]);
  });

  it('sends heartbeats and a five-field status frame', async () => {
    const store = newStore();
    const full = await fullStatus(store);
    const readStatus = vi.fn(() => Promise.resolve(full));
    const stub = sinkStub();
    await open(hubFor(store, { readStatus }), stub.sink);
    await advance(15_000);
    expect(stub.chunks.slice(1)).toEqual([': heartbeat\n\n']);
    await advance(15_000);
    expect(readStatus).toHaveBeenCalledExactlyOnceWith('operator');
    const status = stub.chunks.slice(2).find((chunk) => chunk.startsWith('event: status\n'));
    expect(stub.chunks.slice(2)).toContain(': heartbeat\n\n');
    expect(status).toMatch(/^event: status\ndata: .*\n\n$/);
    const data = JSON.parse(status?.split('\n')[1]?.slice('data: '.length) ?? '') as object;
    expect(Object.keys(full).length).toBeGreaterThan(5);
    expect(Object.keys(data).sort()).toEqual(STATUS_KEYS);
  });

  it('reports a failed status read and skips that round', async () => {
    const store = newStore();
    const onError = vi.fn();
    const stub = sinkStub();
    await open(
      hubFor(store, { onError, readStatus: () => Promise.reject(new Error('busy')) }),
      stub.sink,
    );
    await advance(30_000);
    expect(onError).toHaveBeenCalledWith({ err: expect.any(Error) as unknown, step: 'status' });
    expect(stub.chunks.some((chunk) => chunk.startsWith('event: status'))).toBe(false);
  });

  it('skips frames for a blocked sink and sends one reset on drain', async () => {
    const store = newStore();
    const stub = sinkStub();
    await open(hubFor(store), stub.sink);
    stub.block();
    await emitEvents(store, 1);
    await advance(300);
    expect(stub.sink.write).toHaveBeenCalledTimes(2);
    await emitEvents(store, 1);
    await advance(15_000);
    const last = await emitEvents(store, 1);
    await advance(300);
    expect(stub.sink.write).toHaveBeenCalledTimes(2);
    stub.drain();
    expect(stub.chunks.slice(2)).toEqual([reset(last)]);
    stub.drain();
    expect(stub.chunks.slice(2)).toEqual([reset(last)]);
  });

  it('refuses a stream past 32 and after close starts', async () => {
    const store = newStore();
    const hub = hubFor(store);
    const subscriptions = [];
    for (let index = 0; index < 32; index += 1)
      subscriptions.push(await open(hub, sinkStub().sink));
    expect(await hub.subscribe('operator', undefined, sinkStub().sink)).toBe('full');
    subscriptions[0]?.unsubscribe();
    subscriptions[0]?.unsubscribe();
    const reopened = sinkStub();
    await open(hub, reopened.sink);
    expect(reopened.chunks).toEqual([hello(0)]);
  });

  it('refuses a stream whose head read outlasts the start of close', async () => {
    const store = newStore();
    const hub = hubFor(store);
    const stub = sinkStub();
    const pending = hub.subscribe('operator', undefined, stub.sink);
    const closing = hub.close();
    expect(await pending).toBe('full');
    await closing;
    expect(stub.sink.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs timers only while subscribed', async () => {
    const store = newStore();
    const hub = hubFor(store);
    expect(vi.getTimerCount()).toBe(0);
    const stub = sinkStub();
    const subscription = await open(hub, stub.sink);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    subscription.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    await emitEvents(store, 1);
    await advance(1_000);
    expect(stub.chunks).toEqual([hello(0)]);
  });

  it('close destroys a blocked sink', async () => {
    const store = newStore();
    const hub = hubFor(store);
    const stub = sinkStub();
    await open(hub, stub.sink);
    stub.block();
    await emitEvents(store, 1);
    await advance(300);
    await hub.close();
    expect(stub.sink.destroy).toHaveBeenCalledOnce();
    expect(stub.sink.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close ends a reading sink without destroying it', async () => {
    const store = newStore();
    const hub = hubFor(store);
    const stub = sinkStub();
    await open(hub, stub.sink);
    await hub.close();
    expect(stub.sink.end).toHaveBeenCalledOnce();
    expect(stub.sink.destroy).not.toHaveBeenCalled();
    await emitEvents(store, 1);
    await advance(1_000);
    expect(stub.chunks).toEqual([hello(0)]);
  });

  it('close bounds a hanging end', async () => {
    const store = newStore();
    const hub = hubFor(store);
    const stub = sinkStub({ end: () => new Promise<void>(() => undefined) });
    await open(hub, stub.sink);
    let settled = false;
    const closing = hub.close().then(() => {
      settled = true;
    });
    await advance(999);
    expect(settled).toBe(false);
    expect(stub.sink.destroy).not.toHaveBeenCalled();
    await advance(1);
    await closing;
    expect(settled).toBe(true);
    expect(stub.sink.destroy).toHaveBeenCalledOnce();
  });

  it('close stops the backlog loop', async () => {
    const store = newStore();
    const hub = hubFor(store);
    const stub = sinkStub();
    await open(hub, stub.sink);
    const first = (await emitEvents(store, 1500)) - 1000;
    const reads = vi.spyOn(store.db, 'selectFrom');
    let closing: Promise<void> | undefined;
    stub.onWrite((chunk) => {
      if (chunk.startsWith('event: invalidate')) closing ??= hub.close();
    });
    await advance(300);
    await closing;
    expect(reads.mock.calls.filter(([table]) => table === 'event')).toHaveLength(1);
    expect(stub.chunks.slice(1)).toEqual([invalidate(first, ['proj'], [])]);
  });
});

describe('event stream route', () => {
  it('shutdown does not wait on a client that stopped reading', async () => {
    const store = newStore();
    const hub = createEventHub({
      db: store.db,
      config: config satisfies Config,
      instance,
      readStatus: () => fullStatus(store),
    });
    let routeSink: EventSink | undefined;
    const app = Fastify({ logger: false });
    installEventStream(app, {
      hub: {
        subscribe: (caller, lastId, sink) => {
          routeSink = sink;
          return hub.subscribe(caller, lastId, sink);
        },
        close: () => hub.close(),
      },
      ready: () => true,
      origin: () => undefined,
      audit: () => undefined,
    });
    app.addHook('preClose', () => hub.close());
    let closedApp = false;
    cleanups.push(async () => {
      if (!closedApp) await app.close();
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    const socket = connect(address.port, '127.0.0.1');
    const socketClosed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      socket.once('data', () => {
        socket.pause();
        resolve();
      });
      socket.write('GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    });
    const sink = routeSink;
    if (sink === undefined) throw new Error('Expected a route sink');
    const padding = `: ${'x'.repeat(1021)}\n\n`;
    let written = 0;
    while (sink.write(padding) && written < 10_000) {
      written += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(written).toBeLessThan(10_000);
    const within = (promise: Promise<unknown>) =>
      Promise.race([
        promise.then(() => 'done'),
        new Promise((resolve) => {
          setTimeout(() => {
            resolve('timeout');
          }, 2_000);
        }),
      ]);
    const started = Date.now();
    expect(await within(app.close())).toBe('done');
    closedApp = true;
    expect(Date.now() - started).toBeLessThan(2_000);
    // The paused socket sees the server's close once it reads the bytes queued before it.
    socket.resume();
    expect(await within(socketClosed)).toBe('done');
    socket.destroy();
  });
});
