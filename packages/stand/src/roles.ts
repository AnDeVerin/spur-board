import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StandManifest } from './manifest.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const ROLES = ['operator', 'worker', 'orchestrator'] as const;
export type StandRole = (typeof ROLES)[number];

/** The source CLI entry point, run with `process.execPath`. */
export const BOARD_CLI = fileURLToPath(new URL('../../cli/src/bin.mjs', import.meta.url));

/** Commands that act on the real machine: the user's service manager, the global install. */
const BLOCKED = new Set(['service', 'update', 'rollback', 'skills']);

/**
 * The only PATH a stand process or its children use. Node runs from `process.execPath`; the one
 * helper found by name is `flock` (util-linux), which the daemon lock spawns from /usr/bin.
 */
export const TRUSTED_PATH = '/usr/bin:/bin';

/** Names a stand child inherits; everything else, `NODE_OPTIONS` included, stays behind. */
const INHERITED = new Set([
  'HOME',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'USER',
  'LOGNAME',
  // The live board's directories, so the stand child's own live-home guard sees them.
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

/**
 * The part of `base` a stand child may inherit: an allowlist plus the `LC_*` locale names, and
 * `TRUSTED_PATH` in place of the caller's PATH.
 */
export function standEnv(base: Env): Record<string, string> {
  const env: Record<string, string> = { PATH: TRUSTED_PATH };
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (INHERITED.has(name) || name.startsWith('LC_'))) env[name] = value;
  }
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
  const [command, sub] = args.filter((arg) => !arg.startsWith('-'));
  if (command !== undefined && BLOCKED.has(command))
    return `board ${command} acts on the real machine, not the stand.`;
  // `token create --into <dir>` leaves a token file in that folder, outside the stand, where it
  // outlives the stand and can shadow a real token for that folder.
  if (command === 'token' && sub === 'create')
    return 'board token create writes a token file outside the stand; the stand operator already has a token.';
  return undefined;
}
