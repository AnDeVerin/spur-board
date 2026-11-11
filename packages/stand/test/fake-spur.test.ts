import { AdapterError, type PollContext } from '@spur-board/contracts';
import { createFakeCore } from '@spur-board/adapters/testing';
import { SpurRejectedError } from '@spur-board/core';
import { createSpurPort } from '@spur-board/daemon/in-process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRunner, type PollFailure } from '../../adapters/src/runner/runner.ts';
import { createSpurAdapter, type SpurNotice } from '../../adapters/src/spur/spur.ts';
import { createFakeSpur, parseFakeArgs, type FakeSpur } from '../src/fake-spur.ts';

const BASE = 'http://spur.stand.invalid';
const sessionsUrl = `${BASE}/sessions`;

function createFake(): { fake: FakeSpur; lines: string[] } {
  const lines: string[] = [];
  const fake = createFakeSpur({
    baseUrl: BASE,
    now: () => Date.now(),
    log: (line) => lines.push(line),
  });
  return { fake, lines };
}

function run(fake: FakeSpur, verb: string, args: Record<string, unknown> = {}): unknown {
  const result = fake.control(verb, args);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

interface Inspected {
  instanceId: string;
  requests: { method: string; path: string }[];
  sends: { session: string; message: string }[];
}

const inspect = (fake: FakeSpur) => run(fake, 'inspect') as Inspected;

function adapterFor(fake: FakeSpur, onNotice?: (notice: SpurNotice) => void) {
  return createSpurAdapter({
    baseUrl: BASE,
    intervalMs: 1_000,
    flipSmoothingMs: 30_000,
    now: () => Date.now(),
    fetch: fake.fetch,
    onNotice,
  });
}

function context(ids: string[] = [], signal = new AbortController().signal): PollContext {
  return {
    observe: { prs: [], tickets: [], sessions: ids.map((id) => ({ kind: 'session', id })) },
    signal,
  };
}

const portFor = (fake: FakeSpur, timeoutMs?: number) =>
  createSpurPort({
    baseUrl: BASE,
    fetch: fake.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const send = (fake: FakeSpur, id: string, body: string) =>
  fake.fetch(`${sessionsUrl}/${id}/send`, { method: 'POST', body });

async function errorOf(response: Response): Promise<{ status: number; error: unknown }> {
  const body = (await response.json()) as { error?: unknown };
  return { status: response.status, error: body.error };
}

/** Lets the fake read a body and reach its failure rule. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('sessions', () => {
  it('creates a session with defaults and updates only the fields given', () => {
    const { fake } = createFake();
    expect(run(fake, 'session', { id: 's1' })).toMatchObject({
      session: { id: 's1', project: 'stand-worker', status: 'running', state: 'working' },
    });
    expect(
      run(fake, 'session', { id: 's1', state: 'waiting', project: 'other', branch: 'b1' }),
    ).toMatchObject({
      session: { status: 'running', state: 'waiting', project: 'other', branch: 'b1' },
    });
    expect(run(fake, 'session', { id: 's1', status: 'stopped' })).toMatchObject({
      session: { status: 'stopped', state: 'waiting', project: 'other', branch: 'b1' },
    });
  });

  it('starts with the sessions it was given', async () => {
    const fake = createFakeSpur({
      baseUrl: BASE,
      now: () => Date.now(),
      log: () => undefined,
      sessions: [{ id: 'seeded', project: 'stand-qa', branch: 'seed' }],
    });
    const batch = await adapterFor(fake).poll(context());
    expect(batch.items[0]?.facts).toMatchObject({
      id: 'seeded',
      spurProject: 'stand-qa',
      branch: 'seed',
      lifecycle: 'running',
      health: 'working',
    });
  });

  it.each([
    ['running', 'waiting', false, true, null],
    ['stopped', 'stale', false, true, null],
    ['errored', 'stale', false, true, null],
    ['completed', 'stale', false, false, 'complete'],
    ['killed', 'stale', false, false, 'kill'],
    ['completed', 'stale', true, true, null],
    ['killed', 'stale', true, true, null],
  ] as const)(
    'through a real adapter, %s/%s retained=%s listed=%s ends with %s',
    async (status, state, retain, listed, endReason) => {
      const { fake } = createFake();
      run(fake, 'session', { id: 's1', status, state, ...(retain ? { retain } : {}) });
      const batch = await adapterFor(fake).poll(context(['s1']));
      expect(batch.items).toHaveLength(1);
      expect(batch.items[0]?.facts).toMatchObject({ lifecycle: status, health: state, endReason });
      expect(batch.entities).toEqual([{ ref: { kind: 'session', id: 's1' }, status: 'ok' }]);
      expect(inspect(fake).requests.map(({ path }) => path)).toEqual(
        listed ? ['/sessions'] : ['/sessions', '/sessions/s1'],
      );
      expect(fake.violations().total).toBe(0);
    },
  );

  it('reports an unknown session as not_found', async () => {
    const { fake } = createFake();
    const batch = await adapterFor(fake).poll(context(['gone']));
    expect(batch.items).toEqual([]);
    expect(batch.entities).toEqual([{ ref: { kind: 'session', id: 'gone' }, status: 'not_found' }]);
    expect(fake.violations().total).toBe(0);
  });

  it('changes the instance id on restart, which a real adapter reports', async () => {
    const { fake } = createFake();
    const notices: SpurNotice[] = [];
    const adapter = adapterFor(fake, (notice) => notices.push(notice));
    await adapter.poll(context());
    const before = inspect(fake).instanceId;
    await adapter.poll(context());
    expect(notices).toEqual([]);
    expect(run(fake, 'restart')).not.toEqual({ instanceId: before });
    await adapter.poll(context());
    expect(notices).toEqual([
      { kind: 'restart', previousInstanceId: before, instanceId: inspect(fake).instanceId },
    ]);
  });
});

describe('send by status', () => {
  it.each(['running', 'stopped', 'budget_limited', 'paused', 'spawning'])(
    'accepts a send to a %s session',
    async (status) => {
      const { fake } = createFake();
      run(fake, 'session', { id: 's1', status });
      await portFor(fake).send('s1', 'ping');
      expect(inspect(fake).sends).toMatchObject([{ session: 's1', message: 'ping' }]);
      expect(fake.violations().total).toBe(0);
    },
  );

  it.each(['errored', 'completed', 'killed'])(
    'refuses a send to a %s session as retryable',
    async (status) => {
      const { fake } = createFake();
      run(fake, 'session', { id: 's1', status });
      const sent = portFor(fake).send('s1', 'ping');
      await expect(sent).rejects.toThrow(
        `Spur send failed with HTTP 409: Session has ended (${status}): s1`,
      );
      await expect(sent).rejects.not.toBeInstanceOf(SpurRejectedError);
      expect(inspect(fake).sends).toEqual([]);
      expect(fake.violations().total).toBe(0);
    },
  );

  it('rejects a send to an unknown session for good', async () => {
    const { fake } = createFake();
    const sent = portFor(fake).send('nope', 'ping');
    await expect(sent).rejects.toBeInstanceOf(SpurRejectedError);
    await expect(sent).rejects.toThrow('Session not found: nope');
    expect(fake.violations().total).toBe(0);
  });

  it('answers 500 for a status Spur does not define', async () => {
    const { fake } = createFake();
    run(fake, 'session', { id: 's1', status: 'future' });
    expect(await errorOf(await send(fake, 's1', '{"message":"x"}'))).toEqual({
      status: 500,
      error: 'Unknown session status future: s1',
    });
    expect(fake.violations().total).toBe(0);
  });
});

describe('failure modes', () => {
  it('answers a delayed request only after the delay', async () => {
    vi.useFakeTimers();
    const { fake } = createFake();
    run(fake, 'fail', { mode: 'delay', ms: 1_000 });
    let answered = false;
    const pending = fake.fetch(sessionsUrl).then((response) => {
      answered = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a delayed request on abort and clears its timer', async () => {
    vi.useFakeTimers();
    const { fake } = createFake();
    run(fake, 'fail', { mode: 'delay', ms: 1_000 });
    const abort = new AbortController();
    const pending = fake.fetch(sessionsUrl, { signal: abort.signal });
    const outcome = expect(pending).rejects.toBe('stop');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort('stop');
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a refusal as a transient poll failure and an unreachable API', async () => {
    const { fake } = createFake();
    run(fake, 'fail', { mode: 'refuse' });
    const error: unknown = await adapterFor(fake)
      .poll(context())
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ kind: 'transient', message: 'Spur request failed' });
    await expect(portFor(fake).send('s1', 'ping')).rejects.toThrow('Spur API unreachable');
  });

  it('times a hung send out on its own signal', async () => {
    const { fake } = createFake();
    run(fake, 'fail', { mode: 'hang' });
    await expect(portFor(fake, 200).send('s1', 'ping')).rejects.toThrow('Spur send timed out');
  });

  it('ends a hung poll on abort', async () => {
    const { fake } = createFake();
    run(fake, 'fail', { mode: 'hang' });
    const abort = new AbortController();
    const polled = adapterFor(fake).poll(context([], abort.signal));
    const outcome = expect(polled).rejects.toThrow('Spur poll aborted');
    await settled();
    abort.abort();
    await outcome;
  });

  it.each([
    ['hang', { mode: 'hang' }],
    ['delay', { mode: 'delay', ms: 60_000 }],
  ])('close releases a signal-less %s and leaves no timer', async (_name, rule) => {
    vi.useFakeTimers();
    const { fake } = createFake();
    run(fake, 'fail', rule);
    const pending = fake.fetch(sessionsUrl);
    const outcome = expect(pending).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(1);
    fake.close();
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects later requests after close without logging them', async () => {
    const { fake } = createFake();
    fake.close();
    await expect(fake.fetch(`${BASE}/nope`)).rejects.toThrow('fetch failed');
    expect(fake.violations().total).toBe(0);
    expect(inspect(fake).requests).toEqual([]);
  });

  it('surfaces a 5xx as a transient poll failure and a retryable send error', async () => {
    const { fake } = createFake();
    run(fake, 'fail', { mode: '5xx' });
    const error: unknown = await adapterFor(fake)
      .poll(context())
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ kind: 'transient', message: 'HTTP 503' });
    const sent = portFor(fake).send('s1', 'ping');
    await expect(sent).rejects.toThrow('Spur send failed with HTTP 503');
    await expect(sent).rejects.not.toBeInstanceOf(SpurRejectedError);
  });

  it('keeps a rule until clear, and a later rule replaces it per route', async () => {
    const { fake } = createFake();
    run(fake, 'session', { id: 's1' });
    run(fake, 'fail', { mode: 'refuse', route: 'list' });
    for (let i = 0; i < 3; i += 1) await expect(fake.fetch(sessionsUrl)).rejects.toThrow();
    expect((await fake.fetch(`${sessionsUrl}/s1`)).status).toBe(200);

    run(fake, 'fail', { mode: '5xx', route: 'list', status: 502 });
    expect((await fake.fetch(sessionsUrl)).status).toBe(502);

    run(fake, 'fail', { mode: 'hang' });
    run(fake, 'fail', { mode: 'refuse', route: 'send' });
    let listAnswered = false;
    const list = fake.fetch(sessionsUrl).finally(() => {
      listAnswered = true;
    });
    const released = expect(list).rejects.toThrow('fetch failed');
    await expect(send(fake, 's1', '{"message":"x"}')).rejects.toThrow('fetch failed');
    await settled();
    expect(listAnswered).toBe(false);

    run(fake, 'clear');
    expect((await fake.fetch(`${sessionsUrl}/s1`)).status).toBe(200);
    expect((await fake.fetch(sessionsUrl)).status).toBe(200);
    expect((await send(fake, 's1', '{"message":"x"}')).status).toBe(200);
    fake.close();
    await released;
  });

  it('leaves rules alone on session and restart', async () => {
    const { fake } = createFake();
    run(fake, 'fail', { mode: '5xx', route: 'list' });
    run(fake, 'session', { id: 's1' });
    run(fake, 'restart');
    expect((await fake.fetch(sessionsUrl)).status).toBe(503);
  });
});

describe('violations', () => {
  it.each([
    ['a wrong method', `${BASE}/sessions`, { method: 'POST' }, 'POST /sessions'],
    ['an unmodeled path', `${BASE}/projects`, {}, 'GET /projects'],
    ['a longer session path', `${BASE}/sessions/s1/logs`, {}, 'GET /sessions/s1/logs'],
    ['a path under a prefix', `${BASE}/drift/sessions`, {}, 'GET /drift/sessions'],
  ])('logs %s and answers 404 Route not found', async (_name, url, init, route) => {
    const { fake, lines } = createFake();
    run(fake, 'fail', { mode: 'refuse' });
    expect(await errorOf(await fake.fetch(url, init))).toEqual({
      status: 404,
      error: `Route not found: ${route}`,
    });
    expect(fake.violations()).toMatchObject({ total: 1, items: [{ reason: 'route' }] });
    expect(lines).toHaveLength(1);
    expect(inspect(fake).requests).toEqual([]);
  });

  it('logs a query string and answers as if it were absent', async () => {
    const { fake } = createFake();
    run(fake, 'session', { id: 's1' });
    const response = await fake.fetch(`${sessionsUrl}?includeCompleted=true`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 's1' }]);
    expect(fake.violations()).toMatchObject({
      total: 1,
      items: [{ reason: 'query', path: '/sessions?includeCompleted=true' }],
    });
  });

  it('logs a body on a GET and answers normally', async () => {
    const { fake } = createFake();
    const response = await fake.fetch(sessionsUrl, { method: 'GET', body: 'surprise' });
    expect(response.status).toBe(200);
    expect(fake.violations()).toMatchObject({
      total: 1,
      items: [{ reason: 'body', body: 'surprise' }],
    });
  });

  it.each([
    ['non-JSON', 's1', 'not json', 400, 'Invalid JSON in request body'],
    ['an empty body', 's1', '', 500, 'message or attachments required'],
    ['no message', 's1', '{}', 500, 'message or attachments required'],
    ['a blank message', 's1', '{"message":"  "}', 500, 'message or attachments required'],
    ['a non-string message', 's1', '{"message":1}', 500, 'message or attachments required'],
    ['an unknown session and no message', 'nope', '{}', 404, 'Session not found: nope'],
    ['an unknown session and non-JSON', 'nope', '{', 400, 'Invalid JSON in request body'],
  ])('logs %s and answers as Spur does', async (_name, id, body, status, error) => {
    const { fake } = createFake();
    run(fake, 'session', { id: 's1' });
    expect(await errorOf(await send(fake, id, body))).toEqual({ status, error });
    expect(fake.violations()).toMatchObject({ total: 1, items: [{ reason: 'body' }] });
    expect(inspect(fake).sends).toEqual([]);
  });

  it('logs an extra field and still accepts the send', async () => {
    const { fake } = createFake();
    run(fake, 'session', { id: 's1' });
    const response = await send(fake, 's1', '{"message":"x","queue":false}');
    expect(response.status).toBe(200);
    expect(inspect(fake).sends).toMatchObject([{ session: 's1', message: 'x' }]);
    expect(fake.violations()).toMatchObject({ total: 1, items: [{ reason: 'body' }] });
  });

  it('keeps the first 100 violations, the total, and cuts bodies', async () => {
    const { fake, lines } = createFake();
    for (let i = 0; i < 105; i += 1)
      await fake.fetch(`${BASE}/nope/${String(i)}`, { method: 'POST', body: 'x'.repeat(300) });
    const { total, items } = fake.violations();
    expect(total).toBe(105);
    expect(items).toHaveLength(100);
    expect(items[0]).toMatchObject({ path: '/nope/0', body: 'x'.repeat(200) });
    expect(lines).toHaveLength(105);
  });

  it('keeps the last 500 requests', async () => {
    const { fake } = createFake();
    for (let i = 0; i < 505; i += 1) await fake.fetch(`${sessionsUrl}/s${String(i)}`);
    const { requests } = inspect(fake);
    expect(requests).toHaveLength(500);
    expect(requests[0]?.path).toBe('/sessions/s5');
  });

  it('a real runner retries a drifted route as transient while the log stays non-empty', async () => {
    vi.useFakeTimers();
    const { fake } = createFake();
    const failures: PollFailure[] = [];
    const core = createFakeCore();
    const runner = startRunner({
      entries: [
        {
          adapter: createSpurAdapter({
            baseUrl: `${BASE}/drift`,
            intervalMs: 1_000,
            flipSmoothingMs: 30_000,
            now: () => Date.now(),
            fetch: fake.fetch,
          }),
        },
      ],
      core,
      config: {
        sources: { authRetryMs: 900_000, goneAfterPolls: 3 },
        thresholds: { staleMultiplier: 1_000, blockOpenMs: 86_400_000 },
      },
      now: () => Date.now(),
      onFailure: (failure) => failures.push(failure),
    });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(failures.length).toBeGreaterThanOrEqual(2);
      for (const failure of failures)
        expect(failure).toMatchObject({ step: 'poll', kind: 'transient' });
      expect(core.observed).toEqual([]);
      expect(fake.violations().total).toBe(failures.length);
    } finally {
      await runner.stop();
    }
  });
});

describe('control verbs', () => {
  it.each([
    ['an unknown verb', 'nope', {}],
    ['a session without an id', 'session', {}],
    ['an unknown field', 'restart', { force: true }],
    ['delay without ms', 'fail', { mode: 'delay' }],
    ['delay of 0 ms', 'fail', { mode: 'delay', ms: 0 }],
    ['delay over the bound', 'fail', { mode: 'delay', ms: 60_001 }],
    ['a fractional delay', 'fail', { mode: 'delay', ms: 1.5 }],
    ['a status that is not 5xx', 'fail', { mode: '5xx', status: 404 }],
    ['an unknown mode', 'fail', { mode: 'explode' }],
    ['an unknown route', 'fail', { mode: 'hang', route: 'nope' }],
  ])('answers 400 to %s', (_name, verb, args) => {
    const { fake } = createFake();
    expect(fake.control(verb, args).status).toBe(400);
  });
});

describe('parseFakeArgs', () => {
  it.each([
    [['spur', 'session', 's1'], 'session', { id: 's1' }],
    [
      [
        'spur',
        'session',
        's1',
        '--state',
        'stale',
        '--status',
        'stopped',
        '--project',
        'p',
        '--branch',
        'b',
        '--retain',
      ],
      'session',
      { id: 's1', state: 'stale', status: 'stopped', project: 'p', branch: 'b', retain: true },
    ],
    [['spur', 'restart'], 'restart', {}],
    [['spur', 'clear'], 'clear', {}],
    [['spur', 'inspect'], 'inspect', {}],
    [['spur', 'fail', 'hang'], 'fail', { mode: 'hang', route: 'all' }],
    [['spur', 'fail', 'refuse', '--route', 'send'], 'fail', { mode: 'refuse', route: 'send' }],
    [
      ['spur', 'fail', 'delay', '--ms', '250', '--route', 'list'],
      'fail',
      { mode: 'delay', route: 'list', ms: 250 },
    ],
    [['spur', 'fail', '5xx'], 'fail', { mode: '5xx', route: 'all', status: 503 }],
    [
      ['spur', 'fail', '5xx', '--status', '502'],
      'fail',
      { mode: '5xx', route: 'all', status: 502 },
    ],
  ])('parses %j', (rest, verb, args) => {
    expect(parseFakeArgs(rest)).toEqual({ ok: true, value: { system: 'spur', verb, args } });
  });

  it.each([
    [[]],
    [['github', 'session', 's1']],
    [['spur']],
    [['spur', 'nope']],
    [['spur', 'session']],
    [['spur', 'session', 'a', 'b']],
    [['spur', 'restart', 'extra']],
    [['spur', 'restart', '--route', 'list']],
    [['spur', 'session', 's1', '--ms', '1']],
    [['spur', 'session', 's1', '--unknown']],
    [['spur', 'session', 's1', '--state', '']],
    [['spur', 'fail']],
    [['spur', 'fail', 'explode']],
    [['spur', 'fail', 'delay']],
    [['spur', 'fail', 'delay', '--ms', '1e3']],
    [['spur', 'fail', 'delay', '--ms', '0']],
    [['spur', 'fail', 'delay', '--ms', '60001']],
    [['spur', 'fail', 'hang', '--ms', '5']],
    [['spur', 'fail', 'refuse', '--status', '503']],
    [['spur', 'fail', '5xx', '--status', '404']],
    [['spur', 'fail', 'hang', '--route', 'nope']],
  ])('refuses %j', (rest) => {
    expect(parseFakeArgs(rest).ok).toBe(false);
  });
});
