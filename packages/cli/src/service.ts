import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEMD_SERVICE_SETTINGS } from '@spur-board/contracts';
import { CliError } from './exit-codes.ts';

export const serviceName = 'spur-board.service';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface ServiceOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  daemonEntry?: string;
  username?: string;
  runner?: CommandRunner;
}

export interface ServicePaths {
  nodePath: string;
  daemonEntry: string;
  secretsFile: string;
  unitFile: string;
  environment?: readonly string[];
}

export interface ServiceStatus {
  active: string;
  enabled: string;
  lingering: boolean;
}

function configHome(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env['XDG_CONFIG_HOME'];
  return configured && isAbsolute(configured) ? configured : join(home, '.config');
}

export function servicePaths(options: ServiceOptions = {}): ServicePaths {
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const configDir = configHome(env, home);
  const boardHome = env['BOARD_HOME'];
  const secretsDir = boardHome ? resolve(boardHome) : join(configDir, 'spur-board');
  const environment = boardHome
    ? [`BOARD_HOME=${secretsDir}`]
    : [
        ...(env['XDG_CONFIG_HOME'] && isAbsolute(env['XDG_CONFIG_HOME'])
          ? [`XDG_CONFIG_HOME=${configDir}`]
          : []),
        ...(env['XDG_DATA_HOME'] && isAbsolute(env['XDG_DATA_HOME'])
          ? [`XDG_DATA_HOME=${env['XDG_DATA_HOME']}`]
          : []),
      ];
  const packedDaemon = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
  return {
    nodePath: options.nodePath ?? process.execPath,
    daemonEntry:
      options.daemonEntry ??
      (existsSync(packedDaemon)
        ? packedDaemon
        : fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url))),
    secretsFile: join(secretsDir, 'secrets.env'),
    unitFile: join(configDir, 'systemd', 'user', serviceName),
    environment,
  };
}

function unitArgument(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderUserUnit(paths: ServicePaths): string {
  return [
    '[Unit]',
    'Description=spur-board daemon',
    '',
    '[Service]',
    `ExecStart=${unitArgument(paths.nodePath)} ${unitArgument(paths.daemonEntry)}`,
    ...(paths.environment ?? []).map((entry) => `Environment=${unitArgument(entry)}`),
    `EnvironmentFile=${unitArgument(paths.secretsFile)}`,
    ...SYSTEMD_SERVICE_SETTINGS,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function failureDetail(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
}

async function requireSuccess(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${failureDetail(result)}`);
  }
  return result;
}

async function unitState(runner: CommandRunner): Promise<{ active: string; enabled: string }> {
  const active = await runner('systemctl', ['--user', 'is-active', serviceName]);
  const enabled = await runner('systemctl', ['--user', 'is-enabled', serviceName]);
  return {
    active: active.stdout.trim() || 'unknown',
    enabled: enabled.stdout.trim() || 'unknown',
  };
}

/** Runs a systemctl command that starts the service; a failure leaves the unit in place. */
async function requireStart(
  runner: CommandRunner,
  args: readonly string[],
  unit: { file: string; written?: boolean },
): Promise<void> {
  const result = await runner('systemctl', args);
  if (result.exitCode === 0) return;
  const detail = failureDetail(result)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\.$/, '');
  const state = await unitState(runner);
  const origin =
    unit.written === undefined
      ? ''
      : unit.written
        ? ' (written by this run)'
        : ' (already in place)';
  const hint = [
    `Unit file ${unit.file}${origin} is ${state.enabled}; the service is ${state.active}.`,
    `systemctl ${args.join(' ')} failed: ${detail}.`,
    'Read why with `journalctl --user -u spur-board.service -n 100` and run `board doctor`.',
  ].join(' ');
  throw new CliError('service_start_failed', undefined, undefined, hint);
}

async function preflight(paths: ServicePaths): Promise<void> {
  for (const [label, path] of [
    ['Node executable', paths.nodePath],
    ['daemon entry', paths.daemonEntry],
  ] as const) {
    if (!isAbsolute(path)) throw new Error(`${label} path must be absolute: ${path}`);
    try {
      const file = await stat(path);
      if (!file.isFile() || (file.mode & 0o444) === 0) throw new Error('not a readable file');
      if (label === 'Node executable' && (file.mode & 0o111) === 0) {
        throw new Error('not executable');
      }
      await access(
        path,
        label === 'Node executable' ? constants.R_OK | constants.X_OK : constants.R_OK,
      );
    } catch {
      const condition =
        label === 'Node executable'
          ? 'missing, unreadable, or not executable'
          : 'missing or unreadable';
      throw new Error(`${label} is ${condition}: ${path}`);
    }
  }
  try {
    const secrets = await stat(paths.secretsFile);
    if (!secrets.isFile() || (secrets.mode & 0o777) !== 0o600) {
      throw new Error('invalid mode');
    }
    await access(paths.secretsFile, constants.R_OK);
  } catch {
    throw new Error(`Secrets file must exist as a readable mode 0600 file: ${paths.secretsFile}`);
  }
}

async function existingUnit(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function installService(options: ServiceOptions = {}): Promise<{
  unitFile: string;
  changed: boolean;
}> {
  const paths = servicePaths(options);
  await preflight(paths);
  const runner = options.runner ?? runCommand;
  const unit = renderUserUnit(paths);
  const previousUnit = await existingUnit(paths.unitFile);
  const changed = previousUnit !== unit;
  let wasActive = false;
  if (changed) {
    await mkdir(dirname(paths.unitFile), { recursive: true });
    await writeFile(paths.unitFile, unit);
    await requireSuccess(runner, 'systemctl', ['--user', 'daemon-reload']);
    if (previousUnit !== undefined) {
      const state = await runner('systemctl', ['--user', 'is-active', serviceName]);
      wasActive = state.exitCode === 0 && state.stdout.trim() === 'active';
    }
  }
  const unitInfo = { file: paths.unitFile, written: changed };
  await requireStart(runner, ['--user', 'enable', '--now', serviceName], unitInfo);
  if (wasActive) await requireStart(runner, ['--user', 'restart', serviceName], unitInfo);
  return { unitFile: paths.unitFile, changed };
}

export async function restartService(options: ServiceOptions = {}): Promise<void> {
  await requireStart(options.runner ?? runCommand, ['--user', 'restart', serviceName], {
    file: servicePaths(options).unitFile,
  });
}

export async function statusService(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const runner = options.runner ?? runCommand;
  const { active, enabled } = await unitState(runner);
  const linger = await requireSuccess(runner, 'loginctl', [
    'show-user',
    options.username ?? userInfo().username,
    '--property=Linger',
    '--value',
  ]);
  return {
    active,
    enabled,
    lingering: linger.stdout.trim() === 'yes',
  };
}

export async function uninstallService(options: ServiceOptions = {}): Promise<{
  changed: boolean;
}> {
  const unitFile = servicePaths(options).unitFile;
  if ((await existingUnit(unitFile)) === undefined) return { changed: false };
  const runner = options.runner ?? runCommand;
  await requireSuccess(runner, 'systemctl', ['--user', 'disable', '--now', serviceName]);
  await rm(unitFile);
  await requireSuccess(runner, 'systemctl', ['--user', 'daemon-reload']);
  return { changed: true };
}
