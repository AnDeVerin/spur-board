import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, resolvePaths } from '../src/config.ts';
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  runDaemon,
  type DaemonState,
  type Module,
  type ModuleContext,
  type ModuleEntry,
  type ProcessPort,
} from '../src/lifecycle.ts';
import type { Clock } from '../src/logger.ts';
import { makeHome } from './home.ts';

const { config } = loadConfig(resolvePaths({ BOARD_HOME: makeHome() }, '/unused'));

const PATHS = {
  configFile: '/h/config.yaml',
  secretsFile: '/h/secrets.env',
  dbFile: '/h/board.sqlite',
  lockFile: '/h/board.lock',
};

type Line = Record<string, unknown> & { level: number; msg: string };

interface FakePort extends ProcessPort {
  exits: number[];
  stderr: string[];
  signal(name: string): void;
  fatal(err: unknown): void;
}

function fakePort(): FakePort {
  let onSignal: ((signal: string) => void) | undefined;
  let onFatal: ((err: unknown) => void) | undefined;
  const port: FakePort = {
    exits: [],
    stderr: [],
    onSignal(handler) {
      onSignal = handler;
    },
    onFatal(handler) {
      onFatal = handler;
    },
    exit(code) {
      port.exits.push(code);
    },
    writeErr(text) {
      port.stderr.push(text);
    },
    signal(name) {
      onSignal?.(name);
    },
    fatal(err) {
      onFatal?.(err);
    },
  };
  return port;
}

interface FakeStore {
  close(): Promise<void>;
}

interface ModuleSpec {
  name: string;
  stopStage: ModuleEntry['stopStage'];
  start?: (signal: AbortSignal) => Promise<void>;
  stop?: () => Promise<void>;
}

interface RunOptions {
  modules?: ModuleSpec[];
  factory?: (ctxFor: (name: string) => ModuleContext<FakeStore>) => readonly ModuleEntry[];
  openStore?: () => FakeStore;
  storeClose?: () => Promise<void>;
  acquireLock?: () => { release(): void };
  loadConfig?: () => ReturnType<typeof loadConfig>;
  clock?: Clock;
  shutdownTimeoutMs?: number;
}

/** Fakes that all write to one `events` list; `start()` runs the daemon on them. */
function harness(options: RunOptions = {}) {
  const events: string[] = [];
  const out: string[] = [];
  const port = fakePort();
  const stops = new Map<string, number>();
  const states = new Map<string, DaemonState[]>();
  const clock = options.clock ?? { now: () => 0 };

  const entriesFor = (ctxFor: (name: string) => ModuleContext<FakeStore>): ModuleEntry[] =>
    (options.modules ?? []).map((spec): ModuleEntry => {
      const ctx = ctxFor(spec.name);
      const module: Module = {
        async start(signal) {
          events.push(`${spec.name}:start`);
          states.set(spec.name, [ctx.state()]);
          signal.addEventListener('abort', () => {
            if (!events.includes('abort')) events.push('abort');
          });
          await spec.start?.(signal);
        },
        async stop() {
          events.push(`${spec.name}:stop`);
          stops.set(spec.name, (stops.get(spec.name) ?? 0) + 1);
          await spec.stop?.();
        },
      };
      return { name: spec.name, stopStage: spec.stopStage, module };
    });

  const start = (): Promise<void> =>
    runDaemon<FakeStore>({
      paths: PATHS,
      acquireLock:
        options.acquireLock ??
        (() => {
          events.push('lock');
          let released = false;
          return {
            release() {
              // closeSync on a closed fd throws EBADF; a second release is a bug.
              if (released) throw new Error('lock released twice');
              released = true;
              events.push('lock:release');
            },
          };
        }),
      loadConfig:
        options.loadConfig ??
        (() => {
          events.push('config');
          return { config, secrets: {} };
        }),
      openStore:
        options.openStore ??
        (() => {
          events.push('db');
          return {
            close:
              options.storeClose ??
              (() => {
                events.push('db:close');
                return Promise.resolve();
              }),
          };
        }),
      modules: options.factory ?? entriesFor,
      port,
      stdout: {
        write(line: string) {
          out.push(line);
        },
      },
      clock,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
    });

  return {
    start,
    events,
    port,
    stops,
    states,
    entriesFor,
    lines: (): Line[] => out.map((line) => JSON.parse(line) as Line),
  };
}

async function exitsWith(port: FakePort, exits: number[]): Promise<void> {
  await vi.waitFor(
    () => {
      expect(port.exits).toEqual(exits);
    },
    { timeout: 1_000 },
  );
}

function hasMsg(lines: readonly Line[], msg: string): boolean {
  return lines.some((line) => line.msg === msg);
}

describe('runDaemon', () => {
  it('starts and stops in order', async () => {
    const h = harness({
      modules: [
        { name: 'core', stopStage: 'final' },
        { name: 'adapters', stopStage: 'pollers' },
        { name: 'outbox', stopStage: 'outbox' },
        { name: 'gateway', stopStage: 'final' },
        { name: 'http', stopStage: 'final' },
      ],
    });
    await h.start();
    expect(h.events.slice(0, 8)).toEqual([
      'lock',
      'config',
      'db',
      'core:start',
      'adapters:start',
      'outbox:start',
      'gateway:start',
      'http:start',
    ]);
    expect(hasMsg(h.lines(), 'daemon ready')).toBe(true);

    h.port.signal('SIGTERM');
    await exitsWith(h.port, [0]);
    const at = (event: string): number => h.events.indexOf(event);
    expect(at('abort')).toBeGreaterThan(-1);
    expect(at('abort')).toBeLessThan(at('adapters:stop'));
    expect(at('adapters:stop')).toBeLessThan(at('outbox:stop'));
    for (const name of ['core', 'gateway', 'http']) {
      expect(at('outbox:stop')).toBeLessThan(at(`${name}:stop`));
      expect(at(`${name}:stop`)).toBeLessThan(at('db:close'));
    }
    expect(h.events.slice(-2)).toEqual(['db:close', 'lock:release']);
  });

  it('exits 1 when a stop hangs', async () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    const h = harness({
      shutdownTimeoutMs: 50,
      modules: [
        { name: 'fine', stopStage: 'final' },
        { name: 'hung', stopStage: 'final', stop: () => new Promise<void>(() => undefined) },
      ],
    });
    await h.start();
    h.port.signal('SIGTERM');
    await exitsWith(h.port, [1]);
    const timeout = h.lines().find((line) => line.msg === 'shutdown timed out');
    expect(timeout?.level).toBe(50);
    expect(timeout?.['pending']).toEqual(['hung']);
  });

  it('two signals run one shutdown', async () => {
    const h = harness({
      modules: [
        { name: 'a', stopStage: 'pollers' },
        { name: 'b', stopStage: 'final' },
      ],
    });
    await h.start();
    h.port.signal('SIGTERM');
    h.port.signal('SIGINT');
    await exitsWith(h.port, [0]);
    expect(h.stops).toEqual(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
    );
    expect(h.events.filter((event) => event === 'db:close')).toHaveLength(1);
  });

  it('clean shutdown clears the timer', async () => {
    const h = harness({ shutdownTimeoutMs: 50, modules: [{ name: 'a', stopStage: 'final' }] });
    await h.start();
    h.port.signal('SIGTERM');
    await exitsWith(h.port, [0]);
    await sleep(150);
    expect(h.port.exits).toEqual([0]);
    expect(hasMsg(h.lines(), 'shutdown timed out')).toBe(false);
    expect(h.lines().filter((line) => line.level >= 50)).toEqual([]);
  });

  it('fatal during shutdown exits once', async () => {
    const hang = Promise.withResolvers<undefined>();
    const h = harness({
      shutdownTimeoutMs: 50,
      modules: [{ name: 'slow', stopStage: 'final', stop: () => hang.promise }],
    });
    await h.start();
    h.port.signal('SIGTERM');
    // Poll fast, so the fatal error lands well inside the 50 ms timeout.
    await vi.waitFor(
      () => {
        expect(h.events).toContain('slow:stop');
      },
      { interval: 1 },
    );
    expect(h.port.exits).toEqual([]);
    h.port.fatal(new Error('boom'));
    expect(h.port.exits).toEqual([1]);
    expect(h.lines().some((line) => line.level === 60 && line.msg === 'fatal')).toBe(true);
    hang.resolve(undefined);
    await sleep(150);
    expect(h.port.exits).toEqual([1]);
    // The fatal exit cleared the timer, so it never fired.
    expect(hasMsg(h.lines(), 'shutdown timed out')).toBe(false);
  });

  it('store close failure still releases the lock', async () => {
    const h = harness({
      modules: [{ name: 'a', stopStage: 'final' }],
      storeClose: () => {
        h.events.push('db:close');
        return Promise.reject(new Error('close boom'));
      },
    });
    await h.start();
    h.port.signal('SIGTERM');
    await exitsWith(h.port, [1]);
    expect(h.events.filter((event) => event === 'db:close')).toHaveLength(1);
    expect(h.events.slice(-2)).toEqual(['db:close', 'lock:release']);
    const failed = h.lines().find((line) => line.msg === 'store close failed');
    expect(failed?.level).toBe(50);
    expect((failed?.['err'] as { message: string }).message).toBe('close boom');
    expect(hasMsg(h.lines(), 'shutdown timed out')).toBe(false);
  });

  it('reports starting until all modules are up', async () => {
    let seen: DaemonState | undefined;
    const h = harness({
      factory: (ctxFor) => {
        const ctx = ctxFor('probe');
        seen = ctx.state();
        return h.entriesFor(ctxFor);
      },
      modules: [
        { name: 'a', stopStage: 'final' },
        { name: 'b', stopStage: 'final' },
      ],
    });
    await h.start();
    expect(seen).toBe('starting');
    expect(h.states.get('a')).toEqual(['starting']);
    expect(h.states.get('b')).toEqual(['starting']);
  });

  it('module states move to ready and then stopping', async () => {
    let ctx: ModuleContext<FakeStore> | undefined;
    const h = harness({
      factory: (ctxFor) => {
        ctx = ctxFor('probe');
        return [];
      },
    });
    await h.start();
    expect(ctx?.state()).toBe('ready');
    h.port.signal('SIGTERM');
    expect(ctx?.state()).toBe('stopping');
    await exitsWith(h.port, [0]);
  });

  describe('ready hooks', () => {
    /** Adds a `ready` hook to each module that records its name and the daemon state. */
    function withReady(
      h: ReturnType<typeof harness>,
      ctxFor: (name: string) => ModuleContext<FakeStore>,
    ): ModuleEntry[] {
      const probe = ctxFor('probe');
      return h.entriesFor(ctxFor).map((entry) => ({
        ...entry,
        module: {
          ...entry.module,
          ready() {
            h.events.push(`${entry.name}:ready:${probe.state()}`);
          },
        },
      }));
    }

    it('run in start order once the state is ready', async () => {
      const h: ReturnType<typeof harness> = harness({
        modules: [
          { name: 'm1', stopStage: 'final' },
          { name: 'm2', stopStage: 'pollers' },
        ],
        factory: (ctxFor) => withReady(h, ctxFor),
      });
      await h.start();
      expect(h.events.slice(-2)).toEqual(['m1:ready:ready', 'm2:ready:ready']);
      expect(hasMsg(h.lines(), 'daemon ready')).toBe(true);
      h.port.signal('SIGTERM');
      await exitsWith(h.port, [0]);
    });

    it('do not run when a start fails', async () => {
      const h: ReturnType<typeof harness> = harness({
        modules: [
          { name: 'm1', stopStage: 'final' },
          { name: 'm2', stopStage: 'final', start: () => Promise.reject(new Error('no start')) },
        ],
        factory: (ctxFor) => withReady(h, ctxFor),
      });
      await h.start();
      await exitsWith(h.port, [1]);
      expect(h.events.filter((event) => event.includes(':ready'))).toEqual([]);
    });

    it('do not run when a signal arrives during the last start', async () => {
      const starting = Promise.withResolvers<undefined>();
      const h: ReturnType<typeof harness> = harness({
        modules: [
          { name: 'm1', stopStage: 'final' },
          { name: 'm2', stopStage: 'pollers', start: () => starting.promise },
        ],
        factory: (ctxFor) => withReady(h, ctxFor),
      });
      const run = h.start();
      await vi.waitFor(() => {
        expect(h.events).toContain('m2:start');
      });
      h.port.signal('SIGTERM');
      starting.resolve(undefined);
      await run;
      await exitsWith(h.port, [0]);
      expect(h.events).toContain('m2:stop');
      expect(h.events.filter((event) => event.includes(':ready'))).toEqual([]);
    });
  });

  it('fatal error exits 1', async () => {
    const h = harness({ modules: [{ name: 'a', stopStage: 'final' }] });
    await h.start();
    h.port.fatal(new Error('kaboom'));
    expect(h.port.exits).toEqual([1]);
    const fatal = h.lines().find((line) => line.msg === 'fatal');
    expect(fatal?.level).toBe(60);
    expect((fatal?.['err'] as { message: string }).message).toBe('kaboom');
  });

  it('start failure stops started modules', async () => {
    const h = harness({
      modules: [
        { name: 'm1', stopStage: 'final' },
        { name: 'm2', stopStage: 'final', start: () => Promise.reject(new Error('no start')) },
        { name: 'm3', stopStage: 'final' },
      ],
    });
    await h.start();
    await exitsWith(h.port, [1]);
    expect(h.events).toEqual([
      'lock',
      'config',
      'db',
      'm1:start',
      'm2:start',
      'abort',
      'm1:stop',
      'db:close',
      'lock:release',
    ]);
    const failed = h.lines().find((line) => line.msg === 'start failed');
    expect(failed?.level).toBe(50);
    expect(failed?.['module']).toBe('m2');
    expect(hasMsg(h.lines(), 'daemon ready')).toBe(false);
  });

  it('lock error exits before the config', async () => {
    const h = harness({
      acquireLock: () => {
        throw new Error('another daemon holds /h/board.lock (PID 42)');
      },
    });
    await h.start();
    expect(h.events).toEqual([]);
    expect(h.port.stderr).toEqual(['board daemon: another daemon holds /h/board.lock (PID 42)\n']);
    expect(h.port.exits).toEqual([1]);
  });

  it('config error exits before the store', async () => {
    const h = harness({
      loadConfig: () => {
        h.events.push('config');
        throw new Error('invalid config in /h/config.yaml');
      },
    });
    await h.start();
    expect(h.events).toEqual(['lock', 'config', 'lock:release']);
    expect(h.port.stderr.join('')).toContain('invalid config in /h/config.yaml');
    expect(h.port.exits).toEqual([1]);
  });

  it('store failure releases the lock', async () => {
    let factoryCalled = false;
    const h = harness({
      openStore: () => {
        throw new Error(
          'Database x has schema v9, newer than this code (v1); upgrade spur-board to open it',
        );
      },
      factory: () => {
        factoryCalled = true;
        return [];
      },
    });
    await h.start();
    expect(h.events).toEqual(['lock', 'config', 'lock:release']);
    expect(factoryCalled).toBe(false);
    expect(h.port.exits).toEqual([1]);
    const failed = h.lines().find((line) => line.level === 50);
    expect((failed?.['err'] as { message: string }).message).toContain('newer than this code');
  });

  it('module factory failure closes the store', async () => {
    const h = harness({
      factory: () => {
        throw new Error('bad wiring');
      },
    });
    await h.start();
    expect(h.events).toEqual(['lock', 'config', 'db', 'db:close', 'lock:release']);
    expect(h.port.exits).toEqual([1]);
    expect(h.lines().some((line) => line.level === 50 && line.msg === 'start failed')).toBe(true);

    const rejecting = harness({
      factory: () => {
        throw new Error('bad wiring');
      },
      storeClose: () => {
        rejecting.events.push('db:close');
        return Promise.reject(new Error('close boom'));
      },
    });
    await rejecting.start();
    expect(rejecting.events).toEqual(['lock', 'config', 'db', 'db:close', 'lock:release']);
    expect(rejecting.port.exits).toEqual([1]);
    expect(
      rejecting.lines().some((line) => line.level === 50 && line.msg === 'store close failed'),
    ).toBe(true);
  });

  it('signal during start-failure cleanup tears down once', async () => {
    const closing = Promise.withResolvers<undefined>();
    const h = harness({
      modules: [{ name: 'a', stopStage: 'final' }],
      factory: () => {
        throw new Error('bad wiring');
      },
      storeClose: async () => {
        h.events.push('db:close');
        await closing.promise;
      },
    });
    const run = h.start();
    await vi.waitFor(() => {
      expect(h.events).toContain('db:close');
    });
    h.port.signal('SIGTERM');
    h.port.fatal(new Error('late'));
    closing.resolve(undefined);
    await run;
    await sleep(20);
    expect(h.events).toEqual(['lock', 'config', 'db', 'db:close', 'lock:release']);
    expect(h.port.exits).toEqual([1]);
    expect(h.lines().filter((line) => line.level === 60)).toEqual([]);
  });

  it('signal during a start stops started modules', async () => {
    const starting = Promise.withResolvers<undefined>();
    let ctx: ModuleContext<FakeStore> | undefined;
    const h = harness({
      modules: [
        { name: 'm1', stopStage: 'final' },
        { name: 'm2', stopStage: 'pollers', start: () => starting.promise },
        { name: 'm3', stopStage: 'final' },
      ],
      factory: (ctxFor) => {
        ctx = ctxFor('probe');
        return h.entriesFor(ctxFor);
      },
    });
    const run = h.start();
    await vi.waitFor(() => {
      expect(h.events).toContain('m2:start');
    });
    h.port.signal('SIGTERM');
    starting.resolve(undefined);
    await run;
    await exitsWith(h.port, [0]);
    const at = (event: string): number => h.events.indexOf(event);
    expect(h.events).not.toContain('m3:start');
    expect(at('abort')).toBeLessThan(at('m2:stop'));
    expect(at('m2:stop')).toBeLessThan(at('m1:stop'));
    expect(hasMsg(h.lines(), 'daemon ready')).toBe(false);
    expect(ctx?.state()).toBe('stopping');
  });

  it('a start that rejects after the abort is part of the stop', async () => {
    const h = harness({
      modules: [
        { name: 'm1', stopStage: 'final' },
        {
          name: 'm2',
          stopStage: 'final',
          start: (signal) =>
            new Promise<void>((_, reject) => {
              signal.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
            }),
        },
      ],
    });
    const run = h.start();
    await vi.waitFor(() => {
      expect(h.events).toContain('m2:start');
    });
    h.port.signal('SIGTERM');
    await run;
    await exitsWith(h.port, [0]);
    expect(h.events).toContain('m1:stop');
    expect(h.events).not.toContain('m2:stop');
    const aborted = h.lines().find((line) => line.msg === 'start aborted');
    expect(aborted?.level).toBe(30);
    expect(h.lines().filter((line) => line.level >= 50)).toEqual([]);
  });

  it('module context carries the clock and a bound logCall', async () => {
    let t = 1000;
    const clock: Clock = {
      now() {
        t += 250;
        return t;
      },
    };
    let ctx: ModuleContext<FakeStore> | undefined;
    const h = harness({
      clock,
      factory: (ctxFor) => {
        ctx = ctxFor('adapters');
        return [];
      },
    });
    await h.start();
    expect(ctx?.clock).toBe(clock);
    await expect(ctx?.logCall('gh.search', () => Promise.resolve(1))).resolves.toBe(1);
    const call = h.lines().find((line) => line.msg === 'external call');
    expect(call).toMatchObject({
      level: 30,
      module: 'adapters',
      call: 'gh.search',
      duration_ms: 250,
      outcome: 'ok',
    });
  });
});
