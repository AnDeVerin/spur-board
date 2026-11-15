import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectStream, type StreamState, type RefreshScope } from '../src/lib/stream.ts';
function server() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  let fail = false;
  let signal: AbortSignal | null | undefined;
  const headers: Headers[] = [];
  const fetcher: typeof fetch = (_url, init) => {
    calls++;
    signal = init?.signal;
    headers.push(new Headers(init?.headers));
    if (fail) return Promise.resolve(new Response(null, { status: 502 }));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel() {},
        }),
      ),
    );
  };
  return {
    fetcher,
    calls: () => calls,
    headers,
    signal: () => signal,
    fail(value: boolean) {
      fail = value;
    },
    send(value: string) {
      controller.enqueue(new TextEncoder().encode(value));
    },
    eof() {
      controller.close();
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
});
describe('stream client', () => {
  it('retries 502/network/EOF with capped backoff and recovers only on valid hello', async () => {
    vi.useFakeTimers();
    const s = server();
    const states: StreamState[] = [];
    s.fail(true);
    const stream = connectStream({
      fetch: s.fetcher,
      state: (value) => states.push(value),
      refresh() {},
    });
    await flush();
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = s.calls();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(s.calls()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.calls()).toBe(before + 1);
    }
    expect(states.at(-1)).toBe('offline');
    s.fail(false);
    await vi.advanceTimersByTimeAsync(30000);
    s.send('event: hello\ndata: {}\n\n');
    await flush();
    expect(states.at(-1)).toBe('offline');
    s.send('event: hello\ndata: {"head":1,"instance":"a"}\n\n');
    await flush();
    expect(states.at(-1)).toBe('live');
    s.eof();
    await flush();
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(s.calls()).toBe(11);
    stream.stop();
    const networkStates: StreamState[] = [];
    let failures = 0;
    const network = connectStream({
      fetch: () => {
        failures++;
        return Promise.reject(new Error('network'));
      },
      state: (value) => networkStates.push(value),
      refresh() {},
    });
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(failures).toBe(2);
    expect(networkStates.at(-1)).toBe('reconnecting');
    network.stop();
  });
  it('parses split chunks/comments, retains cursor, compares hello and merges scopes at exactly 400ms', async () => {
    vi.useFakeTimers();
    const s = server();
    const refreshes: (RefreshScope | null)[] = [];
    const stream = connectStream({
      fetch: s.fetcher,
      state() {},
      refresh: (scope) => refreshes.push(scope),
    });
    await flush();
    s.send(': heartbeat\r\nevent: hel');
    s.send('lo\r\nid: 12\r\ndata: {"head":1,"instance":"a"}\r');
    s.send('\n\r\n');
    await flush();
    expect(refreshes).toEqual([]);
    s.send(
      'event: invalidate\ndata: {"projects":["p"],"tasks":["a"]}\n\nevent: invalidate\ndata: {"projects":["q","p"],"tasks":["b"]}\n\n',
    );
    await flush();
    await vi.advanceTimersByTimeAsync(399);
    expect(refreshes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshes).toEqual([{ projects: ['p', 'q'], tasks: ['a', 'b'] }]);
    s.eof();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(s.headers.at(-1)?.get('Last-Event-ID')).toBe('12');
    s.send('event: hello\ndata: {"head":1,"instance":"a"}\n\n');
    await flush();
    expect(refreshes).toHaveLength(1);
    s.send(
      'event: hello\ndata: {"head":2,"instance":"a"}\n\nevent: hello\ndata: {"head":2,"instance":"b"}\n\n',
    );
    await flush();
    expect(refreshes).toEqual([{ projects: ['p', 'q'], tasks: ['a', 'b'] }, null, null]);
    s.send(
      'event: invalidate\ndata: {"tasks":["c"]}\n\nevent: reset\ndata: {}\n\nevent: status\ndata: unspecified\n\n',
    );
    await flush();
    await vi.advanceTimersByTimeAsync(400);
    expect(refreshes).toHaveLength(5);
    stream.stop();
  });
  it.each(['connected', 'reconnecting', 'debouncing'])('stops all work while %s', async (state) => {
    vi.useFakeTimers();
    const s = server();
    let callbacks = 0;
    const stream = connectStream({
      fetch: s.fetcher,
      state() {
        callbacks++;
      },
      refresh() {
        callbacks++;
      },
    });
    await flush();
    if (state === 'reconnecting') {
      s.eof();
      await flush();
    }
    if (state === 'debouncing') {
      s.send('event: invalidate\ndata: {"tasks":["a"]}\n\n');
      await flush();
    }
    stream.stop();
    const before = callbacks;
    await vi.advanceTimersByTimeAsync(60000);
    expect(s.calls()).toBe(1);
    expect(callbacks).toBe(before);
    expect(s.signal()?.aborted).toBe(true);
  });
});
