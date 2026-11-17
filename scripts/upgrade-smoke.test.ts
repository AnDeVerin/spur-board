import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, RunOptions } from '../packages/cli/src/service.ts';
import { installPublished, latestPublishedVersion, registryVersions } from './upgrade-smoke.ts';

describe('previous published version', () => {
  it('selects the newest stable published version', () => {
    expect(latestPublishedVersion('["0.1.0","0.2.0","0.2.1-beta.1","0.3.0"]')).toBe('0.3.0');
  });

  it('uses the latest published package even when the checked-in version is unchanged', () => {
    expect(latestPublishedVersion('"0.1.0"')).toBe('0.1.0');
    expect(latestPublishedVersion('["0.1.0","0.2.0"]')).toBe('0.2.0');
  });

  it('skips only when no package exists', () => {
    expect(
      registryVersions(
        1,
        '',
        'npm error code E404\nNot Found - GET https://registry.npmjs.org/spur-board',
      ),
    ).toBeNull();
  });

  it('fails on registry errors or invalid results', () => {
    expect(() => registryVersions(1, '', 'npm error code EAI_AGAIN')).toThrow('Could not read');
    expect(() => registryVersions(0, '{}', '')).toThrow('invalid version list');
  });
});

// The stderr of CI job 132708337138, where npmjs listed 0.62.1 before its tarball was served.
const TARBALL_404 = [
  'npm error code E404',
  'npm error 404 Not Found - GET https://registry.npmjs.org/spur-board/-/spur-board-0.62.1.tgz - Not found',
].join('\n');
const PACKUMENT_404 = [
  'npm error code E404',
  'npm error 404 Not Found - GET https://registry.npmjs.org/spur-board - Not found',
].join('\n');
const DNS_FAILURE = [
  'npm error code EAI_AGAIN',
  'npm error request to https://registry.npmjs.org/spur-board/-/spur-board-0.62.1.tgz failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
].join('\n');

describe('previous version install retry', () => {
  let root = '';
  const sleeps: number[] = [];
  const logs: string[] = [];
  const deps = {
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    log: (text: string) => logs.push(text),
  };

  /** A fake npm that prints `stderr` and exits 1 for its first `failures` calls, then exits 0. */
  function fakeNpm(stderr: string, failures: number): void {
    root = mkdtempSync(join(tmpdir(), 'board-upgrade-retry-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'stderr'), stderr);
    writeFileSync(join(root, 'calls'), '');
    writeFileSync(
      join(bin, 'npm'),
      [
        '#!/bin/sh',
        'if [ "$1" = pack ]; then exit 0; fi',
        'echo call >> "$FAKE_NPM_CALLS"',
        'if [ "$(wc -l < "$FAKE_NPM_CALLS")" -le "$FAKE_NPM_FAILURES" ]; then',
        '  cat "$FAKE_NPM_STDERR" >&2',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    vi.stubEnv('FAKE_NPM_CALLS', join(root, 'calls'));
    vi.stubEnv('FAKE_NPM_STDERR', join(root, 'stderr'));
    vi.stubEnv('FAKE_NPM_FAILURES', String(failures));
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
  }

  function calls(): number {
    return readFileSync(join(root, 'calls'), 'utf8').split('\n').filter(Boolean).length;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    sleeps.length = 0;
    logs.length = 0;
  });

  it('retries a just-released tarball 404 until npmjs serves it', async () => {
    fakeNpm(TARBALL_404, 2);
    const prefix = join(root, 'previous');
    await expect(installPublished('spur-board@0.62.1', prefix, deps)).resolves.toBe(
      join(prefix, 'node_modules/.bin/board'),
    );
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(logs[0]).toBe(
      'upgrade smoke: 404 on /spur-board/-/spur-board-0.62.1.tgz installing spur-board@0.62.1, attempt 1, retrying in 1000 ms (waited 0 ms)',
    );
  });

  it('verifies the published tarball before installing it', async () => {
    fakeNpm('', 0);
    const optionsSeen: (RunOptions | undefined)[] = [];
    const runner = vi.fn((_command: string, _args: readonly string[], options?: RunOptions) => {
      optionsSeen.push(options);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    await installPublished('spur-board@0.62.1', join(root, 'previous'), { ...deps, runner });
    expect(runner).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining([
        'pack',
        'spur-board@0.62.1',
        '--pack-destination',
        '--ignore-scripts',
      ]),
      optionsSeen[0],
    );
    expect(optionsSeen[0]?.env?.['PATH']).toBe(process.env['PATH']);
    expect(optionsSeen[0]?.timeoutMs).toBeGreaterThan(0);
    expect(optionsSeen[0]?.timeoutMs).toBeLessThanOrEqual(600_000);
  });

  function preflight(
    results: (Omit<CommandResult, 'stdout'> & { duration: number })[],
    sleepOverhead = 0,
  ) {
    let elapsed = 0;
    const destinations: string[] = [];
    const budgets: number[] = [];
    const runner = vi.fn((_command: string, args: readonly string[], options?: RunOptions) => {
      expect(calls()).toBe(0);
      const destination = args[args.indexOf('--pack-destination') + 1] ?? '';
      expect(existsSync(destination)).toBe(true);
      writeFileSync(join(destination, 'download.tgz'), 'partial or complete download');
      destinations.push(destination);
      budgets.push(options?.timeoutMs ?? 0);
      expect(options?.env?.['NPM_TOKEN']).toBeUndefined();
      expect(options?.env?.['GITHUB_TOKEN']).toBeUndefined();
      expect(options?.env?.['PATH']).toBe(process.env['PATH']);
      const result = results[Math.min(runner.mock.calls.length - 1, results.length - 1)];
      if (result === undefined) throw new Error('Missing fake result');
      elapsed += result.duration;
      return Promise.resolve({ ...result, stdout: '' });
    });
    return {
      destinations,
      budgets,
      runner,
      deps: {
        ...deps,
        runner,
        now: () => elapsed,
        environment: { ...process.env, NPM_TOKEN: 'sentinel', GITHUB_TOKEN: 'sentinel' },
        sleep: async (ms: number) => {
          await deps.sleep(ms);
          elapsed += ms + sleepOverhead;
        },
      },
    };
  }

  it('waits for a verified pack before install and cleans its scrubbed download directory', async () => {
    fakeNpm('', 0);
    const probe = preflight([
      { exitCode: 1, stderr: TARBALL_404, duration: 100 },
      { exitCode: 0, stderr: '', duration: 200 },
    ]);
    await installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps);
    expect(probe.runner).toHaveBeenCalledTimes(2);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([5_000]);
    expect(probe.budgets).toEqual([600_000, 594_900]);
    expect(logs).toEqual([
      'upgrade smoke: npm registry lag/404 for spur-board@0.62.1, elapsed 100 ms, retrying in 5000 ms (bound 600000 ms)',
    ]);
    expect(probe.destinations.every((destination) => !existsSync(destination))).toBe(true);
  });

  it('bounds persistent registry lag by elapsed command time and capped backoff', async () => {
    fakeNpm('', 0);
    const probe = preflight([{ exitCode: 1, stderr: TARBALL_404, duration: 100_000 }]);
    const failure = installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps);
    await expect(failure).rejects.toThrow('npm registry lag for spur-board@0.62.1');
    await expect(failure).rejects.toThrow('600000 ms');
    expect(probe.budgets).toEqual([600_000, 495_000, 385_000, 265_000, 135_000, 5_000]);
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(calls()).toBe(0);
    expect(probe.destinations.every((destination) => !existsSync(destination))).toBe(true);
  });

  it('refuses when the next full backoff would reach the deadline', async () => {
    fakeNpm('', 0);
    const probe = preflight([{ exitCode: 1, stderr: TARBALL_404, duration: 599_999 }]);
    await expect(
      installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps),
    ).rejects.toThrow('600000 ms');
    expect(sleeps).toEqual([]);
    expect(probe.budgets).toEqual([600_000]);
    expect(calls()).toBe(0);
  });

  it('starts no npm command when a backoff wakes at the deadline', async () => {
    fakeNpm('', 0);
    const probe = preflight([{ exitCode: 1, stderr: TARBALL_404, duration: 0 }], 595_000);
    await expect(
      installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps),
    ).rejects.toThrow('600000 ms');
    expect(probe.runner).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([5_000]);
    expect(calls()).toBe(0);
    expect(probe.destinations.every((destination) => !existsSync(destination))).toBe(true);
  });

  it('accepts verified success exactly at the shared helper deadline', async () => {
    fakeNpm('', 0);
    const probe = preflight([{ exitCode: 0, stderr: '', duration: 600_000 }]);
    await expect(
      installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps),
    ).resolves.toBe(join(root, 'previous/node_modules/.bin/board'));
    expect(probe.runner).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(probe.destinations.every((destination) => !existsSync(destination))).toBe(true);
  });

  it.each([
    ['a timed-out pack', 1, true],
    ['a late successful pack', 0, undefined],
  ])('rejects %s as registry lag', async (_name, exitCode, timedOut) => {
    fakeNpm('', 0);
    const probe = preflight([
      { exitCode, stderr: '', duration: 600_001, ...(timedOut ? { timedOut: true } : {}) },
    ]);
    await expect(
      installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps),
    ).rejects.toThrow('npm registry lag for spur-board@0.62.1: tarball not ready within 600000 ms');
    expect(probe.runner).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(0);
    expect(sleeps).toEqual([]);
    expect(probe.destinations.every((destination) => !existsSync(destination))).toBe(true);
  });

  it.each([
    ['integrity mismatch', 'npm error code EINTEGRITY'],
    ['DNS failure', DNS_FAILURE],
    ['packument 404', PACKUMENT_404],
  ])('fails preflight immediately on %s', async (_name, stderr) => {
    fakeNpm('', 0);
    const probe = preflight([{ exitCode: 1, stderr, duration: 100 }]);
    await expect(
      installPublished('spur-board@0.62.1', join(root, 'previous'), probe.deps),
    ).rejects.toThrow(stderr);
    expect(probe.runner).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(0);
    expect(sleeps).toEqual([]);
    expect(probe.destinations.every((destination) => !existsSync(destination))).toBe(true);
  });

  it('gives up on a persistent tarball 404 after the bounded schedule', async () => {
    fakeNpm(TARBALL_404, 99);
    const failure = installPublished('spur-board@0.62.1', join(root, 'previous'), deps);
    await expect(failure).rejects.toThrow('spur-board@0.62.1');
    await expect(failure).rejects.toThrow('8 attempts');
    await expect(failure).rejects.toThrow('60000 ms');
    expect(calls()).toBe(8);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(15_000);
  });

  it.each([
    ['a DNS failure', DNS_FAILURE],
    ['a packument 404', PACKUMENT_404],
  ])('fails at once on %s', async (_name, stderr) => {
    fakeNpm(stderr, 99);
    await expect(
      installPublished('spur-board@0.62.1', join(root, 'previous'), deps),
    ).rejects.toThrow('Tarball install failed');
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
