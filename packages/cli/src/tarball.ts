import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, RunOptions } from './service.ts';

/** How long a listed version's tarball may answer 404 (CDN lag after a publish). */
export const TARBALL_WAIT_MS = 600_000;
/** Waits between tarball 404s; the last one repeats. No retry starts past the bound. */
export const TARBALL_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

export interface TarballDeps {
  /** Runs `npm`; it must honour `timeoutMs` (as `runCommand` does) and report `timedOut`. */
  runner: (
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ) => Promise<CommandResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The environment of every `npm pack`. */
  env: NodeJS.ProcessEnv;
  /** Called before each wait after a 404, so the caller can word its own progress line. */
  onWait?: (wait: { waitMs: number; waitedMs: number; boundMs: number }) => void;
  waitMs?: number;
  delaysMs?: readonly number[];
}

export type TarballOutcome =
  | { ok: true }
  | {
      ok: false;
      /**
       * `not-served`: still 404 when the next wait would reach the bound, or `npm pack` was still
       * running (`ranPastBound`). `failed`: any other npm error, an integrity mismatch included.
       */
      reason: 'not-served' | 'failed';
      ranPastBound: boolean;
      /** The last `npm pack` result. */
      result: CommandResult;
      waitedMs: number;
      boundMs: number;
    };

/**
 * Downloads `spec` with `npm pack` into a temp dir it removes, retrying a 404 while the next wait
 * still ends inside the bound. Each attempt gets the remaining budget as its timeout, so the whole
 * check ends within `waitMs`.
 */
export async function waitForTarball(spec: string, deps: TarballDeps): Promise<TarballOutcome> {
  const boundMs = deps.waitMs ?? TARBALL_WAIT_MS;
  const delays = deps.delaysMs ?? TARBALL_DELAYS_MS;
  const dir = mkdtempSync(join(tmpdir(), 'board-update-pack-'));
  try {
    const started = deps.now();
    const deadline = started + boundMs;
    for (let attempt = 0; ; attempt += 1) {
      const result = await deps.runner('npm', ['pack', spec, '--pack-destination', dir], {
        env: deps.env,
        timeoutMs: deadline - deps.now(),
      });
      const now = deps.now();
      const failure = (reason: 'not-served' | 'failed', ranPastBound: boolean): TarballOutcome => ({
        ok: false,
        reason,
        ranPastBound,
        result,
        waitedMs: now - started,
        boundMs,
      });
      if (result.timedOut === true || now > deadline) return failure('not-served', true);
      if (result.exitCode === 0) return { ok: true };
      if (!/\bE404\b/.test(result.stderr)) return failure('failed', false);
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      if (now + wait >= deadline) return failure('not-served', false);
      deps.onWait?.({ waitMs: wait, waitedMs: now - started, boundMs });
      await deps.sleep(wait);
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left in place; it costs only disk space.
    }
  }
}
