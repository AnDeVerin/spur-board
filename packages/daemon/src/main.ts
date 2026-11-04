import { homedir } from 'node:os';
import { commandRetention, openStore, type Store } from '@spur-board/core';
import { createSlackGateway } from '@spur-board/gateway-slack';
import { loadConfig, resolvePaths } from './config.ts';
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  runDaemon,
  type ModuleEntry,
  type ProcessPort,
} from './lifecycle.ts';
import { acquireLock } from './lock.ts';
import { createHttpModule } from './http-module.ts';
import { createOutboxModule, slackSettings } from './outbox-module.ts';

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
  // Keep the process alive when no gateway is configured.
  setInterval(() => undefined, KEEPALIVE_MS);
  await runDaemon<Store>({
    paths: resolvePaths(process.env, homedir()),
    acquireLock,
    loadConfig: (paths) => {
      const loaded = loadConfig(paths);
      slackSettings(loaded.config, loaded.secrets);
      return loaded;
    },
    openStore,
    modules: (ctxFor) => {
      const commands = ctxFor('commands');
      const entries: ModuleEntry[] = [
        {
          name: 'commands',
          stopStage: 'final',
          module: commandRetention({
            store: commands.store,
            clock: commands.clock,
            retentionDays: commands.config.commands.retentionDays,
            onError: (err) => {
              commands.log.error({ err }, 'command purge failed');
            },
          }),
        },
      ];
      const ctx = ctxFor('gateway-slack');
      const settings = slackSettings(ctx.config, ctx.secrets);
      if (settings !== null) {
        const gateway = createSlackGateway(settings);
        entries.push(
          {
            name: 'gateway-slack',
            stopStage: 'final',
            module: {
              start: () => gateway.start(() => Promise.resolve()),
              stop: () => gateway.stop(),
            },
          },
          {
            name: 'outbox',
            stopStage: 'outbox',
            module: createOutboxModule(ctxFor('outbox'), gateway),
          },
        );
      }
      entries.push({
        name: 'http',
        stopStage: 'final',
        module: createHttpModule(ctxFor('http')),
      });
      return entries;
    },
    port: processPort(),
    stdout: process.stdout,
    clock: { now: () => Date.now() },
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  });
}

if (import.meta.main) void main();
