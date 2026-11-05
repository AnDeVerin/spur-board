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
import { DEFAULT_HTTP_PORT, configSchema } from '@spur-board/contracts';
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

export function resolveDaemonAddress(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  configuredPort?: number,
): URL {
  const rawAddress = env['BOARD_DAEMON_URL'];
  if (!rawAddress) {
    let port = configuredPort ?? DEFAULT_HTTP_PORT;
    if (configuredPort === undefined) {
      const boardHome = env['BOARD_HOME'];
      const xdg = env['XDG_CONFIG_HOME'];
      const file = boardHome
        ? join(resolve(boardHome), 'config.yaml')
        : join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'spur-board', 'config.yaml');
      try {
        const parsed = YAML.parseDocument(readFileSync(file, 'utf8'));
        if (parsed.errors.length === 0) {
          const config = configSchema.safeParse(parsed.toJS());
          if (config.success) port = config.data.http.port;
        }
      } catch {
        // The daemon can report the config error; clients still try its default port.
      }
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
    throw new CliError('config', { environmentVariable: 'BOARD_TOKEN' });
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
