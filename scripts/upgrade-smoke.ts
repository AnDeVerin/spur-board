import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage } from './package.ts';
import { installPackage, smokeInstalled } from './package-smoke.ts';

const packageManifest = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));

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

export async function smokeUpgrade(tarball?: string): Promise<'skipped' | 'passed'> {
  const manifest = JSON.parse(readFileSync(packageManifest, 'utf8')) as { version: string };
  const lookup = spawnSync('npm', ['view', 'spur-board', 'versions', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const previous = registryVersions(lookup.status, lookup.stdout, lookup.stderr);
  if (previous === null) {
    process.stdout.write('upgrade smoke: skipped (no previous published version)\n');
    return 'skipped';
  }
  const temporary = mkdtempSync(join(tmpdir(), 'spur-board-upgrade-smoke-'));
  try {
    const previousBinary = installPackage(`spur-board@${previous}`, join(temporary, 'previous'));
    const home = join(temporary, 'home');
    await smokeInstalled(previousBinary, home, previous, true);
    const candidate = tarball ?? packPackage(temporary);
    const candidateBinary = installPackage(candidate, join(temporary, 'candidate'));
    await smokeInstalled(candidateBinary, home, manifest.version);
    process.stdout.write(`upgrade smoke: ${previous} to ${manifest.version} ok\n`);
    return 'passed';
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokeUpgrade(process.argv[2]);
