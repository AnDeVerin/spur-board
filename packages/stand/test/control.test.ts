import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startControl, type Control, type RouteResult } from '../src/control.ts';

const TOKEN = 'control-token';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function post(control: Control, path: string, init: { signal?: AbortSignal } = {}) {
  return fetch(`${control.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: path === '/wait' ? JSON.stringify({ condition: 'x', timeoutMs: 60_000 }) : '{}',
    ...init,
  });
}

/** A raw request, so the test sets Host and Origin itself. */
function raw(control: Control, headers: Record<string, string>): Promise<number> {
  const url = new URL(`${control.url}/reset`);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

let control: Control | undefined;

afterEach(async () => {
  await control?.close();
  control = undefined;
});

describe('control endpoint', () => {
  it('rejects a missing or wrong token, a foreign Host and an Origin before any route runs', async () => {
    const reset = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset },
    });
    const port = new URL(control.url).port;
    const host = `127.0.0.1:${port}`;
    expect(await raw(control, { host })).toBe(401);
    expect(await raw(control, { host, authorization: 'Bearer wrong' })).toBe(401);
    expect(
      await raw(control, { host: `localhost:${port}`, authorization: `Bearer ${TOKEN}` }),
    ).toBe(403);
    expect(
      await raw(control, { host, authorization: `Bearer ${TOKEN}`, origin: 'http://evil' }),
    ).toBe(403);
    expect(reset).not.toHaveBeenCalled();
    expect(await raw(control, { host, authorization: `Bearer ${TOKEN}` })).toBe(200);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('answers 404 to an unknown route and 413 to a large body', async () => {
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset: vi.fn() },
    });
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    expect((await fetch(`${control.url}/nope`, { method: 'POST', headers })).status).toBe(404);
    const big = await fetch(`${control.url}/poll`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'x'.repeat(70_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('runs reset beside a pending wait and serialises resets', async () => {
    const calls: string[] = [];
    const first = deferred<RouteResult>();
    let resets = 0;
    control = await startControl({
      token: TOKEN,
      routes: {
        wait: (_body, signal) =>
          new Promise((resolve) => {
            calls.push('wait');
            signal.addEventListener('abort', () => {
              resolve({ status: 504, body: {} });
            });
          }),
        poll: vi.fn(),
        reset: () => {
          resets += 1;
          const n = resets;
          calls.push(`reset ${String(n)} start`);
          if (n === 1)
            return first.promise.then((result) => {
              calls.push('reset 1 end');
              return result;
            });
          calls.push(`reset ${String(n)} end`);
          return Promise.resolve({ status: 200, body: { n } });
        },
      },
    });
    const closeWait = new AbortController();
    const waiting = post(control, '/wait', { signal: closeWait.signal }).catch(() => undefined);
    await vi.waitFor(() => {
      expect(calls).toContain('wait');
    });

    const one = post(control, '/reset');
    await vi.waitFor(() => {
      expect(calls).toContain('reset 1 start');
    });
    const two = post(control, '/reset');
    // The second reset is queued: give its request time to arrive, then check it has not run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).not.toContain('reset 2 start');

    first.resolve({ status: 200, body: { n: 1 } });
    expect((await one).status).toBe(200);
    expect((await two).status).toBe(200);
    expect(calls).toEqual(['wait', 'reset 1 start', 'reset 1 end', 'reset 2 start', 'reset 2 end']);

    closeWait.abort();
    await waiting;
  });

  it('answers 503 once close has begun and awaits the queued reset', async () => {
    const pending = deferred<RouteResult>();
    const reset = vi.fn(() => pending.promise);
    control = await startControl({ token: TOKEN, routes: { wait: vi.fn(), poll: vi.fn(), reset } });
    const running = post(control, '/reset');
    await vi.waitFor(() => {
      expect(reset).toHaveBeenCalled();
    });
    let closed = false;
    const closing = control.close().then(() => {
      closed = true;
    });
    expect((await post(control, '/poll')).status).toBe(503);
    expect(closed).toBe(false);
    pending.resolve({ status: 200, body: {} });
    expect((await running).status).toBe(200);
    await closing;
    expect(closed).toBe(true);
  });
});
