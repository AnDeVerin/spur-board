import { readFileSync } from 'node:fs';
import {
  AdapterError,
  type Batch,
  configSchema,
  type PollContext,
  type PrEntityRef,
  type SessionEntityRef,
  sourceCursorSchema,
  type TicketEntityRef,
} from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as entry from '../../src/index.ts';
import { classifyHttpFailure } from '../../src/runner/http.ts';
import { type AdapterRunner, type SourceState, startRunner } from '../../src/runner/runner.ts';
import {
  createFakeAdapter,
  createFakeCore,
  type FakeAdapter,
  type FakeCore,
  type FakeCoreOptions,
} from '../../src/testing.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const I = 60_000;
const sha = 'b'.repeat(40);
const defaults = {
  sources: { authRetryMs: 900_000, goneAfterPolls: 3 },
  thresholds: { staleMultiplier: 3 },
};

const pr: PrEntityRef = { kind: 'pr', repo: 'acme/web', number: 42 };
const ticket: TicketEntityRef = { kind: 'ticket', trackerId: 'web', id: '10042', key: 'PROJ-1' };
const session: SessionEntityRef = { kind: 'session', id: 'demo-worker-1' };

const prItem: Batch['items'][number] = {
  kind: 'pr',
  facts: {
    repo: 'acme/web',
    number: 42,
    url: 'https://github.com/acme/web/pull/42',
    title: 'PROJ-1 Add the login page',
    author: 'octocat',
    headSha: sha,
    headBranch: 'PROJ-1-login-page',
    state: 'open',
    draft: false,
    mergeable: 'unknown',
    mergeState: 'unknown',
    requiredChecks: [],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: ['PROJ-1'],
    updatedAt: '2025-12-31T11:00:00Z',
  },
};

function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

function elapsed(): number {
  return Date.now() - T0;
}

async function advanceTo(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms - elapsed());
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    source: 'github',
    observedAt: at(0),
    complete: true,
    items: [],
    entities: [],
    ...overrides,
  };
}

const prOk = (overrides: Partial<Batch> = {}) =>
  batch({ items: [prItem], entities: [{ ref: pr, status: 'ok' }], ...overrides });
const prNotFound = (overrides: Partial<Batch> = {}) =>
  batch({ entities: [{ ref: pr, status: 'not_found' }], ...overrides });

function context(observe: Partial<PollContext['observe']> = {}): Omit<PollContext, 'signal'> {
  return { observe: { prs: [], tickets: [], sessions: [], ...observe } };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A poll that only ends when its signal aborts, as an adapter honouring A7 does. */
function hang(ctx: PollContext): Promise<Batch> {
  return new Promise((_, reject) => {
    ctx.signal.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });
}

function random(value: number): void {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

const runners: AdapterRunner[] = [];

interface Started {
  core: FakeCore;
  adapter: FakeAdapter;
  runner: AdapterRunner;
  /** Elapsed ms at each poll start. */
  starts: number[];
  /** The last reported state. */
  last: () => SourceState | undefined;
}

function start(
  poll: (ctx: PollContext, n: number) => Promise<Batch>,
  options: {
    core?: FakeCoreOptions;
    reserveRemaining?: number;
    config?: typeof defaults;
  } = {},
): Started {
  const core = createFakeCore(options.core);
  const starts: number[] = [];
  const adapter = createFakeAdapter({
    id: 'github',
    intervalMs: I,
    poll: (ctx) => {
      starts.push(elapsed());
      return poll(ctx, starts.length - 1);
    },
  });
  const runner = startRunner({
    entries: [{ adapter, reserveRemaining: options.reserveRemaining }],
    core,
    config: options.config ?? defaults,
  });
  runners.push(runner);
  return { core, adapter, runner, starts, last: () => core.states.at(-1)?.state };
}

function gaps(starts: readonly number[]): number[] {
  return starts.slice(1).map((value, index) => value - (starts[index] ?? 0));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startAdapters', () => {
  it('exports only startAdapters and the test fakes', () => {
    expect(Object.keys(entry)).toEqual(['startAdapters']);
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    expect(Object.keys(manifest.exports)).toEqual(['.', './testing']);
  });

  it('starts with no adapters and stops cleanly', async () => {
    const config = configSchema.parse({
      projects: [
        {
          id: 'web',
          tracker: {
            type: 'jira',
            baseUrl: 'https://example.atlassian.net',
            jql: 'project = PROJ',
            doneStatuses: ['Done'],
            readyStatuses: ['Ready for Dev'],
          },
          repos: ['example-org/web'],
          operatorGithubLogin: 'octocat',
        },
      ],
      operator: { slack: 'U0000000000' },
      digest: { tz: 'Europe/Berlin' },
    });
    const core = { context: vi.fn(), observe: vi.fn(), reportSourceState: vi.fn() };
    const runner = entry.startAdapters(config, core);
    await vi.advanceTimersByTimeAsync(10 * I);
    await expect(runner.stop()).resolves.toBeUndefined();
    expect(core.context).not.toHaveBeenCalled();
    expect(core.observe).not.toHaveBeenCalled();
    expect(core.reportSourceState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('schedule', () => {
  it('polls at start and every intervalMs', async () => {
    random(0);
    const { starts } = start(() => Promise.resolve(batch()));
    await advanceTo(3 * I);
    expect(starts).toEqual([0, I, 2 * I, 3 * I]);
  });

  it('never starts a poll while the previous one is pending', async () => {
    random(0);
    const first = deferred<Batch>();
    const { starts } = start((_, n) => (n === 0 ? first.promise : Promise.resolve(batch())));
    await advanceTo(10 * I);
    expect(starts).toEqual([0]);
    first.resolve(batch());
    await advanceTo(11 * I - 1);
    expect(starts).toEqual([0]);
    await advanceTo(11 * I);
    expect(starts).toEqual([0, 11 * I]);
  });

  it('jitter shortens the interval by at most 10 percent', async () => {
    random(0.999);
    const { starts } = start(() => Promise.resolve(batch()));
    await advanceTo(3 * I);
    expect(gaps(starts)).toEqual([54_006, 54_006, 54_006]);
    for (const gap of gaps(starts)) {
      expect(gap).toBeGreaterThanOrEqual(0.9 * I);
      expect(gap).toBeLessThan(I);
    }
  });

  it('gives each poll its own signal', async () => {
    random(0);
    const { adapter } = start(() => Promise.resolve(batch()));
    await advanceTo(I);
    const [first, second] = adapter.contexts;
    expect(first?.signal).toBeInstanceOf(AbortSignal);
    expect(second?.signal).toBeInstanceOf(AbortSignal);
    expect(first?.signal).not.toBe(second?.signal);
  });

  it('passes core context and cursor through and sends the batch to core.observe', async () => {
    const cursor = sourceCursorSchema.parse('cursor-1');
    const next = sourceCursorSchema.parse('cursor-2');
    const returned = prOk({ cursor: next });
    const { core, adapter } = start(() => Promise.resolve(returned), {
      core: { context: () => ({ ...context({ prs: [pr] }), cursor }) },
    });
    await flush();
    expect(adapter.contexts[0]?.observe).toEqual({ prs: [pr], tickets: [], sessions: [] });
    expect(adapter.contexts[0]?.cursor).toBe(cursor);
    expect(core.observed).toEqual([
      { source: 'github', batch: { ...returned, observedAt: at(0) } },
    ]);
    expect(core.observed[0]?.batch.cursor).toBe(next);
  });

  it('sets observedAt to the poll start', async () => {
    random(0);
    const { core } = start((_, n) =>
      n === 0
        ? Promise.resolve(batch())
        : new Promise((resolve) =>
            setTimeout(() => {
              resolve(batch({ observedAt: '2020-01-01T00:00:00.000Z' }));
            }, 5000),
          ),
    );
    await advanceTo(I + 5000);
    expect(core.observed.map((call) => call.batch.observedAt)).toEqual([at(0), at(I)]);
  });
});

describe('failures', () => {
  it('backs off x2 up to 15 min and resets on success', async () => {
    random(0);
    const { starts } = start((_, n) =>
      n < 5 ? Promise.reject(new AdapterError('transient', 'down')) : Promise.resolve(batch()),
    );
    await advanceTo(3000 * 1000);
    expect(gaps(starts).slice(0, 6)).toEqual([120_000, 240_000, 480_000, 900_000, 900_000, 60_000]);
  });

  it('treats a plain rejection as transient', async () => {
    random(0);
    const { starts } = start((_, n) =>
      n < 2 ? Promise.reject(new Error('boom')) : Promise.resolve(batch()),
    );
    await advanceTo(10 * I);
    expect(gaps(starts).slice(0, 3)).toEqual([2 * I, 4 * I, I]);
  });

  it('backs off when core.observe rejects', async () => {
    random(0);
    let calls = 0;
    const { starts, core } = start(() => Promise.resolve(batch()), {
      core: {
        observe: () => {
          calls += 1;
          if (calls === 1) throw new Error('core down');
        },
      },
    });
    await advanceTo(3 * I);
    expect(gaps(starts)).toEqual([2 * I, I]);
    expect(core.states[0]?.state).toEqual({ gone: [] });
  });
});

describe('http failure classification', () => {
  const now = T0;
  const epochSeconds = (ms: number) => String((now + ms) / 1000);

  it.each([
    ['429 Retry-After seconds', 429, { 'retry-after': '30' }, '', 'throttled', now + 30_000],
    [
      '429 Retry-After HTTP-date',
      429,
      { 'retry-after': 'Thu, 01 Jan 2026 00:05:00 GMT' },
      '',
      'throttled',
      now + 300_000,
    ],
    [
      '429 X-RateLimit-Reset epoch seconds',
      429,
      { 'x-ratelimit-reset': epochSeconds(120_000) },
      '',
      'throttled',
      now + 120_000,
    ],
    [
      '429 X-RateLimit-Reset ISO',
      429,
      { 'x-ratelimit-reset': '2026-01-01T00:02:00Z' },
      '',
      'throttled',
      now + 120_000,
    ],
    ['429 invalid reset', 429, { 'x-ratelimit-reset': 'soon' }, '', 'throttled', undefined],
    ['403 remaining 0', 403, { 'x-ratelimit-remaining': '0' }, '', 'throttled', undefined],
    ['403 retry-after', 403, { 'retry-after': '10' }, '', 'throttled', now + 10_000],
    ['403 rate limit body', 403, {}, 'API rate limit exceeded for user', 'throttled', undefined],
    ['plain 403', 403, { 'x-ratelimit-remaining': '12' }, 'Forbidden', 'auth', undefined],
    ['401', 401, {}, '', 'auth', undefined],
    ['500', 500, { 'retry-after': '30' }, '', 'transient', undefined],
  ] as const)('%s', (_, status, headers, body, kind, retryAt) => {
    const error = classifyHttpFailure({ status, headers: new Headers(headers), body }, now);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.kind).toBe(kind);
    expect(error.retryAt?.getTime()).toBe(retryAt);
  });

  it('starts the next poll at the reset time after a 403 with no remaining requests', async () => {
    random(0);
    const { starts } = start((_, n) => {
      if (n > 0) return Promise.resolve(batch());
      const headers = new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': epochSeconds(300_000),
      });
      return Promise.reject(classifyHttpFailure({ status: 403, headers }, Date.now()));
    });
    await advanceTo(300_000);
    expect(starts).toEqual([0, 300_000]);
  });

  it('waits until retryAt but never less than the interval; no retryAt backs off', async () => {
    random(0);
    const { starts } = start((_, n) => {
      if (n === 0) {
        const headers = new Headers({ 'retry-after': '10' });
        return Promise.reject(classifyHttpFailure({ status: 429, headers }, Date.now()));
      }
      if (n === 1) {
        return Promise.reject(classifyHttpFailure({ status: 429, headers: new Headers() }, 0));
      }
      return Promise.resolve(batch());
    });
    await advanceTo(4 * I);
    expect(starts).toEqual([0, I, 3 * I, 4 * I]);
  });
});

describe('budget', () => {
  it('pauses below the reserve until resetAt', async () => {
    random(0);
    const { starts } = start(
      (_, n) =>
        Promise.resolve(
          n === 0 ? batch({ budget: { remaining: 999, resetAt: at(600_000) } }) : batch(),
        ),
      { reserveRemaining: 1000 },
    );
    await advanceTo(600_000);
    expect(starts).toEqual([0, 600_000]);
  });

  it('does not pause at the reserve or without one', async () => {
    random(0);
    const atReserve = start(
      () => Promise.resolve(batch({ budget: { remaining: 1000, resetAt: at(600_000) } })),
      { reserveRemaining: 1000 },
    );
    const noReserve = start(() =>
      Promise.resolve(batch({ budget: { remaining: 0, resetAt: at(600_000) } })),
    );
    await advanceTo(I);
    expect(atReserve.starts).toEqual([0, I]);
    expect(noReserve.starts).toEqual([0, I]);
  });
});

describe('auth and config errors', () => {
  it.each(['auth', 'config'] as const)(
    'reports blind %s at once, retries every authRetryMs, clears on the first delivered batch',
    async (kind) => {
      random(0);
      const { starts, core, last } = start((_, n) =>
        n < 2 ? Promise.reject(new AdapterError(kind, 'bad token')) : Promise.resolve(batch()),
      );
      await flush();
      expect(last()).toEqual({ blind: { reason: kind, message: 'bad token' }, gone: [] });
      await advanceTo(1_800_000);
      expect(starts).toEqual([0, 900_000, 1_800_000]);
      expect(core.states.map((call) => call.state.blind?.reason)).toEqual([kind, undefined]);
      expect(last()).toEqual({ lastCompleteAt: at(1_800_000), gone: [] });
    },
  );
});

describe('blind and completeness', () => {
  it('turns blind stale after more than staleMultiplier intervals without a poll in between', async () => {
    random(0);
    const { starts, last } = start((_, n) =>
      n === 0 ? Promise.resolve(batch()) : Promise.reject(new Error('down')),
    );
    await advanceTo(3 * I);
    expect(starts).toEqual([0, I, 3 * I]);
    expect(last()).toEqual({ lastCompleteAt: at(0), gone: [] });
    await advanceTo(3 * I + 1);
    expect(last()).toEqual({
      lastCompleteAt: at(0),
      blind: { reason: 'stale', message: 'No complete observation in 3 poll intervals' },
      gone: [],
    });
  });

  it('recovers on the next complete batch', async () => {
    random(0);
    const { starts, last } = start((_, n) =>
      n === 0 || n === 3 ? Promise.resolve(batch()) : Promise.reject(new Error('down')),
    );
    await advanceTo(7 * I - 1);
    expect(last()?.blind?.reason).toBe('stale');
    await advanceTo(7 * I);
    expect(starts).toEqual([0, I, 3 * I, 7 * I]);
    expect(last()).toEqual({ lastCompleteAt: at(7 * I), gone: [] });
  });

  it.each([
    [0, 180_000, 5000],
    [0.999, 162_018, 20_000],
  ])(
    'defers the stale decision while a poll that started before the deadline is in flight (Math.random %s)',
    async (value, fourthStart, fourthTakes) => {
      random(value);
      const { starts, core, last } = start(
        (_, n) => {
          if (n === 0) return Promise.resolve(prOk());
          if (n < 3) return Promise.resolve(prNotFound());
          return new Promise((resolve) =>
            setTimeout(() => {
              resolve(prNotFound());
            }, fourthTakes),
          );
        },
        { core: { context: () => context({ prs: [pr] }) } },
      );
      await advanceTo(3 * I + 1);
      expect(starts[3]).toBe(fourthStart);
      expect(starts).toHaveLength(4);
      await advanceTo(200_000);
      expect(core.states.some((call) => call.state.blind?.reason === 'stale')).toBe(false);
      expect(last()).toEqual({ lastCompleteAt: at(fourthStart), gone: [pr] });
    },
  );

  it('the deadline fires during an in-flight poll and the reports arrive in order', async () => {
    random(0);
    const second = deferred<Batch>();
    const { core, last } = start((_, n) => (n === 1 ? second.promise : Promise.resolve(batch())));
    await flush();
    expect(core.states).toHaveLength(1);
    core.holdReports();
    await advanceTo(3 * I + 1);
    expect(core.states).toHaveLength(1);
    await advanceTo(6 * I + 1);
    expect(core.states).toHaveLength(1);
    await advanceTo(6 * I + 2);
    expect(core.states).toHaveLength(2);
    expect(last()).toMatchObject({ lastCompleteAt: at(0), blind: { reason: 'stale' } });
    second.resolve(batch());
    await flush();
    expect(core.states).toHaveLength(2);
    core.releaseReport();
    await flush();
    expect(core.states).toHaveLength(3);
    expect(last()).toMatchObject({ lastCompleteAt: at(I), blind: { reason: 'stale' } });
    core.releaseReport();
    await advanceTo(7 * I + 2);
    expect(core.states).toHaveLength(4);
    expect(last()).toEqual({ lastCompleteAt: at(7 * I + 2), gone: [] });
    core.releaseReport();
    await flush();
    expect(core.maxReportsInFlight).toBe(1);
  });

  it('a poll settles while the deadline report is in flight and the reports arrive in order', async () => {
    random(0);
    const { core, last } = start((_, n) => Promise.resolve(batch({ complete: n >= 4 })));
    await flush();
    core.holdReports();
    await advanceTo(3 * I + 1);
    expect(core.states).toHaveLength(2);
    expect(last()).toMatchObject({ blind: { reason: 'stale' } });
    await advanceTo(4 * I);
    expect(core.states).toHaveLength(2);
    core.releaseReport();
    await flush();
    expect(core.states.map((call) => call.state)).toEqual([
      { gone: [] },
      {
        blind: { reason: 'stale', message: 'No complete observation in 3 poll intervals' },
        gone: [],
      },
      { lastCompleteAt: at(4 * I), gone: [] },
    ]);
    core.releaseReport();
    await flush();
    expect(core.maxReportsInFlight).toBe(1);
  });

  it('delivers an incomplete batch and keeps lastCompleteAt', async () => {
    const incomplete = batch({ complete: false, items: [prItem] });
    const { core, last } = start(() => Promise.resolve(incomplete));
    await flush();
    expect(core.observed[0]?.batch.items).toEqual([prItem]);
    expect(last()).toEqual({ gone: [] });
  });

  it('reports the source state only when it changes', async () => {
    random(0);
    const { core } = start(() => Promise.resolve(batch({ complete: false })));
    await advanceTo(3 * I);
    expect(core.states.map((call) => call.state)).toEqual([{ gone: [] }]);
    await advanceTo(5 * I);
    expect(core.states.map((call) => call.state.blind?.reason)).toEqual([undefined, 'stale']);
  });

  it('retries a rejected report on the next outcome', async () => {
    random(0);
    let calls = 0;
    const { core } = start(() => Promise.resolve(batch({ complete: false })), {
      core: {
        reportSourceState: () => {
          calls += 1;
          if (calls === 1) throw new Error('core busy');
        },
      },
    });
    await advanceTo(2 * I);
    expect(core.states.map((call) => call.state)).toEqual([{ gone: [] }, { gone: [] }]);
  });
});

describe('gone entities', () => {
  const requestPr = { core: { context: () => context({ prs: [pr] }) } };

  it('marks an entity gone after goneAfterPolls complete polls and stops it blocking completeness', async () => {
    random(0);
    const { last } = start(() => Promise.resolve(prNotFound()), requestPr);
    await advanceTo(I);
    expect(last()).toEqual({ gone: [] });
    await advanceTo(2 * I);
    expect(last()).toEqual({ lastCompleteAt: at(2 * I), gone: [pr] });
  });

  it('counts a ticket the same way', async () => {
    random(0);
    const { last } = start(
      () => Promise.resolve(batch({ entities: [{ ref: ticket, status: 'no_access' }] })),
      { core: { context: () => context({ tickets: [ticket] }) } },
    );
    await advanceTo(2 * I);
    expect(last()).toEqual({ lastCompleteAt: at(2 * I), gone: [ticket] });
  });

  it('clears gone on ok', async () => {
    random(0);
    const { last } = start((_, n) => Promise.resolve(n < 3 ? prNotFound() : prOk()), requestPr);
    await advanceTo(2 * I);
    expect(last()?.gone).toEqual([pr]);
    await advanceTo(3 * I);
    expect(last()).toEqual({ lastCompleteAt: at(3 * I), gone: [] });
  });

  it('neither counts nor resets on an incomplete batch or a failed poll', async () => {
    random(0);
    const { starts, last } = start((_, n) => {
      if (n === 1) return Promise.resolve(prNotFound({ complete: false }));
      if (n === 2) return Promise.reject(new Error('down'));
      if (n === 3) return Promise.resolve(prOk({ complete: false }));
      return Promise.resolve(prNotFound());
    }, requestPr);
    await advanceTo(5 * I);
    expect(starts).toEqual([0, I, 2 * I, 4 * I, 5 * I]);
    expect(last()?.gone).toEqual([]);
    await advanceTo(6 * I);
    expect(last()?.gone).toEqual([pr]);
  });

  it('never counts a session', async () => {
    random(0);
    const { last } = start(
      () => Promise.resolve(batch({ entities: [{ ref: session, status: 'not_found' }] })),
      { core: { context: () => context({ sessions: [session] }) } },
    );
    await advanceTo(5 * I);
    expect(last()).toEqual({ lastCompleteAt: at(5 * I), gone: [] });
  });

  it('drops a ref core no longer requests', async () => {
    random(0);
    let contexts = 0;
    const { last } = start(
      (ctx) => Promise.resolve(ctx.observe.prs.length > 0 ? prNotFound() : batch()),
      {
        core: {
          context: () => {
            contexts += 1;
            return context({ prs: contexts === 4 ? [] : [pr] });
          },
        },
      },
    );
    await advanceTo(2 * I);
    expect(last()?.gone).toEqual([pr]);
    await advanceTo(3 * I);
    expect(last()?.gone).toEqual([]);
    await advanceTo(5 * I);
    expect(last()?.gone).toEqual([]);
    await advanceTo(6 * I);
    expect(last()?.gone).toEqual([pr]);
  });
});

describe('batch validation', () => {
  it.each([
    ['an ok entity without its item', () => batch({ entities: [{ ref: pr, status: 'ok' }] })],
    ['bad budget remaining -1', () => prNotFound({ budget: { remaining: -1, resetAt: at(0) } })],
    ['an unknown top-level key', () => Object.assign(prNotFound(), { extra: 1 })],
    ['source other than adapter.id', () => prNotFound({ source: 'jira' })],
  ])('rejects %s without delivering it', async (_, invalid) => {
    random(0);
    const { starts, core, last } = start(
      (_ctx, n) => Promise.resolve(n === 0 ? prOk() : n === 1 ? invalid() : prNotFound()),
      { core: { context: () => context({ prs: [pr] }) } },
    );
    await advanceTo(I);
    expect(core.observed).toHaveLength(1);
    expect(last()).toEqual({ lastCompleteAt: at(0), gone: [] });
    await advanceTo(3 * I);
    expect(gaps(starts)).toEqual([I, 2 * I]);
    await advanceTo(4 * I);
    expect(last()?.gone).toEqual([]);
    await advanceTo(5 * I);
    expect(core.observed).toHaveLength(4);
    expect(last()).toEqual({ lastCompleteAt: at(5 * I), gone: [pr] });
  });

  it('does not clear blind auth on an invalid batch', async () => {
    random(0);
    const { core } = start((_, n) => {
      if (n === 0) return Promise.reject(new AdapterError('auth', 'bad token'));
      return Promise.resolve(n === 1 ? batch({ source: 'jira' }) : batch());
    });
    await advanceTo(900_000);
    expect(core.observed).toHaveLength(0);
    expect(core.states.map((call) => call.state.blind?.reason)).toEqual(['auth']);
    await advanceTo(900_000 + 2 * I);
    expect(core.states.map((call) => call.state.blind?.reason)).toEqual(['auth', undefined]);
  });

  it("ignores the adapter's own observedAt when validating", async () => {
    const { core } = start(() => Promise.resolve(batch({ observedAt: 'not-a-date' })));
    await flush();
    expect(core.observed.map((call) => call.batch.observedAt)).toEqual([at(0)]);
  });
});

describe('stop', () => {
  it('stop aborts the in-flight poll, drops a late batch and leaves no timers', async () => {
    const late = deferred<Batch>();
    const { runner, adapter, core } = start(() => late.promise);
    await flush();
    const stopped = runner.stop();
    expect(adapter.contexts[0]?.signal.aborted).toBe(true);
    late.resolve(batch());
    await stopped;
    expect(core.observed).toEqual([]);
    expect(core.states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * I);
    expect(core.states).toEqual([]);
  });

  it('stop clears a pending stale deferral', async () => {
    random(0);
    const { runner, core, starts } = start((ctx, n) =>
      n === 0 ? Promise.resolve(batch()) : hang(ctx),
    );
    await advanceTo(4 * I);
    expect(starts).toEqual([0, I]);
    expect(vi.getTimerCount()).toBe(1);
    await runner.stop();
    expect(vi.getTimerCount()).toBe(0);
    const reported = core.states.length;
    await vi.advanceTimersByTimeAsync(10 * I);
    expect(core.states).toHaveLength(reported);
  });
});
