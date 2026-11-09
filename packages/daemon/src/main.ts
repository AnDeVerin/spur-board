import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { copyDatabase, openStore, type Store } from '@spur-board/core';
import { loadConfig, resolvePaths } from './config.ts';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, runDaemon, type ProcessPort } from './lifecycle.ts';
import { acquireLock, LockHeldError } from './lock.ts';
import { createDaemonModules } from './composition.ts';
import { slackSettings } from './outbox-module.ts';

// Below the 2^31-1 ms timer limit; Node turns larger values into 1 ms with a warning.
const KEEPALIVE_MS = 3_600_000;

/** Resolve the publishable package, both from source and from the packed daemon. */
export function publishedVersion(): string {
  const packed = new URL('../package.json', import.meta.url);
  const source = new URL('../../cli/package.json', import.meta.url);
  const packedManifest: unknown = existsSync(packed)
    ? JSON.parse(readFileSync(packed, 'utf8'))
    : null;
  const manifest: unknown =
    packedManifest !== null &&
    typeof packedManifest === 'object' &&
    'name' in packedManifest &&
    packedManifest.name === 'spur-board'
      ? packedManifest
      : JSON.parse(readFileSync(source, 'utf8'));
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  )
    throw new Error('Invalid spur-board package version.');
  return manifest.version;
}

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
  const productVersion = publishedVersion();
  await runDaemon<Store>({
    paths: resolvePaths(process.env, homedir()),
    acquireLock,
    loadConfig: (paths) => {
      const loaded = loadConfig(paths);
      slackSettings(loaded.config, loaded.secrets);
      return loaded;
    },
    openStore,
    modules: (ctxFor) =>
      createDaemonModules(ctxFor, {
        productVersion,
        systemd: { env: process.env, pid: process.pid },
      }).entries,
    port: processPort(),
    stdout: process.stdout,
    clock: { now: () => Date.now() },
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/**
 * `copy-database <source> <target>` in the packed binary: copies the board database to or from
 * a backup with `copyDatabase` while holding the board lock. One of the two absolute paths must
 * be this environment's database file. Exits 0 on success, 2 on bad arguments, 75 while another
 * process holds the lock, and 1 on any other error.
 */
export function copyDatabaseMain(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
  writeErr: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): number {
  const paths = resolvePaths(env, home);
  // A relative HOME leaves the database path relative; compare it as the absolute path it names.
  const dbFile = resolve(paths.dbFile);
  const [source, target] = args;
  if (
    args.length !== 2 ||
    source === undefined ||
    target === undefined ||
    !isAbsolute(source) ||
    !isAbsolute(target) ||
    (resolve(source) !== dbFile && resolve(target) !== dbFile)
  ) {
    writeErr(`copy-database: give two absolute paths, one of them the board database ${dbFile}\n`);
    return 2;
  }
  let lock: { release(): void };
  try {
    lock = acquireLock(paths.lockFile);
  } catch (error) {
    writeErr(`copy-database: ${errorText(error)}\n`);
    return error instanceof LockHeldError ? 75 : 1;
  }
  try {
    copyDatabase(source, target);
    return 0;
  } catch (error) {
    writeErr(`copy-database: ${errorText(error)}\n`);
    return 1;
  } finally {
    lock.release();
  }
}

if (import.meta.main) void main();
