import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { packPackage } from './package.ts';
import {
  credentialFreeEnv,
  installPackage,
  installedVersion,
  isTarballPath,
  retryTarball404,
  smokeInstalled,
} from './package-smoke.ts';

function parts(version: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a stable version: ${version}`);
  return version.split('.').map(Number);
}

function compare(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Find the newest published stable package to seed the upgrade database. */
export function latestPublishedVersion(output: string): string | null {
  const parsed: unknown = JSON.parse(output) as unknown;
  const versions = typeof parsed === 'string' ? [parsed] : parsed;
  if (!Array.isArray(versions) || !versions.every((value) => typeof value === 'string')) {
    throw new Error('Registry returned an invalid version list.');
  }
  const stable = versions.filter((value: string) => /^\d+\.\d+\.\d+$/.test(value));
  stable.sort(compare);
  return stable.at(-1) ?? null;
}

export function registryVersions(
  status: number | null,
  stdout: string,
  stderr: string,
): string | null {
  if (status === 0) return latestPublishedVersion(stdout);
  if (/\bE404\b/.test(stderr) && /registry\.npmjs\.org\/spur-board/.test(stderr)) return null;
  throw new Error(`Could not read published versions: ${stderr || stdout}`);
}

/** The npmjs tarball path of an `npm install` 404, or undefined for any other failure. */
function tarball404Path(result: string | Error): string | undefined {
  if (typeof result === 'string' || !/\bcode E404\b/.test(result.message)) return undefined;
  const path = /GET https:\/\/registry\.npmjs\.org(\/\S+)/.exec(result.message)?.[1];
  return path !== undefined && isTarballPath(path) ? path : undefined;
}

interface InstallDeps {
  sleep: (ms: number) => Promise<unknown>;
  log: (text: string) => void;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
  run?: (
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => { status: number | null; stdout: string; stderr: string; error?: Error };
}

const installDeps: InstallDeps = {
  sleep: (ms) => delay(ms),
  log: (text) => process.stdout.write(`${text}\n`),
};

const READINESS_TIMEOUT_MS = 600_000;

/** npm pack downloads the exact version and verifies its registry integrity before installation. */
async function waitForTarball(spec: string, deps: InstallDeps): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const run = deps.run ?? ((args, options) => spawnSync('npm', args, options));
  const started = now();
  const temporary = mkdtempSync(join(tmpdir(), 'spur-board-upgrade-pack-'));
  const lagError = () =>
    new Error(
      `upgrade smoke: npm registry lag for ${spec}: tarball not ready within ${String(READINESS_TIMEOUT_MS)} ms`,
    );
  try {
    let attempt = 0;
    for (;;) {
      const remaining = READINESS_TIMEOUT_MS - (now() - started);
      if (remaining <= 0) throw lagError();
      const result = run(['pack', spec, '--pack-destination', temporary, '--ignore-scripts'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: credentialFreeEnv(deps.environment ?? process.env),
        timeout: Math.max(1, Math.floor(remaining)),
        killSignal: 'SIGKILL',
      });
      const elapsed = now() - started;
      const timedOut =
        result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT';
      if (timedOut) throw lagError();
      const failure = new Error(`Tarball preflight failed: ${result.stderr || result.stdout}`, {
        cause: result.error,
      });
      if (result.status !== 0 && tarball404Path(failure) === undefined) throw failure;
      if (elapsed >= READINESS_TIMEOUT_MS) throw lagError();
      if (result.status === 0) return;
      const wait = Math.min(
        [5_000, 10_000, 20_000][attempt++] ?? 30_000,
        READINESS_TIMEOUT_MS - elapsed,
      );
      deps.log(
        `upgrade smoke: npm registry lag/404 for ${spec}, elapsed ${String(Math.floor(elapsed))} ms, retrying in ${String(wait)} ms (bound ${String(READINESS_TIMEOUT_MS)} ms)`,
      );
      await deps.sleep(wait);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Waits for a verified published tarball, then installs it with dependency-tarball retries.
 */
export async function installPublished(
  spec: string,
  prefix: string,
  deps: InstallDeps = installDeps,
): Promise<string> {
  await waitForTarball(spec, deps);
  const { result, attempts, waitedMs } = await retryTarball404<string | Error>(
    () => {
      try {
        return installPackage(spec, prefix);
      } catch (error) {
        if (error instanceof Error) return error;
        throw error;
      }
    },
    (result) => tarball404Path(result) !== undefined,
    (failure, tries, wait, waited) => {
      deps.log(
        `upgrade smoke: 404 on ${String(tarball404Path(failure))} installing ${spec}, attempt ${String(tries)}, retrying in ${String(wait)} ms (waited ${String(waited)} ms)`,
      );
    },
    deps.sleep,
  );
  if (typeof result === 'string') return result;
  const path = tarball404Path(result);
  if (path === undefined) throw result;
  throw new Error(
    `upgrade smoke: ${spec} still answers 404 for ${path} after ${String(attempts)} attempts, waited ${String(waitedMs)} ms (npmjs has not served the tarball yet): ${result.message.replace(/^Tarball install failed: /, '')}`,
  );
}

export async function smokeUpgrade(tarball?: string): Promise<'skipped' | 'passed'> {
  const lookup = spawnSync('npm', ['view', 'spur-board', 'versions', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: credentialFreeEnv(process.env),
  });
  const previous = registryVersions(lookup.status, lookup.stdout, lookup.stderr);
  if (previous === null) {
    process.stdout.write('upgrade smoke: skipped (no previous published version)\n');
    return 'skipped';
  }
  const temporary = mkdtempSync(join(tmpdir(), 'spur-board-upgrade-smoke-'));
  try {
    const previousBinary = await installPublished(
      `spur-board@${previous}`,
      join(temporary, 'previous'),
    );
    const home = join(temporary, 'home');
    await smokeInstalled(previousBinary, home, previous, true);
    const candidate = tarball ?? packPackage(temporary);
    const candidatePrefix = join(temporary, 'candidate');
    const candidateBinary = installPackage(candidate, candidatePrefix);
    const version = installedVersion(candidatePrefix);
    await smokeInstalled(candidateBinary, home, version);
    process.stdout.write(`upgrade smoke: ${previous} to ${version} ok\n`);
    return 'passed';
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokeUpgrade(process.argv[2]);
