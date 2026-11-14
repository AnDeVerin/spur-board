// GitHub Actions reads for the reuse and ci-ok jobs in .github/workflows/ci.yml: the code run a
// PR edit may reuse, and the test-versus-stand wall time. Imports only `node:` builtins, so those
// jobs skip `pnpm install`. Responses of an unexpected shape throw; callers fall back or fail.
import { spawnSync } from 'node:child_process';

/**
 * The code jobs. A `pull_request: edited` run skips them when `reuse` found a code run that tested
 * the same merge commit; the edit's ci-ok then judges them in that run.
 */
export const CODE_JOBS = new Set([
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

/** The `changes` step whose name records the merge commit a run tested: `Revision <sha>`. */
export const REVISION_STEP = 'Revision ';

interface RunStep {
  name: string;
  /** '' while the step has not completed. */
  conclusion: string;
}

export interface RunJob {
  name: string;
  /** '' while the job has not completed. */
  conclusion: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: RunStep[];
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
    const steps = job['steps'] ?? [];
    if (!Array.isArray(steps)) throw new Error(`run ${String(runId)}: job steps is not a list`);
    return {
      name: job['name'],
      conclusion: optionalString(job['conclusion'], 'job conclusion') ?? '',
      startedAt: optionalString(job['started_at'], 'job started_at'),
      completedAt: optionalString(job['completed_at'], 'job completed_at'),
      steps: steps.map((step: unknown) => {
        if (!isObject(step) || typeof step['name'] !== 'string') {
          throw new Error(`run ${String(runId)}: a step has no name`);
        }
        return {
          name: step['name'],
          conclusion: optionalString(step['conclusion'], 'step conclusion') ?? '',
        };
      }),
    };
  });
}

export interface PrRun {
  id: number;
  /** Numbers of the open pull requests GitHub lists for the run's head; empty for a fork. */
  pullRequests: number[];
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** The ci.yml pull request runs on a head commit, up to `MAX_PAGES` pages. */
export function fetchRuns(repo: string, headSha: string): PrRun[] {
  const runs: PrRun[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = ghJson(
      `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${headSha}&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
    );
    if (!isObject(body) || !Array.isArray(body['workflow_runs'])) {
      throw new Error('runs response has no workflow_runs list');
    }
    for (const run of body['workflow_runs'] as unknown[]) {
      const id = isObject(run) ? run['id'] : undefined;
      if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('a run has no id');
      const prs = isObject(run) ? (run['pull_requests'] ?? []) : [];
      if (!Array.isArray(prs)) throw new Error(`run ${String(id)}: pull_requests is not a list`);
      const pullRequests = prs.map((pr: unknown) => {
        const number = isObject(pr) ? pr['number'] : undefined;
        if (typeof number !== 'number') throw new Error(`run ${String(id)}: a PR has no number`);
        return number;
      });
      runs.push({ id, pullRequests });
    }
    if (body['workflow_runs'].length < PAGE_SIZE) break;
  }
  return runs;
}

/** A job belongs to an id when its name is the id or an expanded matrix leg `<id> (<n>)`. */
function belongs(name: string, id: string): boolean {
  return name === id || name.startsWith(`${id} (`);
}

/** A run is a code run when its `test` job was not skipped; an edit run skips it. */
export function isCodeRun(jobs: RunJob[]): boolean {
  return jobs.some((job) => belongs(job.name, 'test') && job.conclusion !== 'skipped');
}

/** True when the run's `changes` job has a successful `Revision <revision>` step. */
function testedRevision(jobs: RunJob[], revision: string): boolean {
  return jobs.some(
    (job) =>
      job.name === 'changes' &&
      job.steps.some(
        (step) => step.name === `${REVISION_STEP}${revision}` && step.conclusion === 'success',
      ),
  );
}

/**
 * Judges the code jobs of a run. Every job of a `CODE_JOBS` id must succeed; a
 * `CONDITIONAL_SKIPS` id may instead be one bare skipped job. A missing id fails, and so does a
 * run that did not record `revision`. The run's own `pr-title`, `guardrails`, `ci-ok` and release
 * jobs are not read.
 */
export function judgeCodeRun(id: number, jobs: RunJob[], revision: string): CodeRun {
  const lines: string[] = [];
  let ok = testedRevision(jobs, revision);
  lines.push(
    ok
      ? `ci-ok: code run ${String(id)} tested ${revision} ok`
      : `ci-ok: code run ${String(id)} did not test ${revision} FAIL`,
  );
  for (const jobId of CODE_JOBS) {
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
 * The newest code run, other than the current run, that recorded `Revision <revision>`: it tested
 * the same merge commit. The `pullRequests` filter only saves job lookups; the revision decides.
 * Runs with no jobs and edit runs are skipped. `id` is null when there is none.
 */
export function pickReusableRun(
  runs: PrRun[],
  current: { runId: number; pr: number; revision: string },
  jobsOf: (id: number) => RunJob[],
): { id: number | null; lines: string[] } {
  const lines: string[] = [];
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    if (run.id === current.runId) continue;
    if (!run.pullRequests.includes(current.pr)) {
      lines.push(`reuse: run ${String(run.id)} belongs to another pull request`);
      continue;
    }
    const jobs = jobsOf(run.id);
    if (jobs.length === 0 || !isCodeRun(jobs)) continue;
    if (!testedRevision(jobs, current.revision)) {
      lines.push(`reuse: run ${String(run.id)} tested another revision`);
      continue;
    }
    lines.push(`reuse: reusing code run ${String(run.id)}, which tested ${current.revision}`);
    return { id: run.id, lines };
  }
  lines.push(
    `reuse: no code run of this pull request tested ${current.revision}; running the code jobs`,
  );
  return { id: null, lines };
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
