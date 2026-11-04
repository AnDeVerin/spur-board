import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { configSchema, type Config } from '@spur-board/contracts';
import YAML from 'yaml';

export interface DoctorCheck {
  id: string;
  status: 'pass' | 'fail' | 'warning';
  blocking: boolean;
  fix: string | null;
}

interface SessionProcess {
  id: string;
  project?: string;
  path: string;
  codexHome?: string;
  startAt?: number;
}

export interface DoctorPorts {
  readText(path: string): string;
  secretFile(path: string): { path: string; isFile: boolean; mode: number };
  exists(path: string): boolean;
  run(
    command: string,
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
  ): {
    exitCode: number;
    stdout: string;
  };
  sessions(): SessionProcess[];
  fetcher: typeof fetch;
  productVersion(): string;
}

function systemRun(command: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
    ...(env === undefined ? {} : { env }),
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout };
}

function environmentOf(pid: string): Record<string, string> | null {
  try {
    const content = readFileSync(`/proc/${pid}/environ`, 'utf8');
    return Object.fromEntries(
      content
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const split = entry.indexOf('=');
          return [entry.slice(0, split), entry.slice(split + 1)];
        }),
    );
  } catch {
    return null;
  }
}

function liveSessions(): SessionProcess[] {
  const sessions: SessionProcess[] = [];
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return sessions;
  }
  for (const pid of pids) {
    const env = environmentOf(pid);
    if (!env?.['SPUR_SESSION'] || !env['PATH']) continue;
    const started = systemRun('ps', ['-o', 'etimes=', '-p', pid]);
    const elapsedSeconds = Number(started.stdout.trim());
    const startAt =
      started.exitCode === 0 && Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0
        ? Date.now() - elapsedSeconds * 1000
        : NaN;
    sessions.push({
      id: env['SPUR_SESSION'],
      ...(env['SPUR_PROJECT'] ? { project: env['SPUR_PROJECT'] } : {}),
      path: env['PATH'],
      ...(env['CODEX_HOME'] ? { codexHome: env['CODEX_HOME'] } : {}),
      ...(Number.isFinite(startAt) ? { startAt } : {}),
    });
  }
  return sessions;
}

const defaultPorts: DoctorPorts = {
  readText: (path) => readFileSync(path, 'utf8'),
  secretFile: (path) => {
    const resolved = realpathSync(path);
    const stat = statSync(resolved);
    return { path: resolved, isFile: stat.isFile(), mode: stat.mode & 0o777 };
  },
  exists: existsSync,
  run: systemRun,
  sessions: liveSessions,
  fetcher: fetch,
  productVersion: () => {
    const value: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      typeof value.version === 'string'
    )
      return value.version;
    throw new Error('Invalid package version');
  },
};

function result(id: string, ok: boolean, fix: string): DoctorCheck {
  return { id, status: ok ? 'pass' : 'fail', blocking: !ok, fix: ok ? null : fix };
}

function warning(id: string, fix: string): DoctorCheck {
  return { id, status: 'warning', blocking: false, fix };
}

function configFile(env: NodeJS.ProcessEnv, home: string): string {
  const boardHome = env['BOARD_HOME'];
  if (boardHome) return join(resolve(boardHome), 'config.yaml');
  const xdg = env['XDG_CONFIG_HOME'];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'spur-board', 'config.yaml');
}

function unitFile(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env['XDG_CONFIG_HOME'];
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(home, '.config'),
    'systemd',
    'user',
    'spur-board.service',
  );
}

function localSecrets(config: Config, path: string, ports: DoctorPorts): DoctorCheck {
  let file: ReturnType<DoctorPorts['secretFile']>;
  try {
    file = ports.secretFile(path);
  } catch {
    return result('secrets', false, 'Create secrets.env as a regular file with mode 0600.');
  }
  if (!file.isFile)
    return result('secrets', false, 'Make secrets.env a regular file with mode 0600.');
  if (file.mode !== 0o600)
    return result('secrets', false, 'Set secrets.env mode to 0600 with chmod 600.');
  let names: Record<string, string | undefined>;
  try {
    names = parseEnv(ports.readText(file.path));
  } catch {
    names = {};
  }
  const required = [
    'GITHUB_TOKEN',
    ...(config.projects.some((project) => project.tracker.type === 'jira')
      ? ['JIRA_EMAIL', 'JIRA_API_TOKEN']
      : []),
    ...(config.slack.channels.feed || config.slack.channels.orchestrators
      ? ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']
      : []),
  ];
  const missing = required.filter((name) => !names[name]);
  return result(
    'secrets',
    missing.length === 0,
    `Add ${missing.join(', ')} to the private secrets.env file.`,
  );
}

function stamp(ports: DoctorPorts, path: string): { version: string; installedAt: number } | null {
  try {
    const value: unknown = JSON.parse(ports.readText(path));
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      typeof value.version === 'string' &&
      'installedAt' in value &&
      typeof value.installedAt === 'string'
    ) {
      const installedAt = Date.parse(value.installedAt);
      if (Number.isFinite(installedAt)) return { version: value.version, installedAt };
    }
  } catch {
    // A missing or invalid stamp is a failed version check.
  }
  return null;
}

function nodeFromUnit(unit: string): string | null {
  const match = /^ExecStart=(.*)$/m.exec(unit);
  const line = match?.[1];
  if (!line?.startsWith('"')) return null;
  let path = '';
  for (let index = 1; index < line.length; index++) {
    const char = line[index];
    if (char === '"') return line[index + 1] === ' ' ? path : null;
    if (char === '\\') {
      const escaped = line[++index];
      if (escaped !== '\\' && escaped !== '"') return null;
      path += escaped;
    } else if (char === '%') {
      if (line[++index] !== '%') return null;
      path += '%';
    } else {
      if (char === undefined) return null;
      path += char;
    }
  }
  return null;
}

const remoteIds = [
  'secrets',
  'jira.credentials',
  'github.credentials',
  'spur.api',
  'slack.auth',
  'slack.orchestrators_member',
  'slack.feed_member',
  'slack.command',
  'operator.path',
] as const;

function remoteChecks(value: unknown): { version: string; checks: DoctorCheck[] } | null {
  if (!value || typeof value !== 'object' || !('version' in value) || !('checks' in value))
    return null;
  if (typeof value.version !== 'string' || !Array.isArray(value.checks)) return null;
  const checks: DoctorCheck[] = [];
  for (const entry of value.checks as unknown[]) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !('id' in entry) ||
      !('status' in entry) ||
      !('blocking' in entry) ||
      !('fix' in entry) ||
      typeof entry.id !== 'string' ||
      !remoteIds.some((id) => id === entry.id) ||
      typeof entry.status !== 'string' ||
      !['pass', 'fail', 'warning'].includes(entry.status) ||
      typeof entry.blocking !== 'boolean' ||
      (entry.fix !== null && typeof entry.fix !== 'string')
    )
      return null;
    checks.push({
      id: entry.id,
      status: entry.status as DoctorCheck['status'],
      blocking: entry.blocking,
      fix: entry.fix,
    });
  }
  if (new Set(checks.map((entry) => entry.id)).size !== remoteIds.length) return null;
  return { version: value.version, checks };
}

/** Local preflight remains useful even when the daemon is stopped. */
export async function runDoctor(
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    offline?: boolean;
    ports?: Partial<DoctorPorts>;
  } = {},
): Promise<DoctorCheck[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const ports = { ...defaultPorts, ...options.ports };
  const checks: DoctorCheck[] = [];
  let config: Config;
  try {
    const parsed = YAML.parseDocument(ports.readText(configFile(env, home)));
    if (parsed.errors.length > 0) throw new Error('Invalid YAML');
    const validated = configSchema.safeParse(parsed.toJS());
    if (!validated.success) {
      const path = validated.error.issues[0]?.path.map(String).join('.') || 'root';
      checks.push(
        result('config', false, `Correct ${path} in config.yaml using the configuration schema.`),
      );
      return checks;
    }
    config = validated.data;
    checks.push(result('config', true, 'Correct config.yaml.'));
  } catch {
    checks.push(
      result('config', false, 'Create or correct config.yaml using the configuration schema.'),
    );
    return checks;
  }
  if (options.offline) return checks;

  const unitPath = unitFile(env, home);
  let unit: string | null = null;
  try {
    unit = ports.readText(unitPath);
  } catch {
    // Missing unit is reported by the installed check.
  }
  checks.push(result('service.installed', unit !== null, 'Run board service install.'));
  const node = unit === null ? null : nodeFromUnit(unit);
  checks.push(
    result(
      'service.node',
      node !== null && ports.exists(node),
      'Reinstall the service with a valid Node executable path.',
    ),
  );
  checks.push(
    result(
      'service.running',
      ports.run('systemctl', ['--user', 'is-active', 'spur-board.service']).exitCode === 0,
      'Start or restart the user service and inspect its journal.',
    ),
  );
  checks.push(
    result(
      'flock',
      ports.run('flock', ['--version']).exitCode === 0,
      'Install flock from util-linux.',
    ),
  );
  const currentBoard = ports.run('board', ['--version']);
  checks.push(
    result('path.current', currentBoard.exitCode === 0, 'Install board into the current PATH.'),
  );

  const sessions = ports.sessions();
  const live = sessions[0];
  const spurBoard =
    live === undefined ? null : ports.run('board', ['--version'], { HOME: home, PATH: live.path });
  checks.push(
    result(
      'path.spur',
      spurBoard?.exitCode === 0,
      'Start a Spur session and install board into its PATH.',
    ),
  );
  const configured = new Set(
    config.projects.flatMap((project) => project.spurProjects.map((spur) => spur.name)),
  );
  const codex = sessions.find(
    (session) => session.codexHome && session.project && configured.has(session.project),
  );
  const codexHome = codex?.codexHome;
  checks.push(
    codexHome === undefined
      ? warning(
          'skills.codex_visibility',
          'Start a Codex session in a configured Spur project to verify skill visibility.',
        )
      : result(
          'skills.codex_visibility',
          ports.exists(join(codexHome, 'skills', 'spur-board', 'SKILL.md')),
          'Install the spur-board skill into the Codex session-visible CODEX_HOME and restart the session.',
        ),
  );

  const version = ports.productVersion();
  const stamps = ['.claude', '.codex'].flatMap((agent) =>
    ['spur-board', 'spur-board-setup'].map((skill) =>
      stamp(ports, join(home, agent, 'skills', skill, '.spur-board-install.json')),
    ),
  );
  const latestInstall = Math.max(
    ...stamps.flatMap((entry) => (entry === null ? [] : [entry.installedAt])),
  );
  const stale = sessions.filter(
    (session) => session.startAt !== undefined && session.startAt < latestInstall,
  );
  const unknownStarts = sessions.some((session) => session.startAt === undefined);
  const staleIds = stale
    .map((session) => session.id)
    .filter((id) => /^[a-zA-Z0-9_-]+$/.test(id))
    .slice(0, 10);
  checks.push(
    stale.length > 0 || unknownStarts
      ? warning(
          'sessions.stale',
          `Restart sessions started before the last skill install${staleIds.length ? `: ${staleIds.join(', ')}` : ''}; verify sessions whose start time is unavailable.`,
        )
      : result('sessions.stale', true, 'Restart older sessions.'),
  );

  let remote: { version: string; checks: DoctorCheck[] } | null = null;
  try {
    const base = env['BOARD_DAEMON_URL'] || `http://127.0.0.1:${String(config.http.port)}`;
    const response = await ports.fetcher(new URL('/v1/doctor', base), {
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) remote = remoteChecks(await response.json());
  } catch {
    // A stopped daemon is itself one actionable failure; local checks remain visible.
  }
  checks.push(result('daemon.available', remote !== null, 'Start or restart the user service.'));
  if (remote === null) {
    checks.push(localSecrets(config, join(dirname(configFile(env, home)), 'secrets.env'), ports));
    checks.push(
      ...remoteIds
        .filter((id) => id !== 'secrets')
        .map((id) =>
          warning(id, 'Start the daemon, then rerun board doctor to complete this check.'),
        ),
    );
  } else {
    checks.push(...remote.checks);
  }
  checks.push(
    result(
      'versions',
      remote !== null &&
        remote.version === version &&
        currentBoard.stdout.trim() === version &&
        spurBoard?.stdout.trim() === version &&
        stamps.every((entry) => entry?.version === version),
      'Install matching CLI and skills versions, then restart the daemon.',
    ),
  );
  return checks;
}

export function renderDoctor(checks: readonly DoctorCheck[], json: boolean): string {
  if (json) return JSON.stringify(checks);
  return checks
    .map(
      (check) =>
        `${check.status.toUpperCase()} ${check.id}${check.fix === null ? '' : `: ${check.fix}`}`,
    )
    .join('\n');
}
