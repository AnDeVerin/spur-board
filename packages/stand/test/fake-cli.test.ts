import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import {
  startControl,
  type Control,
  type ControlRoutes,
  type RouteResult,
} from '../src/control.ts';
import { shellWord } from '../src/guards.ts';
import { procStat, STAND_PREFIX, writeManifest } from '../src/manifest.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// Leave room to report and kill a hung child before the 30 s Vitest deadline.
const CLI_TIMEOUT_MS = 25_000;
const TOKEN = 'stub-control-token';

let control: Control | undefined;
let home: string | undefined;
const clock = vi.fn<ControlRoutes['clock']>(() =>
  Promise.resolve({ status: 200, body: { offsetMs: 0 } }),
);
const fake = vi.fn<ControlRoutes['fake']>(() =>
  Promise.resolve({ status: 200, body: { sessions: [] } }),
);
const slackPost = vi.fn<ControlRoutes['slackPost']>(() =>
  Promise.resolve({ status: 200, body: { ok: true, message: 4, responses: [] } }),
);
const demo = vi.fn<ControlRoutes['demo']>(() =>
  Promise.resolve({
    status: 200,
    body: {
      scenario: 'walkthrough',
      step: 5,
      steps: 15,
      title: 'A question to the operator',
      narration: 'The worker asks the operator.',
      open: 'block%3AB7',
      next: 'The answer',
    },
  }),
);

afterEach(async () => {
  await control?.close();
  control = undefined;
  clock.mockClear();
  fake.mockClear();
  slackPost.mockClear();
  demo.mockClear();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

/**
 * A stand home whose manifest names a real control endpoint answering `/violations` with
 * `answer`, with `webUrl` in the manifest when given.
 */
async function stubStand(answer: RouteResult, webUrl?: string): Promise<string> {
  control = await startControl({
    token: TOKEN,
    routes: {
      wait: vi.fn(),
      poll: vi.fn(),
      reset: vi.fn(),
      seed: vi.fn(),
      clock,
      fake,
      slackOutbox: vi.fn(),
      slackClick: vi.fn(),
      slackPost,
      violations: () => Promise.resolve(answer),
      demo,
    },
  });
  home = mkdtempSync(join(realpathSync(tmpdir()), STAND_PREFIX));
  writeManifest(home, {
    version: 1,
    id: 'stub',
    home,
    pid: process.pid,
    pidStartTime: 0,
    daemonUrl: 'http://127.0.0.1:1',
    controlUrl: control.url,
    controlToken: TOKEN,
    tokenPath: join(home, 'token'),
    roles: { worker: 'w', orchestrator: 'o', curator: 'c' },
    ...(webUrl === undefined ? {} : { webUrl }),
  });
  return home;
}

/** Async, because the stub answers from this process and `spawnSync` would block it. */
function runCli(
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const start = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - start);
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const spawnCallMs = elapsedMs();
  let spawnEventMs: number | undefined;
  let exitEventMs: number | undefined;
  let stdout = '';
  let stderr = '';
  child.once('spawn', () => {
    spawnEventMs = elapsedMs();
  });
  child.once('exit', () => {
    exitEventMs = elapsedMs();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeoutError = (): Error => {
      finish();
      let alive: boolean | 'unknown' = 'unknown';
      try {
        alive = child.pid !== undefined && procStat(child.pid) !== undefined;
      } catch {
        // An unreadable /proc entry should not prevent cleanup or hide the captured output.
      }
      const diagnostics = {
        elapsedMs: elapsedMs(),
        spawnCallMs,
        spawnEventMs: spawnEventMs ?? null,
        exitEventMs: exitEventMs ?? null,
        pid: child.pid ?? null,
        alive,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdout,
        stderr,
      };
      // A child that has exited can still leave a pipe open. Release our ends either way.
      if (exitEventMs === undefined) child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      return new Error(`stand CLI did not close: ${JSON.stringify(diagnostics, null, 2)}`);
    };
    const timer = setTimeout(
      () => {
        reject(timeoutError());
      },
      Math.max(0, CLI_TIMEOUT_MS - spawnCallMs),
    );
    const finish = (): void => {
      finished = true;
      clearTimeout(timer);
    };
    onTestFailed(() => {
      // Vitest can get there first, e.g. if the synchronous spawn call blocks its timer.
      if (!finished) throw timeoutError();
    });
    child.once('error', (error) => {
      finish();
      reject(error);
    });
    child.once('close', (code) => {
      finish();
      resolve({ code, stdout, stderr });
    });
  });
}

describe('stand violations', () => {
  it('exits 0 on an empty log', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['violations', '--home', dir]);
    expect(result.code).toBe(0);
  });

  it('exits 1 and prints the entries on a non-empty log', async () => {
    const dir = await stubStand({
      status: 409,
      body: { total: 1, items: [{ reason: 'unknown-shape-marker' }] },
    });
    const result = await runCli(['violations', '--home', dir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('unknown-shape-marker');
  });
});

describe('stand fake slack post', () => {
  it('posts the text and prints the message number', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['fake', 'slack', 'post', '--text', '@cur hello', '--home', dir]);
    expect(result.code).toBe(0);
    expect(slackPost).toHaveBeenCalledExactlyOnceWith({ text: '@cur hello' });
    expect(JSON.parse(result.stdout)).toMatchObject({ message: 4 });
  });

  it.each([
    ['no text', ['fake', 'slack', 'post']],
    ['an extra argument', ['fake', 'slack', 'post', 'x', '--text', 'hi']],
  ])('exits 2 on %s without calling the stand', async (_name, args) => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli([...args, '--home', dir]);
    expect(result.code).toBe(2);
    expect(result.stderr.split('\n')[0]).toMatch(/fake slack post/);
    expect(slackPost).not.toHaveBeenCalled();
  });
});

describe('stand fake spur', () => {
  it.each([
    ['a trailing --home', (dir: string) => ['fake', 'spur', 'inspect', '--home', dir]],
    ['a leading --home', (dir: string) => ['fake', '--home', dir, 'spur', 'inspect']],
  ])('reads the stand named by %s', async (_name, args) => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(args(dir));
    expect(result.code, result.stderr).toBe(0);
    expect(fake).toHaveBeenCalledExactlyOnceWith({ system: 'spur', verb: 'inspect', args: {} });
    expect(JSON.parse(result.stdout)).toEqual({ sessions: [] });
  });
});

describe('stand fake host', () => {
  it.each([
    ['a trailing --home', (dir: string) => ['fake', 'host', 'disk', '95', '/', '--home', dir]],
    ['a leading --home', (dir: string) => ['fake', '--home', dir, 'host', 'disk', '95', '/']],
  ])('sends the reading to the stand named by %s', async (_name, args) => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(args(dir));
    expect(result.code, result.stderr).toBe(0);
    expect(fake).toHaveBeenCalledExactlyOnceWith({
      system: 'host',
      verb: 'disk',
      args: { percent: 95, mount: '/' },
    });
  });

  it('exits 2 on a bad percent without calling the stand', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['fake', 'host', 'disk', 'abc', '--home', dir]);
    expect(result.code).toBe(2);
    expect(result.stderr.split('\n')[0]).toMatch(/fake host disk needs a percent/);
    expect(fake).not.toHaveBeenCalled();
  });
});

describe('stand fake github issue project-status', () => {
  it('sends one status to the issue fake', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli([
      'fake',
      'github',
      'issue',
      '2',
      'project-status',
      'Ready',
      '--home',
      dir,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(fake).toHaveBeenCalledExactlyOnceWith({
      system: 'github',
      verb: 'issue-project-status',
      args: { repo: 'stand-org/board', number: 2, status: 'Ready' },
    });
  });

  it.each([
    ['no status', []],
    ['two statuses', ['Ready', 'Done']],
    ['a title', ['Ready', '--title', 't']],
  ])('exits 2 on %s without calling the stand', async (_name, extra) => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli([
      'fake',
      'github',
      'issue',
      '2',
      'project-status',
      ...extra,
      '--home',
      dir,
    ]);
    expect(result.code).toBe(2);
    expect(fake).not.toHaveBeenCalled();
  });
});

describe('stand demo', () => {
  const EMPTY = { status: 200, body: { total: 0, items: [] } };

  it('sends the verb and prints the step, its narration, the view to open and the next step', async () => {
    const dir = await stubStand(EMPTY, 'https://4801.stand.example');
    const result = await runCli(['demo', 'next', '--home', dir]);
    expect(result.code, result.stderr).toBe(0);
    expect(demo).toHaveBeenCalledExactlyOnceWith({ verb: 'next' });
    expect(result.stdout).toBe(
      [
        'step 5/15: A question to the operator',
        'The worker asks the operator.',
        'open: https://4801.stand.example/?open=block%3AB7',
        'next: The answer',
        '',
      ].join('\n'),
    );
  });

  it('prints no open line without a web URL', async () => {
    const dir = await stubStand(EMPTY);
    const result = await runCli(['demo', 'status', '--home', dir]);
    expect(result.code, result.stderr).toBe(0);
    expect(demo).toHaveBeenCalledExactlyOnceWith({ verb: 'status' });
    expect(result.stdout).not.toContain('open:');
  });

  it('prints the violations a demo reset cleared', async () => {
    demo.mockResolvedValueOnce({
      status: 200,
      body: {
        scenario: 'walkthrough',
        step: 0,
        steps: 15,
        next: 'Triage',
        daemonUrl: 'http://127.0.0.1:1',
        violationsCleared: 2,
      },
    });
    const dir = await stubStand(EMPTY);
    const result = await runCli(['demo', 'reset', '--home', dir]);
    expect(result.code, result.stderr).toBe(0);
    expect(demo).toHaveBeenCalledExactlyOnceWith({ verb: 'reset' });
    expect(result.stdout).toBe('step 0/15\nnext: Triage\nviolations cleared: 2\n');
  });

  it.each([
    ['an unknown verb', ['jump']],
    ['no verb', []],
    ['two verbs', ['next', 'next']],
  ])('exits 2 on %s without calling the stand', async (_name, verbs) => {
    const dir = await stubStand(EMPTY);
    const result = await runCli(['demo', ...verbs, '--home', dir]);
    expect(result.code).toBe(2);
    expect(result.stderr.split('\n')[0]).toMatch(/demo takes one of next, status, reset/);
    expect(demo).not.toHaveBeenCalled();
  });

  it.each(['next', 'status', 'reset'])(
    'refuses demo %s with external credentials and names the command to rerun',
    async (verb) => {
      const dir = await stubStand(EMPTY);
      const result = await runCli(['demo', verb, '--home', dir], {
        GITHUB_TOKEN: 'real-value-123',
        JIRA_API_TOKEN: 'real-value-456',
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('stand refused (external_secrets)');
      expect(result.stderr).toContain(
        `env -u GITHUB_TOKEN -u JIRA_API_TOKEN pnpm stand demo ${verb} --home ${shellWord(dir)}\n`,
      );
      expect(result.stderr).not.toContain('real-value');
      expect(result.stdout).toBe('');
      expect(demo).not.toHaveBeenCalled();
    },
  );

  it('exits 1 with the error on stderr when the stand refuses', async () => {
    demo.mockResolvedValueOnce({
      status: 409,
      body: { error: 'All 15 steps ran.', note: 'Run pnpm stand demo reset to start again.' },
    });
    const dir = await stubStand(EMPTY);
    const result = await runCli(['demo', 'next', '--home', dir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('All 15 steps ran.');
    expect(result.stderr).toContain('demo reset');
  });
});

describe('stand clock', () => {
  it('sends the shift in milliseconds and exits 0', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['clock', '+2h', '--home', dir]);
    expect(result.code).toBe(0);
    expect(clock).toHaveBeenCalledExactlyOnceWith({ shiftMs: 7_200_000 });
  });

  it.each([
    ['no plus', ['2h']],
    ['an unknown unit', ['+2x']],
    ['a zero shift', ['+0m']],
    ['a backward shift', ['-5m']],
    ['a bare plus', ['+']],
    ['no argument', []],
    ['two arguments', ['+1m', '+2m']],
    ['a shift over the cap', ['+366d']],
  ])('exits 2 on %s without calling the stand', async (_name, shift) => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['clock', ...shift, '--home', dir]);
    expect(result.code).toBe(2);
    // The first line is the reason; a pointer to the help follows it.
    expect(result.stderr.split('\n')[0]).toMatch(/clock/);
    expect(clock).not.toHaveBeenCalled();
  });

  it('says the clock only moves forward on a backward shift', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['clock', '-5m', '--home', dir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('only moves forward');
  });
});

describe('stand usage errors', () => {
  it('prints the reason and a pointer to the help, not the help, on a refused board command', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['board', '--home', dir, 'service', 'status']);
    expect(result.code).toBe(2);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines.length, result.stderr).toBeLessThanOrEqual(2);
    expect(lines[0]).toMatch(/service/);
    expect(lines.slice(1).join('\n')).toContain('pnpm stand help');
    expect(result.stderr).not.toContain('Usage:');
  });

  it('prints the reason and a pointer to the help on a parse error', async () => {
    const result = await runCli(['status', '--no-such-flag']);
    expect(result.code).toBe(2);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines, result.stderr).toHaveLength(2);
    expect(lines[0]).toContain('--no-such-flag');
    expect(lines[1]).toContain('pnpm stand help');
  });

  it('prints the full help to stderr and exits 2 with no command', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(2);
    expect(result.stderr.replace(/\s+/g, ' ')).toContain('Usage: pnpm stand <command>');
    expect(result.stderr).toContain('Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.');
  });

  it('prints the full help to stdout and exits 0 on help', async () => {
    const result = await runCli(['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm stand <command>');
    expect(result.stdout).toContain('--web-port');
    expect(result.stdout).not.toContain('--live-home');
  });

  it.each([
    [['up', '--live-home', '/x'], 'only with --foreground'],
    [['up', '--foreground', '--live-home', '/x'], '--live-home goes only with --detached'],
    [['up', '--web-port', 'abc'], '--web-port must be a number'],
  ])('refuses %j as a usage error', async (args, reason) => {
    const result = await runCli(args);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain('pnpm stand help');
  });
});

describe('stand mcp help', () => {
  it.each(['--help', '-h'])(
    'prints the mcp usage and exits 0 on %s without a stand',
    async (flag) => {
      // An empty home: no manifest, so help must not look one up.
      home = mkdtempSync(join(realpathSync(tmpdir()), STAND_PREFIX));
      const result = await runCli(['mcp', '--home', home, flag]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Usage: pnpm stand mcp [--as');
      expect(result.stdout).toContain('stdio');
      expect(result.stdout).toContain('--as operator|worker|orchestrator');
      expect(result.stdout).toContain('default operator');
      expect(result.stdout).not.toContain('Usage: pnpm stand <command>');
    },
  );

  it('still refuses any other argument', async () => {
    const dir = await stubStand({ status: 200, body: { total: 0, items: [] } });
    const result = await runCli(['mcp', '--home', dir, 'tools']);
    expect(result.code).toBe(2);
    expect(result.stderr.split('\n')[0]).toBe('mcp takes no arguments');
  });
});
