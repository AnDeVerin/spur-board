import { join } from 'node:path';
import { openStore, type Store } from '@spur-board/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonModules } from '../src/composition.ts';
import { loadConfig, resolvePaths } from '../src/config.ts';
import type { ModuleContext } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';
import { createJob } from '../src/scheduler.ts';
import { makeHome } from './home.ts';

const INTERVAL = 1_000;
const DAY_MS = 86_400_000;
const START = Date.parse('2026-11-03T10:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Counts runs and the most runs active at once; a run waits on `hold` while it is set. */
function counter() {
  const state = {
    runs: 0,
    running: 0,
    maxRunning: 0,
    hold: undefined as Promise<void> | undefined,
    fail: undefined as number | undefined,
    run: async (): Promise<void> => {
      state.runs += 1;
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      try {
        if (state.hold !== undefined) await state.hold;
        if (state.fail === state.runs) throw new Error(`run ${String(state.runs)} failed`);
      } finally {
        state.running -= 1;
      }
    },
  };
  return state;
}

describe('createJob', () => {
  it('runs at once on a background start, then every interval after a run settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError: vi.fn() });
    await job.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(jobRuns.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(jobRuns.runs).toBe(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(jobRuns.runs).toBe(3);
    await job.stop();
  });

  it('without jitter runs exactly the interval after the previous run settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const held = deferred();
    jobRuns.hold = held.promise;
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError: vi.fn() });
    await job.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(jobRuns.runs).toBe(1);
    jobRuns.hold = undefined;
    held.resolve();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(jobRuns.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(jobRuns.runs).toBe(2);
    await job.stop();
  });

  it('never overlaps a held run, even across many intervals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const held = deferred();
    jobRuns.hold = held.promise;
    const job = createJob({
      run: jobRuns.run,
      intervalMs: INTERVAL,
      jitterMs: 100,
      onError: vi.fn(),
    });
    await job.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20 * INTERVAL);
    expect(jobRuns.runs).toBe(1);
    jobRuns.hold = undefined;
    held.resolve();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(jobRuns.runs).toBeGreaterThan(5);
    expect(jobRuns.maxRunning).toBe(1);
    await job.stop();
  });

  it('queues a trigger behind the active run and resolves when its own run settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const held = deferred();
    jobRuns.hold = held.promise;
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError: vi.fn() });
    await job.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    let triggered = false;
    const trigger = job.trigger().then(() => {
      triggered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(jobRuns.runs).toBe(1);
    expect(triggered).toBe(false);
    jobRuns.hold = undefined;
    held.resolve();
    await trigger;
    expect(jobRuns.runs).toBe(2);
    expect(jobRuns.maxRunning).toBe(1);
    await job.stop();
  });

  it('sends a failed later run to onError and still runs the next one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    jobRuns.fail = 2;
    const onError = vi.fn();
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError });
    await job.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(jobRuns.runs).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(new Error('run 2 failed'));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(jobRuns.runs).toBe(3);
    expect(onError).toHaveBeenCalledTimes(1);
    await job.stop();
  });

  it.each<{ title: string; onError: Parameters<typeof createJob>[0]['onError'] }>([
    {
      title: 'throws',
      onError: (): void => {
        throw new Error('onError failed');
      },
    },
    {
      title: 'rejects',
      onError: (): Promise<void> => Promise.reject(new Error('onError failed')),
    },
  ])('keeps running when onError $title', async ({ onError }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const jobRuns = counter();
      jobRuns.fail = 2;
      const handler = vi.fn(onError);
      const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError: handler });
      await job.start(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(jobRuns.runs).toBe(2);
      expect(handler).toHaveBeenCalledTimes(1);
      await expect(job.settled()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(jobRuns.runs).toBe(3);
      await job.stop();
      // Let a rejection the chain dropped reach the process before checking.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('resolves an awaited start after the first run, then runs on the interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const job = createJob({
      run: jobRuns.run,
      intervalMs: INTERVAL,
      first: 'await',
      onError: vi.fn(),
    });
    await job.start(new AbortController().signal);
    expect(jobRuns.runs).toBe(1);
    expect(jobRuns.running).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(jobRuns.runs).toBe(2);
    await job.stop();
  });

  it('rejects an awaited start when the first run fails and arms no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    jobRuns.fail = 1;
    const onError = vi.fn();
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, first: 'await', onError });
    await expect(job.start(new AbortController().signal)).rejects.toThrow('run 1 failed');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(jobRuns.runs).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops by clearing the timer and awaiting the active run, and ignores later triggers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError: vi.fn() });
    await job.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const held = deferred();
    jobRuns.hold = held.promise;
    void job.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobRuns.running).toBe(1);
    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    held.resolve();
    await stopping;
    await expect(job.stop()).resolves.toBeUndefined();
    await job.trigger();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(jobRuns.runs).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops scheduling once the start signal aborts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jobRuns = counter();
    const controller = new AbortController();
    const job = createJob({ run: jobRuns.run, intervalMs: INTERVAL, onError: vi.fn() });
    await job.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await job.trigger();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(jobRuns.runs).toBe(1);
    await job.stop();
  });
});

describe('composed command retention', () => {
  it('purges once a day until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const home = makeHome();
    const store = openStore(join(home, 'board.sqlite'));
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const config = { ...loaded.config, commands: { ...loaded.config.commands, retentionDays: 1 } };
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      {
        write(line) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
      {},
    );
    let now = START;
    const clock = { now: () => now };
    const advance = async (ms: number): Promise<void> => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    const ctxFor = (name: string): ModuleContext<Store> => ({
      config,
      secrets: {},
      store,
      log: log.child({ module: name }),
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    });
    const keys = async (): Promise<string[]> =>
      (await store.db.selectFrom('command').select('key').orderBy('key').execute()).map(
        (row) => row.key,
      );
    try {
      const { entries } = createDaemonModules(ctxFor, {
        spur: { send: () => Promise.resolve() },
        tick: () => Promise.resolve(),
        startAdapters: () => ({ stop: () => Promise.resolve() }),
      });
      const commands = entries[0];
      expect(commands).toMatchObject({ name: 'commands', stopStage: 'final' });
      if (commands === undefined) throw new Error('No commands entry');
      // `soon` expires one day after start; `later` one day after that.
      await store.transaction(async (trx) => {
        for (const [key, ms] of Object.entries({ soon: START - DAY_MS, later: START })) {
          await trx
            .insertInto('command')
            .values({
              actor: 'operator',
              key,
              operation: 'test.touch',
              fingerprint: null,
              result: '{}',
              at: new Date(ms).toISOString(),
            })
            .execute();
        }
      });

      await commands.module.start(new AbortController().signal);
      expect(await keys()).toEqual(['later', 'soon']);
      await advance(DAY_MS - 1);
      expect(await keys()).toEqual(['later', 'soon']);
      await advance(1);
      expect(await keys()).toEqual(['later']);

      await commands.module.stop();
      await advance(DAY_MS);
      expect(await keys()).toEqual(['later']);
      expect(records.map((record) => record['msg'])).not.toContain('command purge failed');
    } finally {
      await store.close();
    }
  });
});
