// GitHub Actions reads for the ci-ok job in .github/workflows/ci.yml: the code run a PR edit
// stands on, and the test-versus-stand wall time. Imports only `node:` builtins, so ci-ok skips
// `pnpm install`. Responses of an unexpected shape throw, so callers fail closed.
import { spawnSync } from 'node:child_process';

/** The code jobs a `pull_request: edited` run skips; the edit's ci-ok judges them in the code run. */
export const EDIT_SKIPPED = new Set([
  'changes',
  'secrets',
  'workflows',
  'quality',
  'test',
  'stand',
  'package-smoke',
]);

/** Code jobs whose skip the code run's own ci-ok accepts on a `changes` output. */
const CONDITIONAL_SKIPS = new Set(['workflows', 'package-smoke']);

export interface RunJob {
  name: string;
  /** '' while the job has not completed. */
  conclusion: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CodeRun {
  id: number;
  ok: boolean;
  lines: string[];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ghJson(path: string): unknown {
  const result = spawnSync('gh', ['api', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr.trim();
    throw new Error(`gh api ${path} failed: ${reason}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

function optionalString(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

/** The jobs of one run, from the jobs API. */
export function fetchJobs(repo: string, runId: number): RunJob[] {
  const body = ghJson(`repos/${repo}/actions/runs/${String(runId)}/jobs?per_page=100`);
  if (!isObject(body) || !Array.isArray(body['jobs'])) {
    throw new Error(`run ${String(runId)}: jobs response has no jobs list`);
  }
  return body['jobs'].map((job: unknown) => {
    if (!isObject(job) || typeof job['name'] !== 'string') {
      throw new Error(`run ${String(runId)}: a job has no name`);
    }
    return {
      name: job['name'],
      conclusion: optionalString(job['conclusion'], 'job conclusion') ?? '',
      startedAt: optionalString(job['started_at'], 'job started_at'),
      completedAt: optionalString(job['completed_at'], 'job completed_at'),
    };
  });
}

/** Ids of the ci.yml pull request runs on a head commit. */
export function fetchRunIds(repo: string, headSha: string): number[] {
  const body = ghJson(
    `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`,
  );
  if (!isObject(body) || !Array.isArray(body['workflow_runs'])) {
    throw new Error('runs response has no workflow_runs list');
  }
  return body['workflow_runs'].map((run: unknown) => {
    const id = isObject(run) ? run['id'] : undefined;
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('a run has no id');
    return id;
  });
}

/** A job belongs to an id when its name is the id or an expanded matrix leg `<id> (<n>)`. */
function belongs(name: string, id: string): boolean {
  return name === id || name.startsWith(`${id} (`);
}

/** A run is a code run when its `test` job was not skipped; an edit run skips it. */
export function isCodeRun(jobs: RunJob[]): boolean {
  return jobs.some((job) => belongs(job.name, 'test') && job.conclusion !== 'skipped');
}

/**
 * Judges the code jobs of a run. Every job of an `EDIT_SKIPPED` id must succeed; a
 * `CONDITIONAL_SKIPS` id may instead be one bare skipped job. A missing id fails. The run's own
 * `pr-title`, `guardrails`, `ci-ok` and release jobs are not read.
 */
export function judgeCodeRun(id: number, jobs: RunJob[]): CodeRun {
  const lines: string[] = [];
  let ok = true;
  for (const jobId of EDIT_SKIPPED) {
    const matched = jobs.filter((job) => belongs(job.name, jobId));
    if (matched.length === 0) {
      lines.push(`ci-ok: code run ${String(id)} ${jobId} missing FAIL`);
      ok = false;
      continue;
    }
    const skipAccepted =
      CONDITIONAL_SKIPS.has(jobId) &&
      matched.length === 1 &&
      matched[0]?.name === jobId &&
      matched[0].conclusion === 'skipped';
    for (const job of matched) {
      const accepted = skipAccepted || job.conclusion === 'success';
      if (!accepted) ok = false;
      const conclusion = job.conclusion === '' ? 'not-completed' : job.conclusion;
      lines.push(
        `ci-ok: code run ${String(id)} ${job.name} ${conclusion} ${accepted ? 'ok' : 'FAIL'}`,
      );
    }
  }
  return { id, ok, lines };
}

/**
 * Judges the newest code run among `runIds`, skipping the current run, runs with no jobs and edit
 * runs. Null when there is none.
 */
export function pickCodeRun(
  runIds: number[],
  currentRunId: number,
  jobsOf: (id: number) => RunJob[],
): CodeRun | null {
  for (const id of [...runIds].sort((a, b) => b - a)) {
    if (id === currentRunId) continue;
    const jobs = jobsOf(id);
    if (jobs.length > 0 && isCodeRun(jobs)) return judgeCodeRun(id, jobs);
  }
  return null;
}

function seconds(job: RunJob): number | null {
  if (job.conclusion !== 'success' || job.startedAt === null || job.completedAt === null) {
    return null;
  }
  const ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/**
 * The wall time of `test (N)` against `stand (N)` for every Node leg where both succeeded, as a
 * markdown table, and a warning per leg where stand took longer.
 */
export function standTiming(jobs: RunJob[]): { summary: string | null; warnings: string[] } {
  const rows: string[] = [];
  const warnings: string[] = [];
  for (const test of jobs) {
    const node = /^test \((\d+)\)$/.exec(test.name)?.[1];
    const stand = jobs.find((job) => job.name === `stand (${node ?? ''})`);
    const testTime = seconds(test);
    const standTime = stand === undefined ? null : seconds(stand);
    if (node === undefined || testTime === null || standTime === null) continue;
    rows.push(`| ${node} | ${String(testTime)}s | ${String(standTime)}s |`);
    if (standTime > testTime) {
      warnings.push(
        `::warning title=stand slower than test::stand (${node}) took ${String(standTime)}s, test (${node}) ${String(testTime)}s`,
      );
    }
  }
  if (rows.length === 0) return { summary: null, warnings };
  const table = ['| Node | test | stand |', '| --- | --- | --- |', ...rows];
  return { summary: ['### Test and stand wall time', '', ...table, ''].join('\n'), warnings };
}
