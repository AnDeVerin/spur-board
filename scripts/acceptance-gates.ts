// `node scripts/acceptance-gates.ts`: the CI `acceptance-gates` job, run on the `pull_request` merge
// ref. When the PR changes a UI file, the PR description's `## Acceptance gates` section must give
// each gate (`tester`, `designer`) the head its last passed run checked, or `n/a`. It fails when a
// gate head has a UI-file diff to the PR head, is not an ancestor of the PR head, or the section is
// missing or malformed. A PR that changes no UI file passes without reading the description.
// UI files follow the base rule of Final head in .agents/skills/manager/references/verdicts.md;
// change both together. Imports only `node:` builtins and ./guardrails.ts, so the job skips
// `pnpm install`.
import { spawnSync } from 'node:child_process';
import { escapeCommand, readPullRequest, sectionText } from './guardrails.ts';

const GATES = ['tester', 'designer'] as const;

type Gate = (typeof GATES)[number];

/** A UI file: under `packages/web/` outside its top-level `test/`, `gallery/` and `kit/`. */
export function isUiPath(path: string): boolean {
  if (path === 'docs/design-system-decisions.md') return true;
  return path.startsWith('packages/web/') && !/^packages\/web\/(?:test|gallery|kit)\//.test(path);
}

type ParsedGates =
  { ok: true; gates: Record<Gate, string | null> } | { ok: false; errors: string[] };

const GATE_LINE = /^(tester|designer):[ \t]*(.*?)[ \t]*$/;
const SHA = /^[0-9a-f]{7,64}$/i;

/**
 * Reads an `## Acceptance gates` section: each non-blank line is `tester: <value>` or
 * `designer: <value>`, one per gate, and each value is a 7-64 digit hex SHA or `n/a` (null). Any
 * other line, a code fence or a bullet included, is an error naming it.
 */
export function parseGates(section: string): ParsedGates {
  const values: Record<Gate, string[]> = { tester: [], designer: [] };
  const errors: string[] = [];
  for (const line of section.split('\n')) {
    if (line.trim() === '') continue;
    const match = GATE_LINE.exec(line);
    if (match) values[match[1] as Gate].push(match[2] ?? '');
    else
      errors.push(`line "${line.trim()}" is not "tester: <sha | n/a>" or "designer: <sha | n/a>"`);
  }
  const gates: Record<Gate, string | null> = { tester: null, designer: null };
  for (const gate of GATES) {
    const found = values[gate];
    if (found.length === 0) {
      errors.push(`${gate}: no "${gate}:" line`);
      continue;
    }
    if (found.length > 1) {
      errors.push(`${gate}: ${String(found.length)} "${gate}:" lines, expected one`);
      continue;
    }
    const value = found[0] ?? '';
    if (/^n\/a$/i.test(value)) gates[gate] = null;
    else if (SHA.test(value)) gates[gate] = value.toLowerCase();
    else errors.push(`${gate}: "${value}" is not a commit SHA or n/a`);
  }
  return errors.length === 0 ? { ok: true, gates } : { ok: false, errors };
}

class UsageError extends Error {}

const USAGE =
  'usage: node scripts/acceptance-gates.ts - takes no argument and runs only in a pull_request ' +
  'CI run, on the merge ref.';

function git(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git ${args[0] ?? ''} failed: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function uiFiles(cwd: string, from: string, to: string): string[] {
  const output = gitOk(cwd, ['diff', '--no-renames', '--name-only', '-z', from, to, '--']);
  return output.split('\0').filter((path) => path !== '' && isUiPath(path));
}

/** The problem with one gate head, or null when it has no UI change up to `prHead`. */
function checkGate(cwd: string, gate: Gate, value: string, prHead: string): string | null {
  const resolved = git(cwd, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
  const sha = resolved.stdout.trim();
  if (resolved.status !== 0 || sha === '') {
    return `${gate} ${value}: not a commit in this repository`;
  }
  const ancestor = git(cwd, ['merge-base', '--is-ancestor', sha, prHead]);
  if (ancestor.status === 1) return `${gate} ${value}: not an ancestor of the PR head ${prHead}`;
  if (ancestor.status !== 0) throw new Error(`git merge-base failed: ${ancestor.stderr.trim()}`);
  const changed = uiFiles(cwd, sha, prHead);
  if (changed.length === 0) return null;
  return [
    `${gate} ${value}: UI files changed since this head:`,
    ...changed.map((path) => `  - ${path}`),
  ].join('\n');
}

function run(argv: string[], env: NodeJS.ProcessEnv): number {
  const out = (text: string) => process.stdout.write(`acceptance-gates: ${escapeCommand(text)}\n`);
  if (argv.length > 0 || env['GITHUB_EVENT_NAME'] !== 'pull_request') throw new UsageError(USAGE);
  const request = readPullRequest(env['GITHUB_EVENT_PATH']);
  const cwd = gitOk(process.cwd(), ['rev-parse', '--show-toplevel']).replace(/\n$/, '');
  const shas = gitOk(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ');
  const base = shas[1];
  const prHead = shas[2];
  if (shas.length !== 3 || base === undefined || prHead === undefined) {
    throw new Error(
      'HEAD is not a merge commit with two parents (needs the pull_request merge ref)',
    );
  }
  const changed = uiFiles(cwd, base, 'HEAD');
  if (changed.length === 0) {
    out('PASS (no UI change)');
    return 0;
  }
  out(`PR head ${prHead}, ${String(changed.length)} UI file(s) changed`);

  const parsed = parseGates(sectionText(request.body ?? '', 'acceptance gates'));
  const problems: string[] = [];
  const passed: string[] = [];
  if (!parsed.ok) problems.push(...parsed.errors);
  else {
    for (const gate of GATES) {
      const value = parsed.gates[gate];
      if (value === null) {
        passed.push(`${gate} n/a`);
        continue;
      }
      const problem = checkGate(cwd, gate, value, prHead);
      if (problem === null) passed.push(`${gate} ${value}`);
      else problems.push(problem);
    }
  }
  if (problems.length === 0) {
    out(`PASS (no UI change since ${passed.join(', ')})`);
    return 0;
  }
  const message = [
    'acceptance-gates: this PR changes UI files, so "## Acceptance gates" in the PR description ' +
      'must give each gate the head its last passed run checked, or n/a.',
    'UI files in this PR:',
    ...changed.map((path) => `- ${path}`),
    'Problems:',
    ...problems.map((problem) => `- ${problem}`),
    'Rerun each such gate on the final head (Final head, .agents/skills/manager/references/' +
      'verdicts.md); the cap never excuses the final-head run.',
    'Editing the description re-runs this job; "Re-run jobs" reuses the old description.',
  ].join('\n');
  process.stdout.write(`::error::${escapeCommand(message)}\n`);
  out('FAIL');
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2), process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`acceptance-gates: ${escapeCommand(message)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
