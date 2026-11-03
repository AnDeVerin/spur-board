import type { Config } from '@spur-board/contracts';
import type { DestinationStream, Logger } from 'pino';
import type { Paths } from './config.ts';
import { createLogger, logCall, type Clock } from './logger.ts';

/**
 * Shutdown order after the shared signal aborts ("stop accepting"): pollers, then the outbox,
 * then everything else (HTTP close, gateways, core). Modules within a stage stop in parallel.
 */
const STOP_STAGES = ['pollers', 'outbox', 'final'] as const;

export type DaemonState = 'starting' | 'ready' | 'stopping';

export interface Module {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface ModuleEntry {
  readonly name: string;
  readonly stopStage: (typeof STOP_STAGES)[number];
  readonly module: Module;
}

export interface ModuleContext<S> {
  readonly config: Config;
  readonly secrets: Readonly<Record<string, string>>;
  readonly store: S;
  /** A child logger carrying `module: <name>`. */
  readonly log: Logger;
  readonly clock: Clock;
  /** Runs an external call and logs its duration and outcome on this module's logger. */
  logCall<T>(call: string, fn: () => Promise<T>): Promise<T>;
  state(): DaemonState;
}

/** The process as runDaemon sees it; main.ts binds the real one. */
export interface ProcessPort {
  onSignal(handler: (signal: string) => void): void;
  onFatal(handler: (err: unknown) => void): void;
  exit(code: number): void;
  writeErr(text: string): void;
}

interface DaemonDeps<S> {
  paths: Paths;
  acquireLock(file: string): { release(): void };
  loadConfig(paths: Paths): { config: Config; secrets: Readonly<Record<string, string>> };
  openStore(file: string): S;
  /** Builds the modules in start order; `ctxFor(name)` gives each its context. */
  modules(ctxFor: (name: string) => ModuleContext<S>): readonly ModuleEntry[];
  port: ProcessPort;
  stdout: DestinationStream;
  clock: Clock;
  shutdownTimeoutMs: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the daemon: lock, config, logger, store, modules in order, then `daemon ready`. A signal
 * runs one ordered shutdown. Every exit goes through `port.exit`, exactly once.
 * Resolves when start is over; the process then lives until the port exits it.
 */
export async function runDaemon<S extends { close(): Promise<void> }>(
  deps: DaemonDeps<S>,
): Promise<void> {
  const { port, clock } = deps;
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    if (timer !== undefined) clearTimeout(timer);
    port.exit(code);
  };

  // Steps 1-2: no logger yet, so failures go to stderr.
  let lock: { release(): void };
  try {
    lock = deps.acquireLock(deps.paths.lockFile);
  } catch (err) {
    port.writeErr(`board daemon: ${messageOf(err)}\n`);
    finish(1);
    return;
  }
  let loaded: ReturnType<DaemonDeps<S>['loadConfig']>;
  try {
    loaded = deps.loadConfig(deps.paths);
  } catch (err) {
    port.writeErr(`board daemon: ${messageOf(err)}\n`);
    lock.release();
    finish(1);
    return;
  }
  const { config, secrets } = loaded;

  // Step 3.
  const log = createLogger(deps.stdout, secrets);
  let state: DaemonState = 'starting';
  const controller = new AbortController();

  // Step 4. No handler is registered yet, so this cleanup is the only teardown that can run.
  let store: S | undefined;
  let opened: { store: S; entries: readonly ModuleEntry[] };
  try {
    const db = deps.openStore(deps.paths.dbFile);
    store = db;
    const ctxFor = (name: string): ModuleContext<S> => {
      const child = log.child({ module: name });
      return {
        config,
        secrets,
        store: db,
        log: child,
        clock,
        logCall: (call, fn) => logCall(child, clock, call, fn),
        state: () => state,
      };
    };
    opened = { store: db, entries: deps.modules(ctxFor) };
  } catch (err) {
    log.error({ err }, 'start failed');
    if (store !== undefined) {
      try {
        await store.close();
      } catch (closeErr) {
        log.error({ err: closeErr }, 'store close failed');
      }
    }
    lock.release();
    finish(1);
    return;
  }
  const { entries } = opened;
  const db = opened.store;

  // Modules whose start resolved, in start order. A module whose start threw or rejected gets
  // no stop(): its start owns its own cleanup.
  const started: ModuleEntry[] = [];
  let inFlight: Promise<unknown> = Promise.resolve();
  let shutdown: Promise<void> | undefined;

  async function runShutdown(failed: boolean): Promise<void> {
    state = 'stopping';
    const pending = new Set<string>();
    timer = setTimeout(() => {
      log.error({ pending: [...pending] }, 'shutdown timed out');
      finish(1);
    }, deps.shutdownTimeoutMs);
    controller.abort();
    await inFlight;
    for (const entry of started) pending.add(entry.name);
    let code = failed ? 1 : 0;
    for (const stage of STOP_STAGES) {
      const batch = started.filter((entry) => entry.stopStage === stage);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          try {
            await entry.module.stop();
          } finally {
            pending.delete(entry.name);
          }
        }),
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          log.error({ err: result.reason, module: batch[i]?.name }, 'stop failed');
          code = 1;
        }
      });
    }
    try {
      await db.close();
    } catch (err) {
      log.error({ err }, 'store close failed');
      code = 1;
    } finally {
      lock.release();
      finish(code);
    }
  }

  const stop = (failed: boolean): Promise<void> => {
    shutdown ??= runShutdown(failed);
    return shutdown;
  };

  // Step 5: from here on a signal or a fatal error reaches the daemon.
  port.onSignal((signal) => {
    log.info({ signal }, 'shutting down');
    void stop(false);
  });
  port.onFatal((err) => {
    log.fatal({ err }, 'fatal');
    finish(1);
  });

  // Step 6. A signal can arrive during any await, so `aborted()` is read fresh each time.
  const { signal } = controller;
  const aborted = (): boolean => signal.aborted;
  for (const entry of entries) {
    if (aborted()) return;
    const attempt = (async (): Promise<{ err: unknown } | undefined> => {
      try {
        await entry.module.start(signal);
        started.push(entry);
        return undefined;
      } catch (err) {
        return { err };
      }
    })();
    inFlight = attempt;
    const failure = await attempt;
    if (failure === undefined) continue;
    if (aborted()) {
      // Shutdown began while this start ran; its rejection is part of the stop.
      log.info({ err: failure.err, module: entry.name }, 'start aborted');
      return;
    }
    log.error({ err: failure.err, module: entry.name }, 'start failed');
    void stop(true);
    return;
  }
  if (aborted()) return;
  state = 'ready';
  log.info('daemon ready');
}
