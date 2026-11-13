import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTarball } from './package.ts';

interface ReleaseContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  nextRelease: { version: string };
}

interface ReleaseChecks {
  checkTarball: typeof checkTarball;
  publishTarball: (tarball: string, context: ReleaseContext) => void;
}

function tarballPath(context: ReleaseContext): string {
  return join(context.cwd, 'release-artifacts', `spur-board-${context.nextRelease.version}.tgz`);
}

export function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function publishTarball(tarball: string, context: ReleaseContext): void {
  const result = spawnSync('npm', ['publish', tarball, '--provenance', '--access', 'public'], {
    cwd: context.cwd,
    env: context.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`npm publish of checked tarball failed (exit ${String(result.status)}).`);
  }
}

const RERUN = 're-run all jobs of this workflow run';

/**
 * Publish the candidate `release-build` packed and `release-smoke` checked: the downloaded
 * tarball must match the version and sha256 that job reported and the version semantic-release
 * computed now.
 */
export function createReleasePackage(checks: ReleaseChecks = { checkTarball, publishTarball }) {
  let prepared: { tarball: string; digest: string } | undefined;
  return {
    prepare: (_config: unknown, context: ReleaseContext): void => {
      const version = context.nextRelease.version;
      const candidate = context.env['RELEASE_CANDIDATE_VERSION'];
      if (candidate !== version) {
        throw new Error(
          `Release candidate ${String(candidate)} differs from release ${version}; ${RERUN}.`,
        );
      }
      const tarball = tarballPath(context);
      if (!existsSync(tarball))
        throw new Error(`Release candidate ${tarball} is missing; ${RERUN}.`);
      const expected = context.env['RELEASE_CANDIDATE_SHA256'] ?? '';
      if (!/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error('RELEASE_CANDIDATE_SHA256 is not a sha256 hex digest.');
      }
      const actual = digest(tarball);
      if (actual !== expected) {
        throw new Error(`Release candidate sha256 ${actual} differs from ${expected}; ${RERUN}.`);
      }
      checks.checkTarball(tarball, version);
      prepared = { tarball, digest: actual };
    },
    publish: (_config: unknown, context: ReleaseContext): void => {
      const tarball = tarballPath(context);
      if (prepared?.tarball !== tarball || prepared.digest !== digest(tarball)) {
        throw new Error('Release tarball changed after prepare.');
      }
      checks.publishTarball(tarball, context);
    },
  };
}

const plugin = createReleasePackage();
export const prepare = plugin.prepare;
export const publish = plugin.publish;
