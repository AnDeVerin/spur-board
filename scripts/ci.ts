// CI helpers for .github/workflows/ci.yml. Imports only `node:` builtins, so the jobs that run it
// skip `pnpm install`.
//   node scripts/ci.ts changes [<base>]  - which kinds of files changed
//   node scripts/ci.ts secrets-range     - the git log range the secret scan covers
//   node scripts/ci.ts ok                - the ci-ok verdict over the needed jobs
// Git runs in the current directory; pnpm runs scripts from the repository root.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export interface Changes {
  github: boolean;
  docsOnly: boolean;
  code: boolean;
}

function isDocs(path: string): boolean {
  return path.endsWith('.md') || path.startsWith('docs/') || path === 'LICENSE';
}

/** Classifies the changed paths. `docsOnly` needs at least one path. */
export function classifyChanges(paths: string[]): Changes {
  return {
    github: paths.some((path) => path.startsWith('.github/')),
    docsOnly: paths.length > 0 && paths.every(isDocs),
    code: paths.some((path) => !isDocs(path)),
  };
}

export interface NeededJob {
  result?: unknown;
  outputs?: Record<string, unknown>;
}

export interface Verdict {
  ok: boolean;
  lines: string[];
}

/**
 * Passes only when every job succeeded. Accepted skips: `pr-title` outside pull requests, and
 * `workflows` when `changes` succeeded and reported `github=false`.
 */
export function decideCiOk(input: {
  needs: Record<string, NeededJob>;
  event: string;
  jobIds: string[];
}): Verdict {
  const { needs, event, jobIds } = input;
  const lines: string[] = [];
  let failures = 0;
  const report = (accepted: boolean, line: string) => {
    lines.push(`${line} ${accepted ? 'ok' : 'FAIL'}`);
    if (!accepted) failures += 1;
  };
  if (jobIds.length === 0) report(false, 'ci-ok: no jobs found in ci.yml');
  for (const id of jobIds) {
    if (!(id in needs)) report(false, `ci-ok: ${id} missing from needs`);
  }
  const changes = needs['changes'];
  for (const [id, job] of Object.entries(needs)) {
    const result = typeof job.result === 'string' ? job.result : String(job.result);
    let accepted = result === 'success';
    if (result === 'skipped' && id === 'pr-title') accepted = event !== 'pull_request';
    if (result === 'skipped' && id === 'workflows') {
      accepted = changes?.result === 'success' && changes.outputs?.['github'] === 'false';
    }
    report(accepted, `ci-ok: ${id} ${result}`);
  }
  const ok = failures === 0;
  lines.push(ok ? 'ci-ok: PASS' : 'ci-ok: FAIL');
  return { ok, lines };
}

/** The job ids under `jobs:` in a workflow file, read from its two-space indented keys. */
export function jobIdsFromWorkflow(text: string): string[] {
  const ids: string[] = [];
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('#')) inJobs = line === 'jobs:';
    const match = inJobs ? /^ {2}([\w-]+):$/.exec(line) : null;
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

const SHA = /^[0-9a-f]{40}$/;
const PR_RANGE = '--first-parent -m HEAD^1..HEAD';
const FULL_HISTORY = '--full-history --all';

/**
 * The `git log` options for the secret scan; never empty. A pull request scans its net change
 * (the merge ref's first-parent diff), a push its pushed range, anything else full history.
 */
export function secretsLogOpts(input: {
  event: string;
  before?: string | undefined;
  after?: string | undefined;
  beforeExists: boolean;
}): string {
  const { event, before = '', after = '', beforeExists } = input;
  if (event === 'pull_request') return PR_RANGE;
  if (
    event === 'push' &&
    SHA.test(before) &&
    SHA.test(after) &&
    !/^0+$/.test(before) &&
    beforeExists
  ) {
    return `${before}..${after}`;
  }
  return FULL_HISTORY;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function git(args: string[]): { status: number; stdout: string } {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { status: result.error ? 127 : (result.status ?? 1), stdout: result.stdout };
}

function writeOutputs(outputs: Record<string, string>): void {
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  const file = process.env['GITHUB_OUTPUT'];
  if (file) appendFileSync(file, text);
  else process.stdout.write(text);
}

function changesCommand(base: string | undefined): number {
  const resolved = base ?? (process.env['GITHUB_EVENT_NAME'] === 'pull_request' ? 'HEAD^1' : null);
  let changes: Changes = { github: true, docsOnly: true, code: true };
  if (resolved !== null) {
    const diff = git(['diff', '--name-only', '-z', resolved, 'HEAD']);
    if (diff.status !== 0) {
      console.error(`ci changes: git diff ${resolved} HEAD failed`);
      return 1;
    }
    changes = classifyChanges(diff.stdout.split('\0').filter((path) => path !== ''));
  }
  writeOutputs({
    github: String(changes.github),
    docs_only: String(changes.docsOnly),
    code: String(changes.code),
  });
  return 0;
}

/** `before` and `after` from the push event payload; undefined when absent or unreadable. */
function readPushEvent(): { before: string | undefined; after: string | undefined } {
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH'] ?? '', 'utf8'));
  } catch {
    event = null;
  }
  const field = (key: string) => {
    const value: unknown = isObject(event) ? event[key] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  return { before: field('before'), after: field('after') };
}

function commitCount(opts: string): number | null {
  const result = git(['rev-list', '--count', ...opts.split(' ')]);
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function secretsRangeCommand(): number {
  const event = process.env['GITHUB_EVENT_NAME'] ?? '';
  const { before, after } =
    event === 'push' ? readPushEvent() : { before: undefined, after: undefined };
  const beforeExists =
    before !== undefined &&
    SHA.test(before) &&
    git(['cat-file', '-e', `${before}^{commit}`]).status === 0;
  let opts = secretsLogOpts({ event, before, after, beforeExists });
  let count = commitCount(opts);
  if (event === 'pull_request' && count !== 1) {
    const found = count === null ? 'git rev-list failed' : `${String(count)} commits`;
    console.error(`ci secrets-range: ${opts}: ${found}, expected 1 commit`);
    return 1;
  }
  if (opts !== FULL_HISTORY && count === 0) {
    opts = FULL_HISTORY;
    count = commitCount(opts);
  }
  if (count === null || count === 0) {
    console.error(`ci secrets-range: ${opts} covers no commits`);
    return 1;
  }
  writeOutputs({ 'log-opts': opts });
  return 0;
}

function okCommand(): number {
  let needs: unknown;
  try {
    needs = JSON.parse(process.env['NEEDS'] ?? '');
  } catch {
    console.log('ci-ok: NEEDS is not valid JSON FAIL');
    return 1;
  }
  if (!isObject(needs) || !Object.values(needs).every(isObject)) {
    console.log('ci-ok: NEEDS is not an object of jobs FAIL');
    return 1;
  }
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const verdict = decideCiOk({
    needs: needs as Record<string, NeededJob>,
    event: process.env['GITHUB_EVENT_NAME'] ?? '',
    jobIds: jobIdsFromWorkflow(workflow).filter((id) => id !== 'ci-ok'),
  });
  for (const line of verdict.lines) console.log(line);
  return verdict.ok ? 0 : 1;
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  let code: number;
  if (command === 'changes') code = changesCommand(arg);
  else if (command === 'secrets-range') code = secretsRangeCommand();
  else if (command === 'ok') code = okCommand();
  else {
    console.error('usage: node scripts/ci.ts changes [<base>] | secrets-range | ok');
    code = 2;
  }
  process.exitCode = code;
}
