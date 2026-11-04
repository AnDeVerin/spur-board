// Pure planning for `pnpm check`. scripts/check.ts gathers the git facts and runs the steps.
import { parseArgs } from 'node:util';

/** Every check step, in the order they run. */
const STEP_NAMES = ['format', 'lint', 'types', 'knip', 'test'] as const;

/**
 * The steps `--only` selects: null when `--only` is absent (run every step), the selected set,
 * or an error message for an unknown or empty name or for `--only` without `--full`.
 */
export function parseOnly(
  value: string | undefined,
  full: boolean,
): ReadonlySet<string> | null | string {
  if (value === undefined) return null;
  if (!full) return '--only needs --full';
  const selected = new Set<string>();
  for (const name of value.split(',')) {
    const step = STEP_NAMES.find((known) => known === name);
    if (step === undefined) {
      return `--only: unknown step "${name}" (steps: ${STEP_NAMES.join(', ')})`;
    }
    selected.add(step);
  }
  return selected;
}

type CheckArgs =
  { full: boolean; prePush: boolean; only: ReadonlySet<string> | null } | { error: string };

/** Parses the `scripts/check.ts` arguments: `--full` and `--only <steps>`. */
export function parseCheckArgs(argv: string[]): CheckArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        full: { type: 'boolean' },
        'pre-push': { type: 'boolean' },
        only: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const full = values.full ?? false;
  const prePush = values['pre-push'] ?? false;
  if (full && prePush) return { error: '--pre-push and --full are mutually exclusive' };
  const only = parseOnly(values.only, full);
  return typeof only === 'string' ? { error: only } : { full, prePush, only };
}

export type Base = { kind: 'base'; ref: string; sha: string } | { kind: 'full'; reason: string };

export interface BaseFacts {
  insideWorkTree: boolean;
  headExists: boolean;
  originMainMergeBase: string | null;
  mainMergeBase: string | null;
}

export function resolveBase(facts: BaseFacts): Base {
  if (!facts.insideWorkTree) return { kind: 'full', reason: 'not a git repository' };
  if (!facts.headExists) return { kind: 'full', reason: 'no commits yet' };
  if (facts.originMainMergeBase !== null) {
    return { kind: 'base', ref: 'origin/main', sha: facts.originMainMergeBase };
  }
  if (facts.mainMergeBase !== null) return { kind: 'base', ref: 'main', sha: facts.mainMergeBase };
  return { kind: 'full', reason: 'no base ref' };
}

export interface ChangedFile {
  path: string;
  deleted: boolean;
}

/**
 * Parses `git diff --name-status -z` output: NUL-separated fields, a status then its path,
 * or two paths for R/C. Run it with `--no-renames`; R/C entries are a fallback.
 */
export function parseNameStatus(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const fields = text.split('\0');
  let i = 0;
  while (i < fields.length) {
    const status = fields[i] ?? '';
    const first = fields[i + 1];
    if (status === '' || first === undefined) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[i + 2] ?? '';
      if (status.startsWith('R')) files.push({ path: first, deleted: true });
      files.push({ path: second, deleted: false });
      i += 3;
    } else {
      files.push({ path: first, deleted: status === 'D' });
      i += 2;
    }
  }
  return files;
}

// A change to any of these can affect every package, so it runs the full check.
const GLOBAL_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'eslint.config.js',
  'vitest.config.ts',
  '.prettierrc.json',
  '.prettierignore',
  '.gitignore',
  'knip.json',
]);
const GLOBAL_DIRS = ['eslint/', 'scripts/', 'packages/testkit/', 'packages/skills/'];
const LINT_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/;

function isGlobal(path: string): boolean {
  return (
    GLOBAL_FILES.has(path) ||
    /^tsconfig[^/]*\.json$/.test(path) ||
    GLOBAL_DIRS.some((dir) => path.startsWith(dir))
  );
}

export interface Plan {
  mode: 'full' | 'changed' | 'none';
  reason: string;
  formatFiles: string[];
  lintFiles: string[];
  packageDirs: string[];
}

export function planCheck(input: {
  full: boolean;
  prePush?: boolean;
  changed: ChangedFile[];
  packageDirs: string[];
}): Plan {
  const everything = { formatFiles: ['.'], lintFiles: ['.'], packageDirs: input.packageDirs };
  if (input.full) return { mode: 'full', reason: '--full', ...everything };
  const trigger = input.changed.find((file) => isGlobal(file.path));
  if (trigger && !input.prePush)
    return { mode: 'full', reason: `${trigger.path} changed`, ...everything };
  if (input.changed.length === 0) {
    return { mode: 'none', reason: 'no changes', formatFiles: [], lintFiles: [], packageDirs: [] };
  }

  const present = input.changed.filter((file) => !file.deleted).map((file) => file.path);
  // Shared root files and tooling can affect every package, even in the scoped push mode.
  const packageDirs =
    input.prePush && trigger
      ? input.packageDirs
      : input.packageDirs.filter((dir) =>
          input.changed.some((file) => file.path.startsWith(`${dir}/`)),
        );
  return {
    mode: 'changed',
    reason: `${String(input.changed.length)} changed file(s)`,
    formatFiles: present,
    lintFiles: present.filter((path) => LINT_EXTENSIONS.test(path)),
    packageDirs,
  };
}
