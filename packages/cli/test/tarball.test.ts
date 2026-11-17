import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandResult, RunOptions } from '../src/service.ts';
import { TARBALL_DELAYS_MS, TARBALL_WAIT_MS, waitForTarball } from '../src/tarball.ts';

const ok = (): CommandResult => ({ exitCode: 0, stdout: 'spur-board-1.1.0.tgz\n', stderr: '' });
const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: '', stderr });
const NOT_FOUND = 'npm error code E404\nnpm error 404 Not Found - GET .../spur-board-1.1.0.tgz\n';

/** A fake npm answering each `npm pack` from `answer`, on a fake clock that only sleeps move. */
function harness(answer: (run: number, clock: { t: number }) => CommandResult) {
  const clock = { t: 1_000_000 };
  const calls: { args: readonly string[]; options: RunOptions | undefined }[] = [];
  const sleeps: number[] = [];
  const waits: { waitMs: number; waitedMs: number; boundMs: number }[] = [];
  const env = { PATH: '/usr/bin' };
  const deps = {
    runner: (command: string, args: readonly string[], options?: RunOptions) => {
      expect(command).toBe('npm');
      calls.push({ args, options });
      return Promise.resolve(answer(calls.length, clock));
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
    now: () => clock.t,
    env,
    onWait: (wait: { waitMs: number; waitedMs: number; boundMs: number }) => {
      waits.push(wait);
    },
  };
  return { deps, calls, sleeps, waits, env };
}

describe('waitForTarball', () => {
  it('exports the 600 s bound and the 5, 10, 20, 30 s delays', () => {
    expect(TARBALL_WAIT_MS).toBe(600_000);
    expect(TARBALL_DELAYS_MS).toEqual([5_000, 10_000, 20_000, 30_000]);
  });

  it('retries a 404 until the tarball downloads, then removes its temp dir', async () => {
    const h = harness((run) => (run <= 2 ? fail(NOT_FOUND) : ok()));
    expect(await waitForTarball('spur-board@1.1.0', h.deps)).toEqual({ ok: true });

    expect(h.sleeps).toEqual([5_000, 10_000]);
    expect(h.waits).toEqual([
      { waitMs: 5_000, waitedMs: 0, boundMs: 600_000 },
      { waitMs: 10_000, waitedMs: 5_000, boundMs: 600_000 },
    ]);
    const dir = h.calls[0]?.args[3] ?? '';
    for (const call of h.calls) {
      expect(call.args).toEqual(['pack', 'spur-board@1.1.0', '--pack-destination', dir]);
      expect(call.options?.env).toBe(h.env);
    }
    expect(h.calls.map((call) => call.options?.timeoutMs)).toEqual([600_000, 595_000, 585_000]);
    expect(existsSync(dir)).toBe(false);
  });

  it('gives up a persistent 404 when the next wait would reach the bound', async () => {
    const h = harness(() => fail(NOT_FOUND));
    const outcome = await waitForTarball('spur-board@1.1.0', h.deps);

    expect(outcome).toEqual({
      ok: false,
      reason: 'not-served',
      ranPastBound: false,
      result: fail(NOT_FOUND),
      waitedMs: 575_000,
      boundMs: 600_000,
    });
    // Attempts at 0, 5, 15, 35 s and every 30 s from 65 to 575 s.
    const starts = [0, 5_000, 15_000, 35_000];
    for (let k = 0; k < 18; k += 1) starts.push(65_000 + k * 30_000);
    expect(h.calls.map((call) => call.options?.timeoutMs)).toEqual(starts.map((t) => 600_000 - t));
    expect(h.sleeps).toEqual([5_000, 10_000, 20_000, ...Array<number>(18).fill(30_000)]);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(575_000);
    expect(existsSync(h.calls[0]?.args[3] ?? '')).toBe(false);
  });

  it.each([
    ['is killed at the bound', (): CommandResult => ({ ...fail(''), timedOut: true })],
    [
      'succeeds only after the bound',
      (clock: { t: number }): CommandResult => {
        clock.t += 600_001;
        return ok();
      },
    ],
  ])('reports a pack that %s as not served past the bound', async (_name, last) => {
    const h = harness((run, clock) => (run === 1 ? fail(NOT_FOUND) : last(clock)));
    const outcome = await waitForTarball('spur-board@1.1.0', h.deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'not-served', ranPastBound: true });
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([5_000]);
  });

  it('fails an integrity error at once without a wait', async () => {
    const h = harness(() => fail('npm error code EINTEGRITY\n'));
    const outcome = await waitForTarball('spur-board@1.1.0', h.deps);

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'failed',
      ranPastBound: false,
      waitedMs: 0,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.waits).toEqual([]);
    expect(existsSync(h.calls[0]?.args[3] ?? '')).toBe(false);
  });

  it('takes a caller bound and delays', async () => {
    const h = harness(() => fail(NOT_FOUND));
    const outcome = await waitForTarball('left-pad@1.3.0', {
      ...h.deps,
      waitMs: 10_000,
      delaysMs: [3_000],
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'not-served', boundMs: 10_000 });
    expect(h.sleeps).toEqual([3_000, 3_000, 3_000]);
    expect(h.calls.map((call) => call.options?.timeoutMs)).toEqual([10_000, 7_000, 4_000, 1_000]);
  });
});
