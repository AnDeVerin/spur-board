import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Batch } from '@spur-board/contracts';
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
  /** Each source's regular polls in order; the last one repeats. */
  alpha: Partial<Batch>[];
  beta: Partial<Batch>[];
  /** The budget an on-demand refresh of an alpha PR reports after the first polls. */
  refresh?: Batch['budget'];
  /** How long the runner runs before status.get is read. */
  runMs: number;
  waiting: string[];
  /** Alpha's stored budget remaining at the read. */
  alphaRemaining: number | null;
  reason: string | null;
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
      reason: `${alpha} waits for its rate budget until ${new Date(RESET).toISOString()}`,
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
      reason: `${alpha} waits for its rate budget until ${new Date(RESET).toISOString()}`,
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
  const adapter = (source: string, polls: Partial<Batch>[]) => {
    let n = 0;
    return createFakeAdapter({
      id: source,
      intervalMs: I,
      poll: () =>
        Promise.resolve({
          source,
          observedAt: observedAt(),
          complete: true,
          items: [],
          entities: [],
          ...polls[Math.min(n++, polls.length - 1)],
        }),
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
  } finally {
    await runner?.stop();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
