import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, startInProcessDaemon, type InProcessDaemon } from '../src/in-process.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'example/repo' },
      repos: ['example/repo'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  http: { port: 0 },
});

let home: string;
let daemon: InProcessDaemon | undefined;
let release: () => void = () => undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'in-process-'));
});

afterEach(async () => {
  release();
  await daemon?.teardown;
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('startInProcessDaemon', () => {
  it('exits 1 on a fatal error, then frees the listener, store and lock before teardown', async () => {
    let fatal: ((err: unknown) => void) | undefined;
    // A board tick that stalls until released keeps the shutdown from finishing early.
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockFile = join(home, 'board.lock');
    daemon = await startInProcessDaemon({
      paths: {
        configFile: join(home, 'config.yaml'),
        secretsFile: join(home, 'secrets.env'),
        dbFile: join(home, 'board.sqlite'),
        lockFile,
      },
      loadConfig: () => ({ config, secrets: {} }),
      acquireLock,
      clock: { now: () => Date.now() },
      stdout: { write() {} },
      writeErr(text) {
        throw new Error(text);
      },
      ports: {
        tick: () => stalled,
        startAdapters: () => ({ stop: () => Promise.resolve() }),
      },
      registerFatal: (handler) => {
        fatal = handler;
      },
    });
    const { address } = daemon;
    let tornDown = false;
    void daemon.teardown.then(() => {
      tornDown = true;
    });

    fatal?.(new Error('boom'));
    expect(await daemon.exited).toBe(1);
    expect(await daemon.stop()).toBe(1);
    // The shutdown waits for the stalled tick: the lock is still held and teardown pending.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tornDown).toBe(false);
    expect(() => acquireLock(lockFile)).toThrow();

    release();
    await daemon.teardown;
    acquireLock(lockFile).release();
    await expect(fetch(`${address}/v1/schema`)).rejects.toThrow();
  });
});
