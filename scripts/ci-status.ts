// `pnpm ci:status [PR]`: the latest CI state of a PR's head commit, by job and step.
// Failed, cancelled, pending and superseded runs are kept apart. The last stdout line is always
// `CI-STATUS PASS|FAIL|CANCELLED|PENDING|ERROR (exit N)`, and the exit code is N.
import { spawnSync } from 'node:child_process';

/** The workflow whose run decides the PR (`name:` on line 1 of .github/workflows/ci.yml). */
export const REQUIRED_WORKFLOW = 'ci';
/** The summary job; it fails whenever another job fails or is cancelled. */
const CI_OK = 'ci-ok';
const TAIL_LINES = 20;

export interface RunListItem {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string;
  createdAt: string;
}

interface JobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string;
}

export interface Job {
  name: string;
  databaseId: number;
  status: string;
  conclusion: string;
  steps: JobStep[];
}

export interface RunView {
  status: string;
  conclusion: string;
  jobs: Job[];
}

export interface SummaryInput {
  sha: string;
  runs: RunListItem[];
  /** `gh run view <id> --json status,conclusion,jobs`, keyed by run id. */
  views: Record<string, RunView>;
  /** `--log-failed` output, keyed by run id; missing when not fetched or the fetch failed. */
  logs: Record<string, string>;
}

type State = 'pass' | 'pending' | 'cancelled' | 'failed';

const RANK: Record<State, number> = { pass: 0, pending: 1, cancelled: 2, failed: 3 };
const EXIT: Record<State | 'error', number> = {
  pass: 0,
  failed: 1,
  error: 2,
  pending: 3,
  cancelled: 4,
};
const LABEL: Record<State | 'error', string> = {
  pass: 'PASS',
  failed: 'FAIL',
  error: 'ERROR',
  pending: 'PENDING',
  cancelled: 'CANCELLED',
};

function statusLine(code: number): string {
  const state = (Object.keys(EXIT) as (keyof typeof EXIT)[]).find((key) => EXIT[key] === code);
  return `CI-STATUS ${state === undefined ? 'ERROR' : LABEL[state]} (exit ${String(code)})`;
}

const OK = new Set(['success', 'skipped', 'neutral']);

/** A job or step conclusion; an empty one means it has not finished. Unknown values count as failed. */
function classify(conclusion: string): 'ok' | 'cancelled' | 'pending' | 'failed' {
  if (conclusion === '') return 'pending';
  if (OK.has(conclusion)) return 'ok';
  return conclusion === 'cancelled' ? 'cancelled' : 'failed';
}

/** Latest run per workflow (latest createdAt, tie -> higher id) and the older runs it supersedes. */
function latestRuns(runs: RunListItem[]): {
  latest: RunListItem[];
  superseded: { run: RunListItem; by: RunListItem }[];
} {
  const newestFirst = [...runs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.databaseId - a.databaseId,
  );
  const byWorkflow = new Map<string, RunListItem>();
  const superseded: { run: RunListItem; by: RunListItem }[] = [];
  for (const run of newestFirst) {
    const by = byWorkflow.get(run.workflowName);
    if (by === undefined) byWorkflow.set(run.workflowName, run);
    else superseded.push({ run, by });
  }
  return { latest: [...byWorkflow.values()], superseded };
}

/** Failed jobs that count: ci-ok only when no other job failed or was cancelled. */
function countedFailures(view: RunView): Job[] {
  const failed = view.jobs.filter((job) => classify(job.conclusion) === 'failed');
  const othersBad = view.jobs.some(
    (job) => job.name !== CI_OK && ['failed', 'cancelled'].includes(classify(job.conclusion)),
  );
  return othersBad ? failed.filter((job) => job.name !== CI_OK) : failed;
}

/**
 * The gh arguments that fetch the logs of a run's counted failed jobs. gh refuses run-wide
 * --log-failed until the run completes, so an unfinished run is read job by job.
 */
function logFetches(id: number, view: RunView): string[][] {
  const failed = countedFailures(view);
  if (failed.length === 0) return [];
  const run = ['run', 'view', String(id)];
  if (view.status === 'completed') return [[...run, '--log-failed']];
  return failed
    .filter((job) => job.status === 'completed')
    .map((job) => [...run, '--job', String(job.databaseId), '--log-failed']);
}

/**
 * `gh run view --log-failed` output -> job -> step -> text lines. Each line is
 * `<job>\t<step>\t<ISO timestamp> <text>`; the first line of each block starts its third
 * field with U+FEFF, and continuation lines of a multi-line value carry no timestamp.
 */
export function parseFailedLog(text: string): Map<string, Map<string, string[]>> {
  const jobs = new Map<string, Map<string, string[]>>();
  for (const line of text.split('\n')) {
    const first = line.indexOf('\t');
    const second = first === -1 ? -1 : line.indexOf('\t', first + 1);
    if (second === -1) continue;
    const job = line.slice(0, first);
    const step = line.slice(first + 1, second);
    let rest = line.slice(second + 1).replace(/\r$/, '');
    if (rest.startsWith('\uFEFF')) rest = rest.slice(1);
    rest = rest.replace(/^\d{4}-\d\d-\d\dT\S*Z /, '');
    const steps = jobs.get(job) ?? new Map<string, string[]>();
    jobs.set(job, steps);
    const lines = steps.get(step) ?? [];
    steps.set(step, lines);
    lines.push(rest);
  }
  return jobs;
}

/** The local command that reproduces a failed step. Step names in ci.yml are the commands. */
export function reproFor(job: string, step: string): string {
  const pnpm = /^Run (pnpm \S.*)$/.exec(step);
  if (pnpm?.[1] !== undefined) return pnpm[1];
  if (job === 'secrets') return 'GITLEAKS_LOG_OPTS=origin/main..HEAD sh scripts/gitleaks.sh';
  if (job === 'pr-title') return 'no local command - edit the PR title';
  return 'no local command - read the log above';
}

function runState(view: RunView, counted: Job[]): State {
  if (counted.length > 0) return 'failed';
  if (view.status !== 'completed') return 'pending';
  const jobs = view.jobs.map((job) => classify(job.conclusion));
  const anyCancelled = jobs.includes('cancelled');
  if (!anyCancelled && classify(view.conclusion) === 'failed') return 'failed';
  if (anyCancelled || view.conclusion === 'cancelled') return 'cancelled';
  if (jobs.includes('pending')) return 'pending';
  return 'pass';
}

function runLines(
  run: RunListItem,
  view: RunView,
  log: string | undefined,
): {
  lines: string[];
  state: State;
} {
  const counted = countedFailures(view);
  const state = runState(view, counted);
  const lines = [
    `run ${String(run.databaseId)} ${run.workflowName} ${view.conclusion || view.status}`,
  ];
  const logs = parseFailedLog(log ?? '');
  for (const job of view.jobs) {
    const kind = classify(job.conclusion);
    if (kind === 'pending') {
      lines.push(`  ${job.name} pending`);
      continue;
    }
    if (kind === 'failed' && !counted.includes(job)) {
      lines.push(`  ${job.name} ${job.conclusion} (follows the jobs above)`);
      continue;
    }
    lines.push(`  ${job.name} ${job.conclusion}`);
    if (kind !== 'failed') continue;
    const steps = job.steps.filter((step) => classify(step.conclusion) === 'failed');
    if (steps.length === 0) {
      lines.push('    no failed step reported', `    repro: ${reproFor(job.name, '')}`);
    }
    for (const step of steps) {
      lines.push(`    step ${String(step.number)} ${step.name}`);
      const text = logs.get(job.name)?.get(step.name) ?? [];
      if (text.length === 0) lines.push('      log not available');
      for (const line of text.slice(-TAIL_LINES)) lines.push(`      ${line}`);
      lines.push(`    repro: ${reproFor(job.name, step.name)}`);
    }
  }
  if (state === 'failed' && counted.length === 0 && view.status === 'completed') {
    lines.push(
      `run ${String(run.databaseId)} ${run.workflowName} concluded ${view.conclusion} with no failed job`,
    );
  }
  return { lines, state };
}

/** The report for a head commit, without the CI-STATUS line. */
export function summarize(input: SummaryInput): { lines: string[]; code: number } {
  const { latest, superseded } = latestRuns(input.runs);
  const lines: string[] = [];
  let worst: State = 'pass';
  const worsen = (state: State) => {
    if (RANK[state] > RANK[worst]) worst = state;
  };
  for (const { run, by } of superseded) {
    lines.push(
      `run ${String(run.databaseId)} ${run.workflowName} ${run.conclusion || run.status} - superseded by run ${String(by.databaseId)}`,
    );
  }
  for (const run of latest) {
    const view = input.views[String(run.databaseId)];
    if (view === undefined) throw new Error(`no jobs read for run ${String(run.databaseId)}`);
    const result = runLines(run, view, input.logs[String(run.databaseId)]);
    lines.push(...result.lines);
    worsen(result.state);
  }
  if (!latest.some((run) => run.workflowName === REQUIRED_WORKFLOW)) {
    lines.push(`ci-status: no ci run on ${input.sha.slice(0, 7)} yet`);
    worsen('pending');
  }
  return { lines, code: EXIT[worst] };
}

function gh(args: string[]): { ok: true; stdout: string } | { ok: false; message: string } {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) return { ok: false, message: result.error.message };
  if (result.status !== 0) {
    const code = result.status === null ? String(result.signal) : String(result.status);
    return { ok: false, message: `gh ${args.join(' ')} failed (exit ${code})\n${result.stderr}` };
  }
  return { ok: true, stdout: result.stdout };
}

/** A gh read the report cannot do without: failure -> exit 2 with gh's message. */
function ghJson(args: string[]): unknown {
  const result = gh(args);
  if (!result.ok) throw new Error(result.message);
  return JSON.parse(result.stdout);
}

const USAGE = 'usage: pnpm ci:status [PR number, URL or branch]';

function main(argv: string[]): number {
  if (argv.length > 1 || argv[0]?.startsWith('-') === true) {
    console.error(USAGE);
    return EXIT.error;
  }
  const pr = ghJson(['pr', 'view', ...argv, '--json', 'number,headRefOid']) as {
    number: number;
    headRefOid: string;
  };
  console.log(`ci-status: PR #${String(pr.number)} head ${pr.headRefOid.slice(0, 7)}`);
  const runs = ghJson([
    'run',
    'list',
    '--commit',
    pr.headRefOid,
    '--limit',
    '50',
    '--json',
    'databaseId,workflowName,status,conclusion,event,createdAt,attempt',
  ]) as RunListItem[];
  const views: Record<string, RunView> = {};
  const logs: Record<string, string> = {};
  for (const run of latestRuns(runs).latest) {
    const id = String(run.databaseId);
    const view = ghJson(['run', 'view', id, '--json', 'status,conclusion,jobs']) as RunView;
    views[id] = view;
    // A log that cannot be read prints `log not available`; it never changes the exit code.
    const texts = logFetches(run.databaseId, view)
      .map(gh)
      .flatMap((result) => (result.ok ? [result.stdout] : []));
    if (texts.length > 0) logs[id] = texts.join('\n');
  }
  const { lines, code } = summarize({ sha: pr.headRefOid, runs, views, logs });
  for (const line of lines) console.log(line);
  return code;
}

if (import.meta.main) {
  let code: number;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-status: ${error instanceof Error ? error.message : String(error)}`);
    code = EXIT.error;
  }
  console.log(statusLine(code));
  process.exitCode = code;
}
