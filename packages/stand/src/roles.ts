import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isScrubbed } from '@spur-board/testkit';
import type { StandManifest } from './manifest.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const ROLES = ['operator', 'worker', 'orchestrator'] as const;
export type StandRole = (typeof ROLES)[number];

/** The source CLI entry point, run with `process.execPath`. */
export const BOARD_CLI = fileURLToPath(new URL('../../cli/src/bin.mjs', import.meta.url));

/** Commands that act on the real machine: the user's service manager, the global install. */
const BLOCKED = new Set(['service', 'update', 'rollback', 'skills']);

/**
 * `base` without session identity, credentials or proxy settings (`isScrubbed`), and with
 * `--use-env-proxy` removed from `NODE_OPTIONS`.
 */
export function standEnv(base: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isScrubbed(name)) env[name] = value;
  }
  const options = (env['NODE_OPTIONS'] ?? '')
    .split(/\s+/)
    .filter((word) => word !== '' && word !== '--use-env-proxy')
    .join(' ');
  if (options === '') Reflect.deleteProperty(env, 'NODE_OPTIONS');
  else env['NODE_OPTIONS'] = options;
  return env;
}

/**
 * The environment of a board CLI call as `role` against the stand. The operator carries the
 * stand's token and no session; a worker or orchestrator carries a session id, which outranks a
 * token in the CLI.
 */
export function roleEnv(
  manifest: StandManifest,
  role: StandRole,
  base: Env,
): Record<string, string> {
  const env = standEnv(base);
  env['BOARD_DAEMON_URL'] = manifest.daemonUrl;
  env['BOARD_HOME'] = manifest.home;
  if (role === 'operator') env['BOARD_TOKEN'] = readFileSync(manifest.tokenPath, 'utf8').trim();
  else env['SPUR_SESSION'] = manifest.roles[role];
  return env;
}

/** Why a board command must not run against the stand, or undefined when it may. */
export function blockedBoardCommand(args: readonly string[]): string | undefined {
  const command = args.find((arg) => !arg.startsWith('-'));
  return command !== undefined && BLOCKED.has(command)
    ? `board ${command} acts on the real machine, not the stand.`
    : undefined;
}
