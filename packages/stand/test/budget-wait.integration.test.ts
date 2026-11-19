import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError, configSchema, type Batch } from '@spur-board/contracts';
import { createFakeAdapter } from '@spur-board/adapters/testing';
import {
  createObservationCore,
  createOperationRegistry,
  createQuery,
  openStore,
} from '@spur-board/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startRunner, type AdapterRunner } from '../../adapters/src/runner/runner.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const I = 60_000;
const RESET = T0 + 600_000;
const alpha = 'github:alpha:o/a';
const beta = 'github:beta:o/b';
const jira = (key: string) => ({
  type: 'jira',
  baseUrl: 'https://jira.example.test',
  jql: `project = ${key}`,
  doneStatuses: ['Done'],
  readyStatuses: ['Ready'],
  projectKeys: [key],
});
// Jira trackers, so the github service rolls up only the two PR sources the runner polls.
const config = configSchema.parse({
  projects: [
    { id: 'alpha', tracker: jira('ALPHA'), repos: ['o/a'], operatorGithubLogin: 'operator' },
    { id: 'beta', tracker: jira('BETA'), repos: ['o/b'], operatorGithubLogin: 'operator' },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const reserve = config.github.reserveRemaining;
const low = {
  budget: { remaining: reserve - 1, limit: 5000, resetAt: new Date(RESET).toISOString() },
};
const high = { budget: { remaining: 5000, limit: 5000, resetAt: new Date(RESET).toISOString() } };
const ref = { kind: 'pr' as const, repo: 'o/a', number: 7 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Row {
  /** A budget under the reserve that an earlier daemon run stored for alpha. */
  stored?: boolean;
  /** Each source's regular polls in order, a batch or the error it fails with; the last repeats. */
  alpha: (Partial<Batch> | AdapterError)[];
  beta: Partial<Batch>[];
  /** The budget an on-demand refresh of an alpha PR reports after the first polls. */
  refresh?: Batch['budget'];
  /** How long the runner runs before status.get is read. */
  runMs: number;
  waiting: string[];
  /** Alpha's stored budget remaining at the read. */
  alphaRemaining: number | null;
  reason: string | null;
  /** A second read after the runner runs this much longer. */
  later?: { runMs: number; waiting: string[]; reason: string | null };
}

// status.get reads the regular runner's pause of this daemon run, never the stored budget.
it.each<[string, Row]>([
  [
    'two projects pause on their own budgets',
    {
      alpha: [low],
      beta: [low],
      runMs: 0,
      waiting: [alpha, beta],
      alphaRemaining: reserve - 1,
      reason: `${alpha} waits for its rate budget`,
    },
  ],
  [
    'an old stored pause and a budgetless complete poll after a restart',
    {
      stored: true,
      alpha: [{}],
      beta: [high],
      runMs: 0,
      waiting: [],
      alphaRemaining: reserve - 1,
      reason: null,
    },
  ],
  [
    'a first incomplete poll under the reserve pauses',
    {
      alpha: [{ complete: false, ...low }],
      beta: [high],
      runMs: 0,
      waiting: [alpha],
      alphaRemaining: reserve - 1,
      reason: `${alpha} waits for its rate budget`,
    },
  ],
  [
    'the paused poll at reset ends the pause without a budget',
    {
      alpha: [low, {}],
      beta: [high],
      runMs: RESET - T0,
      waiting: [],
      alphaRemaining: reserve - 1,
      reason: null,
    },
  ],
  [
    'an on-demand refresh under the reserve, then a throttled regular poll until its retry',
    {
      alpha: [
        high,
        new AdapterError('throttled', 'Rate limited', { retryAt: new Date(RESET) }),
        {},
      ],
      beta: [high],
      refresh: low.budget,
      runMs: I,
      waiting: [alpha],
      alphaRemaining: reserve - 1,
      reason: `${alpha} waits for its rate budget`,
      later: { runMs: RESET - T0 - I, waiting: [], reason: null },
    },
  ],
  [
    'an on-demand refresh under the reserve, then a regular poll throttled without a retry time',
    {
      alpha: [high, new AdapterError('throttled', 'HTTP 429'), {}],
      beta: [high],
      refresh: low.budget,
      runMs: I,
      waiting: [alpha],
      alphaRemaining: reserve - 1,
      reason: `${alpha} waits for its rate budget`,
      // The first failure backs off for two intervals, then the backoff poll delivers.
      later: { runMs: 2 * I, waiting: [], reason: null },
    },
  ],
  [
    'an on-demand refresh under the reserve',
    {
      alpha: [high],
      beta: [high],
      refresh: low.budget,
      runMs: 0,
      waiting: [],
      alphaRemaining: reserve - 1,
      reason: null,
    },
  ],
])('sources[].waitsForBudget follows the runner: %s', async (_name, row) => {
  const home = mkdtempSync(join(tmpdir(), 'board-budget-wait-'));
  const store = openStore(join(home, 'board.db'));
  const clock = { now: () => Date.now() };
  const observedAt = () => new Date(clock.now()).toISOString();
  if (row.stored === true)
    await createObservationCore({ store, config, clock }).observe(alpha, {
      batch: {
        source: alpha,
        observedAt: observedAt(),
        complete: true,
        items: [],
        entities: [],
        ...low,
      },
      effectiveComplete: true,
      state: { lastCompleteAt: observedAt(), gone: [] },
      outcomes: [],
    });
  // A new core is a new daemon run on the same database.
  const core = createObservationCore({ store, config, clock });
  // Holds every source's first poll until the read before any poll delivers.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = (source: string, polls: (Partial<Batch> | AdapterError)[]) => {
    let n = 0;
    return createFakeAdapter({
      id: source,
      intervalMs: I,
      poll: async () => {
        const startedAt = observedAt();
        const next = polls[Math.min(n++, polls.length - 1)];
        await gate;
        if (next instanceof AdapterError) throw next;
        return { source, observedAt: startedAt, complete: true, items: [], entities: [], ...next };
      },
      pollPr: (pr) =>
        Promise.resolve({
          source,
          observedAt: observedAt(),
          complete: false,
          items: [],
          entities: [{ ref: pr, status: 'not_found' as const }],
          ...(row.refresh === undefined ? {} : { budget: row.refresh }),
        }),
    });
  };
  let runner: AdapterRunner | undefined;
  const registry = createOperationRegistry({
    config,
    clock,
    completeSince: core.completeSince,
    budgetWaits: () => runner?.budgetWaits,
  });
  const query = createQuery({ store, config, clock });
  const waiting = async () =>
    (await query(registry['status.get'], { project: 'beta' }, 'operator')).sources
      .filter((entry) => entry.waitsForBudget)
      .map((entry) => entry.source);
  try {
    runner = startRunner({
      entries: [
        { adapter: adapter(alpha, row.alpha), reserveRemaining: reserve },
        { adapter: adapter(beta, row.beta), reserveRemaining: reserve },
      ],
      core,
      config,
      now: clock.now,
    });
    // Before the first poll of this run delivers, nothing waits, whatever an earlier run stored.
    expect(await waiting()).toEqual([]);
    release();
    await runner.firstAttempts;
    if (row.refresh !== undefined)
      expect(await runner.pollPr?.(alpha, ref, { timeoutMs: 1000 })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(row.runMs);
    // The chosen project does not narrow sources, so beta's view shows alpha's pause.
    const status = await query(registry['status.get'], { project: 'beta' }, 'operator');
    expect(
      status.sources.filter((entry) => entry.waitsForBudget).map((entry) => entry.source),
    ).toEqual(row.waiting);
    expect(status.sources.find((entry) => entry.source === alpha)?.budget?.remaining ?? null).toBe(
      row.alphaRemaining,
    );
    expect(status.services.find((entry) => entry.service === 'github')?.reason).toBe(row.reason);
    if (row.later !== undefined) {
      await vi.advanceTimersByTimeAsync(row.later.runMs);
      const later = await query(registry['status.get'], { project: 'beta' }, 'operator');
      expect(await waiting()).toEqual(row.later.waiting);
      expect(later.services.find((entry) => entry.service === 'github')?.reason).toBe(
        row.later.reason,
      );
    }
  } finally {
    await runner?.stop();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
