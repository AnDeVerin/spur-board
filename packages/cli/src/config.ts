import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import YAML from 'yaml';
import { CliError } from './exit-codes.ts';

export interface ClientConfig {
  address: URL;
  session: string | undefined;
  token: string | undefined;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

const CONNECT_TIMEOUT_MS = 2_000;
const RESPONSE_TIMEOUT_MS = 30_000;

/** A relative `BOARD_HOME` counts from `cwd`; relative XDG directories are ignored. */
export function configFile(env: NodeJS.ProcessEnv, home: string, cwd = process.cwd()): string {
  const boardHome = env['BOARD_HOME'];
  if (boardHome) return join(resolve(cwd, boardHome), 'config.yaml');
  const xdg = env['XDG_CONFIG_HOME'];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'spur-board', 'config.yaml');
}

/**
 * The directory of the daemon database and its lock. It mirrors `resolvePaths` in
 * packages/daemon/src/config.ts, which resolves a relative `BOARD_HOME` from the daemon's
 * working directory, here `cwd`; the CLI cannot import the daemon package.
 */
export function dataDirectory(env: NodeJS.ProcessEnv, home: string, cwd = process.cwd()): string {
  const boardHome = env['BOARD_HOME'];
  if (boardHome) return resolve(cwd, boardHome);
  const xdg = env['XDG_DATA_HOME'];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'spur-board');
}

/** The http.port in config.yaml, or undefined when the file is missing or invalid. */
export function readConfiguredPort(env: NodeJS.ProcessEnv, home: string): number | undefined {
  try {
    const parsed = YAML.parseDocument(readFileSync(configFile(env, home), 'utf8'));
    if (parsed.errors.length === 0) {
      const config = configSchema.safeParse(parsed.toJS());
      if (config.success) return config.data.http.port;
    }
  } catch {
    // A missing or unreadable file has no port; the caller decides what that means.
  }
  return undefined;
}

export function resolveDaemonAddress(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  configuredPort?: number,
): URL {
  const rawAddress = env['BOARD_DAEMON_URL'];
  if (rawAddress === undefined) {
    const port = configuredPort ?? readConfiguredPort(env, home);
    if (port === undefined) {
      // Guessing the default port could reach another board, so nothing is sent.
      throw new CliError(
        'config',
        { environmentVariable: 'BOARD_DAEMON_URL', configPath: configFile(env, home) },
        undefined,
        'Set BOARD_DAEMON_URL to the daemon address, or make config.yaml valid and set http.port in it; `board doctor --offline` names what is wrong.',
      );
    }
    if (port === 0) {
      throw new CliError(
        'config',
        undefined,
        undefined,
        'http.port: 0 assigns a runtime port that clients cannot discover. Set BOARD_DAEMON_URL to the daemon listening address.',
      );
    }
    return new URL(`http://127.0.0.1:${String(port)}`);
  }

  let address: URL;
  try {
    address = new URL(rawAddress);
  } catch {
    throw new CliError('config', { environmentVariable: 'BOARD_DAEMON_URL' });
  }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new CliError('config', { environmentVariable: 'BOARD_DAEMON_URL' });
  }

  return address;
}

function tokenInFolder(folder: string, warn: (message: string) => void): string | undefined {
  const directory = join(folder, '.spur-board');
  const file = join(directory, 'token');
  try {
    const owner = process.getuid?.();
    const directoryInfo = lstatSync(directory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.uid !== owner ||
      (directoryInfo.mode & 0o077) !== 0
    ) {
      throw new Error('unsafe token directory');
    }
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: string;
    try {
      const fileInfo = fstatSync(descriptor);
      if (!fileInfo.isFile() || fileInfo.uid !== owner || (fileInfo.mode & 0o077) !== 0) {
        throw new Error('unsafe token file');
      }
      value = readFileSync(descriptor, 'utf8').trimEnd();
    } finally {
      closeSync(descriptor);
    }
    if (value === '') throw new Error('empty token file');
    return value;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    warn('Ignoring an unsafe .spur-board/token candidate.\n');
    return undefined;
  }
}

/** A `.git` file or directory marks the worktree root; an unreadable entry counts as one. */
function isWorktreeRoot(folder: string): boolean {
  try {
    lstatSync(join(folder, '.git'));
    return true;
  } catch (error) {
    return !(
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }
}

export function findTokenFile(
  cwd: string,
  home: string,
  warn: (message: string) => void = (message) => {
    process.stderr.write(message);
  },
): string | undefined {
  const current = realpathSync(cwd);
  const boundary = realpathSync(home);
  if (current === boundary) return undefined;
  const toCurrent = relative(boundary, current);
  const outsideHome =
    toCurrent === '..' || toCurrent.startsWith(`..${sep}`) || isAbsolute(toCurrent);
  let folder = current;
  while (folder !== boundary) {
    if (outsideHome) {
      const info = statSync(folder);
      if (info.uid !== process.getuid?.() || (info.mode & 0o002) !== 0) break;
    }
    const token = tokenInFolder(folder, warn);
    if (token !== undefined) return token;
    if (isWorktreeRoot(folder)) break;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return undefined;
}

export function loadClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  paths: { cwd: string; home: string } = { cwd: process.cwd(), home: homedir() },
): ClientConfig {
  const address = resolveDaemonAddress(env, paths.home);
  const session = env['SPUR_SESSION'] || undefined;
  const token = session
    ? undefined
    : env['BOARD_TOKEN'] === undefined
      ? findTokenFile(paths.cwd, paths.home)
      : env['BOARD_TOKEN'];
  if (!session && !token) {
    // An explicit empty BOARD_TOKEN is a configuration mistake; no identity at all is not.
    if (env['BOARD_TOKEN'] === '') {
      throw new CliError('config', { environmentVariable: 'BOARD_TOKEN' });
    }
    throw new CliError('identity_missing');
  }

  return {
    address,
    session,
    token,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  };
}

/** Enrollment sends only a hash and works before any operator credential exists. */
export function loadEnrollmentConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  return {
    address: resolveDaemonAddress(env),
    session: undefined,
    token: undefined,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  };
}
