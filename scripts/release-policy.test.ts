import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import semanticRelease from 'semantic-release';
import { dryRunEnv, nextVersion } from './release-candidate.ts';
import { createReleasePackage, digest, publishTarball } from './release-package.ts';

const require = createRequire(import.meta.url);
const config = require('../release.config.cjs') as {
  branches: string[];
  plugins: Array<string | [string, Record<string, unknown>]>;
};
// Swallows semantic-release logs so a passing run prints nothing.
const quiet = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
}) as unknown as NodeJS.WriteStream;

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

function fixture(message: string, tag = 'v0.1.0'): { repo: string; remote: string } {
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
  git(repo, 'tag', tag);
  writeFileSync(join(repo, 'README.md'), 'changed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', message);
  git(repo, 'push', '-q', '--tags', 'origin', 'main');
  return { repo, remote };
}

type Plugin = string | [string, Record<string, unknown>];

/** release.config.cjs as it loads with RELEASE_CHANGELOG_COMMIT set to `gate`. */
function loadConfig(gate: string | undefined): { plugins: Plugin[] } {
  const path = require.resolve('../release.config.cjs');
  const saved = process.env['RELEASE_CHANGELOG_COMMIT'];
  if (gate === undefined) delete process.env['RELEASE_CHANGELOG_COMMIT'];
  else process.env['RELEASE_CHANGELOG_COMMIT'] = gate;
  try {
    Reflect.deleteProperty(require.cache, path);
    return require(path) as { plugins: Plugin[] };
  } finally {
    Reflect.deleteProperty(require.cache, path);
    if (saved === undefined) delete process.env['RELEASE_CHANGELOG_COMMIT'];
    else process.env['RELEASE_CHANGELOG_COMMIT'] = saved;
  }
}

function pluginName(plugin: Plugin): string {
  return typeof plugin === 'string' ? plugin : plugin[0];
}

function pluginOptions(plugin: Plugin | undefined): Record<string, unknown> {
  return plugin === undefined || typeof plugin === 'string' ? {} : plugin[1];
}

/** A short label per plugin: the module, plus the file for a changelog entry. */
function pluginLabels(plugins: Plugin[]): string[] {
  return plugins.map((plugin) => {
    const name = pluginName(plugin);
    const label = name.replace(/^.*\/node_modules\/@semantic-release\/([^/]+)\/.*$/, '$1');
    const file = pluginOptions(plugin)['changelogFile'];
    return typeof file === 'string' ? `${label}:${file}` : label.replace(/^.*\/scripts\//, '');
  });
}

const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);

/** The gate-on plugins a changelog commit needs, in config order. */
function changelogCommitPlugins(): Plugin[] {
  const keep = ['release-analyzer.ts', 'release-notes-generator', 'changelog:CHANGELOG.md', 'git'];
  const plugins = loadConfig('true').plugins;
  const labels = pluginLabels(plugins);
  return plugins.filter((_plugin, index) => keep.includes(labels[index] ?? ''));
}

function changelogTitle(): string {
  const entry = loadConfig('true').plugins.find(
    (plugin) => pluginOptions(plugin)['changelogFile'] === 'CHANGELOG.md',
  );
  const title = pluginOptions(entry)['changelogTitle'];
  if (typeof title !== 'string') throw new Error('No changelogTitle for CHANGELOG.md.');
  return title;
}

/** A fixture whose main has a CHANGELOG.md with an older entry and a feat to release. */
function changelogFixture(): { repo: string; remote: string; title: string } {
  const { repo, remote } = fixture('feat(core): add API');
  const title = changelogTitle();
  writeFileSync(join(repo, 'CHANGELOG.md'), `${title}\n\n## Older\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'docs: add changelog');
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, remote, title };
}

function releaseWithChangelog(repo: string, remote: string) {
  return semanticRelease(
    {
      branches: ['main'],
      repositoryUrl: `file://${remote}`,
      tagFormat: 'v${version}',
      plugins: changelogCommitPlugins(),
      ci: false,
    },
    { cwd: repo, env: dryRunEnv(process.env), stdout: quiet, stderr: quiet },
  );
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
    const [analyzer, notes] = config.plugins;
    expect(pluginName(analyzer ?? '')).toBe(require.resolve('./release-analyzer.ts'));
    expect((pluginOptions(analyzer)['releaseRules'] as unknown[])[0]).toEqual({
      breaking: true,
      release: 'major',
    });
    for (const plugin of [analyzer, notes]) {
      expect(pluginOptions(plugin)['parserOpts']).toMatchObject({ fieldPattern: null });
    }
    expect(pluginName(notes ?? '')).toBe(
      require.resolve('@semantic-release/release-notes-generator'),
    );
    expect(
      typeof (pluginOptions(notes)['writerOpts'] as Record<string, unknown>)['finalizeContext'],
    ).toBe('function');
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ name: 'spur-board' });
  });

  it('loads the changelog commit only when RELEASE_CHANGELOG_COMMIT is true', () => {
    const off = [
      'release-analyzer.ts',
      'release-notes-generator',
      'changelog:RELEASE_CHANGELOG.md',
      'npm',
      'release-package.ts',
      'github',
    ];
    for (const gate of [undefined, '', 'false', 'TRUE', '1']) {
      expect(pluginLabels(loadConfig(gate).plugins), String(gate)).toEqual(off);
    }
    const on = loadConfig('true').plugins;
    expect(pluginLabels(on)).toEqual([
      'release-analyzer.ts',
      'release-notes-generator',
      'changelog:RELEASE_CHANGELOG.md',
      'changelog:CHANGELOG.md',
      'npm',
      'release-package.ts',
      'git',
      'github',
    ]);
    const commit = pluginOptions(on.find((plugin) => pluginLabels([plugin])[0] === 'git'));
    expect(commit['assets']).toEqual(['CHANGELOG.md']);
    expect(commit['message']).toContain('[skip ci]');
  });

  it('CHANGELOG.md starts with the configured changelog title', () => {
    const title = changelogTitle();
    expect(title).toContain('https://github.com/AnDeVerin/spur-board/releases');
    expect(readFileSync(CHANGELOG, 'utf8').startsWith(`${title}\n\n`)).toBe(true);
  });

  it('commits CHANGELOG.md before the tag', async () => {
    const { repo, remote, title } = changelogFixture();
    const result = await releaseWithChangelog(repo, remote);
    expect(result ? result.nextRelease.version : null).toBe('0.2.0');
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): 0.2.0 [skip ci]');
    expect(git(remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main')).toBe(
      'CHANGELOG.md',
    );
    expect(git(remote, 'rev-list', '-n1', 'v0.2.0')).toBe(git(remote, 'rev-parse', 'main'));
    const changelog = git(remote, 'show', 'main:CHANGELOG.md');
    expect(changelog.startsWith(`${title}\n\n`)).toBe(true);
    expect(changelog.indexOf('0.2.0')).toBeGreaterThan(title.length);
    expect(changelog.indexOf('0.2.0')).toBeLessThan(changelog.indexOf('## Older'));
  });

  it('publishes no tag when the changelog push is refused', async () => {
    const { repo, remote } = changelogFixture();
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read -r old new ref; do\n  [ "$ref" = refs/heads/main ] && exit 1\ndone\nexit 0\n',
    );
    chmodSync(hook, 0o755);
    const main = git(remote, 'rev-parse', 'main');
    await expect(releaseWithChangelog(repo, remote)).rejects.toThrow();
    expect(git(repo, 'ls-remote', '--tags', 'origin')).not.toContain('v0.2.0');
    expect(git(remote, 'rev-parse', 'main')).toBe(main);
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

  const breakingFooter = 'BREAKING CHANGE: migrate the config';
  it.each([
    {
      name: 'breaking',
      tag: 'v0.1.0',
      message: 'feat(core)!: break API',
      version: '0.2.0',
      contain: ['break API'],
      lack: [],
    },
    {
      name: 'fix',
      tag: 'v0.1.0',
      message: 'fix(core): repair API',
      version: '0.1.1',
      contain: ['repair API'],
      lack: [],
    },
    {
      name: 'breaking from 1.x',
      tag: 'v1.2.0',
      message: 'feat(core)!: break API',
      version: '2.0.0',
      contain: ['break API'],
      lack: [],
    },
    {
      name: 'footer after a dash line',
      tag: 'v1.2.0',
      message: `feat(core): add API\n\n- [x] item -\nwrapped\n\n${breakingFooter}\n\nCloses #1`,
      version: '2.0.0',
      contain: ['BREAKING CHANGES', 'migrate the config'],
      lack: [],
    },
    {
      name: 'footer after a dash line from 0.x',
      tag: 'v0.1.0',
      message: `feat(core): add API\n\n- [x] item -\nwrapped\n\n${breakingFooter}\n\nCloses #1`,
      version: '0.2.0',
      contain: ['migrate the config'],
      lack: [],
    },
    {
      name: 'footer cut at a # line',
      tag: 'v0.1.0',
      message: `feat(core): add API\n\n${breakingFooter}\nsee #5 first\ntail text\n\nCloses #1`,
      version: '0.2.0',
      contain: ['migrate the config'],
      lack: ['tail text'],
    },
    {
      name: 'only closing references',
      tag: 'v0.1.0',
      message: 'feat(core): add API\n\nFollows #5 here\n\nCloses #9',
      version: '0.2.0',
      contain: ['closes [#9]'],
      lack: ['[#5]'],
    },
    {
      name: 'lowercase breaking-change line',
      tag: 'v0.1.0',
      message: 'chore(agents): add skill\n\nbreaking-change rules | x |',
      version: null,
      contain: [],
      lack: [],
    },
    {
      name: 'footer above Closes and squash trailers',
      tag: 'v0.1.0',
      message: `feat(core): add API\n\n${breakingFooter}\n\nCloses #1\n\n[AI-generated, session: sb-1]\n\n---------\n\nCo-authored-by: A <a@example.com>`,
      version: '0.2.0',
      contain: ['migrate the config', 'closes [#1]'],
      lack: ['AI-generated', 'Co-authored-by'],
    },
  ])('dry runs from $tag: $name -> $version', async ({ tag, message, version, contain, lack }) => {
    const { repo, remote } = fixture(message, tag);
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
        stdout: quiet,
        stderr: quiet,
      },
    );
    expect(result ? result.nextRelease.version : null).toBe(version);
    const notes = result ? result.nextRelease.notes : '';
    for (const text of contain) expect(notes).toContain(text);
    for (const text of lack) expect(notes).not.toContain(text);
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

  it.each<[string, string | null, string?]>([
    ['feat(core)!: break API', '0.2.0'],
    ['fix(core): repair API', '0.1.1'],
    ['chore: tidy', null],
    ['feat(core)!: break API', '2.0.0', 'v1.2.0'],
  ])('computes the next version from a mirror: %s -> %s', async (message, expected, tag) => {
    const { repo } = fixture(message, tag);
    // A dispatch checkout: on a feature branch, with no local main.
    git(repo, 'checkout', '-qb', 'feature');
    git(repo, 'branch', '-qD', 'main');
    const version = await nextVersion(
      repo,
      {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/feature',
      },
      quiet,
    );
    expect(version).toBe(expected);
  });
});
