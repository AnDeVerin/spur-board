import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import semanticRelease from 'semantic-release';
import { createReleasePackage, publishTarball } from './release-package.ts';

const require = createRequire(import.meta.url);
const config = require('../release.config.cjs') as {
  branches: string[];
  plugins: Array<string | [string, Record<string, unknown>]>;
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(message: string): { repo: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'release-policy-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '-b', 'main', repo);
  git(root, 'init', '-q', '--bare', remote);
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'chore: bootstrap');
  git(repo, 'tag', 'v0.1.0');
  writeFileSync(join(repo, 'README.md'), 'changed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', message);
  git(repo, 'push', '-q', '--tags', 'origin', 'main');
  return { repo, remote };
}

describe('release policy', () => {
  it('publishes only the CLI package and produces a changelog artifact', () => {
    expect(config.branches).toEqual(['main']);
    expect(config.plugins).toContainEqual([
      require.resolve('@semantic-release/npm'),
      { pkgRoot: 'packages/cli', npmPublish: false },
    ]);
    expect(config.plugins).toContainEqual([
      require.resolve('@semantic-release/changelog'),
      { changelogFile: 'RELEASE_CHANGELOG.md' },
    ]);
    expect(config.plugins).toContainEqual([
      require.resolve('@semantic-release/github'),
      { assets: ['RELEASE_CHANGELOG.md'] },
    ]);
    const plugins = config.plugins.map((plugin) =>
      typeof plugin === 'string' ? plugin : plugin[0],
    );
    expect(plugins.indexOf(require.resolve('@semantic-release/npm'))).toBeLessThan(
      plugins.indexOf(require.resolve('./release-package.ts')),
    );
    expect(plugins.indexOf(require.resolve('./release-package.ts'))).toBeLessThan(
      plugins.indexOf(require.resolve('@semantic-release/github')),
    );
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ name: 'spur-board' });
  });

  it('checks and smokes the versioned tarball before publishing those same bytes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'release-artifact-'));
    const artifact = join(cwd, 'release-artifacts', 'spur-board-0.2.0.tgz');
    mkdirSync(join(cwd, 'release-artifacts'));
    writeFileSync(artifact, 'first tarball');
    const calls: string[] = [];
    const plugin = createReleasePackage({
      packPackage: () => {
        calls.push(`pack:${artifact}`);
        return artifact;
      },
      checkTarball: (path, version) => {
        calls.push(`check:${path}:${String(version)}`);
      },
      smokePackage: (path) => {
        calls.push(`smoke:${String(path)}`);
        return Promise.resolve();
      },
      smokeUpgrade: (path) => {
        calls.push(`upgrade:${String(path)}`);
        return Promise.resolve('passed');
      },
      publishTarball: (path) => {
        calls.push(`publish:${path}`);
      },
    });
    const context = { cwd, env: {}, nextRelease: { version: '0.2.0' } };
    await plugin.prepare({}, context);
    plugin.publish({}, context);
    expect(calls).toEqual([
      `pack:${artifact}`,
      `check:${artifact}:0.2.0`,
      `smoke:${artifact}`,
      `upgrade:${artifact}`,
      `publish:${artifact}`,
    ]);
    writeFileSync(artifact, 'changed tarball');
    expect(() => {
      plugin.publish({}, context);
    }).toThrow('changed after smoke');
  });

  it('passes the checked tarball to npm publish with provenance', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'release-publish-'));
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const capture = join(cwd, 'npm-args');
    const npm = join(bin, 'npm');
    writeFileSync(npm, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n');
    chmodSync(npm, 0o755);
    const tarball = join(cwd, 'spur-board-0.2.0.tgz');
    publishTarball(tarball, {
      cwd,
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, CAPTURE: capture },
      nextRelease: { version: '0.2.0' },
    });
    expect(readFileSync(capture, 'utf8')).toBe(
      `publish\n${tarball}\n--provenance\n--access\npublic\n`,
    );
  });

  it.each([
    ['feat(core)!: break API', '0.2.0', 'break API'],
    ['fix(core): repair API', '0.1.1', 'repair API'],
  ])('dry runs from v0.1.0: %s -> %s', async (message, expected, subject) => {
    const { repo, remote } = fixture(message);
    const result = await semanticRelease(
      {
        branches: ['main'],
        repositoryUrl: `file://${remote}`,
        tagFormat: 'v${version}',
        plugins: config.plugins.slice(0, 2),
        dryRun: true,
        ci: false,
      },
      {
        cwd: repo,
        env: { ...process.env, GITHUB_REF: 'refs/heads/main' },
      },
    );
    expect(result && result.nextRelease.version).toBe(expected);
    expect(result && result.nextRelease.notes).toContain(subject);
  });
});
