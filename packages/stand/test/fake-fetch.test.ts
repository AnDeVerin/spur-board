import { AdapterError } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBody } from '../src/cli.ts';
import {
  createFakes,
  FakeViolation,
  type FakeModule,
  type FakeRequest,
} from '../src/fakes/fetch.ts';
import { createGithubPrFake } from '../src/fakes/github-pr.ts';
import {
  BOARD,
  fakeFetch,
  githubFakes,
  GRAPHQL,
  NOW,
  pollContext,
  pollRepo,
  postQuery,
  violations,
} from './fake-helpers.ts';

const REST = 'https://api.github.com/repos/stand-org/board/issues';
const BAD_QUERY = 'query Unknown { nothing }';

afterEach(() => {
  vi.useRealTimers();
});

function failWith(fakes: ReturnType<typeof githubFakes>, failure: Record<string, unknown>): void {
  expect(fakes.control({ system: 'github', verb: 'fail', args: failure }).status).toBe(200);
}

const pendingAfterTurns = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  promise.then(mark, mark);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  return !settled;
};

describe('fake fetch', () => {
  function withRest() {
    const seen: FakeRequest[] = [];
    const reset = vi.fn();
    const rest: FakeModule = {
      system: 'github',
      claims: (url) => url.pathname.startsWith('/repos/'),
      prepare(request) {
        seen.push(request);
        if (request.method !== 'GET') throw new FakeViolation('REST module takes GET.');
        return () => ({ status: 200, body: { from: 'rest' } });
      },
      control: (verb) => (verb === 'rest' ? { status: 200, body: { rest: true } } : undefined),
      reset,
    };
    const fakes = createFakes({
      now: () => NOW,
      modules: [(now) => createGithubPrFake({ now, repos: [BOARD] }), () => rest],
    });
    return { fakes, reset, seen };
  }

  it('routes another URL on the same host to its module, sharing the log and failure plan', async () => {
    const { fakes, reset, seen } = withRest();
    const fetcher = fakeFetch(fakes);

    const answered = await fetcher(REST);
    expect(await answered.json()).toEqual({ from: 'rest' });
    expect(seen).toHaveLength(1);
    expect(fakes.control({ system: 'github', verb: 'rest', args: {} }).status).toBe(200);

    expect((await fetcher(REST, { method: 'POST' })).status).toBe(400);
    expect((await postQuery(fetcher, BAD_QUERY, {})).status).toBe(400);
    expect(violations(fakes)).toHaveLength(2);

    failWith(fakes, { mode: 'server-error', status: 503 });
    expect((await fetcher(REST)).status).toBe(503);

    fakes.reset();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(violations(fakes)).toEqual([]);
    expect((await fetcher(REST)).status).toBe(200);
  });

  it('reads a string, a URL and a Request alike', async () => {
    const { fakes, seen } = withRest();
    const fetcher = fakeFetch(fakes);
    await fetcher(REST, { headers: { 'x-a': '1' } });
    await fetcher(new URL(REST));
    await fetcher(new Request(REST, { headers: { 'x-a': '2' } }));
    expect(seen.map((request) => request.url.href)).toEqual([REST, REST, REST]);
    expect(seen.map((request) => request.headers.get('x-a'))).toEqual(['1', null, '2']);
    const posted = new Request(GRAPHQL, { method: 'POST', body: '{"query":"query {"}' });
    expect((await fetcher(posted)).status).toBe(400);
    expect(violations(fakes)[0]?.reason).toContain('syntax error');
  });

  it('passes an unclaimed request to the wrapped fetch untouched', async () => {
    const fakes = githubFakes();
    const fallback = vi.fn<typeof fetch>(() => Promise.resolve(new Response('real')));
    const init = { method: 'GET' };
    const response = await fakes.wrap(fallback)(REST, init);
    expect(await response.text()).toBe('real');
    expect(fallback).toHaveBeenCalledWith(REST, init);
    expect(violations(fakes)).toEqual([]);
  });

  it('reports an empty log, then the entries and their total', async () => {
    const fakes = githubFakes();
    expect(fakes.violations()).toEqual({ total: 0, items: [] });
    await postQuery(fakeFetch(fakes), BAD_QUERY, {});
    expect(fakes.violations()).toMatchObject({
      total: 1,
      items: [{ system: 'github', method: 'POST', url: GRAPHQL }],
    });
  });

  it('caps the log at 100 and counts what it drops', async () => {
    const fakes = githubFakes();
    const fetcher = fakeFetch(fakes);
    for (let i = 0; i < 103; i += 1) await postQuery(fetcher, BAD_QUERY, {});
    expect(violations(fakes)).toHaveLength(100);
    expect(fakes.violations().total).toBe(103);
  });

  it('never stores the Authorization header in the log', async () => {
    const fakes = githubFakes();
    const marker = 'secret-marker-value';
    await postQuery(
      fakeFetch(fakes),
      BAD_QUERY,
      {},
      {
        headers: { Authorization: `Bearer ${marker}` },
      },
    );
    const text = JSON.stringify(fakes.violations());
    expect(violations(fakes)).toHaveLength(1);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toContain(marker);
  });

  it('refuses an unknown system, verb and malformed failure', () => {
    const fakes = githubFakes();
    expect(fakes.control({ system: 'nope', verb: 'fail', args: {} }).status).toBe(400);
    expect(fakes.control({ system: 'github', verb: 'nope', args: {} }).status).toBe(400);
    expect(fakes.control({ system: 'github', verb: 'fail', args: { mode: 'nope' } }).status).toBe(
      400,
    );
  });
});

describe('failure modes through the real adapter', () => {
  it('delay answers after its time', async () => {
    vi.useFakeTimers();
    const fakes = githubFakes();
    failWith(fakes, { mode: 'delay', ms: 5_000 });
    const poll = pollRepo(fakes, BOARD);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await pendingAfterTurns(poll)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll).resolves.toMatchObject({ complete: true });
  });

  it('refuse is transient', async () => {
    const fakes = githubFakes();
    failWith(fakes, { mode: 'refuse' });
    await expect(pollRepo(fakes, BOARD)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('hang stays pending until abort, then rejects as an abort', async () => {
    const fakes = githubFakes();
    failWith(fakes, { mode: 'hang' });
    const controller = new AbortController();
    const poll = pollRepo(fakes, BOARD, pollContext({ signal: controller.signal }));
    expect(await pendingAfterTurns(poll)).toBe(true);
    const reason = new DOMException('stopped', 'AbortError');
    controller.abort(reason);
    const error: unknown = await poll.catch((err: unknown) => err);
    expect(error).toBe(reason);
    expect(error).not.toBeInstanceOf(AdapterError);
  });

  it('rate-limit is throttled with retryAt from Retry-After', async () => {
    const fakes = githubFakes();
    failWith(fakes, { mode: 'rate-limit', seconds: 30 });
    const error: unknown = await pollRepo(fakes, BOARD).catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: 'throttled', retryAt: new Date(NOW + 30_000) });
  });

  it.each([
    [undefined, 500],
    [503, 503],
  ])('server-error %s is transient at status %s', async (status, expected) => {
    const fakes = githubFakes();
    failWith(fakes, { mode: 'server-error', ...(status === undefined ? {} : { status }) });
    const error: unknown = await pollRepo(fakes, BOARD).catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: 'transient', message: `HTTP ${String(expected)}` });
  });

  it('clear restores answers for later requests and leaves a held request held', async () => {
    const fakes = githubFakes();
    failWith(fakes, { mode: 'hang' });
    const controller = new AbortController();
    const held = pollRepo(fakes, BOARD, pollContext({ signal: controller.signal }));
    expect(await pendingAfterTurns(held)).toBe(true);
    failWith(fakes, { mode: 'clear' });
    await expect(pollRepo(fakes, BOARD)).resolves.toMatchObject({ complete: true });
    expect(await pendingAfterTurns(held)).toBe(true);
    controller.abort();
    await expect(held).rejects.toBeDefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['delay', { mode: 'delay', ms: 600_000 }],
    ['refuse', { mode: 'refuse' }],
    ['hang', { mode: 'hang' }],
    ['rate-limit', { mode: 'rate-limit', seconds: 30 }],
    ['server-error', { mode: 'server-error' }],
  ])('%s never hides a violation', async (_name, failure) => {
    vi.useFakeTimers();
    const fakes = githubFakes();
    failWith(fakes, failure);
    const response = await postQuery(fakeFetch(fakes), BAD_QUERY, {});
    expect(response.status).toBe(400);
    expect(violations(fakes)).toHaveLength(1);
  });
});

describe('release', () => {
  const VALID = 'query PrDetails($owner: String!, $repo: String!) { rateLimit { remaining } }';

  it.each<[string, Record<string, unknown>]>([
    ['hang', { mode: 'hang' }],
    ['delay', { mode: 'delay', ms: 600_000 }],
  ])(
    'rejects a held %s request, later requests at once, and survives reset',
    async (_name, failure) => {
      const fakes = githubFakes();
      failWith(fakes, failure);
      const held = pollRepo(fakes, BOARD);
      expect(await pendingAfterTurns(held)).toBe(true);

      fakes.release();
      await expect(held).rejects.toMatchObject({ kind: 'transient' });
      // A poll queued behind the release: the plan still says hang, and it must not hold.
      await expect(pollRepo(fakes, BOARD)).rejects.toMatchObject({ kind: 'transient' });

      fakes.reset();
      failWith(fakes, failure);
      await expect(pollRepo(fakes, BOARD)).rejects.toMatchObject({ kind: 'transient' });
      await expect(postQuery(fakeFetch(fakes), VALID)).rejects.toThrow('stopping');
    },
  );

  it('still passes an unclaimed request through', async () => {
    const fakes = githubFakes();
    fakes.release();
    const fallback = vi.fn<typeof fetch>(() => Promise.resolve(new Response('real')));
    expect(await (await fakes.wrap(fallback)(REST)).text()).toBe('real');
  });
});

describe('fakeBody', () => {
  const target = { repo: BOARD, number: 7 };
  const pr = (verb: string, args: Record<string, unknown> = {}) => ({
    system: 'github',
    verb,
    args: { ...target, ...args },
  });
  const fail = (args: Record<string, unknown>) => ({ system: 'github', verb: 'fail', args });
  const SHA = 'b'.repeat(40);

  it.each<[string[], Record<string, string>, Record<string, unknown>]>([
    [['github', 'fail', 'delay', '250'], {}, fail({ mode: 'delay', ms: 250 })],
    [['github', 'fail', 'refuse'], {}, fail({ mode: 'refuse' })],
    [['github', 'fail', 'hang'], {}, fail({ mode: 'hang' })],
    [['github', 'fail', 'rate-limit', '30'], {}, fail({ mode: 'rate-limit', seconds: 30 })],
    [['github', 'fail', 'server-error'], {}, fail({ mode: 'server-error' })],
    [['github', 'fail', 'server-error', '503'], {}, fail({ mode: 'server-error', status: 503 })],
    [['github', 'fail', 'clear'], {}, fail({ mode: 'clear' })],
    [['github', 'pr', '7', 'create'], {}, pr('create')],
    [
      ['github', 'pr', '7', 'create'],
      { repo: 'stand-org/service', seed: '{"title":"t"}' },
      pr('create', { repo: 'stand-org/service', seed: { title: 't' } }),
    ],
    [['github', 'pr', '7', 'approve'], {}, pr('approve')],
    [['github', 'pr', '7', 'ci-red'], {}, pr('ci-red')],
    [['github', 'pr', '7', 'ci-green'], {}, pr('ci-green')],
    [['github', 'pr', '7', 'merge'], {}, pr('merge')],
    [['github', 'pr', '7', 'conflict'], {}, pr('conflict')],
    [['github', 'pr', '7', 'push', SHA], {}, pr('push', { sha: SHA })],
  ])('maps %j %j', (positionals, values, expected) => {
    expect(fakeBody(positionals, values)).toEqual(expected);
  });

  it.each<[string[], Record<string, string>?]>([
    [[]],
    [['nope']],
    [['violations']],
    [['github']],
    [['github', 'fail']],
    [['github', 'fail', 'nope']],
    [['github', 'fail', 'delay']],
    [['github', 'fail', 'delay', 'soon']],
    [['github', 'fail', 'delay', '1', '2']],
    [['github', 'fail', 'rate-limit']],
    [['github', 'fail', 'refuse', '1']],
    [['github', 'fail', 'hang', '1']],
    [['github', 'fail', 'clear', '1']],
    [['github', 'fail', 'server-error', '500', '1']],
    [['github', 'fail', 'hang'], { seed: '{}' }],
    [['github', 'pr']],
    [['github', 'pr', 'x', 'create']],
    [['github', 'pr', '7']],
    [['github', 'pr', '7', 'nope']],
    [['github', 'pr', '7', 'create', 'extra']],
    [['github', 'pr', '7', 'push']],
    [['github', 'pr', '7', 'push', SHA, 'extra']],
    [['github', 'pr', '7', 'approve'], { seed: '{}' }],
    [['github', 'pr', '7', 'create'], { seed: 'not json' }],
  ])('rejects %j %j', (positionals, values = {}) => {
    expect(() => fakeBody(positionals, values)).toThrow();
  });
});
