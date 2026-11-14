import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type CodeRun,
  type RunJob,
  EDIT_SKIPPED,
  isCodeRun,
  judgeCodeRun,
  pickCodeRun,
  standTiming,
} from './ci-runs.ts';
import { decideCiOk, jobIdsFromWorkflow } from './ci.ts';

const CI_YML = new URL('../.github/workflows/ci.yml', import.meta.url);
const SHA = 'e3c0a10'.padEnd(40, '0');
const GUARD = "github.event.action != 'edited'";

const job = (name: string, conclusion = 'success', start = 0, end = 60): RunJob => ({
  name,
  conclusion,
  startedAt: new Date(Date.UTC(2026, 0, 1, 4, 0, start)).toISOString(),
  completedAt: new Date(Date.UTC(2026, 0, 1, 4, 0, end)).toISOString(),
});

// Shaped like run 43556366309: expanded matrix legs, bare skipped `workflows` and release jobs.
function codeJobs(overrides: Record<string, string | null> = {}): RunJob[] {
  const names = ['changes', 'pr-title', 'guardrails', 'secrets', 'workflows', 'quality'];
  const legs = ['test', 'stand', 'package-smoke'].flatMap((id) => [`${id} (24)`, `${id} (26)`]);
  const jobs = [...names, ...legs, 'release-build', 'release-smoke', 'ci-ok'].map((name) =>
    job(name, /^(workflows|release)/.test(name) ? 'skipped' : 'success'),
  );
  jobs[jobs.findIndex((j) => j.name === 'test (24)')] = job('test (24)', 'success', 0, 126);
  jobs[jobs.findIndex((j) => j.name === 'stand (24)')] = job('stand (24)', 'success', 0, 109);
  return jobs
    .filter((j) => overrides[j.name] !== null)
    .map((j) => ({ ...j, conclusion: overrides[j.name] ?? j.conclusion }));
}

function editJobs(): RunJob[] {
  return [...EDIT_SKIPPED, 'release-build', 'release-smoke']
    .map((name) => job(name, 'skipped'))
    .concat([job('pr-title'), job('guardrails'), job('ci-ok', '')]);
}

describe('edit runs in ci.yml', () => {
  const workflow = readFileSync(CI_YML, 'utf8');
  const jobs = (parse(workflow) as { jobs: Record<string, { if?: string; steps?: unknown[] }> })
    .jobs;

  it('skips exactly the EDIT_SKIPPED jobs on an edit and never cancels for one', () => {
    const guarded = jobIdsFromWorkflow(workflow).filter((id) =>
      (jobs[id]?.if ?? '').includes(GUARD),
    );
    expect(guarded).toEqual([...EDIT_SKIPPED]);
    // A new code job must carry the guard and join EDIT_SKIPPED; only these ids run on an edit
    // or never run on a pull request.
    const unguarded = new Set([
      'pr-title',
      'guardrails',
      'ci-ok',
      'release',
      'release-build',
      'release-smoke',
    ]);
    const codeJobIds = jobIdsFromWorkflow(workflow).filter((id) => !unguarded.has(id));
    expect(codeJobIds).toEqual(guarded);
    for (const id of guarded) expect(jobs[id]?.if?.startsWith(GUARD), id).toBe(true);
    for (const id of ['pr-title', 'guardrails', 'ci-ok']) {
      expect(jobs[id]?.if ?? '', id).not.toContain('edited');
    }
    const concurrency = (parse(workflow) as { concurrency: Record<string, string> }).concurrency;
    expect(concurrency['cancel-in-progress']).toBe(
      `\${{ github.event_name == 'pull_request' && ${GUARD} }}`,
    );
  });

  it('times the run before the verdict without letting the timing fail ci-ok', () => {
    const ciOk = (
      parse(workflow) as {
        jobs: Record<string, { permissions: unknown; steps: Record<string, unknown>[] }>;
      }
    ).jobs['ci-ok'];
    expect(ciOk?.permissions).toEqual({ contents: 'read', actions: 'read' });
    const runs = ciOk?.steps.map((step) => step['run']) ?? [];
    const timing = runs.indexOf('node scripts/ci.ts timing');
    expect(timing).toBeGreaterThanOrEqual(0);
    expect(timing).toBeLessThan(runs.indexOf('pnpm ci:ok'));
    expect(ciOk?.steps[timing]).toMatchObject({ 'continue-on-error': true, if: GUARD });
  });
});

describe('decideCiOk on an edit', () => {
  const okRun: CodeRun = { id: 7, ok: true, lines: ['ci-ok: code run 7 test (24) success ok'] };
  const editNeeds = (overrides: Record<string, string> = {}) => {
    const needs: Record<string, { result: string }> = {};
    for (const id of [...EDIT_SKIPPED, 'release-build', 'release-smoke']) {
      needs[id] = { result: 'skipped' };
    }
    needs['pr-title'] = { result: 'success' };
    needs['guardrails'] = { result: 'success' };
    for (const [id, result] of Object.entries(overrides)) needs[id] = { result };
    return needs;
  };
  const decide = (
    codeRun: CodeRun | null | undefined,
    overrides: Record<string, string> = {},
    on: { event: string; action?: string } = { event: 'pull_request', action: 'edited' },
  ) => {
    const needs = editNeeds(overrides);
    return decideCiOk({ needs, jobIds: Object.keys(needs), ...on, codeRun });
  };

  it('passes when the code jobs skipped, title and body passed and the code run passed', () => {
    const verdict = decide(okRun);
    expect(verdict.ok).toBe(true);
    expect(verdict.lines).toContain('ci-ok: workflows skipped ok');
    expect(verdict.lines).toContain('ci-ok: code run 7 test (24) success ok');
    expect(verdict.lines.at(-1)).toBe('ci-ok: PASS');
  });

  it.each([
    ['pr-title', 'failure'],
    ['pr-title', 'skipped'],
    ['guardrails', 'failure'],
    ['guardrails', 'skipped'],
  ])('fails when this run has %s %s', (id, result) => {
    expect(decide(okRun, { [id]: result }).ok).toBe(false);
  });

  it.each([null, undefined])('fails with the push hint when the code run is %s', (codeRun) => {
    const verdict = decide(codeRun);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: no completed code run on the head commit FAIL');
    expect(verdict.lines).toContain('ci-ok: push a new commit to start a code run');
  });

  it('fails when the code run failed', () => {
    expect(decide({ id: 7, ok: false, lines: [] }).ok).toBe(false);
  });

  it.each([
    ['a non-edit PR action', 'pull_request', 'synchronize'],
    ['no action', 'pull_request', undefined],
    ['a push', 'push', 'edited'],
  ])('keeps the skipped test a failure on %s', (_name, event, action) => {
    const verdict = decide(okRun, {}, action === undefined ? { event } : { event, action });
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: test skipped FAIL');
  });
});

describe('judgeCodeRun', () => {
  it('passes a code run whose own guardrails and ci-ok failed', () => {
    const verdict = judgeCodeRun(7, codeJobs({ guardrails: 'failure', 'ci-ok': 'failure' }));
    expect(verdict.ok).toBe(true);
    expect(verdict.lines).toContain('ci-ok: code run 7 test (24) success ok');
    expect(verdict.lines).toContain('ci-ok: code run 7 workflows skipped ok');
    expect(verdict.lines.join('\n')).not.toMatch(/guardrails|pr-title|ci-ok success|release/);
  });

  it('accepts bare skipped workflows and package-smoke', () => {
    const jobs = codeJobs({ 'package-smoke (24)': null, 'package-smoke (26)': null });
    expect(judgeCodeRun(7, [...jobs, job('package-smoke', 'skipped')]).ok).toBe(true);
  });

  it.each(
    ['changes', 'secrets', 'quality', 'test (24)', 'stand (26)'].flatMap((name) =>
      ['failure', 'cancelled', ''].map((conclusion) => [name, conclusion]),
    ),
  )('fails when %s is "%s"', (name, conclusion) => {
    expect(judgeCodeRun(7, codeJobs({ [name]: conclusion })).ok).toBe(false);
  });

  it.each(['test', 'stand'])('fails on a bare skipped %s', (id) => {
    const jobs = codeJobs({ [`${id} (24)`]: null, [`${id} (26)`]: null });
    expect(judgeCodeRun(7, [...jobs, job(id, 'skipped')]).ok).toBe(false);
  });

  it('fails when a code job is missing', () => {
    const verdict = judgeCodeRun(7, codeJobs({ quality: null }));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: code run 7 quality missing FAIL');
  });

  it('fails on a failed package-smoke leg', () => {
    expect(judgeCodeRun(7, codeJobs({ 'package-smoke (24)': 'failure' })).ok).toBe(false);
  });
});

describe('pickCodeRun', () => {
  it('tells a code run from an edit run', () => {
    expect(isCodeRun(codeJobs())).toBe(true);
    expect(isCodeRun(codeJobs({ 'test (24)': 'cancelled' }))).toBe(true);
    expect(isCodeRun(editJobs())).toBe(false);
  });

  it('judges the newest code run, skipping the current run, empty runs and edit runs', () => {
    const jobs: Record<number, RunJob[]> = { 1: codeJobs(), 2: codeJobs(), 3: [], 4: editJobs() };
    const asked: number[] = [];
    const jobsOf = (id: number) => {
      asked.push(id);
      return jobs[id] ?? [];
    };
    expect(pickCodeRun([1, 4, 3, 2, 5], 5, jobsOf)?.id).toBe(2);
    expect(asked).toEqual([4, 3, 2]);
    expect(pickCodeRun([3, 4], 5, jobsOf)).toBeNull();
  });
});

describe('standTiming', () => {
  it('tabulates both legs of run 43556366309 without a warning', () => {
    const { summary, warnings } = standTiming(codeJobs());
    expect(summary).toContain('| Node | test | stand |');
    expect(summary).toContain('| 24 | 126s | 109s |');
    expect(summary).toContain('| 26 | 60s | 60s |');
    expect(warnings).toEqual([]);
  });

  it('warns when stand took strictly longer', () => {
    const jobs = codeJobs().map((j) =>
      j.name === 'stand (26)' ? job(j.name, 'success', 0, 61) : j,
    );
    expect(standTiming(jobs).warnings).toEqual([
      '::warning title=stand slower than test::stand (26) took 61s, test (26) 60s',
    ]);
  });

  it.each([
    ['an edit run', editJobs()],
    ['failed stand legs', codeJobs({ 'stand (24)': 'failure', 'stand (26)': 'cancelled' })],
    ['missing stand legs', codeJobs({ 'stand (24)': null, 'stand (26)': null })],
  ])('reports nothing for %s', (_name, jobs) => {
    expect(standTiming(jobs)).toEqual({ summary: null, warnings: [] });
  });
});

interface Reply {
  stdout?: string;
  exit?: number;
}

const RUNS = `api repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${SHA}&per_page=100`;
const JOBS = (id: number) => `api repos/o/r/actions/runs/${String(id)}/jobs?per_page=100`;
const apiJobs = (jobs: RunJob[]): Reply => ({
  stdout: JSON.stringify({
    jobs: jobs.map((j) => ({
      name: j.name,
      conclusion: j.conclusion === '' ? null : j.conclusion,
      started_at: j.startedAt,
      completed_at: j.completedAt,
    })),
  }),
});
const apiRuns = (...ids: number[]): Reply => ({
  stdout: JSON.stringify({ workflow_runs: ids.map((id) => ({ id })) }),
});

// Runs ci.ts with a fake `gh` first on PATH that answers from `replies`, keyed by its argv joined
// with spaces, logs every call, and fails any call it has no reply for.
function cli(replies: Record<string, Reply>, command: string, extra: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-runs-'));
  writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
  writeFileSync(
    join(dir, 'gh'),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const key = process.argv.slice(2).join(" ");',
      `fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, key + "\\n");`,
      `const reply = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'replies.json'))}, 'utf8'))[key];`,
      'if (reply === undefined) { process.stderr.write("fake gh: no reply for " + key + "\\n"); process.exit(99); }',
      'process.stdout.write(reply.stdout ?? "");',
      'process.exit(reply.exit ?? 0);',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(
    join(dir, 'event.json'),
    JSON.stringify({ action: 'edited', pull_request: { head: { sha: SHA } } }),
  );
  writeFileSync(join(dir, 'summary'), '');
  const needs: Record<string, { result: string }> = {};
  for (const id of [...EDIT_SKIPPED, 'release-build', 'release-smoke']) {
    needs[id] = { result: 'skipped' };
  }
  needs['pr-title'] = needs['guardrails'] = { result: 'success' };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env['PATH'] ?? ''}`,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: join(dir, 'event.json'),
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '9',
    GITHUB_OUTPUT: join(dir, 'output'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    NEEDS: JSON.stringify(needs),
    ...extra,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) Reflect.deleteProperty(env, key);
  }
  const script = fileURLToPath(new URL('ci.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, command], { env, encoding: 'utf8' });
  const callsFile = join(dir, 'calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  const summary = readFileSync(join(dir, 'summary'), 'utf8');
  return { status: result.status, lines: result.stdout.trimEnd().split('\n'), calls, summary };
}

describe('ci.ts ok on an edit', () => {
  it('passes on a code run whose stale guardrails and ci-ok failed, never reading itself', () => {
    const stale = codeJobs({ guardrails: 'failure', 'ci-ok': 'failure' });
    const result = cli({ [RUNS]: apiRuns(9, 8, 7), [JOBS(8)]: apiJobs(stale) }, 'ok');
    expect(result.status).toBe(0);
    expect(result.lines).toContain('ci-ok: code run 8 test (24) success ok');
    expect(result.calls).toEqual([RUNS, JOBS(8)]);
  });

  it('fails when the code run has a failed stand leg', () => {
    const jobs = codeJobs({ 'stand (24)': 'failure' });
    const result = cli({ [RUNS]: apiRuns(9, 8), [JOBS(8)]: apiJobs(jobs) }, 'ok');
    expect(result.status).toBe(1);
    expect(result.lines).toContain('ci-ok: code run 8 stand (24) failure FAIL');
  });

  it.each([
    ['only edit runs', { [RUNS]: apiRuns(9, 8), [JOBS(8)]: apiJobs(editJobs()) }],
    ['no runs', { [RUNS]: apiRuns() }],
    ['a run with no jobs', { [RUNS]: apiRuns(8), [JOBS(8)]: apiJobs([]) }],
  ])('fails with no code run on %s', (_name, replies) => {
    const result = cli(replies, 'ok');
    expect(result.status).toBe(1);
    expect(result.lines).toContain('ci-ok: no completed code run on the head commit FAIL');
  });

  it('fails when gh fails', () => {
    expect(cli({ [RUNS]: { exit: 1 } }, 'ok').status).toBe(1);
  });

  it('fails when the head sha is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-runs-event-'));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ action: 'edited' }));
    const result = cli({}, 'ok', { GITHUB_EVENT_PATH: join(dir, 'event.json') });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
  });
});

describe('ci.ts timing', () => {
  it('appends the table to the step summary and prints the warning', () => {
    const jobs = codeJobs().map((j) =>
      j.name === 'stand (26)' ? job(j.name, 'success', 0, 90) : j,
    );
    const result = cli({ [JOBS(9)]: apiJobs(jobs) }, 'timing');
    expect(result.status).toBe(0);
    expect(result.summary).toContain('| 26 | 60s | 90s |');
    expect(result.lines).toContain(
      '::warning title=stand slower than test::stand (26) took 90s, test (26) 60s',
    );
  });

  it('fails when gh fails', () => {
    expect(cli({ [JOBS(9)]: { exit: 1 } }, 'timing').status).not.toBe(0);
  });
});
