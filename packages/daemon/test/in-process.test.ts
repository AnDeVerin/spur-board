import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '@spur-board/contracts';
import { startFakeSlackApi } from '@spur-board/gateway-slack/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, startInProcessDaemon, type InProcessDaemon } from '../src/in-process.ts';

const configFor = (port: number) =>
  configSchema.parse({
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
    http: { port },
  });

/** The daemon options of these tests: a temp home, a real lock, a tick the test controls. */
function optionsFor(input: {
  tick: () => Promise<void>;
  port?: number;
  lines?: string[];
  shutdownTimeoutMs?: number;
  registerFatal?: (handler: (err: unknown) => void) => void;
  config?: Config;
  secrets?: Readonly<Record<string, string>>;
}): Parameters<typeof startInProcessDaemon>[0] {
  return {
    paths: {
      configFile: join(home, 'config.yaml'),
      secretsFile: join(home, 'secrets.env'),
      dbFile: join(home, 'board.sqlite'),
      lockFile: join(home, 'board.lock'),
    },
    loadConfig: () => ({
      config: input.config ?? configFor(input.port ?? 0),
      secrets: input.secrets ?? {},
    }),
    acquireLock,
    clock: { now: () => Date.now() },
    stdout: {
      write(line: string) {
        input.lines?.push(line);
      },
    },
    writeErr(text) {
      throw new Error(text);
    },
    ports: {
      tick: input.tick,
      startAdapters: () => ({ stop: () => Promise.resolve() }),
    },
    ...(input.registerFatal === undefined ? {} : { registerFatal: input.registerFatal }),
    ...(input.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: input.shutdownTimeoutMs }),
  };
}

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
    daemon = await startInProcessDaemon(
      optionsFor({
        tick: () => stalled,
        registerFatal: (handler) => {
          fatal = handler;
        },
      }),
    );
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

  it('logs no shutdown timeout after a fatal exit whose teardown finished in time', async () => {
    let fatal: ((err: unknown) => void) | undefined;
    const lines: string[] = [];
    daemon = await startInProcessDaemon(
      optionsFor({
        tick: () => Promise.resolve(),
        lines,
        // Long enough that a teardown slowed by machine load still beats the timer.
        shutdownTimeoutMs: 1_500,
        registerFatal: (handler) => {
          fatal = handler;
        },
      }),
    );
    fatal?.(new Error('boom'));
    expect(await daemon.exited).toBe(1);
    await daemon.teardown;
    // Past the shutdown timeout window: the cleared timer must log nothing.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(lines.filter((line) => line.includes('shutdown timed out'))).toEqual([]);
  }, 10_000);

  it('rejects a failed start only after teardown has freed the lock', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const address = taken.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let outcome: string | undefined;
    const lines: string[] = [];
    // The API port is taken, so the HTTP module fails to start; the stalled tick holds shutdown.
    const starting = startInProcessDaemon(
      optionsFor({ tick: () => stalled, port, lines, shutdownTimeoutMs: 200 }),
    ).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    void starting.then((result) => {
      outcome = result;
    });
    try {
      // The shutdown timer has fired, so stop() has resolved; the start still waits on teardown.
      await vi.waitFor(
        () => {
          expect(lines.some((line) => line.includes('shutdown timed out'))).toBe(true);
        },
        { timeout: 20_000 },
      );
      expect(outcome).toBeUndefined();
      expect(() => acquireLock(join(home, 'board.lock'))).toThrow();
      release();
      expect(await starting).toBe('Daemon did not bind HTTP');
      acquireLock(join(home, 'board.lock')).release();
    } finally {
      release();
      await new Promise<void>((resolve) =>
        taken.close(() => {
          resolve();
        }),
      );
    }
  }, 30_000);

  it('logs a failed Slack envelope through the gateway-slack logger', async () => {
    const fake = await startFakeSlackApi();
    const lines: string[] = [];
    const config = configFor(0);
    try {
      daemon = await startInProcessDaemon(
        optionsFor({
          tick: () => Promise.resolve(),
          lines,
          config: {
            ...config,
            slack: {
              ...config.slack,
              channels: { orchestrators: 'C000000001', feed: 'C000000002' },
            },
          },
          secrets: {
            SLACK_BOT_TOKEN: 'xoxb-in-process',
            SLACK_APP_TOKEN: 'xapp-in-process',
            SLACK_API_URL: fake.url,
          },
        }),
      );
      // An unknown thread root fails the envelope before the sink, so it is never acked.
      void fake.emitEnvelope('events_api', {
        event: {
          type: 'message',
          channel: 'C000000001',
          user: 'U1',
          text: 'x',
          ts: '200.000002',
          thread_ts: '100.000001',
        },
      });
      await vi.waitFor(() => {
        const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toContainEqual(
          expect.objectContaining({
            level: 50,
            module: 'gateway-slack',
            msg: 'slack envelope failed',
            err: expect.objectContaining({
              message: 'Slack thread root unavailable',
              stack: expect.any(String) as unknown,
            }) as unknown,
          }),
        );
      });
      expect(await daemon.stop()).toBe(0);
    } finally {
      await fake.close();
    }
  });
});
