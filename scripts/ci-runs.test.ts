import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type CodeRun,
  type PrRun,
  type RunJob,
  CODE_JOBS,
  REVISION_STEP,
  isCodeRun,
  judgeCodeRun,
  pickReusableRun,
  standTiming,
} from './ci-runs.ts';
import { decideCiOk, jobIdsFromWorkflow } from './ci.ts';

const CI_YML = new URL('../.github/workflows/ci.yml', import.meta.url);
const SHA = 'e3c0a10'.padEnd(40, '0');
/** The merge commit this run tests, `GITHUB_SHA`. */
const MERGE = '6df560a'.padEnd(40, '0');
/** The merge commit of a run made before the base moved. */
const OLD_MERGE = '5b1d2c3'.padEnd(40, '0');
const REUSE_GUARD = "${{ !cancelled() && needs.reuse.outputs.code-run == '' }}";
const CHANGES_GUARD = "${{ !cancelled() && needs.changes.result == 'success' && ";

const job = (name: string, conclusion = 'success', start = 0, end = 60): RunJob => ({
  name,
  conclusion,
  startedAt: new Date(Date.UTC(2026, 0, 1, 4, 0, start)).toISOString(),
  completedAt: new Date(Date.UTC(2026, 0, 1, 4, 0, end)).toISOString(),
  steps: [],
});

// Shaped like run 43556366309: expanded matrix legs, bare skipped `workflows` and release jobs.
// `changes` records `revision` in its Revision step; null leaves the step out.
function codeJobs(
  overrides: Record<string, string | null> = {},
  revision: string | null = MERGE,
): RunJob[] {
  const names = ['changes', 'pr-title', 'guardrails', 'secrets', 'workflows', 'quality'];
  const legs = ['test', 'stand', 'package-smoke'].flatMap((id) => [`${id} (24)`, `${id} (26)`]);
  const jobs = [...names, ...legs, 'release-build', 'release-smoke', 'ci-ok'].map((name) =>
    job(name, /^(workflows|release)/.test(name) ? 'skipped' : 'success'),
  );
  jobs[jobs.findIndex((j) => j.name === 'test (24)')] = job('test (24)', 'success', 0, 126);
  jobs[jobs.findIndex((j) => j.name === 'stand (24)')] = job('stand (24)', 'success', 0, 109);
  const steps = revision === null ? [] : [{ name: `Revision ${revision}`, conclusion: 'success' }];
  return jobs
    .filter((j) => overrides[j.name] !== null)
    .map((j) => ({
      ...j,
      conclusion: overrides[j.name] ?? j.conclusion,
      steps: j.name === 'changes' ? steps : [],
    }));
}

function editJobs(): RunJob[] {
  return ['reuse', ...CODE_JOBS, 'release-build', 'release-smoke']
    .map((name) => job(name, name === 'reuse' ? 'success' : 'skipped'))
    .concat([job('pr-title'), job('guardrails'), job('ci-ok', '')]);
}

type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

/** The needs of an edit run whose reuse output is `codeRun` and whose code jobs ended `code`. */
function editNeeds(codeRun: string, code = 'skipped', overrides: Record<string, string> = {}) {
  const needs: Needs = { reuse: { result: 'success', outputs: { 'code-run': codeRun } } };
  for (const id of CODE_JOBS) needs[id] = { result: code };
  needs['release-build'] = needs['release-smoke'] = { result: 'skipped' };
  needs['pr-title'] = needs['guardrails'] = { result: 'success' };
  for (const [id, result] of Object.entries(overrides)) needs[id] = { ...needs[id], result };
  return needs;
}

interface WorkflowJob {
  if?: string;
  needs?: unknown;
  permissions?: unknown;
  outputs?: unknown;
  steps?: Record<string, unknown>[];
}

describe('reuse gating in ci.yml', () => {
  const workflow = readFileSync(CI_YML, 'utf8');
  const parsed = parse(workflow) as {
    concurrency: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  };
  const jobs = parsed.jobs;

  it('runs reuse only on an edit, read-only and with no install', () => {
    const reuse = jobs['reuse'];
    expect(reuse?.if).toBe(
      "github.event_name == 'pull_request' && github.event.action == 'edited'",
    );
    expect(reuse?.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(reuse?.outputs).toEqual({ 'code-run': '${{ steps.reuse.outputs.code-run }}' });
    expect(reuse?.steps?.find((step) => step['id'] === 'reuse')).toMatchObject({
      run: 'node scripts/ci.ts reuse',
      env: { GH_TOKEN: '${{ github.token }}' },
    });
    expect(JSON.stringify(reuse?.steps)).not.toMatch(/pnpm|install/);
  });

  it('gates every code job on reuse, directly or through changes, and never cancels an edit', () => {
    // A new job that does not read the title or body must be gated and join CODE_JOBS.
    const notCode = new Set(['reuse', 'pr-title', 'guardrails', 'ci-ok', 'release']);
    for (const id of ['release-build', 'release-smoke']) notCode.add(id);
    const codeJobIds = jobIdsFromWorkflow(workflow).filter((id) => !notCode.has(id));
    expect(codeJobIds).toEqual([...CODE_JOBS]);
    for (const id of codeJobIds) {
      const { needs, if: condition = '' } = jobs[id] ?? {};
      const viaReuse = needs === 'reuse' && condition === REUSE_GUARD;
      const viaChanges = needs === 'changes' && condition.startsWith(CHANGES_GUARD);
      expect(viaReuse || viaChanges, `${id}: ${condition}`).toBe(true);
    }
    expect(jobs['changes']).toMatchObject({ needs: 'reuse', if: REUSE_GUARD });
    const steps = jobs['changes']?.steps ?? [];
    const checkout = steps.findIndex((step) =>
      String(step['uses']).startsWith('actions/checkout@'),
    );
    const revision = steps.findIndex(
      (step) => step['name'] === `${REVISION_STEP}\${{ github.sha }}`,
    );
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(revision).toBeGreaterThan(checkout);
    for (const id of ['pr-title', 'guardrails', 'ci-ok']) {
      expect(jobs[id]?.if ?? '', id).not.toContain('reuse');
    }
    expect(parsed.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' && github.event.action != 'edited' }}",
    );
  });

  it('times every run before the verdict without letting the timing fail ci-ok', () => {
    const ciOk = jobs['ci-ok'];
    expect(ciOk?.permissions).toEqual({ contents: 'read', actions: 'read' });
    const runs = ciOk?.steps?.map((step) => step['run']) ?? [];
    const timing = runs.indexOf('node scripts/ci.ts timing');
    expect(timing).toBeGreaterThanOrEqual(0);
    expect(timing).toBeLessThan(runs.indexOf('pnpm ci:ok'));
    expect(ciOk?.steps?.[timing]).toMatchObject({ 'continue-on-error': true });
    expect(ciOk?.steps?.[timing]).not.toHaveProperty('if');
  });
});

describe('decideCiOk on an edit', () => {
  const okRun: CodeRun = { id: 7, ok: true, lines: ['ci-ok: code run 7 test (24) success ok'] };
  const EDIT = { event: 'pull_request', action: 'edited' };
  const decide = (
    codeRun: CodeRun | null,
    needs: Needs = editNeeds('7'),
    on: { event: string; action?: string } = EDIT,
  ) => decideCiOk({ needs, jobIds: Object.keys(needs), ...on, codeRun });

  it('passes when the code jobs skipped, title and body passed and the reused run passed', () => {
    const verdict = decide(okRun);
    expect(verdict.ok).toBe(true);
    expect(verdict.lines).toContain('ci-ok: reuse success ok');
    expect(verdict.lines).toContain('ci-ok: workflows skipped ok');
    expect(verdict.lines).toContain('ci-ok: code run 7 test (24) success ok');
    expect(verdict.lines.at(-1)).toBe('ci-ok: PASS');
  });

  it.each([
    ['pr-title', 'failure'],
    ['pr-title', 'skipped'],
    ['guardrails', 'failure'],
    ['guardrails', 'skipped'],
    ['reuse', 'skipped'],
    ['reuse', 'failure'],
  ])('fails when this run has %s %s', (id, result) => {
    expect(decide(okRun, editNeeds('7', 'skipped', { [id]: result })).ok).toBe(false);
  });

  it('fails when the reused run failed', () => {
    expect(decide({ ...okRun, ok: false }).ok).toBe(false);
  });

  it('fails when reuse named another run', () => {
    expect(decide(okRun, editNeeds('8')).ok).toBe(false);
  });

  it('fails on skipped code jobs with no reused run', () => {
    const verdict = decide(null, editNeeds(''));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: test skipped FAIL');
  });

  it('passes the fallback, where reuse found nothing and the code jobs ran', () => {
    const verdict = decide(null, editNeeds('', 'success'));
    expect(verdict.ok).toBe(true);
    expect(verdict.lines.join('\n')).not.toContain('code run');
  });

  it.each([
    ['a non-edit PR action', 'pull_request', 'synchronize'],
    ['no action', 'pull_request', undefined],
    ['a push', 'push', 'edited'],
  ])('keeps the skipped test a failure and accepts a skipped reuse on %s', (_n, event, action) => {
    const needs = editNeeds('7', 'skipped', { reuse: 'skipped' });
    const verdict = decide(okRun, needs, action === undefined ? { event } : { event, action });
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: test skipped FAIL');
    expect(verdict.lines).toContain('ci-ok: reuse skipped ok');
  });
});

describe('judgeCodeRun', () => {
  it('passes a code run whose own guardrails and ci-ok failed', () => {
    const verdict = judgeCodeRun(7, codeJobs({ guardrails: 'failure', 'ci-ok': 'failure' }), MERGE);
    expect(verdict.ok).toBe(true);
    expect(verdict.lines).toContain(`ci-ok: code run 7 tested ${MERGE} ok`);
    expect(verdict.lines).toContain('ci-ok: code run 7 test (24) success ok');
    expect(verdict.lines).toContain('ci-ok: code run 7 workflows skipped ok');
    expect(verdict.lines.join('\n')).not.toMatch(/guardrails|pr-title|ci-ok success|release/);
  });

  it('accepts bare skipped workflows and package-smoke', () => {
    const jobs = codeJobs({ 'package-smoke (24)': null, 'package-smoke (26)': null });
    expect(judgeCodeRun(7, [...jobs, job('package-smoke', 'skipped')], MERGE).ok).toBe(true);
  });

  it.each(
    ['changes', 'secrets', 'quality', 'test (24)', 'stand (26)'].flatMap((name) =>
      ['failure', 'cancelled', ''].map((conclusion) => [name, conclusion]),
    ),
  )('fails when %s is "%s"', (name, conclusion) => {
    expect(judgeCodeRun(7, codeJobs({ [name]: conclusion }), MERGE).ok).toBe(false);
  });

  it.each(['test', 'stand'])('fails on a bare skipped %s', (id) => {
    const jobs = codeJobs({ [`${id} (24)`]: null, [`${id} (26)`]: null });
    expect(judgeCodeRun(7, [...jobs, job(id, 'skipped')], MERGE).ok).toBe(false);
  });

  it('fails when a code job is missing', () => {
    const verdict = judgeCodeRun(7, codeJobs({ quality: null }), MERGE);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain('ci-ok: code run 7 quality missing FAIL');
  });

  it('fails on a failed package-smoke leg', () => {
    expect(judgeCodeRun(7, codeJobs({ 'package-smoke (24)': 'failure' }), MERGE).ok).toBe(false);
  });

  it.each([
    ['no revision step', null],
    ['another merge commit', OLD_MERGE],
    ['a prefix of the merge commit', MERGE.slice(0, 7)],
  ])('fails on a run that recorded %s', (_name, revision) => {
    const verdict = judgeCodeRun(7, codeJobs({}, revision), MERGE);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain(`ci-ok: code run 7 did not test ${MERGE} FAIL`);
  });
});

describe('pickReusableRun', () => {
  const current = { runId: 9, pr: 435, revision: MERGE };
  const ofPr = (...ids: number[]): PrRun[] => ids.map((id) => ({ id, pullRequests: [435] }));
  const lookups = (jobs: Record<number, RunJob[]>) => {
    const asked: number[] = [];
    const jobsOf = (id: number) => {
      asked.push(id);
      return jobs[id] ?? [];
    };
    return { asked, jobsOf };
  };

  it('tells a code run from an edit run', () => {
    expect(isCodeRun(codeJobs())).toBe(true);
    expect(isCodeRun(codeJobs({ 'test (24)': 'cancelled' }))).toBe(true);
    expect(isCodeRun(editJobs())).toBe(false);
  });

  it('reuses the newest matching code run, skipping the current, empty and edit runs', () => {
    const { asked, jobsOf } = lookups({
      1: codeJobs(),
      2: codeJobs(),
      4: editJobs(),
      9: codeJobs(),
    });
    const picked = pickReusableRun(ofPr(1, 4, 3, 2, 9), current, jobsOf);
    expect(picked.id).toBe(2);
    expect(asked).toEqual([4, 3, 2]);
    expect(picked.lines).toEqual([`reuse: reusing code run 2, which tested ${MERGE}`]);
  });

  it("never looks up another pull request's run, even one that recorded the revision", () => {
    const { asked, jobsOf } = lookups({ 5: codeJobs(), 2: codeJobs() });
    const runs = [
      { id: 5, pullRequests: [999] },
      { id: 2, pullRequests: [999, 435] },
    ];
    const picked = pickReusableRun(runs, current, jobsOf);
    expect(picked.id).toBe(2);
    expect(asked).toEqual([2]);
    expect(picked.lines).toContain('reuse: run 5 belongs to another pull request');
  });

  it('runs the code jobs when the base moved', () => {
    const { jobsOf } = lookups({ 2: codeJobs({}, OLD_MERGE) });
    const picked = pickReusableRun(ofPr(2), current, jobsOf);
    expect(picked.id).toBeNull();
    expect(picked.lines).toEqual([
      'reuse: run 2 tested another revision',
      `reuse: no code run of this pull request tested ${MERGE}; running the code jobs`,
    ]);
  });

  it('runs the code jobs on a fork pull request, which lists no pull requests', () => {
    const { asked, jobsOf } = lookups({ 2: codeJobs() });
    expect(pickReusableRun([{ id: 2, pullRequests: [] }], current, jobsOf).id).toBeNull();
    expect(asked).toEqual([]);
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

const RUNS = (page: number) =>
  `api repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${SHA}&per_page=100&page=${String(page)}`;
const JOBS = (id: number) => `api repos/o/r/actions/runs/${String(id)}/jobs?per_page=100`;
const apiJobs = (jobs: RunJob[]): Reply => ({
  stdout: JSON.stringify({
    jobs: jobs.map((j) => ({
      name: j.name,
      conclusion: j.conclusion === '' ? null : j.conclusion,
      started_at: j.startedAt,
      completed_at: j.completedAt,
      steps: j.steps,
    })),
  }),
});
const apiRuns = (...runs: { id: number; prs: number[] }[]): Reply => ({
  stdout: JSON.stringify({
    workflow_runs: runs.map(({ id, prs }) => ({
      id,
      pull_requests: prs.map((number) => ({ number })),
    })),
  }),
});

// Runs ci.ts with a fake `gh` first on PATH that answers from `replies`, keyed by its argv joined
// with spaces, logs every call, and fails any call it has no reply for. By default the run is
// edit run 9 of PR 435 on merge commit MERGE, and `reuse` named run 8.
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
    JSON.stringify({ action: 'edited', pull_request: { number: 435, head: { sha: SHA } } }),
  );
  writeFileSync(join(dir, 'summary'), '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env['PATH'] ?? ''}`,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: join(dir, 'event.json'),
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '9',
    GITHUB_SHA: MERGE,
    GITHUB_OUTPUT: join(dir, 'output'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    NEEDS: JSON.stringify(editNeeds('8')),
    ...extra,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) Reflect.deleteProperty(env, key);
  }
  const script = fileURLToPath(new URL('ci.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, command], { env, encoding: 'utf8' });
  const read = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
  const calls = read('calls').trim() === '' ? [] : read('calls').trim().split('\n');
  const lines = result.stdout.trimEnd().split('\n');
  return { status: result.status, lines, calls, summary: read('summary'), output: read('output') };
}

describe('ci.ts reuse', () => {
  const pr = (...ids: number[]) => ids.map((id) => ({ id, prs: [435] }));

  it('names the code run that tested this merge commit', () => {
    const result = cli(
      { [RUNS(1)]: apiRuns(...pr(9, 8)), [JOBS(8)]: apiJobs(codeJobs()) },
      'reuse',
    );
    expect(result.status).toBe(0);
    expect(result.output).toBe('code-run=8\n');
    expect(result.calls).toEqual([RUNS(1), JOBS(8)]);
  });

  it('runs the code jobs when the base moved', () => {
    const jobs = apiJobs(codeJobs({}, OLD_MERGE));
    const result = cli({ [RUNS(1)]: apiRuns(...pr(8)), [JOBS(8)]: jobs }, 'reuse');
    expect(result.status).toBe(0);
    expect(result.output).toBe('code-run=\n');
    expect(result.lines).toContain('reuse: run 8 tested another revision');
  });

  it("reads the second page and never looks up another pull request's runs", () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, prs: [999] }));
    const replies = {
      [RUNS(1)]: apiRuns(...others),
      [RUNS(2)]: apiRuns(...pr(8)),
      [JOBS(8)]: apiJobs(codeJobs()),
    };
    const result = cli(replies, 'reuse');
    expect(result.output).toBe('code-run=8\n');
    expect(result.calls).toEqual([RUNS(1), RUNS(2), JOBS(8)]);
  });

  it('runs the code jobs when gh fails', () => {
    const result = cli({ [RUNS(1)]: { exit: 1 } }, 'reuse');
    expect(result.status).toBe(0);
    expect(result.output).toBe('code-run=\n');
    expect(result.lines.some((line) => line.endsWith('running the code jobs'))).toBe(true);
  });

  it('runs the code jobs without calling gh when GITHUB_SHA is missing', () => {
    const result = cli({}, 'reuse', { GITHUB_SHA: undefined });
    expect(result.status).toBe(0);
    expect(result.output).toBe('code-run=\n');
    expect(result.calls).toEqual([]);
  });
});

describe('ci.ts ok on an edit', () => {
  it('judges the reused run by id, passing one whose stale guardrails and ci-ok failed', () => {
    const stale = codeJobs({ guardrails: 'failure', 'ci-ok': 'failure' });
    const result = cli({ [JOBS(8)]: apiJobs(stale) }, 'ok');
    expect(result.status).toBe(0);
    expect(result.lines).toContain(`ci-ok: code run 8 tested ${MERGE} ok`);
    expect(result.lines).toContain('ci-ok: code run 8 test (24) success ok');
    expect(result.calls).toEqual([JOBS(8)]);
  });

  it('fails when the reused run has a failed stand leg', () => {
    const result = cli({ [JOBS(8)]: apiJobs(codeJobs({ 'stand (24)': 'failure' })) }, 'ok');
    expect(result.status).toBe(1);
    expect(result.lines).toContain('ci-ok: code run 8 stand (24) failure FAIL');
  });

  it('fails when gh fails', () => {
    expect(cli({ [JOBS(8)]: { exit: 1 } }, 'ok').status).toBe(1);
  });

  it.each([
    ['passes', 'reuse found nothing and the code jobs ran', '', 'success', 0],
    ['fails', 'reuse found nothing and the code jobs skipped', '', 'skipped', 1],
    ['fails', 'the reuse output is not a run id', '8 ', 'skipped', 1],
  ])('%s with no gh call when %s', (_v, _n, codeRun, code, status) => {
    const result = cli({}, 'ok', { NEEDS: JSON.stringify(editNeeds(codeRun, code)) });
    expect(result.status).toBe(status);
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
