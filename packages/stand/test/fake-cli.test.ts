import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startControl,
  type Control,
  type ControlRoutes,
  type RouteResult,
} from '../src/control.ts';
import { STAND_PREFIX, writeManifest } from '../src/manifest.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = 'stub-control-token';

let control: Control | undefined;
let home: string | undefined;
const clock = vi.fn<ControlRoutes['clock']>(() =>
  Promise.resolve({ status: 200, body: { offsetMs: 0 } }),
);

afterEach(async () => {
  await control?.close();
  control = undefined;
  clock.mockClear();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

/** A stand home whose manifest names a real control endpoint answering `/violations` with `answer`. */
async function stubStand(answer: RouteResult): Promise<string> {
  control = await startControl({
    token: TOKEN,
    routes: {
      wait: vi.fn(),
      poll: vi.fn(),
      reset: vi.fn(),
      seed: vi.fn(),
      clock,
      fake: vi.fn(),
      slackOutbox: vi.fn(),
      slackClick: vi.fn(),
      violations: () => Promise.resolve(answer),
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
  });
  return home;
}

/** Async, because the stub answers from this process and `spawnSync` would block it. */
function runCli(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
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
  });
});
