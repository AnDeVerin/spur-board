import type { Module } from './lifecycle.ts';

/**
 * One recurring job: a `setTimeout` chain armed `intervalMs` plus under `jitterMs` after each
 * timer run settles. Runs never overlap; `trigger` queues behind the active run. A failed run goes
 * to `onError`, except a failed `first: 'await'` run, which rejects `start` and arms no timer.
 * `stop` clears the timer and awaits the active run; after it, and once the start signal aborts,
 * nothing new runs. Uses the global timers so `vi.useFakeTimers` controls it.
 */
export function createJob(options: {
  run: (signal: AbortSignal) => Promise<unknown>;
  intervalMs: number;
  jitterMs?: number;
  first?: 'await' | 'background';
  onError: (err: unknown) => void;
}): Module & {
  /** Runs once more behind the active run; resolves when that run settles. */
  trigger(): Promise<void>;
  /** Resolves when every run queued so far has settled. */
  settled(): Promise<void>;
} {
  const { run, intervalMs, jitterMs = 0, first = 'background', onError } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  let stopped = false;
  let signal: AbortSignal | undefined;
  const idle = (): boolean => stopped || signal === undefined || signal.aborted;
  const enqueue = (): Promise<void> => {
    if (idle()) return active;
    active = active
      .then(async () => {
        if (signal !== undefined && !idle()) await run(signal);
      })
      .catch(onError);
    return active;
  };
  const schedule = (): void => {
    if (idle()) return;
    const delay = intervalMs + Math.floor(Math.random() * jitterMs);
    timer = setTimeout(() => {
      timer = undefined;
      void enqueue().then(schedule);
    }, delay);
  };
  return {
    async start(startSignal) {
      signal = startSignal;
      if (first === 'background') {
        void enqueue().then(schedule);
        return;
      }
      if (idle()) return;
      const firstRun = run(startSignal);
      active = firstRun.then(
        () => undefined,
        () => undefined,
      );
      await firstRun;
      schedule();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await active;
    },
    trigger: enqueue,
    settled: () => active,
  };
}
