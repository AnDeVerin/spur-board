import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDaemonToExit, spawnDaemon, waitForLine } from './daemon-process.ts';
import { makeHome } from './home.ts';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

describe('single instance', () => {
  it('refuses a second daemon and recovers after the first is killed', async () => {
    const home = makeHome();
    const first = spawnDaemon(home);
    children.push(first);
    await waitForLine(first, 'daemon ready');

    const second = runDaemonToExit(home);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(join(home, 'board.lock'));
    expect(second.stderr).toContain(`PID ${String(first.pid)}`);
    expect(first.exitCode).toBeNull();

    const firstExit = once(first, 'exit');
    first.kill('SIGKILL');
    await firstExit;

    const third = spawnDaemon(home);
    children.push(third);
    await waitForLine(third, 'daemon ready');
    const thirdExit = once(third, 'exit');
    third.kill('SIGTERM');
    const [code] = (await thirdExit) as [number | null];
    expect(code).toBe(0);
  }, 30_000);
});
