import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatTargets, gitleaksVerdict, isOnlyIndex, partiallyStaged } from './hooks.ts';

const SCRIPT = fileURLToPath(new URL('./hooks.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NO_LEAKS = { output: '8:16PM INF no leaks found', exit: 0 };

// The variables git exports to hooks. Removed from every child env so a test run started from
// a git hook never acts on this repository.
const LOCAL_ENV = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
  .stdout.split('\n')
  .filter((name) => name !== '');

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  for (const name of [...LOCAL_ENV, 'CI']) Reflect.deleteProperty(env, name);
  return { ...env, ...extra };
}

interface Fake {
  output: string;
  exit: number;
}

// A fake executable that records its arguments (and `env` when asked) next to itself.
function fakeBin(
  dir: string,
  name: string,
  fake: Fake,
  recordEnv = false,
  recordStdin = false,
): void {
  writeFileSync(
    join(dir, name),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${join(dir, `${name}.args`)}'`,
      recordEnv ? `env > '${join(dir, `${name}.env`)}'` : '',
      recordStdin ? `cat > '${join(dir, `${name}.stdin`)}'` : '',
      `printf '%s\\n' '${fake.output}'`,
      `exit ${String(fake.exit)}`,
    ].join('\n'),
  );
  chmodSync(join(dir, name), 0o755);
}

function recorded(dir: string, file: string): string[] | undefined {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : undefined;
}

// A temp repo with one commit, a fake gitleaks first on PATH and the real pre-commit hook
// (this checkout's scripts/hooks.ts) installed through core.hooksPath.
function sandbox(gitleaks: Fake = NO_LEAKS) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  const bin = join(dir, 'bin');
  const hooks = join(dir, 'hooks');
  const repo = join(dir, 'repo');
  mkdirSync(bin);
  mkdirSync(hooks);
  fakeBin(bin, 'gitleaks', gitleaks);
  writeFileSync(
    join(hooks, 'pre-commit'),
    `#!/bin/sh\nexec '${process.execPath}' '${SCRIPT}' pre-commit "$@"\n`,
  );
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const env = cleanEnv({
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    GIT_CEILING_DIRECTORIES: dir,
  });

  const exec = (
    cmd: string,
    args: string[],
    extra: NodeJS.ProcessEnv = {},
    cwd = repo,
    input?: string,
  ) => {
    const result = spawnSync(cmd, args, {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
      input,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const tryGit = (...args: string[]) => exec('git', args);
  const git = (...args: string[]) => {
    const result = tryGit(...args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const write = (file: string, content: string) => {
    writeFileSync(join(repo, file), content);
  };
  const read = (file: string) => readFileSync(join(repo, file), 'utf8');
  const node = (
    script: string,
    args: string[],
    extra: NodeJS.ProcessEnv = {},
    cwd = repo,
    input?: string,
  ) => exec(process.execPath, [script, ...args], extra, cwd, input);
  const head = () => git('rev-parse', 'HEAD').trim();

  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  write('README.md', '# test\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('config', 'core.hooksPath', hooks);
  return { dir, bin, repo, env, git, tryGit, write, read, node, head };
}

describe('partiallyStaged', () => {
  it('returns staged files that also have unstaged changes', () => {
    expect(partiallyStaged(['a.ts', 'b.ts', 'c.ts'], ['c.ts', 'd.ts', 'a.ts'])).toEqual([
      'a.ts',
      'c.ts',
    ]);
  });

  it('returns nothing when no staged file is dirty', () => {
    expect(partiallyStaged(['a.ts'], ['b.ts'])).toEqual([]);
  });
});

describe('gitleaksVerdict', () => {
  it('passes a clean run', () => {
    expect(gitleaksVerdict(0, '8:16PM INF no leaks found')).toBeNull();
  });

  it('fails on a non-zero exit', () => {
    expect(gitleaksVerdict(1, '8:16PM WRN leaks found: 2')).toContain('exit 1');
  });

  it('fails when gitleaks exits 0 after logging a git error', () => {
    expect(gitleaksVerdict(0, '8:16PM ERR [git] fatal: detected dubious ownership')).toBe(
      'gitleaks logged an error',
    );
  });
});

describe('formatTargets', () => {
  it('keeps added, copied, modified and renamed paths and drops symlinks and submodules', () => {
    const raw = [
      ':000000 100644 0000000 1111111 A',
      'a.ts',
      ':100644 100644 1111111 2222222 M',
      'dir/b with space.md',
      ':100644 100644 1111111 1111111 R100',
      'old.ts',
      'new.ts',
      ':100644 100644 1111111 1111111 C75',
      'src.ts',
      'copy.ts',
      ':000000 120000 0000000 3333333 A',
      'link.ts',
      ':000000 160000 0000000 4444444 A',
      'sub',
      '',
    ].join('\0');
    expect(formatTargets(raw)).toEqual(['a.ts', 'dir/b with space.md', 'new.ts', 'copy.ts']);
  });

  it('returns nothing for an empty diff', () => {
    expect(formatTargets('')).toEqual([]);
  });

  it('drops a staged symlink from the real git output', () => {
    const box = sandbox();
    box.write('a.ts', 'const a = 1;\n');
    symlinkSync('a.ts', join(box.repo, 'link.ts'));
    box.git('add', 'a.ts', 'link.ts');
    const raw = box.git('diff', '--cached', '--raw', '-z', '--diff-filter=ACMR');
    expect(formatTargets(raw)).toEqual(['a.ts']);
  });
});

describe('isOnlyIndex', () => {
  it.each([
    ['/x/.git/worktrees/w/next-index-123.lock', true],
    ['.git/next-index-9.lock', true],
    ['.git/index', false],
    ['/x/.git/index.lock', false],
    [undefined, false],
  ])('%s -> %s', (file, expected) => {
    expect(isOnlyIndex(file)).toBe(expected);
  });
});

describe('hooks.ts CLI', () => {
  it.each([[[]], [['bogus']], [['toString']], [['install', 'extra']]])(
    'exits 2 with usage for %j',
    (args) => {
      const box = sandbox();
      const r = box.node(SCRIPT, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('usage: node scripts/hooks.ts');
    },
  );
});

describe('hooks.ts install', () => {
  it('sets core.hooksPath to .githooks, also when it is already set', () => {
    const box = sandbox();
    box.git('config', '--unset', 'core.hooksPath');
    const first = box.node(SCRIPT, ['install']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('core.hooksPath set to .githooks');
    expect(box.git('config', '--get', 'core.hooksPath').trim()).toBe('.githooks');
    expect(box.node(SCRIPT, ['install']).status).toBe(0);
    expect(box.git('config', '--get', 'core.hooksPath').trim()).toBe('.githooks');
  });

  it.each(['0', 'false'])('installs when CI=%s', (ci) => {
    const box = sandbox();
    box.git('config', '--unset', 'core.hooksPath');
    expect(box.node(SCRIPT, ['install'], { CI: ci }).status).toBe(0);
    expect(box.git('config', '--get', 'core.hooksPath').trim()).toBe('.githooks');
  });

  it('skips under CI=true', () => {
    const box = sandbox();
    box.git('config', '--unset', 'core.hooksPath');
    const r = box.node(SCRIPT, ['install'], { CI: 'true' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipped');
    expect(box.tryGit('config', '--get', 'core.hooksPath').status).toBe(1);
  });

  it('skips outside a git work tree', () => {
    const box = sandbox();
    const r = box.node(SCRIPT, ['install'], {}, box.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipped (not a git work tree)');
  });

  it('leaves another core.hooksPath and warns', () => {
    const box = sandbox();
    box.git('config', 'core.hooksPath', 'other');
    const r = box.node(SCRIPT, ['install']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('core.hooksPath is other, leaving it');
    expect(box.git('config', '--get', 'core.hooksPath').trim()).toBe('other');
  });
});

describe('pre-commit: gitleaks', () => {
  it('refuses when gitleaks exits non-zero, before formatting', () => {
    const box = sandbox({ output: '8:16PM WRN leaks found: 1', exit: 1 });
    const base = box.head();
    box.write('a.ts', 'const a  =  1\n');
    box.git('add', 'a.ts');
    const r = box.tryGit('commit', '-m', 'x');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('leaks found');
    expect(r.stderr).toContain('pre-commit: gitleaks found leaks or failed (exit 1)');
    expect(box.head()).toBe(base);
    expect(box.read('a.ts')).toBe('const a  =  1\n');
    expect(recorded(box.bin, 'gitleaks.args')).toEqual(
      expect.arrayContaining(['git', '--staged', '--redact']),
    );
  });

  it('refuses when gitleaks exits 0 after logging a git error', () => {
    const box = sandbox({ output: '8:16PM ERR [git] fatal: detected dubious ownership', exit: 0 });
    box.write('a.ts', 'const a = 1;\n');
    box.git('add', 'a.ts');
    const r = box.tryGit('commit', '-m', 'x');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gitleaks logged an error');
  });

  it('refuses with an install hint when gitleaks is not on PATH', () => {
    const box = sandbox();
    const only = join(box.dir, 'only');
    mkdirSync(only);
    const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(gitPath, join(only, 'git'));
    symlinkSync(process.execPath, join(only, 'node'));
    box.write('a.ts', 'const a = 1;\n');
    box.git('add', 'a.ts');
    const r = box.node(SCRIPT, ['pre-commit'], { PATH: only });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-commit: gitleaks not found on PATH - install it');
  });
});

describe('pre-commit: formatting', () => {
  it('commits a staged unformatted file formatted', () => {
    const box = sandbox();
    box.write('a.ts', 'const a  =  1\n');
    box.git('add', 'a.ts');
    expect(box.tryGit('commit', '-m', 'x').status).toBe(0);
    expect(box.git('show', 'HEAD:a.ts')).toBe('const a = 1;\n');
    expect(box.git('status', '--porcelain')).toBe('');
  });

  it('formats through git commit -a', () => {
    const box = sandbox();
    box.write('a.ts', 'const a = 1;\n');
    box.git('add', 'a.ts');
    box.git('commit', '-qm', 'a');
    box.write('a.ts', 'const a  =  2\n');
    expect(box.tryGit('commit', '-a', '-m', 'x').status).toBe(0);
    expect(box.git('show', 'HEAD:a.ts')).toBe('const a = 2;\n');
    expect(box.git('status', '--porcelain')).toBe('');
  });

  it('refuses a partly staged file and names it', () => {
    const box = sandbox();
    box.write('b.ts', 'const b = 1;\n');
    box.git('add', 'b.ts');
    box.write('b.ts', 'const b = 2;\n');
    const cached = box.git('diff', '--cached');
    const r = box.tryGit('commit', '-m', 'x');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-commit: staged files also have unstaged changes: b.ts');
    expect(box.git('diff', '--cached')).toBe(cached);
  });

  it('refuses without writing when one target does not parse', () => {
    const box = sandbox();
    box.write('a.ts', 'const a  =  1\n');
    box.write('bad.ts', 'const = ;\n');
    box.git('add', 'a.ts', 'bad.ts');
    const r = box.tryGit('commit', '-m', 'x');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-commit: prettier failed (exit 2)');
    expect(r.stderr).toContain('SyntaxError');
    expect(box.read('a.ts')).toBe('const a  =  1\n');
    expect(box.git('show', ':a.ts')).toBe('const a  =  1\n');
    expect(box.git('show', ':bad.ts')).toBe('const = ;\n');
  });

  // A copy of hooks.ts outside this checkout has no node_modules next to it.
  function withoutPrettier() {
    const box = sandbox();
    const copy = join(box.dir, 'copy', 'scripts', 'hooks.ts');
    mkdirSync(join(box.dir, 'copy', 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, copy);
    return { box, copy };
  }

  it('refuses when prettier is not installed and there are targets', () => {
    const { box, copy } = withoutPrettier();
    box.write('a.ts', 'const a = 1;\n');
    box.git('add', 'a.ts');
    const r = box.node(copy, ['pre-commit']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'prettier not found at node_modules/.bin/prettier - run pnpm install',
    );
  });

  it('passes a deletion-only commit without looking for prettier', () => {
    const { box, copy } = withoutPrettier();
    box.git('rm', '-q', 'README.md');
    const r = box.node(copy, ['pre-commit']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('refuses git commit <path> when the file needs formatting', () => {
    const box = sandbox();
    const base = box.head();
    box.write('a.ts', 'const a  =  1\n');
    box.git('add', 'a.ts');
    const r = box.tryGit('commit', '-m', 'x', 'a.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-commit: formatting needed in: a.ts');
    expect(box.head()).toBe(base);
    expect(box.read('a.ts')).toBe('const a  =  1\n');
    expect(box.git('show', ':a.ts')).toBe('const a  =  1\n');
  });

  // A trailing space goes on a directory: on the file it would change the extension.
  it.each([' lead.ts', 'trail /a.ts', 'new\nline.ts'])(
    'commits a staged unformatted file named %j formatted',
    (name) => {
      const box = sandbox();
      mkdirSync(join(box.repo, dirname(name)), { recursive: true });
      box.write(name, 'const a  =  1\n');
      box.write('ok.ts', 'const b  =  2\n');
      box.git('add', '--', name, 'ok.ts');
      const r = box.tryGit('commit', '-m', 'x');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(box.git('show', `HEAD:${name}`)).toBe('const a = 1;\n');
      expect(box.git('show', 'HEAD:ok.ts')).toBe('const b = 2;\n');
      expect(box.git('status', '--porcelain')).toBe('');
    },
  );

  it('names an oddly named target in the git commit <path> refusal', () => {
    const box = sandbox();
    box.write(' lead.ts', 'const a  =  1\n');
    box.git('add', '--', ' lead.ts');
    const r = box.tryGit('commit', '-m', 'x', '--', ' lead.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pre-commit: formatting needed in:  lead.ts - stage');
  });

  it('commits git commit <path> when the file is formatted', () => {
    const box = sandbox();
    box.write('a.ts', 'const a = 1;\n');
    box.git('add', 'a.ts');
    expect(box.tryGit('commit', '-m', 'x', 'a.ts').status).toBe(0);
    expect(box.git('status', '--porcelain')).toBe('');
  });
});

describe('pre-push', () => {
  it('runs the pre-push mode without the git local env vars and exits with its status', () => {
    const box = sandbox();
    fakeBin(box.bin, 'pnpm', { output: 'CHECK FAIL (exit 3)', exit: 3 }, true, true);
    const refs = `refs/heads/main ${box.head()} refs/heads/main ${'0'.repeat(40)}\n`;
    const r = box.node(
      SCRIPT,
      ['pre-push', 'origin', 'url'],
      {
        GIT_DIR: '/bogus',
        GIT_INDEX_FILE: '/bogus',
      },
      box.repo,
      refs,
    );
    expect(r.status).toBe(3);
    expect(recorded(box.bin, 'pnpm.args')).toEqual(['run', 'check', '--pre-push']);
    expect(readFileSync(join(box.bin, 'pnpm.stdin'), 'utf8')).toBe(refs);
    const env = recorded(box.bin, 'pnpm.env') ?? [];
    expect(env.length).toBeGreaterThan(0);
    expect(env.filter((line) => /^GIT_(DIR|INDEX_FILE)=/.test(line))).toEqual([]);
  });
});

describe('.githooks', () => {
  it('commits both hooks as executables', () => {
    const r = spawnSync(
      'git',
      ['ls-files', '-s', '--', '.githooks/pre-commit', '.githooks/pre-push'],
      { cwd: REPO_ROOT, env: cleanEnv(), encoding: 'utf8' },
    );
    const entries = r.stdout.trim().split('\n');
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatch(/^100755 /);
  });
});
