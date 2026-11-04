import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return {
    nodePath: options.nodePath ?? process.execPath,
    daemonEntry:
      options.daemonEntry ?? fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url)),
    secretsFile: join(secretsDir, 'secrets.env'),
    unitFile: join(configDir, 'systemd', 'user', serviceName),
  };
}

function unitArgument(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderUserUnit(paths: ServicePaths): string {
  return [
    '[Unit]',
    'Description=spur-board daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${unitArgument(paths.nodePath)} ${unitArgument(paths.daemonEntry)}`,
    `EnvironmentFile=${unitArgument(paths.secretsFile)}`,
    'Restart=on-failure',
    'RestartSec=5s',
    'TimeoutStopSec=15s',
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

async function requireSuccess(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result;
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
      await access(path, constants.R_OK);
    } catch {
      throw new Error(`${label} is missing or unreadable: ${path}`);
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
  const changed = (await existingUnit(paths.unitFile)) !== unit;
  if (changed) {
    await mkdir(dirname(paths.unitFile), { recursive: true });
    await writeFile(paths.unitFile, unit);
    await requireSuccess(runner, 'systemctl', ['--user', 'daemon-reload']);
  }
  await requireSuccess(runner, 'systemctl', ['--user', 'enable', '--now', serviceName]);
  return { unitFile: paths.unitFile, changed };
}

export async function restartService(options: ServiceOptions = {}): Promise<void> {
  await requireSuccess(options.runner ?? runCommand, 'systemctl', [
    '--user',
    'restart',
    serviceName,
  ]);
}

export async function statusService(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const runner = options.runner ?? runCommand;
  const active = await runner('systemctl', ['--user', 'is-active', serviceName]);
  const enabled = await runner('systemctl', ['--user', 'is-enabled', serviceName]);
  const linger = await requireSuccess(runner, 'loginctl', [
    'show-user',
    options.username ?? userInfo().username,
    '--property=Linger',
    '--value',
  ]);
  return {
    active: active.stdout.trim() || 'unknown',
    enabled: enabled.stdout.trim() || 'unknown',
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
