import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
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

function daemonAddress(env: NodeJS.ProcessEnv): URL {
  const rawAddress = env['BOARD_DAEMON_URL'];
  if (!rawAddress) {
    throw new CliError('config', { environmentVariable: 'BOARD_DAEMON_URL' });
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

function tokenInFolder(folder: string): string | undefined {
  try {
    const value = readFileSync(join(folder, '.spur-board', 'token'), 'utf8').trimEnd();
    if (value === '') throw new CliError('config', { environmentVariable: 'BOARD_TOKEN' });
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new CliError('config', { environmentVariable: 'BOARD_TOKEN' });
  }
}

export function findTokenFile(cwd: string, home: string): string | undefined {
  const current = realpathSync(cwd);
  const boundary = realpathSync(home);
  if (current === boundary) return undefined;
  const toCurrent = relative(boundary, current);
  if (toCurrent === '..' || toCurrent.startsWith(`..${sep}`) || isAbsolute(toCurrent)) {
    return tokenInFolder(current);
  }
  let folder = current;
  while (folder !== boundary) {
    const token = tokenInFolder(folder);
    if (token !== undefined) return token;
    folder = dirname(folder);
  }
  return undefined;
}

export function loadClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  paths: { cwd: string; home: string } = { cwd: process.cwd(), home: homedir() },
): ClientConfig {
  const address = daemonAddress(env);
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
    address: daemonAddress(env),
    session: undefined,
    token: undefined,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  };
}
