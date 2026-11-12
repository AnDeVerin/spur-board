// `pnpm check` (changed files and affected packages) and `pnpm check:full`.
// The last stdout line is always `CHECK PASS` or `CHECK FAIL (exit N)`, and the exit code is N.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCheckArgs,
  parseNameStatus,
  planCheck,
  resolveBase,
  type Base,
  type ChangedFile,
  type Plan,
} from './check-plan.ts';

const PACKAGE_SMOKE_SCRIPT = 'scripts/package-smoke.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

export interface Command {
  cmd: string;
  args: string[];
}

export type Step = { name: string; commands: Command[] } | { name: string; skip: string };

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export function parsePushRefs(input: string): PushRef[] | { error: string } {
  const refs: PushRef[] = [];
  for (const line of input.split('\n')) {
    if (line === '') continue;
    const fields = line.split(' ');
    if (fields.length !== 4 || fields.some((field) => field === '')) {
      return { error: 'pre-push: invalid ref list from git' };
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!localRef || !localSha || !remoteRef || !remoteSha) {
      return { error: 'pre-push: invalid ref list from git' };
    }
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs.length > 0 ? refs : { error: 'pre-push: git supplied no refs to check' };
}

export function pushRanges(
  refs: PushRef[],
  headSha: string | null,
  newRefBase: Base,
): { from: string; to: string }[] | { error: string } {
  const ranges: { from: string; to: string }[] = [];
  for (const ref of refs) {
    if (/^0+$/.test(ref.localSha)) continue; // Deleting a remote ref pushes no new code.
    if (ref.localSha !== headSha) {
      return {
        error: `pre-push: ${ref.localRef} is not checked out at HEAD; check out the ref before pushing it`,
      };
    }
    if (/^0+$/.test(ref.remoteSha)) {
      if (newRefBase.kind === 'full') {
        return {
          error: `pre-push: ${newRefBase.reason}; create or update a local main or origin/main ref, then retry`,
        };
      }
      ranges.push({ from: newRefBase.sha, to: ref.localSha });
    } else {
      ranges.push({ from: ref.remoteSha, to: ref.localSha });
    }
  }
  return ranges;
}

export function selectPlan(input: {
  full: boolean;
  prePush: boolean;
  base: Base;
  changed: ChangedFile[];
  packageDirs: string[];
}): Plan | { error: string } {
  if (input.full) return planCheck({ full: true, changed: [], packageDirs: input.packageDirs });
  if (input.base.kind === 'full') {
    if (input.prePush)
      return {
        error: `pre-push: ${input.base.reason}; create or update a local main or origin/main ref, then retry`,
      };
    return {
      ...planCheck({ full: true, changed: [], packageDirs: input.packageDirs }),
      reason: input.base.reason,
    };
  }
  return planCheck({
    full: false,
    prePush: input.prePush,
    changed: input.changed,
    packageDirs: input.packageDirs,
  });
}

export function prePushWorkers(value: string | undefined): number | { error: string } {
  if (value === undefined) return 2;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return { error: 'VITEST_MAX_WORKERS must be a positive integer' };
  }
  return Number(value);
}

export function packageSmokeCommands(
  mode: 'full' | 'changed' | 'none',
  packageDirs: string[],
): Command[] {
  return mode === 'full' || packageDirs.includes('packages/cli')
    ? [{ cmd: 'node', args: [PACKAGE_SMOKE_SCRIPT] }]
    : [];
}

/** Runs every step, prints one line per step and returns the first non-zero exit code. */
export function runSteps(steps: Step[], log: (line: string) => void = console.log): number {
  let first = 0;
  for (const step of steps) {
    if ('skip' in step) {
      log(`check: ${step.name} skipped (${step.skip})`);
      continue;
    }
    let status = 0;
    for (const { cmd, args } of step.commands) {
      const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
      const code = result.error ? 127 : (result.status ?? 1);
      if (status === 0) status = code;
    }
    log(
      status === 0 ? `check: ${step.name} ok` : `check: ${step.name} FAIL (exit ${String(status)})`,
    );
    if (first === 0) first = status;
  }
  return first;
}

export function statusLine(code: number): string {
  return code === 0 ? 'CHECK PASS' : `CHECK FAIL (exit ${String(code)})`;
}

/** Raw git stdout, or null when git fails. List output uses -z, so it is never trimmed. */
function gitRaw(args: string[]): string | null {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout : null;
}

/** A single-value git output (a SHA or `true`), trimmed. */
function git(args: string[]): string | null {
  return gitRaw(args)?.trim() ?? null;
}

function changedFiles(sha: string): ChangedFile[] {
  const diff = gitRaw(['diff', '--no-renames', '--name-status', '-z', sha]);
  const untracked = gitRaw(['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff === null || untracked === null) throw new Error('git could not list changed files');
  const files = parseNameStatus(diff);
  for (const path of untracked.split('\0')) {
    if (path !== '') files.push({ path, deleted: false });
  }
  return files;
}

function pushedFiles(ranges: { from: string; to: string }[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const { from, to } of ranges) {
    const diff = gitRaw(['diff', '--no-renames', '--name-status', '-z', from, to]);
    if (diff === null) {
      throw new Error(`pre-push: cannot compare ${from} to ${to}; fetch the remote ref and retry`);
    }
    for (const file of parseNameStatus(diff)) files.set(file.path, file);
  }
  return [...files.values()];
}

function workspacePackages(): string[] {
  return readdirSync(join(root, 'packages'))
    .map((name) => `packages/${name}`)
    .filter((dir) => existsSync(join(root, dir, 'package.json')));
}

/** The changed packages plus every workspace package that depends on them. */
function withDependents(dirs: string[]): string[] {
  if (dirs.length === 0) return [];
  const filters = dirs.flatMap((dir) => ['--filter', `...{${dir}}`]);
  const result = spawnSync('pnpm', [...filters, 'ls', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) throw new Error('pnpm could not list dependent packages');
  const projects = JSON.parse(result.stdout) as { path: string }[];
  const all = projects.map((project) => relative(root, project.path));
  return [...new Set(all.filter((dir) => dir.startsWith('packages/')))].sort();
}

function bin(tool: string): string {
  return join(root, 'node_modules/.bin', tool);
}

export function buildSteps(plan: Plan, prePush: boolean, workers = 2): Step[] {
  const noFiles = { skip: 'no files to check' };
  const noPackages = { skip: 'no affected packages' };
  const typeProjects = plan.mode === 'full' ? ['.', ...plan.packageDirs] : plan.packageDirs;
  const startupTest = 'packages/cli/test/startup.test.ts';
  const checkStartup =
    !prePush && (plan.mode === 'full' || plan.packageDirs.includes('packages/cli'));
  const testCommands: Command[] = [
    {
      cmd: bin('vitest'),
      args: [
        'run',
        ...(plan.mode === 'full' ? [] : ['--passWithNoTests']),
        ...(prePush ? ['--maxWorkers', String(workers)] : []),
        '--project',
        'unit',
        ...(!prePush ? ['--project', 'integration', '--project', 'process'] : []),
        ...(plan.mode === 'full' ? [] : plan.packageDirs.map((dir) => `${dir}/`)),
      ],
    },
    ...(checkStartup
      ? [
          {
            cmd: bin('vitest'),
            args: [
              'run',
              startupTest,
              '--project',
              'startup',
              '--outputFile.junit=reports/junit-startup.xml',
            ],
          },
        ]
      : []),
    ...(!prePush ? packageSmokeCommands(plan.mode, plan.packageDirs) : []),
  ];
  return [
    plan.formatFiles.length === 0
      ? { name: 'format', ...noFiles }
      : {
          name: 'format',
          commands: [
            { cmd: bin('prettier'), args: ['--check', '--ignore-unknown', ...plan.formatFiles] },
          ],
        },
    plan.lintFiles.length === 0
      ? { name: 'lint', ...noFiles }
      : {
          name: 'lint',
          commands: [
            {
              cmd: bin('eslint'),
              args: ['--max-warnings=0', '--no-warn-ignored', ...plan.lintFiles],
            },
          ],
        },
    typeProjects.length === 0
      ? { name: 'types', ...noPackages }
      : {
          name: 'types',
          commands: typeProjects.map((dir) => ({ cmd: bin('tsc'), args: ['--noEmit', '-p', dir] })),
        },
    plan.mode === 'full'
      ? { name: 'knip', commands: [{ cmd: bin('knip'), args: ['--no-progress'] }] }
      : { name: 'knip', skip: 'full check only' },
    plan.agents
      ? { name: 'agents', commands: [{ cmd: 'node', args: ['scripts/agents.ts', 'lint'] }] }
      : { name: 'agents', skip: 'no agent files changed' },
    plan.mode === 'full' || plan.packageDirs.length > 0
      ? { name: 'test', commands: testCommands }
      : { name: 'test', ...noPackages },
    prePush
      ? { name: 'stand', skip: 'pre-push runs unit tests only' }
      : plan.mode === 'full' || plan.packageDirs.includes('packages/stand')
        ? { name: 'stand', commands: [{ cmd: bin('vitest'), args: ['run', '--project', 'stand'] }] }
        : { name: 'stand', skip: 'packages/stand not affected' },
  ];
}

function main(): number {
  const args = parseCheckArgs(process.argv.slice(2));
  if ('error' in args) {
    console.log(`check: ${args.error}`);
    return 2;
  }
  const { full, prePush, only } = args;
  const workers = prePush ? prePushWorkers(process.env['VITEST_MAX_WORKERS']) : 2;
  if (typeof workers !== 'number') {
    console.log(`check: ${workers.error}`);
    return 2;
  }
  const packageDirs = workspacePackages();
  const base = full
    ? { kind: 'full' as const, reason: '--full' }
    : resolveBase({
        insideWorkTree: git(['rev-parse', '--is-inside-work-tree']) === 'true',
        headExists: git(['rev-parse', '--verify', '--quiet', 'HEAD']) !== null,
        originMainMergeBase: git(['merge-base', 'HEAD', 'origin/main']),
        mainMergeBase: git(['merge-base', 'HEAD', 'main']),
      });
  let changed = base.kind === 'base' && !prePush ? changedFiles(base.sha) : [];
  let planBase = base;
  if (prePush) {
    const refs = parsePushRefs(readFileSync(0, 'utf8'));
    if ('error' in refs) {
      console.error(`check: ${refs.error}`);
      return 2;
    }
    const ranges = pushRanges(refs, git(['rev-parse', 'HEAD']), base);
    if ('error' in ranges) {
      console.error(`check: ${ranges.error}`);
      return 2;
    }
    changed = pushedFiles(ranges);
    planBase = { kind: 'base', ref: 'push', sha: ranges[0]?.from ?? '' };
  }
  const plan = selectPlan({
    full,
    prePush,
    base: planBase,
    changed,
    packageDirs,
  });
  if ('error' in plan) {
    console.error(`check: ${plan.error}`);
    return 2;
  }
  if (plan.mode === 'changed' && !prePush) plan.packageDirs = withDependents(plan.packageDirs);
  console.log(`check: mode ${plan.mode} (${plan.reason})`);
  const steps = buildSteps(plan, prePush, workers);
  return runSteps(only === null ? steps : steps.filter((step) => only.has(step.name)));
}

if (import.meta.main) {
  let code: number;
  try {
    code = main();
  } catch (error) {
    console.error(error);
    code = 1;
  }
  console.log(statusLine(code));
  process.exitCode = code;
}
