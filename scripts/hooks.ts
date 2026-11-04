// The repo's git hooks (.githooks/* exec this file) and their installer.
//
//   node scripts/hooks.ts install     - `pnpm install` runs it as `prepare`; sets core.hooksPath
//   node scripts/hooks.ts pre-commit  - gitleaks on the staged changes, then prettier on them
//   node scripts/hooks.ts pre-push    - `pnpm run check --pre-push`
//
// git runs hooks from the work tree root, so git and prettier run in the current directory.
// prettier is resolved next to this file, like scripts/check.ts does.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const USAGE = 'usage: node scripts/hooks.ts install|pre-commit|pre-push';
const GITLEAKS_INSTALL = 'https://github.com/gitleaks/gitleaks#installing';

/** Files that are staged and also have unstaged changes, in staged order. */
export function partiallyStaged(staged: string[], unstaged: string[]): string[] {
  const dirty = new Set(unstaged);
  return staged.filter((path) => dirty.has(path));
}

/** Why the gitleaks run fails the commit, or null when it passed. */
export function gitleaksVerdict(status: number, output: string): string | null {
  if (status !== 0) return `gitleaks found leaks or failed (exit ${String(status)})`;
  // gitleaks exits 0 when git fails; it only logs an ERR line (see scripts/gitleaks.sh).
  if (output.includes(' ERR ')) return 'gitleaks logged an error';
  return null;
}

/**
 * Paths prettier may format, from `git diff --cached --raw -z --diff-filter=ACMR`: the new path
 * of every entry except symlinks (120000) and submodules (160000).
 */
export function formatTargets(rawDiff: string): string[] {
  const fields = rawDiff.split('\0');
  const targets: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const meta = fields[i] ?? '';
    if (!meta.startsWith(':')) {
      i += 1;
      continue;
    }
    const [, newMode = '', , , status = ''] = meta.slice(1).split(' ');
    const twoPaths = status.startsWith('R') || status.startsWith('C');
    const path = fields[i + (twoPaths ? 2 : 1)] ?? '';
    i += twoPaths ? 3 : 2;
    if (path !== '' && newMode !== '120000' && newMode !== '160000') targets.push(path);
  }
  return targets;
}

/** True when git runs the hook for `git commit <path>`, which commits from a temporary index. */
export function isOnlyIndex(indexFile: string | undefined): boolean {
  return indexFile !== undefined && /^next-index-.*\.lock$/.test(basename(indexFile));
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function run(cmd: string, args: string[]): Run {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return {
    status: result.error ? 127 : (result.status ?? 128),
    stdout: result.stdout,
    stderr: result.stderr,
    missing,
  };
}

function git(args: string[]): string {
  const result = run('git', ['-c', 'core.quotePath=false', ...args]);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${String(result.status)}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

function names(output: string): string[] {
  return output.split('\0').filter((path) => path !== '');
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function refuse(reason: string, output = ''): number {
  if (output.trim() !== '') process.stderr.write(`${output.trimEnd()}\n`);
  process.stderr.write(`pre-commit: ${reason}\n`);
  return 1;
}

function preCommit(): number {
  const partly = partiallyStaged(
    names(git(['diff', '--cached', '--name-only', '-z'])),
    names(git(['diff', '--name-only', '-z'])),
  );
  if (partly.length > 0) {
    return refuse(
      `staged files also have unstaged changes: ${partly.join(', ')} - stage or drop the rest first`,
    );
  }

  const leaks = run('gitleaks', ['git', '--staged', '--redact', '--no-banner', '--no-color', '.']);
  if (leaks.missing) {
    return refuse(`gitleaks not found on PATH - install it (${GITLEAKS_INSTALL})`);
  }
  const verdict = gitleaksVerdict(leaks.status, leaks.stdout + leaks.stderr);
  if (verdict !== null) return refuse(verdict, leaks.stdout + leaks.stderr);

  const targets = formatTargets(git(['diff', '--cached', '--raw', '-z', '--diff-filter=ACMR']));
  if (targets.length === 0) return 0;

  const prettier = join(root, 'node_modules/.bin/prettier');
  if (!existsSync(prettier)) {
    return refuse('prettier not found at node_modules/.bin/prettier - run pnpm install');
  }
  // Check every target first: one file that does not parse must not leave the others rewritten.
  const check = run(prettier, ['--list-different', '--ignore-unknown', '--', ...targets]);
  if (check.status === 0) return 0;
  if (check.status !== 1) {
    return refuse(`prettier failed (exit ${String(check.status)})`, check.stdout + check.stderr);
  }
  // prettier's output is not parsed into paths: a name may hold a newline or edge spaces.
  if (isOnlyIndex(process.env['GIT_INDEX_FILE'])) {
    const reported = new Set(check.stdout.split('\n'));
    const listed = targets.filter((target) => reported.has(target));
    return refuse(
      `formatting needed in: ${(listed.length > 0 ? listed : targets).join(', ')} - stage them and commit without paths, or run pnpm format first`,
    );
  }
  // --write rewrites only the files that differ; every target is staged and fully staged.
  const write = run(prettier, ['--write', '--ignore-unknown', '--', ...targets]);
  if (write.status !== 0) {
    return refuse(
      `prettier failed while writing (exit ${String(write.status)}); some of ${targets.join(', ')} may be rewritten - review them and git add`,
      write.stdout + write.stderr,
    );
  }
  git(['add', '--', ...targets]);
  return 0;
}

function prePush(): number {
  // git exports GIT_DIR and friends to hooks; passed on, they would make the git calls in
  // `pnpm run check --pre-push` (and its tests) act on this repository.
  const local = run('git', ['rev-parse', '--local-env-vars']);
  if (local.status !== 0) {
    process.stderr.write(`pre-push: git rev-parse --local-env-vars failed\n${local.stderr}`);
    return 1;
  }
  const env = { ...process.env };
  for (const name of lines(local.stdout)) Reflect.deleteProperty(env, name);
  const result = spawnSync('pnpm', ['run', 'check', '--pre-push'], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    process.stderr.write(
      `pre-push: could not run pnpm run check --pre-push: ${result.error.message}\n`,
    );
    return 127;
  }
  return result.status ?? 1;
}

function install(): number {
  const ci = process.env['CI'];
  if (ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false') {
    console.log('hooks: skipped (CI)');
    return 0;
  }
  if (run('git', ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') {
    console.log('hooks: skipped (not a git work tree)');
    return 0;
  }
  const current = run('git', ['config', '--get', 'core.hooksPath']).stdout.trim();
  if (current !== '' && current !== '.githooks') {
    process.stderr.write(
      `hooks: core.hooksPath is ${current}, leaving it - set it to .githooks to use the repo hooks\n`,
    );
    return 0;
  }
  git(['config', 'core.hooksPath', '.githooks']);
  console.log('hooks: core.hooksPath set to .githooks');
  return 0;
}

const COMMANDS: Record<string, () => number> = {
  install,
  'pre-commit': preCommit,
  'pre-push': prePush,
};

if (import.meta.main) {
  const [name, ...rest] = process.argv.slice(2);
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  // Git passes arguments to pre-push (remote name and URL); the other commands take none.
  if (command === undefined || (name !== 'pre-push' && rest.length > 0)) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = command();
    } catch (error) {
      process.stderr.write(
        `${name ?? 'hooks'}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
