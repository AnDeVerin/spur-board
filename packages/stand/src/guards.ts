import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_HTTP_PORT } from '@spur-board/contracts';
import { resolvePaths } from '@spur-board/daemon/in-process';

type Env = Readonly<Record<string, string | undefined>>;

export type RefusalReason =
  'live_home' | 'live_port' | 'port_range' | 'external_secrets' | 'env_proxy' | 'unsafe_root';

export interface StandRefusal {
  reason: RefusalReason;
  message: string;
}

/** A stand start refused by a guard. The message never carries a variable's value. */
export class StandRefusedError extends Error {
  override name = 'StandRefusedError';
  readonly reason: RefusalReason;

  constructor(refusal: StandRefusal) {
    super(refusal.message);
    this.reason = refusal.reason;
  }
}

/** Stand ports; 0 lets the kernel pick a free one. */
const STAND_PORT_MIN = 4780;
const STAND_PORT_MAX = 4799;

const SECRET_PREFIXES = ['SLACK_', 'JIRA_'];
const SECRET_NAMES = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Credential suffixes; a Spur variable with one of them holds a secret, not an identifier. */
const SPUR_SECRET_SUFFIXES = ['_TOKEN', '_SECRET', '_PASSWORD', '_KEY'];

function isExternalSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SECRET_NAMES.has(upper) ||
    upper === 'BOARD_TOKEN' ||
    SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    (upper.startsWith('SPUR_') && SPUR_SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix)))
  );
}

/**
 * Names of credentials set to a non-empty value, sorted: external services, the live board's
 * operator token and Spur secrets. A Spur session id such as `SPUR_SESSION` is not a credential.
 */
function externalSecretNames(env: Env): string[] {
  return Object.keys(env)
    .filter((name) => isExternalSecret(name) && (env[name] ?? '') !== '')
    .sort();
}

/** The live board's directories: `BOARD_HOME`, and its config and data directories, real paths. */
export function liveBoardDirs(env: Env, osHome: string): string[] {
  const live = resolvePaths(env, osHome);
  return [
    ...(env['BOARD_HOME'] ? [env['BOARD_HOME']] : []),
    dirname(live.configFile),
    dirname(live.dbFile),
  ].map(realOrResolved);
}

/** Whether two paths are the same or one holds the other. */
export function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/**
 * Why other users could replace `root` or one of its entries, or undefined when they cannot.
 * `root` and every ancestor up to `/` must be owned by root or this user, and either be writable
 * by no group or other user or be sticky (as /tmp is): otherwise someone could rename a directory
 * on the path and put a link in its place.
 */
function unsafeRoot(root: string): string | undefined {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(root);
  } catch {
    return `The stand root ${root} cannot be read.`;
  }
  if (!info.isDirectory()) return `The stand root ${root} is not a directory.`;
  for (let dir = root; ; dir = dirname(dir)) {
    const entry = dir === root ? info : statSync(dir);
    if (entry.uid !== 0 && entry.uid !== process.getuid?.())
      return `${dir} on the stand root path belongs to another user. Set TMPDIR to a directory of yours.`;
    if ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)
      return `Other users can replace entries of ${dir} on the stand root path: it is group- or world-writable without the sticky bit. Set TMPDIR to a private directory.`;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Why a stand must not start: a root inside the live board's home, the live port, a port outside
 * the stand range, or real external credentials in the environment.
 */
export function refusal(input: {
  root: string;
  port: number;
  env: Env;
  osHome: string;
}): StandRefusal | undefined {
  const root = realOrResolved(input.root);
  const hit = liveBoardDirs(input.env, input.osHome).find((dir) => within(dir, root));
  if (hit !== undefined)
    return {
      reason: 'live_home',
      message: `The stand root ${root} is inside the live board directory ${hit}.`,
    };
  const unsafe = unsafeRoot(root);
  if (unsafe !== undefined) return { reason: 'unsafe_root', message: unsafe };
  if (input.port === DEFAULT_HTTP_PORT)
    return {
      reason: 'live_port',
      message: `Port ${String(DEFAULT_HTTP_PORT)} belongs to the live board. Use 0 or a port from ${String(STAND_PORT_MIN)} to ${String(STAND_PORT_MAX)}.`,
    };
  if (input.port !== 0 && (input.port < STAND_PORT_MIN || input.port > STAND_PORT_MAX))
    return {
      reason: 'port_range',
      message: `Port ${String(input.port)} is outside the stand range. Use 0 or a port from ${String(STAND_PORT_MIN)} to ${String(STAND_PORT_MAX)}.`,
    };
  const names = externalSecretNames(input.env);
  if (names.length > 0)
    return {
      reason: 'external_secrets',
      message: `The environment holds external credentials: ${names.join(', ')}. Run the stand without them: env ${names.map((name) => `-u ${name}`).join(' ')} pnpm stand up`,
    };
  return undefined;
}

/**
 * Node reads the env proxy once at startup, so a running process cannot turn it off; the stand
 * refuses to run with it on.
 */
export function proxyRefusal(input: {
  env: Env;
  execArgv: readonly string[];
}): StandRefusal | undefined {
  // Node unquotes NODE_OPTIONS words and reads `_` in a flag name as `-`, so the flag counts
  // wherever it appears once quotes are gone and underscores are dashes.
  const mentions = (text: string): boolean =>
    text
      .replace(/["'\\]/g, '')
      .replace(/_/g, '-')
      .includes('--use-env-proxy');
  if (
    (input.env['NODE_USE_ENV_PROXY'] ?? '') !== '' ||
    input.execArgv.some(mentions) ||
    mentions(input.env['NODE_OPTIONS'] ?? '')
  )
    return {
      reason: 'env_proxy',
      message:
        'The Node env proxy is on (NODE_USE_ENV_PROXY or --use-env-proxy); it would route requests around the network guard. Start the stand without it.',
    };
  return undefined;
}
