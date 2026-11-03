import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_WORKFLOW,
  parseFailedLog,
  reproFor,
  summarize,
  type Job,
  type RunListItem,
  type RunView,
  type SummaryInput,
} from './ci-status.ts';

const SCRIPT = fileURLToPath(new URL('./ci-status.ts', import.meta.url));
const CI_YML = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const BOM = '\uFEFF';

// Trimmed job: setup steps are dropped, only the step that matters is kept.
function job(name: string, id: number, conclusion: string, failedStep?: [number, string]): Job {
  const steps = [{ name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' }];
  if (failedStep !== undefined) {
    steps.push({
      name: failedStep[1],
      number: failedStep[0],
      status: 'completed',
      conclusion: 'failure',
    });
  }
  return {
    name,
    databaseId: id,
    status: conclusion === '' ? 'in_progress' : 'completed',
    conclusion,
    steps,
  };
}

function listed(
  id: number,
  createdAt: string,
  conclusion: string,
  workflowName = 'ci',
): RunListItem {
  return {
    databaseId: id,
    workflowName,
    status: conclusion === '' ? 'in_progress' : 'completed',
    conclusion,
    createdAt,
  };
}

const SHA = '8fb28f44965dade4a6243cd339056d40d8a64683';

// Run 41625342454 (PR #91): guardrails failed at step 5, ci-ok failed after it.
const RUN_91: RunView = {
  status: 'completed',
  conclusion: 'failure',
  jobs: [
    job('pr-title', 125881155386, 'success'),
    job('changes', 125881155770, 'success'),
    job('guardrails', 125881155795, 'failure', [5, 'Run pnpm guardrails']),
    job('secrets', 125881155824, 'success'),
    job('quality', 125881155921, 'success'),
    job('test (26)', 125881156077, 'success'),
    job('test (24)', 125881156339, 'success'),
    { ...job('workflows', 125881335415, 'skipped'), steps: [] },
    job('ci-ok', 125881436627, 'failure', [5, 'Run pnpm ci:ok']),
  ],
};

// Excerpt of `gh run view 41625342454 --log-failed`: U+FEFF opens field 3 on the first line of
// each job+step block; the NEEDS lines continue a multi-line value and carry no timestamp.
const LOG_91 = [
  `guardrails\tRun pnpm guardrails\t${BOM}2026-11-03T11:10:48.5979117Z ##[group]Run pnpm guardrails`,
  'guardrails\tRun pnpm guardrails\t2026-11-03T11:10:48.6246316Z $ node scripts/guardrails.ts',
  'guardrails\tRun pnpm guardrails\t2026-11-03T11:10:48.8108864Z guardrails: 6 file(s) need a ## Changed checks entry',
  'guardrails\tRun pnpm guardrails\t2026-11-03T11:10:48.8154240Z guardrails: FAIL',
  'guardrails\tRun pnpm guardrails\t2026-11-03T11:10:48.8193142Z ##[error]Process completed with exit code 1.',
  `ci-ok\tRun pnpm ci:ok\t${BOM}2026-11-03T11:11:23.0071587Z ##[group]Run pnpm ci:ok`,
  'ci-ok\tRun pnpm ci:ok\t2026-11-03T11:11:23.0099273Z   NEEDS: {',
  'ci-ok\tRun pnpm ci:ok\t  "changes": {',
  'ci-ok\tRun pnpm ci:ok\t2026-11-03T11:11:23.1113646Z ci-ok: FAIL',
  '',
].join('\n');

// Run 41610346568 (PR #86): cancelled by an edit; every job but pr-title cancelled, ci-ok failed.
const RUN_86_CANCELLED: RunView = {
  status: 'completed',
  conclusion: 'cancelled',
  jobs: [
    job('secrets', 125830373069, 'cancelled'),
    job('pr-title', 125830373087, 'success'),
    job('test (24)', 125830373091, 'cancelled'),
    job('quality', 125830373131, 'cancelled'),
    job('test (26)', 125830373258, 'cancelled'),
    job('changes', 125830373321, 'cancelled'),
    { ...job('workflows', 125830522037, 'cancelled'), steps: [] },
    job('ci-ok', 125830700336, 'failure', [5, 'Run pnpm ci:ok']),
  ],
};

// Run 41610374714 (PR #86): the run that superseded 41610346568 on the same head.
const RUN_86_NEWER: RunView = {
  status: 'completed',
  conclusion: 'success',
  jobs: [
    job('secrets', 125830895180, 'success'),
    job('pr-title', 125830895522, 'success'),
    job('changes', 125830895585, 'success'),
    { ...job('workflows', 125831074624, 'skipped'), steps: [] },
    job('ci-ok', 125831127240, 'success'),
  ],
};

// Run shape seen while a run is in progress: guardrails already failed, the rest unfinished.
const IN_PROGRESS: RunView = {
  status: 'in_progress',
  conclusion: '',
  jobs: [
    job('guardrails', 125881155795, 'failure', [5, 'Run pnpm guardrails']),
    job('test (24)', 125881156339, ''),
    { ...job('quality', 125881155921, ''), status: 'queued', steps: [] },
  ],
};

const LOG_IN_PROGRESS = LOG_91.split('\n')
  .filter((line) => line.startsWith('guardrails'))
  .join('\n');

function input(runs: [RunListItem, RunView][], logs: Record<string, string> = {}): SummaryInput {
  return {
    sha: SHA,
    runs: runs.map(([run]) => run),
    views: Object.fromEntries(runs.map(([run, view]) => [String(run.databaseId), view])),
    logs,
  };
}

const CODEQL: [RunListItem, RunView] = [
  listed(41610344176, '2026-11-03T09:21:22Z', 'success', 'CodeQL'),
  { status: 'completed', conclusion: 'success', jobs: [job('Analyze (actions)', 1, 'success')] },
];

describe('summarize', () => {
  it('AC3a: reports the failed guardrails step with its log tail and repro, ci-ok as following', () => {
    const { lines, code } = summarize(
      input([[listed(41625342454, '2026-11-03T11:10:33Z', 'failure'), RUN_91]], {
        '41625342454': LOG_91,
      }),
    );
    expect(code).toBe(1);
    expect(lines).toContain('  guardrails failure');
    expect(lines).toContain('    step 5 Run pnpm guardrails');
    expect(lines).toContain('      guardrails: FAIL');
    expect(lines).toContain('    repro: pnpm guardrails');
    expect(lines).toContain('  ci-ok failure (follows the jobs above)');
    expect(lines).not.toContain('    repro: pnpm ci:ok');
    expect(lines.every((line) => !line.includes(BOM))).toBe(true);
  });

  it('AC3b: a cancelled latest run is cancelled, not failed, and its ci-ok failure is not counted', () => {
    const { lines, code } = summarize(
      input([[listed(41610346568, '2026-11-03T09:21:23Z', 'cancelled'), RUN_86_CANCELLED], CODEQL]),
    );
    expect(code).toBe(4);
    expect(lines).toContain('run 41610346568 ci cancelled');
    expect(lines).toContain('  ci-ok failure (follows the jobs above)');
    for (const line of lines.filter((l) => !l.startsWith('  ci-ok'))) {
      expect(line).not.toMatch(/fail/i);
    }
  });

  it('AC3c: a cancelled run with a newer run on the same head is superseded', () => {
    const { lines, code } = summarize(
      input([
        [listed(41610374714, '2026-11-03T09:21:36Z', 'success'), RUN_86_NEWER],
        [listed(41610346568, '2026-11-03T09:21:23Z', 'cancelled'), RUN_86_CANCELLED],
        CODEQL,
      ]),
    );
    expect(code).toBe(0);
    expect(lines).toContain('run 41610346568 ci cancelled - superseded by run 41610374714');
    expect(lines.join('\n')).not.toContain('follows the jobs above');
  });

  it('breaks a createdAt tie by the higher run id (PR #92: 41631809449 vs 41631809529)', () => {
    const { lines, code } = summarize(
      input([
        [listed(41631809449, '2026-11-03T11:58:23Z', 'cancelled'), RUN_86_CANCELLED],
        [listed(41631809529, '2026-11-03T11:58:23Z', 'success'), RUN_86_NEWER],
      ]),
    );
    expect(code).toBe(0);
    expect(lines).toContain('run 41631809449 ci cancelled - superseded by run 41631809529');
  });

  it('AC3c: a queued run with no jobs is pending', () => {
    const { code } = summarize(
      input([
        [listed(1, '2026-11-03T12:00:00Z', ''), { status: 'queued', conclusion: '', jobs: [] }],
      ]),
    );
    expect(code).toBe(3);
  });

  it('AC3c: a completed startup_failure run with no jobs is failed', () => {
    const { lines, code } = summarize(
      input([
        [
          listed(2, '2026-11-03T12:00:00Z', 'startup_failure'),
          { status: 'completed', conclusion: 'startup_failure', jobs: [] },
        ],
      ]),
    );
    expect(code).toBe(1);
    expect(lines).toContain('run 2 ci concluded startup_failure with no failed job');
  });

  it('a completed failure run whose only real problem is a cancelled job is cancelled', () => {
    const view: RunView = {
      status: 'completed',
      conclusion: 'failure',
      jobs: [
        job('pr-title', 1, 'success'),
        job('quality', 2, 'cancelled'),
        job('test (24)', 3, 'success'),
        job('ci-ok', 4, 'failure', [5, 'Run pnpm ci:ok']),
      ],
    };
    const { lines, code } = summarize(
      input([[listed(3, '2026-11-03T12:00:00Z', 'failure'), view]]),
    );
    expect(code).toBe(4);
    expect(lines).toContain('  ci-ok failure (follows the jobs above)');
  });

  it('counts ci-ok when it is the only failed job', () => {
    const view: RunView = {
      status: 'completed',
      conclusion: 'failure',
      jobs: [job('pr-title', 1, 'success'), job('ci-ok', 4, 'failure', [5, 'Run pnpm ci:ok'])],
    };
    const { lines, code } = summarize(
      input([[listed(4, '2026-11-03T12:00:00Z', 'failure'), view]]),
    );
    expect(code).toBe(1);
    expect(lines).toContain('    step 5 Run pnpm ci:ok');
    expect(lines).toContain('      log not available');
    expect(lines).toContain('    repro: pnpm ci:ok');
  });

  it('AC3d: a head with only a successful CodeQL run is pending', () => {
    const { lines, code } = summarize(input([CODEQL]));
    expect(code).toBe(3);
    expect(lines).toContain('ci-status: no ci run on 8fb28f4 yet');
  });

  it('AC3e: an in-progress run with a failed job is failed and lists the unfinished jobs', () => {
    const { lines, code } = summarize(
      input([[listed(5, '2026-11-03T12:00:00Z', ''), IN_PROGRESS]], { '5': LOG_IN_PROGRESS }),
    );
    expect(code).toBe(1);
    expect(lines).toContain('      guardrails: FAIL');
    expect(lines).toContain('    repro: pnpm guardrails');
    expect(lines).toContain('  test (24) pending');
    expect(lines).toContain('  quality pending');
  });

  it('AC3e: without a log the in-progress failure still fails and says log not available', () => {
    const { lines, code } = summarize(
      input([[listed(5, '2026-11-03T12:00:00Z', ''), IN_PROGRESS]]),
    );
    expect(code).toBe(1);
    expect(lines).toContain('      log not available');
  });

  it('keeps only the last 20 log lines of a step', () => {
    const log = Array.from(
      { length: 30 },
      (_, i) => `guardrails\tRun pnpm guardrails\t2026-11-03T11:10:48.0000000Z line ${String(i)}`,
    ).join('\n');
    const { lines } = summarize(
      input([[listed(41625342454, '2026-11-03T11:10:33Z', 'failure'), RUN_91]], {
        '41625342454': log,
      }),
    );
    expect(lines).not.toContain('      line 9');
    expect(lines).toContain('      line 10');
    expect(lines).toContain('      line 29');
  });
});

describe('parseFailedLog', () => {
  it('keys lines by job and step and strips U+FEFF and the timestamp', () => {
    const jobs = parseFailedLog(LOG_91);
    expect([...jobs.keys()]).toEqual(['guardrails', 'ci-ok']);
    expect(jobs.get('guardrails')?.get('Run pnpm guardrails')?.[0]).toBe(
      '##[group]Run pnpm guardrails',
    );
    expect(jobs.get('ci-ok')?.get('Run pnpm ci:ok')).toEqual([
      '##[group]Run pnpm ci:ok',
      '  NEEDS: {',
      '  "changes": {',
      'ci-ok: FAIL',
    ]);
  });
});

describe('reproFor', () => {
  it.each([
    ['test (24)', 'Run pnpm check:full --only test', 'pnpm check:full --only test'],
    ['guardrails', 'Run pnpm guardrails', 'pnpm guardrails'],
    [
      'secrets',
      'Run ghcr.io/gitleaks/gitleaks:v8.30.1',
      'GITLEAKS_LOG_OPTS=origin/main..HEAD sh scripts/gitleaks.sh',
    ],
    ['pr-title', "Run re='^(feat)'", 'no local command - edit the PR title'],
    ['workflows', 'Run docker://rhysd/actionlint', 'no local command - read the log above'],
  ])('%s / %s -> %s', (jobName, step, repro) => {
    expect(reproFor(jobName, step)).toBe(repro);
  });
});

describe('REQUIRED_WORKFLOW', () => {
  it('equals the name on line 1 of ci.yml', () => {
    const first = readFileSync(CI_YML, 'utf8').split('\n')[0];
    expect(first).toBe(`name: ${REQUIRED_WORKFLOW}`);
  });
});

interface Reply {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

// Runs ci-status.ts with a fake `gh` first on PATH. The fake answers from `replies`, keyed by
// its argv joined with spaces, logs every call, and fails any call it has no reply for.
function cli(replies: Record<string, Reply>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-status-'));
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
      'process.stderr.write(reply.stderr ?? "");',
      'process.exit(reply.exit ?? 0);',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
    encoding: 'utf8',
  });
  const callsFile = join(dir, 'calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  const lines = result.stdout.trimEnd().split('\n');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines, calls };
}

const PR_VIEW = 'pr view 91 --json number,headRefOid';
const RUN_LIST = `run list --commit ${SHA} --limit 50 --json databaseId,workflowName,status,conclusion,event,createdAt,attempt`;
const json = (value: unknown): Reply => ({ stdout: JSON.stringify(value) });

function head(runs: [RunListItem, RunView][]): Record<string, Reply> {
  const replies: Record<string, Reply> = {
    [PR_VIEW]: json({ number: 91, headRefOid: SHA }),
    [RUN_LIST]: json(runs.map(([run]) => run)),
  };
  for (const [run, view] of runs) {
    replies[`run view ${String(run.databaseId)} --json status,conclusion,jobs`] = json(view);
  }
  return replies;
}

describe('ci-status.ts CLI', () => {
  it('AC3a: a failed run exits 1 and prints the repro command', () => {
    const replies = head([
      [listed(41625342454, '2026-11-03T11:10:33Z', 'failure'), RUN_91],
      CODEQL,
    ]);
    replies['run view 41625342454 --log-failed'] = { stdout: LOG_91 };
    const result = cli(replies, '91');
    expect(result.status).toBe(1);
    expect(result.lines).toContain('    repro: pnpm guardrails');
    expect(result.lines).toContain('      guardrails: FAIL');
    expect(result.lines.at(-1)).toBe('CI-STATUS FAIL (exit 1)');
    expect(result.stdout).not.toContain(BOM);
  });

  it('AC3c: a superseded cancelled run passes without fetching any log', () => {
    const result = cli(
      head([
        [listed(41610374714, '2026-11-03T09:21:36Z', 'success'), RUN_86_NEWER],
        [listed(41610346568, '2026-11-03T09:21:23Z', 'cancelled'), RUN_86_CANCELLED],
      ]),
      '91',
    );
    expect(result.status).toBe(0);
    expect(result.lines).toContain('run 41610346568 ci cancelled - superseded by run 41610374714');
    expect(result.lines.at(-1)).toBe('CI-STATUS PASS (exit 0)');
    expect(result.calls.some((call) => call.includes('--log-failed'))).toBe(false);
  });

  it('AC3b: a cancelled latest run exits 4', () => {
    const result = cli(
      head([[listed(41610346568, '2026-11-03T09:21:23Z', 'cancelled'), RUN_86_CANCELLED]]),
      '91',
    );
    expect(result.status).toBe(4);
    expect(result.lines.at(-1)).toBe('CI-STATUS CANCELLED (exit 4)');
  });

  it('AC3c: a queued run exits 3', () => {
    const result = cli(
      head([
        [listed(1, '2026-11-03T12:00:00Z', ''), { status: 'queued', conclusion: '', jobs: [] }],
      ]),
      '91',
    );
    expect(result.status).toBe(3);
    expect(result.lines.at(-1)).toBe('CI-STATUS PENDING (exit 3)');
  });

  it('AC3d: a head with only CodeQL exits 3', () => {
    const result = cli(head([CODEQL]), '91');
    expect(result.status).toBe(3);
    expect(result.lines).toContain('ci-status: no ci run on 8fb28f4 yet');
    expect(result.lines.at(-1)).toBe('CI-STATUS PENDING (exit 3)');
  });

  it('AC3c: more than one argument is a usage error', () => {
    const result = cli({}, '1', '2');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: pnpm ci:status');
    expect(result.lines.at(-1)).toBe('CI-STATUS ERROR (exit 2)');
    expect(result.calls).toEqual([]);
  });

  it('AC3c: gh pr view failing exits 2 and passes on its message', () => {
    const result = cli(
      { [PR_VIEW]: { stderr: 'no pull requests found for branch "x"\n', exit: 1 } },
      '91',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no pull requests found');
    expect(result.lines.at(-1)).toBe('CI-STATUS ERROR (exit 2)');
  });

  it('reads the current branch PR when no argument is given', () => {
    const replies = head([CODEQL]);
    replies['pr view --json number,headRefOid'] = json({ number: 91, headRefOid: SHA });
    const result = cli(replies);
    expect(result.calls[0]).toBe('pr view --json number,headRefOid');
    expect(result.status).toBe(3);
  });

  it('AC3e: an in-progress run reads the failed job log by job, never run-wide', () => {
    const replies = head([[listed(5, '2026-11-03T12:00:00Z', ''), IN_PROGRESS]]);
    replies['run view 5 --log-failed'] = {
      stderr: 'run 5 is still in progress; logs will be available when it is complete\n',
      exit: 1,
    };
    replies['run view 5 --job 125881155795 --log-failed'] = { stdout: LOG_IN_PROGRESS };
    const result = cli(replies, '91');
    expect(result.status).toBe(1);
    expect(result.lines).toContain('      guardrails: FAIL');
    expect(result.lines).toContain('  test (24) pending');
    expect(result.calls).toContain('run view 5 --job 125881155795 --log-failed');
    expect(result.calls).not.toContain('run view 5 --log-failed');
  });

  it('AC3e: a failing per-job log fetch prints log not available and keeps exit 1', () => {
    const replies = head([[listed(5, '2026-11-03T12:00:00Z', ''), IN_PROGRESS]]);
    replies['run view 5 --job 125881155795 --log-failed'] = { stderr: 'boom\n', exit: 1 };
    const result = cli(replies, '91');
    expect(result.status).toBe(1);
    expect(result.lines).toContain('      log not available');
    expect(result.lines.at(-1)).toBe('CI-STATUS FAIL (exit 1)');
  });
});
