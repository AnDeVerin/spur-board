import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import semanticRelease from 'semantic-release';
import { dryRunEnv, nextVersion } from './release-candidate.ts';
import { createReleasePackage, digest, publishTarball } from './release-package.ts';

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

  function candidate(contents = 'candidate tarball') {
    const cwd = mkdtempSync(join(tmpdir(), 'release-artifact-'));
    const artifact = join(cwd, 'release-artifacts', 'spur-board-0.2.0.tgz');
    mkdirSync(join(cwd, 'release-artifacts'));
    writeFileSync(artifact, contents);
    const calls: string[] = [];
    const plugin = createReleasePackage({
      checkTarball: (path, version) => {
        calls.push(`check:${path}:${String(version)}`);
      },
      publishTarball: (path) => {
        calls.push(`publish:${path}`);
      },
    });
    const env = { RELEASE_CANDIDATE_VERSION: '0.2.0', RELEASE_CANDIDATE_SHA256: digest(artifact) };
    return { cwd, artifact, calls, plugin, env, nextRelease: { version: '0.2.0' } };
  }

  it('checks the downloaded candidate and publishes those same bytes', () => {
    const { cwd, artifact, calls, plugin, env, nextRelease } = candidate();
    const context = { cwd, env, nextRelease };
    plugin.prepare({}, context);
    plugin.publish({}, context);
    expect(calls).toEqual([`check:${artifact}:0.2.0`, `publish:${artifact}`]);
    writeFileSync(artifact, 'changed tarball');
    expect(() => {
      plugin.publish({}, context);
    }).toThrow('changed after');
  });

  it('refuses a candidate built for another version', () => {
    const { cwd, calls, plugin, env } = candidate();
    expect(() => {
      plugin.prepare({}, { cwd, env, nextRelease: { version: '0.3.0' } });
    }).toThrow('re-run all jobs');
    expect(() => {
      plugin.prepare(
        {},
        {
          cwd,
          env: { ...env, RELEASE_CANDIDATE_VERSION: '0.1.9' },
          nextRelease: { version: '0.2.0' },
        },
      );
    }).toThrow('re-run all jobs');
    expect(calls).toEqual([]);
  });

  it('refuses a candidate whose sha256 differs and never publishes it', () => {
    const { cwd, calls, plugin, env, nextRelease } = candidate();
    const context = { cwd, env: { ...env, RELEASE_CANDIDATE_SHA256: 'a'.repeat(64) }, nextRelease };
    expect(() => {
      plugin.prepare({}, context);
    }).toThrow('differs from');
    expect(() => {
      plugin.prepare({}, { ...context, env: { ...env, RELEASE_CANDIDATE_SHA256: '' } });
    }).toThrow('not a sha256');
    expect(() => {
      plugin.publish({}, context);
    }).toThrow('changed after');
    expect(calls).toEqual([]);
  });

  it('refuses a missing candidate', () => {
    const { cwd, artifact, calls, plugin, env, nextRelease } = candidate();
    rmSync(artifact);
    expect(() => {
      plugin.prepare({}, { cwd, env, nextRelease });
    }).toThrow('missing');
    expect(calls).toEqual([]);
  });

  it('leaves smoke to release-smoke', () => {
    const source = readFileSync(new URL('./release-package.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('./package-smoke.ts');
    expect(source).not.toContain('./upgrade-smoke.ts');
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

  it('builds a dry-run env with no runner credentials', () => {
    const env = dryRunEnv({
      GITHUB_TOKEN: 'sentinel-gh',
      GH_TOKEN: 'sentinel-gh2',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'sentinel-oidc-url',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'sentinel-oidc',
      ACTIONS_RUNTIME_TOKEN: 'sentinel-rt',
      GITHUB_EVENT_PATH: 'sentinel-event',
      npm_config__authToken: 'sentinel-npm',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/heads/feature',
      PATH: '/usr/bin',
      HOME: '/home/x',
    });
    expect(Object.values(env).filter((value) => value?.startsWith('sentinel-'))).toEqual([]);
    const names = Object.keys(env);
    expect(names.filter((name) => /^ACTIONS_/i.test(name))).toEqual([]);
    expect(names.filter((name) => /^npm_config_/i.test(name))).toEqual([]);
    expect(
      Object.fromEntries(Object.entries(env).filter(([name]) => /^GITHUB_/i.test(name))),
    ).toEqual({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' });
    expect(names).not.toContain('GH_TOKEN');
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x' });
  });

  it.each([
    ['feat(core)!: break API', '0.2.0'],
    ['fix(core): repair API', '0.1.1'],
    ['chore: tidy', null],
  ])('computes the next version from a mirror: %s -> %s', async (message, expected) => {
    const { repo } = fixture(message);
    // A dispatch checkout: on a feature branch, with no local main.
    git(repo, 'checkout', '-qb', 'feature');
    git(repo, 'branch', '-qD', 'main');
    const version = await nextVersion(repo, {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/feature',
    });
    expect(version).toBe(expected);
  });
});
