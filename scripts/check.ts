// `pnpm check` (changed files and affected packages) and `pnpm check:full`.
// The last stdout line is always `CHECK PASS` or `CHECK FAIL (exit N)`, and the exit code is N.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNameStatus, planCheck, resolveBase, type ChangedFile } from './check-plan.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

export interface Command {
  cmd: string;
  args: string[];
}

export type Step = { name: string; commands: Command[] } | { name: string; skip: string };

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

function git(args: string[]): string | null {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function changedFiles(sha: string): ChangedFile[] {
  const diff = git(['diff', '--no-renames', '--name-status', sha]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (diff === null || untracked === null) throw new Error('git could not list changed files');
  const files = parseNameStatus(diff);
  for (const path of untracked.split('\n')) {
    if (path !== '') files.push({ path, deleted: false });
  }
  return files;
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

function main(): number {
  const full = process.argv.includes('--full');
  const packageDirs = workspacePackages();
  let plan;
  if (full) {
    plan = planCheck({ full, changed: [], packageDirs });
  } else {
    const base = resolveBase({
      insideWorkTree: git(['rev-parse', '--is-inside-work-tree']) === 'true',
      headExists: git(['rev-parse', '--verify', '--quiet', 'HEAD']) !== null,
      originMainMergeBase: git(['merge-base', 'HEAD', 'origin/main']),
      mainMergeBase: git(['merge-base', 'HEAD', 'main']),
    });
    plan =
      base.kind === 'full'
        ? { ...planCheck({ full: true, changed: [], packageDirs }), reason: base.reason }
        : planCheck({ full, changed: changedFiles(base.sha), packageDirs });
  }
  if (plan.mode === 'changed') plan.packageDirs = withDependents(plan.packageDirs);
  console.log(`check: mode ${plan.mode} (${plan.reason})`);

  const noFiles = { skip: 'no files to check' };
  const noPackages = { skip: 'no affected packages' };
  const typeProjects = plan.mode === 'full' ? ['.', ...plan.packageDirs] : plan.packageDirs;
  const steps: Step[] = [
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
      ? { name: 'test', commands: [{ cmd: bin('vitest'), args: ['run'] }] }
      : plan.packageDirs.length === 0
        ? { name: 'test', ...noPackages }
        : {
            name: 'test',
            commands: [
              {
                cmd: bin('vitest'),
                args: ['run', '--passWithNoTests', ...plan.packageDirs.map((dir) => `${dir}/`)],
              },
            ],
          },
  ];
  return runSteps(steps);
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
