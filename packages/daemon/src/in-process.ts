import type { Config } from '@spur-board/contracts';
import { openStore, type Store } from '@spur-board/core';
import type { DestinationStream } from 'pino';
import { createDaemonModules, type DaemonModulePorts } from './composition.ts';
import type { Paths } from './config.ts';
import { runDaemon, type ProcessPort } from './lifecycle.ts';
import type { Clock } from './logger.ts';

export { loadConfig, resolvePaths, type Paths } from './config.ts';
export { acquireLock } from './lock.ts';

export interface InProcessOptions {
  paths: Paths;
  loadConfig(paths: Paths): { config: Config; secrets: Readonly<Record<string, string>> };
  acquireLock(file: string): { release(): void };
  clock: Clock;
  stdout: DestinationStream;
  /** Lock and config failures before the logger exists. */
  writeErr(text: string): void;
  ports?: DaemonModulePorts;
  /** Binds the fatal handler; the default binds none. */
  registerFatal?: (handler: (err: unknown) => void) => void;
  shutdownTimeoutMs?: number;
}

export interface InProcessDaemon {
  /** The bound HTTP address; kept after stop. */
  readonly address: string;
  /** The daemon's store; closed once the daemon exits. */
  readonly store: Store;
  readonly inbound: ReturnType<typeof createDaemonModules>['inbound'];
  readonly outbox: ReturnType<typeof createDaemonModules>['outbox'];
  /** Runs the board-core tick once more behind its active run. */
  tick(): Promise<void>;
  /**
   * Stops the daemon once and resolves its exit code. A daemon that already began or finished
   * shutdown gets no second signal; every call resolves the same code and none rejects.
   */
  stop(): Promise<number>;
  /** Resolves with the exit code whenever the daemon exits, on its own or through `stop`. */
  readonly exited: Promise<number>;
  /**
   * Resolves once the daemon holds nothing: after a `stop`, when module teardown, store close
   * and lock release have finished, even if the shutdown timeout made `stop` resolve earlier.
   * An exit nobody asked for (a fatal error, a failed start) leaves no shutdown running, so it
   * resolves at that exit.
   */
  readonly teardown: Promise<void>;
}

/**
 * The daemon's production module graph in this process, with the process bound to fakes: no
 * signal handlers, no `process.exit`. Shared by the in-process e2e harness and the stand.
 */
export async function startInProcessDaemon(options: InProcessOptions): Promise<InProcessDaemon> {
  let address: string | undefined;
  let store: Store | undefined;
  let composed: ReturnType<typeof createDaemonModules> | undefined;
  let signal: ((name: string) => void) | undefined;
  let exitCode: number | undefined;
  let stopping: Promise<number> | undefined;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let lockHeld = false;
  let stopRequested = false;
  let resolveTeardown: () => void = () => undefined;
  const teardown = new Promise<void>((resolve) => {
    resolveTeardown = resolve;
  });
  const port: ProcessPort = {
    onSignal(handler) {
      signal = handler;
    },
    onFatal(handler) {
      options.registerFatal?.(handler);
    },
    exit(code) {
      exitCode ??= code;
      resolveExit(code);
      if (!lockHeld || !stopRequested) resolveTeardown();
    },
    writeErr: (text) => {
      options.writeErr(text);
    },
  };
  const stop = (): Promise<number> => {
    if (stopping !== undefined) return stopping;
    if (exitCode === undefined && signal !== undefined) {
      stopRequested = true;
      signal('SIGTERM');
    }
    stopping = exited;
    return stopping;
  };
  const onListening = options.ports?.onListening;
  await runDaemon<Store>({
    paths: options.paths,
    acquireLock: (file) => {
      const lock = options.acquireLock(file);
      lockHeld = true;
      return {
        // The shutdown releases the lock last, after module teardown and store close.
        release() {
          try {
            lock.release();
          } finally {
            lockHeld = false;
            resolveTeardown();
          }
        },
      };
    },
    loadConfig: (paths) => options.loadConfig(paths),
    openStore: (file) => {
      store = openStore(file);
      return store;
    },
    modules: (ctxFor) => {
      composed = createDaemonModules(ctxFor, {
        ...options.ports,
        onListening: (bound) => {
          address = bound;
          onListening?.(bound);
        },
      });
      return composed.entries;
    },
    port,
    stdout: options.stdout,
    clock: options.clock,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
  });
  if (exitCode !== undefined)
    throw new Error(`Daemon exited during start with code ${String(exitCode)}`);
  if (address === undefined || store === undefined || composed === undefined) {
    await stop();
    throw new Error('Daemon did not bind HTTP');
  }
  const bound = address;
  const db = store;
  const modules = composed;
  return {
    address: bound,
    store: db,
    inbound: modules.inbound,
    outbox: modules.outbox,
    tick: modules.tick,
    stop,
    exited,
    teardown,
  };
}
