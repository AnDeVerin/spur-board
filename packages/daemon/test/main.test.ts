import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDaemonToExit, spawnDaemon, waitForLine } from './daemon-process.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

describe('daemon process', () => {
  it('invalid config exits 1 before creating the database', () => {
    const home = makeHome({
      config: VALID_CONFIG_YAML.replace('repo: example-org/board', 'repo: bad'),
    });
    const result = runDaemonToExit(home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('projects.0.tracker.repo');
    expect(result.stderr).toContain('hint:');
    expect(existsSync(join(home, 'board.sqlite'))).toBe(false);
  }, 30_000);

  it('fails clearly without flock', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'daemon-nopath-'));
    const result = runDaemonToExit(makeHome(), { PATH: emptyPath });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('flock from util-linux is required');
  }, 30_000);

  it('logs JSON, reaches ready and exits 0 on SIGTERM', async () => {
    const home = makeHome();
    const child = spawnDaemon(home);
    children.push(child);
    const ready = await waitForLine(child, 'daemon ready');
    expect(ready['level']).toBe(30);
    expect(existsSync(join(home, 'board.sqlite'))).toBe(true);

    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = (await exited) as [number | null, string | null];
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 30_000);
});
