// Checks examples/minimal against the real config schema and `board doctor --offline`. A change
// only under examples/ runs no Vitest in a local `pnpm check`; CI runs every test, this one too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { configSchema } from '@spur-board/contracts';
import { runCli, type CliIo } from '../src/cli.ts';
import type { DoctorCheck } from '../src/doctor.ts';

const exampleUrl = new URL('../../../examples/minimal/', import.meta.url);
const exampleHome = fileURLToPath(exampleUrl);
const read = (relative: string, base = exampleUrl) => readFileSync(new URL(relative, base), 'utf8');
const configText = read('config.yaml');
const spurText = read('projects.spur.yaml');
const readme = read('README.md');
const repoRoot = new URL('../../../', import.meta.url);

// Per-project keys of Spur 1.62.3 spur.yaml.reference. The example may use only these.
const SPUR_PROJECT_KEYS = new Set([
  'name',
  'path',
  'defaultBranch',
  'sessionPrefix',
  'worktree',
  'restoreAfterReboot',
  'maxLiveSessions',
  'symlinks',
  'branchNaming',
  'defaultAgent',
  'defaultModels',
  'reasoningEffort',
  'codexArgs',
  'workspaceAccess',
  'preflight',
  'spawn',
  'sidecars',
  'modes',
  'sources',
  'triggers',
]);

// One `spur spawn` command: flags around the project id, then a quoted prompt that is not blank.
// `--plan` drops the project's steps and `--step` replaces them, so neither may appear.
const FLAG = String.raw`--(?!plan\b|step\b)[a-z][a-z-]*(?:[ =](?!--)[^\s"]+)?`;
const SPAWN_LINE = new RegExp(
  String.raw`^spur spawn(?: ${FLAG})* (?<id>[A-Za-z0-9_-]+)(?: ${FLAG})* "[^"]*\S[^"]*"$`,
);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, out, err };
}

async function doctor(readText?: (path: string) => string) {
  const output = capture();
  const exitCode = await runCli(['doctor', '--offline', '--json'], {
    io: output.io,
    home: '/nonexistent-home',
    env: { BOARD_HOME: exampleHome },
    ...(readText === undefined ? {} : { doctor: { readText } }),
  });
  const checks = JSON.parse(output.out.join('')) as DoctorCheck[];
  return { exitCode, checks };
}

const spur = YAML.parse(spurText) as {
  projects: Record<string, { path?: string; spawn?: { steps?: string[] } }>;
};

/** Parsed per test, so a broken example fails its doctor case instead of the whole file. */
function example() {
  const parsed = configSchema.safeParse(YAML.parse(configText));
  const project = parsed.data?.projects[0];
  if (parsed.data === undefined || project === undefined)
    throw new Error(`examples/minimal/config.yaml does not parse: ${String(parsed.error)}`);
  const byRole = (role: string) =>
    project.spurProjects.filter((entry) => entry.role === role).map(({ name }) => name);
  const names = project.spurProjects.map(({ name }) => name);
  return { config: parsed.data, project, names, byRole };
}
const steps = (name: string) => (spur.projects[name]?.spawn?.steps ?? []).join('\n');
const comments = (text: string) => text.split('\n').filter((line) => line.trim().startsWith('#'));

describe('examples/minimal config through board doctor --offline', () => {
  it('passes every offline check', async () => {
    const { exitCode, checks } = await doctor();
    expect(exitCode).toBe(0);
    expect(checks[0]).toMatchObject({ id: 'config', status: 'pass' });
    expect(checks.filter(({ status }) => status !== 'pass')).toEqual([]);
  });

  it.each([
    [
      'an unknown Review orchestrator',
      configText.replace('orchestrator: example-reviewer', 'orchestrator: example-missing'),
      'orchestrator',
    ],
    [
      'a renamed operatorGithubLogin',
      configText.replace('operatorGithubLogin:', 'operatorLogin:'),
      undefined,
    ],
  ])('fails on a copy with %s', async (_case, broken, fixMentions) => {
    expect(broken).not.toBe(configText);
    const { exitCode, checks } = await doctor((path) => {
      if (path.endsWith('config.yaml')) return broken;
      throw new Error(`offline doctor read ${path}`);
    });
    expect(exitCode).toBe(1);
    expect(checks[0]).toMatchObject({ id: 'config', status: 'fail', blocking: true });
    if (fixMentions !== undefined) expect(checks[0]?.fix).toContain(fixMentions);
  });
});

describe('examples/minimal shape', () => {
  it('is one Slack-free github-issues project with Todo, Dev, Review and Done', () => {
    const { config, project, byRole } = example();
    const raw = YAML.parse(configText) as Record<string, unknown>;
    expect(Object.keys(raw)).not.toContain('slack');
    expect(Object.keys(raw)).not.toContain('operator');
    expect(Object.keys(raw)).not.toContain('web');
    expect(config.projects).toHaveLength(1);
    expect(project.tracker.type).toBe('github-issues');
    if (project.tracker.type !== 'github-issues') return;
    expect(project.repos).toContain(project.tracker.repo);
    expect(project.dispatcher.mode).toBe('on');
    expect(project.columns.map(({ id, enabled }) => [id, enabled])).toEqual([
      ['todo', true],
      ['dev', true],
      ['review', true],
      ['done', true],
    ]);
    expect(project.columns.find(({ id }) => id === 'dev')?.orchestrator).toBe('none');
    expect(byRole('orchestrator')).toHaveLength(1);
    expect(project.columns.find(({ id }) => id === 'review')?.orchestrator).toBe(
      byRole('orchestrator')[0],
    );
    expect(byRole('worker')).toHaveLength(1);
    expect(byRole('operator')).toHaveLength(1);
  });

  it('defines the same Spur projects with only public Spur keys', () => {
    const { names } = example();
    expect(Object.keys(spur)).toEqual(['projects']);
    expect(Object.keys(spur.projects).sort()).toEqual([...names].sort());
    for (const [name, entry] of Object.entries(spur.projects)) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(Object.keys(entry).filter((key) => !SPUR_PROJECT_KEYS.has(key))).toEqual([]);
      expect(entry.path).toBe('.');
    }
  });
});

describe('examples/minimal prompts and README', () => {
  it('points every prompt at the spur-board skill and names no repo-private tooling', () => {
    const { project, names, byRole } = example();
    for (const name of names) {
      expect(steps(name)).toContain('spur-board');
      expect(steps(name)).not.toMatch(/manager|gstack|brain|\.notes|role agent/i);
    }
    if (project.tracker.type !== 'github-issues') throw new Error('expected github-issues');
    const [worker = ''] = byRole('worker');
    const [reviewer = ''] = byRole('orchestrator');
    const [operator = ''] = byRole('operator');
    expect(steps(worker)).toContain(
      `board-worker=https://github.com/${project.tracker.repo}/issues/`,
    );
    expect(steps(worker)).toContain('Closes #');
    for (const phrase of ['board submit', 'board return', 'push'])
      expect(steps(reviewer)).toContain(phrase);
    expect(steps(operator)).toContain('board inbox operator');
  });

  it('passes a quoted prompt in every spur spawn of the README', () => {
    const { names } = example();
    const occurrences = [...readme.matchAll(/spur spawn[^`\n]*/g)].map((m) => m[0].trim());
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
    expect(occurrences.filter((line) => !SPAWN_LINE.test(line))).toEqual([]);
    const spawned = new Set(occurrences.map((line) => SPAWN_LINE.exec(line)?.groups?.['id']));
    expect(names.filter((name) => !spawned.has(name))).toEqual([]);
  });

  it('rejects spawn lines that would drop the project steps', () => {
    for (const line of [
      'spur spawn example-worker',
      'spur spawn example-worker --prompt-file prompt.md',
      'spur spawn example-worker \\',
      'spur spawn example-worker Work on the issue',
      'spur spawn example-worker " "',
      'spur spawn --plan example-worker "Plan it"',
      'spur spawn example-worker --step "Only this" "Work"',
    ])
      expect(SPAWN_LINE.test(line), line).toBe(false);
    expect(SPAWN_LINE.test('spur spawn --link pr=1 example-worker "Work"')).toBe(true);
  });

  it('keeps the comments that explain the example values', () => {
    const configComments = comments(configText).join('\n');
    expect(configComments).toContain('owner/repo');
    expect(configComments).toContain('login');
    const spurComments = comments(spurText);
    expect(spurComments.some((line) => line.includes('checkout'))).toBe(true);
    expect(spurComments.some((line) => line.includes('prompt'))).toBe(true);
  });

  it('names the Spur versions, GitHub sign-in and unique ids, and is linked from the guides', () => {
    for (const phrase of ['1.53.0', '1.62.3', 'gh auth login', 'sessionPrefix'])
      expect(readme).toContain(phrase);
    for (const guide of ['README.md', 'SETUP.md'])
      expect(read(guide, repoRoot)).toContain('examples/minimal');
  });
});
