import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callLocal,
  MAX_WAIT_MS,
  startControl,
  type Control,
  type RouteResult,
} from '../src/control.ts';

const TOKEN = 'control-token';
const slackStubs = { slackOutbox: vi.fn(), slackClick: vi.fn() };

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
function raw(control: Control, headers: Record<string, string>, path = '/reset'): Promise<number> {
  const url = new URL(`${control.url}${path}`);
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
      routes: { wait: vi.fn(), poll: vi.fn(), reset, ...slackStubs },
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

  it.each(['/fake/slack/outbox', '/fake/slack/click'])(
    'rejects a missing token, a foreign Host and an Origin on %s',
    async (path) => {
      const slackOutbox = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
      const slackClick = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
      control = await startControl({
        token: TOKEN,
        routes: { wait: vi.fn(), poll: vi.fn(), reset: vi.fn(), slackOutbox, slackClick },
      });
      const port = new URL(control.url).port;
      const host = `127.0.0.1:${port}`;
      const authorization = `Bearer ${TOKEN}`;
      expect(await raw(control, { host }, path)).toBe(401);
      expect(await raw(control, { host, authorization: 'Bearer wrong' }, path)).toBe(401);
      expect(await raw(control, { host: `localhost:${port}`, authorization }, path)).toBe(403);
      expect(await raw(control, { host, authorization, origin: 'http://evil' }, path)).toBe(403);
      expect(slackOutbox).not.toHaveBeenCalled();
      expect(slackClick).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['no fields', {}],
    ['a zero message', { message: 0, button: 'b' }],
    ['a negative message', { message: -1, button: 'b' }],
    ['a fractional message', { message: 1.5, button: 'b' }],
    ['a string message', { message: '1', button: 'b' }],
    ['no button', { message: 1 }],
    ['an empty button', { message: 1, button: '' }],
    ['a numeric button', { message: 1, button: 2 }],
    ['non-string text', { message: 1, button: 'answer', text: 1 }],
  ])('answers 400 to a click with %s', async (_name, body) => {
    const slackClick = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset: vi.fn(), slackOutbox: vi.fn(), slackClick },
    });
    const response = await fetch(`${control.url}/fake/slack/click`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(slackClick).not.toHaveBeenCalled();
  });

  it('passes a valid click to its route', async () => {
    const slackClick = vi.fn(() => Promise.resolve({ status: 200, body: { ok: true } }));
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset: vi.fn(), slackOutbox: vi.fn(), slackClick },
    });
    const click = (body: unknown) =>
      fetch(`${control?.url ?? ''}/fake/slack/click`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await click({ message: 2, button: 'answer', text: 'Yes.' })).status).toBe(200);
    expect((await click({ message: 1, button: 'item:1:close' })).status).toBe(200);
    expect(slackClick.mock.calls).toEqual([
      [{ message: 2, button: 'answer', text: 'Yes.' }],
      [{ message: 1, button: 'item:1:close' }],
    ]);
  });

  it('queues a click behind a reset and answers the outbox beside it', async () => {
    const pending = deferred<RouteResult>();
    const reset = vi.fn(() => pending.promise);
    const slackOutbox = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
    const slackClick = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset, slackOutbox, slackClick },
    });
    const running = post(control, '/reset');
    await vi.waitFor(() => {
      expect(reset).toHaveBeenCalled();
    });
    const clicking = fetch(`${control.url}/fake/slack/click`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 1, button: 'b' }),
    });
    expect((await post(control, '/fake/slack/outbox')).status).toBe(200);
    // The click is queued: give its request time to arrive, then check it has not run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(slackClick).not.toHaveBeenCalled();
    pending.resolve({ status: 200, body: {} });
    expect((await running).status).toBe(200);
    expect((await clicking).status).toBe(200);
    expect(slackClick).toHaveBeenCalledTimes(1);
  });

  it('answers 404 to an unknown route and 413 to a large body', async () => {
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset: vi.fn(), ...slackStubs },
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
        ...slackStubs,
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
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset, ...slackStubs },
    });
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

  it('rejects a non-finite wait timeout and clamps a long one', async () => {
    const asked: number[] = [];
    control = await startControl({
      token: TOKEN,
      routes: {
        ...slackStubs,
        wait: (body) => {
          asked.push(body.timeoutMs);
          return Promise.resolve({ status: 200, body: {} });
        },
        poll: vi.fn(),
        reset: vi.fn(),
      },
    });
    const wait = (raw: string) =>
      fetch(`${control?.url ?? ''}/wait`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: raw,
      });
    expect((await wait('{"condition":"x","timeoutMs":1e309}')).status).toBe(400);
    expect((await wait('{"condition":"x","timeoutMs":10000000}')).status).toBe(200);
    expect(asked).toEqual([MAX_WAIT_MS]);
  });

  it('drops a request whose body is still arriving when close begins', async () => {
    const reset = vi.fn(() => Promise.resolve({ status: 200, body: {} }));
    let reading: () => void = () => undefined;
    const bodyRead = new Promise<void>((resolve) => {
      reading = resolve;
    });
    control = await startControl({
      token: TOKEN,
      routes: { wait: vi.fn(), poll: vi.fn(), reset, ...slackStubs },
      onBodyRead: () => {
        reading();
      },
    });
    const url = new URL(`${control.url}/reset`);
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        host: url.host,
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': '100',
      },
    });
    const failed = new Promise<unknown>((resolve) => {
      req.on('error', resolve);
      req.on('response', (response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    req.write('{');
    // The server is inside the body read when close begins.
    await bodyRead;
    await control.close();
    expect(await failed).not.toBe(200);
    expect(reset).not.toHaveBeenCalled();
  });

  it('drops a connection whose client stops reading the answer once the flush bound passes', async () => {
    let answered: () => void = () => undefined;
    const answering = new Promise<void>((resolve) => {
      answered = resolve;
    });
    control = await startControl({
      token: TOKEN,
      routes: {
        ...slackStubs,
        wait: () => {
          answered();
          // Far larger than the socket buffers, so it cannot flush to a client that reads nothing.
          return Promise.resolve({
            status: 504,
            body: { diagnostics: 'x'.repeat(32 * 1024 * 1024) },
          });
        },
        poll: vi.fn(),
        reset: vi.fn(),
      },
    });
    const url = new URL(control.url);
    const body = JSON.stringify({ condition: 'x', timeoutMs: 1 });
    const socket = connect(Number(url.port), '127.0.0.1');
    socket.on('error', () => undefined);
    socket.pause();
    socket.write(
      [
        'POST /wait HTTP/1.1',
        `host: ${url.host}`,
        `authorization: Bearer ${TOKEN}`,
        'content-type: application/json',
        `content-length: ${String(body.length)}`,
        '',
        body,
      ].join('\r\n'),
    );
    await answering;
    const started = Date.now();
    await control.close();
    expect(Date.now() - started).toBeLessThan(4_000);
    socket.destroy();
  }, 10_000);

  it('calls the control endpoint directly and refuses a host other than 127.0.0.1', async () => {
    control = await startControl({
      token: TOKEN,
      routes: {
        ...slackStubs,
        wait: vi.fn(),
        poll: vi.fn(),
        reset: () => Promise.resolve({ status: 200, body: { ok: 1 } }),
      },
    });
    const answer = await callLocal(`${control.url}/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{}',
      timeoutMs: 5_000,
    });
    expect(answer).toEqual({ status: 200, body: '{"ok":1}\n' });
    const port = new URL(control.url).port;
    await expect(
      callLocal(`http://localhost:${port}/reset`, { method: 'POST', body: '{}', timeoutMs: 5_000 }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });
});
