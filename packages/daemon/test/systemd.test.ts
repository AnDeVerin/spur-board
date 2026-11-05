import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { configSchema } from '@spur-board/contracts';
import { openStore, type Store } from '@spur-board/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardModules } from '../src/board-modules.ts';
import { createDaemonModules } from '../src/composition.ts';
import {
  runDaemon,
  type ModuleContext,
  type ModuleEntry,
  type ProcessPort,
} from '../src/lifecycle.ts';
import { createSystemdModule, createSystemdNotifier, type NotifySend } from '../src/systemd.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  http: { port: 0 },
});
const NOTIFY_ENV = { NOTIFY_SOCKET: '/x', WATCHDOG_USEC: '180000000' };

afterEach(() => {
  vi.useRealTimers();
});

interface Run {
  log: string[];
  names: string[];
  exits: number[];
  signal(name: string): void;
  started: Promise<void>;
}

/** Run the daemon with `modules` built from a temp store and a fake process port. */
function run(
  modules: (ctxFor: (name: string) => ModuleContext<Store>, log: string[]) => ModuleEntry[],
): Run {
  const file = join(mkdtempSync(join(tmpdir(), 'board-systemd-')), 'board.db');
  let onSignal: ((name: string) => void) | undefined;
  const result: Run = {
    log: [],
    names: [],
    exits: [],
    signal(name) {
      onSignal?.(name);
    },
    started: Promise.resolve(),
  };
  const port: ProcessPort = {
    onSignal(handler) {
      onSignal = handler;
    },
    onFatal() {},
    exit(code) {
      result.exits.push(code);
    },
    writeErr(text) {
      throw new Error(text);
    },
  };
  result.started = runDaemon<Store>({
    paths: { configFile: 'config', secretsFile: 'secrets', dbFile: file, lockFile: 'lock' },
    acquireLock: () => ({ release() {} }),
    loadConfig: () => ({ config, secrets: {} }),
    openStore,
    modules: (ctxFor) => {
      const entries = modules(ctxFor, result.log);
      result.names = entries.map((entry) => entry.name);
      return entries;
    },
    port,
    stdout: { write() {} },
    clock: { now: () => Date.now() },
    shutdownTimeoutMs: 5_000,
  });
  return result;
}

function composed(
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    tick?: () => Promise<void>;
    startAdapters?: () => { stop(): Promise<void> };
  } = {},
) {
  return (ctxFor: (name: string) => ModuleContext<Store>, log: string[]): ModuleEntry[] =>
    createDaemonModules(ctxFor, {
      spur: { send: () => Promise.resolve() },
      tick: options.tick ?? (() => Promise.resolve()),
      startAdapters: options.startAdapters ?? (() => ({ stop: () => Promise.resolve() })),
      sessionFetcher: () => Promise.reject(new Error('unexpected live session lookup')),
      onListening: () => {
        log.push('listening');
      },
      systemd: {
        env: options.env ?? NOTIFY_ENV,
        pid: 42,
        send: (state) => {
          log.push(state);
        },
      },
    }).entries;
}

async function stopped(daemon: Run): Promise<void> {
  daemon.signal('SIGTERM');
  await vi.waitFor(
    () => {
      expect(daemon.exits).toHaveLength(1);
    },
    { interval: 5 },
  );
}

describe('systemd notifications from the composed daemon', () => {
  it('sends READY after HTTP listens and WATCHDOG when the held first tick completes', async () => {
    let release: () => void = () => undefined;
    const daemon = run(
      composed({
        tick: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      }),
    );
    await daemon.started;
    expect(daemon.log).toEqual(['listening', 'READY=1']);
    release();
    await vi.waitFor(
      () => {
        expect(daemon.log).toEqual(['listening', 'READY=1', 'WATCHDOG=1']);
      },
      { interval: 5 },
    );
    await stopped(daemon);
  });

  it('drops the WATCHDOG of a tick that completes before READY', async () => {
    const daemon = run(composed());
    await daemon.started;
    await sleep(20);
    expect(daemon.log).toEqual(['listening', 'READY=1']);
    await stopped(daemon);
  });

  it('sends STOPPING last on SIGTERM and exits 0', async () => {
    const daemon = run(composed());
    await daemon.started;
    await stopped(daemon);
    expect(daemon.log.at(-1)).toBe('STOPPING=1');
    expect(daemon.exits).toEqual([0]);
  });

  it('sends neither READY nor STOPPING when a module fails to start', async () => {
    const daemon = run(
      composed({
        startAdapters: () => {
          throw new Error('adapters down');
        },
      }),
    );
    await daemon.started;
    await vi.waitFor(
      () => {
        expect(daemon.exits).toEqual([1]);
      },
      { interval: 5 },
    );
    expect(daemon.log).not.toContain('READY=1');
    expect(daemon.log).not.toContain('STOPPING=1');
  });

  it('sends nothing without NOTIFY_SOCKET', async () => {
    let release: () => void = () => undefined;
    const daemon = run(
      composed({
        env: { WATCHDOG_USEC: '180000000' },
        tick: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      }),
    );
    await daemon.started;
    release();
    await sleep(20);
    await stopped(daemon);
    expect(daemon.log).toEqual(['listening']);
  });

  it('registers the systemd module after HTTP', async () => {
    const daemon = run(composed());
    await daemon.started;
    expect(daemon.names.slice(-2)).toEqual(['http', 'systemd']);
    await stopped(daemon);
  });
});

describe('WATCHDOG per board tick', () => {
  function boardRun(tick: (n: number) => Promise<void>): Run & { ticks(): number } {
    let ticks = 0;
    const daemon = run((ctxFor, log) => {
      const notifier = createSystemdNotifier({
        env: NOTIFY_ENV,
        pid: 42,
        log: ctxFor('systemd').log,
        send: (state) => {
          log.push(state);
        },
      });
      return [
        ...createBoardModules(ctxFor, {
          startAdapters: () => ({ stop: () => Promise.resolve() }),
          tick: () => {
            ticks += 1;
            return tick(ticks);
          },
          onTick: () => {
            notifier.watchdog();
          },
        }),
        { name: 'systemd', stopStage: 'pollers', module: createSystemdModule(notifier) },
      ];
    });
    return Object.assign(daemon, { ticks: () => ticks });
  }
  const pings = (daemon: Run): number => daemon.log.filter((s) => s === 'WATCHDOG=1').length;

  it('pings once per completed tick and not while a tick stalls', async () => {
    vi.useFakeTimers();
    const held: (() => void)[] = [];
    const daemon = boardRun((n) =>
      n === 1 || n === 4
        ? new Promise<void>((resolve) => {
            held.push(resolve);
          })
        : Promise.resolve(),
    );
    await daemon.started;
    expect(pings(daemon)).toBe(0);
    held.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(daemon)).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(daemon)).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(daemon)).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.ticks()).toBe(4);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pings(daemon)).toBe(3);
    expect(daemon.ticks()).toBe(4);
    held.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    daemon.signal('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.exits).toEqual([0]);
  });

  it('does not ping after a failed tick and pings again after the next success', async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    const daemon = boardRun((n) => {
      if (n === 1)
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      if (n === 2) return Promise.reject(new Error('tick failed'));
      return Promise.resolve();
    });
    await daemon.started;
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(daemon)).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.ticks()).toBe(2);
    expect(pings(daemon)).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.ticks()).toBe(3);
    expect(pings(daemon)).toBe(2);
    daemon.signal('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.exits).toEqual([0]);
  });
});

describe('createSystemdNotifier', () => {
  function notifier(env: Record<string, string>, send?: NotifySend) {
    const sent: string[] = [];
    const log = { error: vi.fn() };
    const n = createSystemdNotifier({
      env,
      pid: 42,
      log,
      send:
        send ??
        ((state) => {
          sent.push(state);
        }),
    });
    return { n, sent, log };
  }

  it('sends nothing without NOTIFY_SOCKET', () => {
    const { n, sent } = notifier({ WATCHDOG_USEC: '1' });
    n.ready();
    n.watchdog();
    n.stopping();
    expect(sent).toEqual([]);
  });

  it('sends no WATCHDOG without WATCHDOG_USEC', () => {
    const { n, sent } = notifier({ NOTIFY_SOCKET: '/x' });
    n.ready();
    n.watchdog();
    n.stopping();
    expect(sent).toEqual(['READY=1', 'STOPPING=1']);
  });

  it('sends no WATCHDOG when WATCHDOG_PID names another process', () => {
    const { n, sent } = notifier({ ...NOTIFY_ENV, WATCHDOG_PID: '7' });
    n.ready();
    n.watchdog();
    expect(sent).not.toContain('WATCHDOG=1');
  });

  it('sends WATCHDOG when WATCHDOG_PID is this process', () => {
    const { n, sent } = notifier({ ...NOTIFY_ENV, WATCHDOG_PID: '42' });
    n.ready();
    n.watchdog();
    expect(sent).toEqual(['READY=1', 'WATCHDOG=1']);
  });

  it('drops WATCHDOG before READY and after STOPPING', () => {
    const { n, sent } = notifier(NOTIFY_ENV);
    n.watchdog();
    n.ready();
    n.stopping();
    n.watchdog();
    expect(sent).toEqual(['READY=1', 'STOPPING=1']);
  });

  it('sends READY once', () => {
    const { n, sent } = notifier(NOTIFY_ENV);
    n.ready();
    n.ready();
    expect(sent).toEqual(['READY=1']);
  });

  it('logs a throwing send once and does not throw', () => {
    const err = new Error('boom');
    const { n, log } = notifier(NOTIFY_ENV, () => {
      throw err;
    });
    expect(() => {
      n.ready();
    }).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      'systemd notify failed',
    );
  });
});

describe('the systemd-notify spawn sender', () => {
  function fakeBinary(tail = ''): string {
    const dir = mkdtempSync(join(tmpdir(), 'board-notify-'));
    const script = join(dir, 'systemd-notify');
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "$NOTIFY_SOCKET.args"\nexport -p >> "$NOTIFY_SOCKET.env"\n${tail}`,
    );
    chmodSync(script, 0o755);
    return dir;
  }

  it('passes the state and only NOTIFY_SOCKET and PATH to the child', async () => {
    const dir = fakeBinary();
    const socket = join(dir, 'sock');
    const log = { error: vi.fn() };
    createSystemdNotifier({
      env: { NOTIFY_SOCKET: socket, PATH: dir, GITHUB_TOKEN: 'secret' },
      pid: 42,
      log,
    }).ready();
    await vi.waitFor(
      () => {
        expect(readFileSync(`${socket}.args`, 'utf8')).toBe('READY=1\n');
        const env = readFileSync(`${socket}.env`, 'utf8');
        expect(env).toContain('NOTIFY_SOCKET=');
        expect(env).toContain('PATH=');
        expect(env).not.toContain('GITHUB_TOKEN');
      },
      { interval: 10 },
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs one failure with the exit code of a failing systemd-notify', async () => {
    const dir = fakeBinary('exit 3\n');
    const log = { error: vi.fn() };
    createSystemdNotifier({
      env: { NOTIFY_SOCKET: join(dir, 'sock'), PATH: dir },
      pid: 42,
      log,
    }).ready();
    await vi.waitFor(
      () => {
        expect(log.error).toHaveBeenCalledTimes(1);
      },
      { interval: 10 },
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 3 }),
      'systemd notify failed',
    );
  });

  it('logs one ENOENT failure when systemd-notify is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-notify-empty-'));
    const log = { error: vi.fn() };
    expect(() => {
      createSystemdNotifier({
        env: { NOTIFY_SOCKET: join(dir, 'sock'), PATH: dir },
        pid: 42,
        log,
      }).ready();
    }).not.toThrow();
    await vi.waitFor(
      () => {
        expect(log.error).toHaveBeenCalledTimes(1);
      },
      { interval: 10 },
    );
    await sleep(100);
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0] as [{ err: NodeJS.ErrnoException }, string];
    expect(message).toBe('systemd notify failed');
    expect(fields.err.code).toBe('ENOENT');
  });
});
