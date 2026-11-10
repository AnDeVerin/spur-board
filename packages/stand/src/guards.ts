import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_HTTP_PORT } from '@spur-board/contracts';
import { resolvePaths } from '@spur-board/daemon/in-process';

type Env = Readonly<Record<string, string | undefined>>;

export type RefusalReason =
  'live_home' | 'live_port' | 'port_range' | 'external_secrets' | 'env_proxy';

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

/** Names of external-service credentials set to a non-empty value, sorted. */
function externalSecretNames(env: Env): string[] {
  return Object.keys(env)
    .filter((name) => {
      const upper = name.toUpperCase();
      return (
        (SECRET_NAMES.has(upper) || SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix))) &&
        (env[name] ?? '') !== ''
      );
    })
    .sort();
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
  const live = resolvePaths(input.env, input.osHome);
  const liveDirs = [
    ...(input.env['BOARD_HOME'] ? [input.env['BOARD_HOME']] : []),
    dirname(live.configFile),
    dirname(live.dbFile),
  ].map(realOrResolved);
  const hit = liveDirs.find((dir) => within(dir, root));
  if (hit !== undefined)
    return {
      reason: 'live_home',
      message: `The stand root ${root} is inside the live board directory ${hit}.`,
    };
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
  const options = (input.env['NODE_OPTIONS'] ?? '').split(/\s+/);
  if (
    (input.env['NODE_USE_ENV_PROXY'] ?? '') !== '' ||
    input.execArgv.includes('--use-env-proxy') ||
    options.includes('--use-env-proxy')
  )
    return {
      reason: 'env_proxy',
      message:
        'The Node env proxy is on (NODE_USE_ENV_PROXY or --use-env-proxy); it would route requests around the network guard. Start the stand without it.',
    };
  return undefined;
}
