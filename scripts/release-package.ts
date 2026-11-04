import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTarball, packPackage } from './package.ts';
import { smokePackage } from './package-smoke.ts';
import { smokeUpgrade } from './upgrade-smoke.ts';

interface ReleaseContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  nextRelease: { version: string };
}

interface ReleaseChecks {
  packPackage: typeof packPackage;
  checkTarball: typeof checkTarball;
  smokePackage: typeof smokePackage;
  smokeUpgrade: typeof smokeUpgrade;
  publishTarball: (tarball: string, context: ReleaseContext) => void;
}

function tarballPath(context: ReleaseContext): string {
  return join(context.cwd, 'release-artifacts', `spur-board-${context.nextRelease.version}.tgz`);
}

function digest(path: string): string {
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

/** Pack after semantic-release/npm sets the version, then publish the checked bytes. */
export function createReleasePackage(
  checks: ReleaseChecks = {
    packPackage,
    checkTarball,
    smokePackage,
    smokeUpgrade,
    publishTarball,
  },
) {
  let prepared: { tarball: string; digest: string } | undefined;
  return {
    prepare: async (_config: unknown, context: ReleaseContext): Promise<void> => {
      const tarball = checks.packPackage(join(context.cwd, 'release-artifacts'));
      if (tarball !== tarballPath(context)) {
        throw new Error('Packed tarball name differs from the release version.');
      }
      checks.checkTarball(tarball, context.nextRelease.version);
      await checks.smokePackage(tarball);
      await checks.smokeUpgrade(tarball);
      prepared = { tarball, digest: digest(tarball) };
    },
    publish: (_config: unknown, context: ReleaseContext): void => {
      const tarball = tarballPath(context);
      if (prepared?.tarball !== tarball || prepared.digest !== digest(tarball)) {
        throw new Error('Release tarball changed after smoke.');
      }
      checks.publishTarball(tarball, context);
    },
  };
}

const plugin = createReleasePackage();
export const prepare = plugin.prepare;
export const publish = plugin.publish;
