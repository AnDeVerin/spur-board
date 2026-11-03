import { homedir } from 'node:os';
import { openStore, type Store } from '@spur-board/core';
import { loadConfig, resolvePaths } from './config.ts';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, runDaemon, type ProcessPort } from './lifecycle.ts';
import { acquireLock } from './lock.ts';

// Below the 2^31-1 ms timer limit; Node turns larger values into 1 ms with a warning.
const KEEPALIVE_MS = 3_600_000;

/** The real process. Handlers are attached when runDaemon registers them, not before. */
function processPort(): ProcessPort {
  return {
    onSignal(handler) {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
          handler(signal);
        });
      }
    },
    onFatal(handler) {
      process.on('uncaughtException', handler);
      process.on('unhandledRejection', handler);
    },
    exit(code) {
      process.exit(code);
    },
    writeErr(text) {
      process.stderr.write(text);
    },
  };
}

/** `board daemon`: runs in the foreground until SIGTERM or SIGINT. */
export async function main(): Promise<void> {
  // No module owns a server yet, so nothing else keeps the event loop alive.
  setInterval(() => undefined, KEEPALIVE_MS);
  await runDaemon<Store>({
    paths: resolvePaths(process.env, homedir()),
    acquireLock,
    loadConfig,
    openStore,
    // Later issues add entries here in start order, each with its stopStage and built from
    // ctxFor('<name>'), e.g. { name: 'core', stopStage: 'final', module: createCore(ctxFor('core')) }.
    modules: () => [],
    port: processPort(),
    stdout: process.stdout,
    clock: { now: () => Date.now() },
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  });
}

if (import.meta.main) void main();
