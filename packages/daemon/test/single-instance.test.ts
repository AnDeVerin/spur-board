import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killDaemons, runDaemonToExit, spawnDaemon, waitForLine } from './daemon-process.ts';
import { makeHome } from './home.ts';

afterEach(killDaemons);

describe('single instance', () => {
  it('refuses a second daemon and recovers after the first is killed', async () => {
    const home = makeHome();
    const first = spawnDaemon(home);
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
    await waitForLine(third, 'daemon ready');
    const thirdExit = once(third, 'exit');
    third.kill('SIGTERM');
    const [code] = (await thirdExit) as [number | null];
    expect(code).toBe(0);
  }, 30_000);
});
