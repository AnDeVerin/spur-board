import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startControl, type Control, type RouteResult } from '../src/control.ts';
import { STAND_PREFIX, writeManifest } from '../src/manifest.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = 'stub-control-token';

let control: Control | undefined;
let home: string | undefined;

afterEach(async () => {
  await control?.close();
  control = undefined;
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

/** A stand home whose manifest names a real control endpoint answering `/fake` with `answer`. */
async function stubStand(answer: RouteResult): Promise<string> {
  control = await startControl({
    token: TOKEN,
    routes: { wait: vi.fn(), poll: vi.fn(), reset: vi.fn(), fake: () => answer },
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
    roles: { worker: 'w', orchestrator: 'o' },
  });
  return home;
}

/** Async, because the stub answers from this process and `spawnSync` would block it. */
function runCli(args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
  });
}

describe('stand fake violations', () => {
  it('exits 0 on an empty log', async () => {
    const dir = await stubStand({ status: 200, body: { violations: [], dropped: 0 } });
    const result = await runCli(['fake', 'violations', '--home', dir]);
    expect(result.code).toBe(0);
  });

  it('exits 1 and prints the entries on a non-empty log', async () => {
    const dir = await stubStand({
      status: 409,
      body: { violations: [{ reason: 'unknown-shape-marker' }], dropped: 0 },
    });
    const result = await runCli(['fake', 'violations', '--home', dir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('unknown-shape-marker');
  });
});
