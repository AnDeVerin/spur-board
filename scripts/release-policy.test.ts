import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import semanticRelease from 'semantic-release';

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
      { pkgRoot: 'packages/cli' },
    ]);
    expect(config.plugins).toContainEqual([
      require.resolve('@semantic-release/changelog'),
      { changelogFile: 'RELEASE_CHANGELOG.md' },
    ]);
    expect(config.plugins).toContainEqual([
      require.resolve('@semantic-release/github'),
      { assets: ['RELEASE_CHANGELOG.md'] },
    ]);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ name: 'spur-board' });
  });

  it.each([
    ['feat(core)!: break API', '0.2.0'],
    ['fix(core): repair API', '0.1.1'],
  ])('dry runs from v0.1.0: %s -> %s', async (message, expected) => {
    const { repo, remote } = fixture(message);
    const analyzer = config.plugins[0];
    const result = await semanticRelease(
      {
        branches: ['main'],
        repositoryUrl: `file://${remote}`,
        tagFormat: 'v${version}',
        plugins: analyzer === undefined ? [] : [analyzer],
        dryRun: true,
        ci: false,
      },
      {
        cwd: repo,
        env: { ...process.env },
      },
    );
    expect(result && result.nextRelease.version).toBe(expected);
  });
});
