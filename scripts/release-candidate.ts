// Pack the release candidate in a job without publish credentials.
//   node scripts/release-candidate.ts <destination>
// Prints `version=<x.y.z>` and `sha256=<hex>` to stdout for $GITHUB_OUTPUT; logs go to stderr.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semanticRelease from 'semantic-release';
import { checkTarball, packPackage } from './package.ts';
import { credentialFreeEnv } from './package-smoke.ts';
import { digest } from './release-package.ts';
import { patchManifest } from './update-smoke.ts';

const require = createRequire(import.meta.url);
const config = require('../release.config.cjs') as {
  branches: string[];
  tagFormat: string;
  plugins: Array<string | [string, Record<string, unknown>]>;
};
const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = join(root, 'packages/cli/package.json');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The dry run's env: no runner credentials, and a push to main whatever event started it. */
export function dryRunEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...credentialFreeEnv(env),
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
  };
}

/**
 * The version semantic-release would publish for HEAD of `cwd`, or null when no release is due.
 * Runs against a local mirror with `main` at HEAD, so it needs no token and pushes nothing.
 */
export async function nextVersion(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const analyzer = config.plugins.find(
    (plugin) =>
      (typeof plugin === 'string' ? plugin : plugin[0]) ===
      require.resolve('@semantic-release/commit-analyzer'),
  );
  if (analyzer === undefined) throw new Error('release.config.cjs has no commit analyzer.');
  const temporary = mkdtempSync(join(tmpdir(), 'spur-board-release-candidate-'));
  try {
    const mirror = join(temporary, 'mirror.git');
    const work = join(temporary, 'work');
    git(cwd, 'clone', '--bare', '--quiet', cwd, mirror);
    git(cwd, '--git-dir', mirror, 'update-ref', 'refs/heads/main', git(cwd, 'rev-parse', 'HEAD'));
    // semantic-release reads tags merged into its local `main`, which a branch checkout may lack.
    git(temporary, 'clone', '--quiet', '--no-checkout', '--branch', 'main', mirror, work);
    const result = await semanticRelease(
      {
        branches: config.branches,
        tagFormat: config.tagFormat,
        repositoryUrl: `file://${mirror}`,
        plugins: [analyzer],
        dryRun: true,
        ci: false,
      },
      { cwd: work, env: dryRunEnv(env), stdout: process.stderr, stderr: process.stderr },
    );
    return result ? result.nextRelease.version : null;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function buildCandidate(destination: string, version: string): { tarball: string; sha256: string } {
  const original = readFileSync(manifestPath, 'utf8');
  try {
    if ((JSON.parse(original) as { version: string }).version !== version) {
      writeFileSync(manifestPath, patchManifest(original, version));
    }
    const tarball = packPackage(destination);
    checkTarball(tarball, version);
    return { tarball, sha256: digest(tarball) };
  } finally {
    writeFileSync(manifestPath, original);
  }
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (destination === undefined) throw new Error('Usage: node scripts/release-candidate.ts <dir>');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  const version = (await nextVersion(root, process.env)) ?? manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version: ${version}`);
  const { sha256 } = buildCandidate(resolve(destination), version);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Unexpected sha256: ${sha256}`);
  process.stdout.write(`version=${version}\nsha256=${sha256}\n`);
}
