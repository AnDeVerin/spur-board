import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  actorIdSchema,
  apiBaseUrl,
  configSchema,
  DEFAULT_STAND_PORT_RANGE,
  resolveWebOrigin,
  remoteDoctorReportSchema,
  requiredSecretKeys,
  successEnvelopeSchema,
  type Config,
  type DoctorCheck as DaemonCheck,
} from '@spur-board/contracts';
import YAML from 'yaml';
import { z } from 'zod';
import { configFile, dataDirectory, resolveDaemonAddress } from './config.ts';
import { bindLoopback, checkHttpPort } from './port.ts';
import { escapeTerminalControls } from './terminal.ts';

export interface DoctorCheck extends DaemonCheck {
  present?: string[];
}

interface SessionProcess {
  id: string;
  project?: string;
  path: string;
  codexHome?: string;
  cwd?: string;
  startAt?: number;
}

export interface DoctorPorts {
  readText(path: string): string;
  secretFile(path: string): { path: string; isFile: boolean; mode: number };
  listDir(path: string): string[];
  exists(path: string): boolean;
  realPath(path: string): string;
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
  bind(port: number): Promise<string | null>;
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
    let cwd: string | undefined;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // The session can still be checked through its CODEX_HOME.
    }
    sessions.push({
      id: env['SPUR_SESSION'],
      ...(env['SPUR_PROJECT'] ? { project: env['SPUR_PROJECT'] } : {}),
      path: env['PATH'],
      ...(env['CODEX_HOME'] ? { codexHome: env['CODEX_HOME'] } : {}),
      ...(cwd ? { cwd } : {}),
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
  listDir: readdirSync,
  exists: existsSync,
  realPath: (path) => realpathSync(path),
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
  bind: bindLoopback,
};

function result(id: string, ok: boolean, fix: string): DoctorCheck {
  return { id, status: ok ? 'pass' : 'fail', blocking: !ok, fix: ok ? null : fix };
}

function warning(id: string, fix: string): DoctorCheck {
  return { id, status: 'warning', blocking: false, fix };
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

/** Fails when group or others can access `board.sqlite`; a missing database passes. */
function databasePrivate(path: string, ports: DoctorPorts): DoctorCheck {
  let mode: number;
  try {
    // Not a secret file, but it needs the same resolve and stat.
    mode = ports.secretFile(path).mode;
  } catch {
    return result('database.private', true, '');
  }
  return result(
    'database.private',
    (mode & 0o077) === 0,
    'Set board.sqlite mode to 0600 with chmod 600; the daemon also sets it when it starts.',
  );
}

function localSecrets(config: Config, path: string, ports: DoctorPorts): DoctorCheck {
  let file: ReturnType<DoctorPorts['secretFile']>;
  try {
    file = ports.secretFile(path);
  } catch {
    let candidate: string | undefined;
    try {
      candidate = ports.listDir(dirname(path)).find((name) => {
        if (name === 'secrets.env' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.env$/.test(name)) return false;
        try {
          return ports.secretFile(join(dirname(path), name)).isFile;
        } catch {
          return false;
        }
      });
    } catch {
      // The missing file is still actionable if its directory cannot be read.
    }
    const fix = candidate
      ? `Create secrets.env with mode 0600; rename ${candidate} to secrets.env if it contains the intended tokens.`
      : 'Create secrets.env as a regular file with mode 0600.';
    return { ...result('secrets', false, fix), present: [] };
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
  const required = requiredSecretKeys(config);
  const missing = required.filter((name) => !names[name]);
  return {
    ...result(
      'secrets',
      missing.length === 0,
      `Add ${missing.join(', ')} to the private secrets.env file.`,
    ),
    present: required.filter((name) => Boolean(names[name])),
  };
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

const remoteBaseIds = [
  'web.spurUiOrigin',
  'secrets',
  'jira.credentials',
  'github.credentials',
  'link.rules',
  'spur.api',
  'spur.send',
  'operator.path',
  'operator.tokens',
  'curator.sessions',
  'orchestrator.sessions',
] as const;
const remoteSlackIds = [
  'slack.auth',
  'slack.orchestrators_member',
  'slack.feed_member',
  'slack.command',
] as const;
function remoteIdSet(slackConfigured: boolean): string[] {
  return [...remoteBaseIds, ...(slackConfigured ? remoteSlackIds : ['slack.configured'])];
}

const unreportedFix =
  'The daemon did not report this check. Restart the user service so the daemon runs the installed version, then rerun board doctor.';

/**
 * The daemon's checks to show: any id it sends, except one the CLI checks itself or sent twice,
 * plus a warning for each check this version expects but the daemon left out.
 */
function remoteMerge(
  remote: readonly DoctorCheck[],
  localIds: ReadonlySet<string>,
  slackConfigured: boolean,
): DoctorCheck[] {
  const reported = new Set(remote.map((check) => check.id));
  const slack = reported.has('slack.configured')
    ? false
    : remoteSlackIds.some((id) => reported.has(id)) || slackConfigured;
  const seen = new Set(localIds);
  const shown = remote.filter((check) => {
    if (seen.has(check.id)) return false;
    seen.add(check.id);
    return true;
  });
  return [
    ...shown,
    ...remoteIdSet(slack)
      .filter((id) => id !== 'secrets' && !reported.has(id))
      .map((id) => warning(id, unreportedFix)),
  ];
}

function safeIds(values: readonly string[]): string[] {
  return values.filter((id) => /^[a-zA-Z0-9_-]+$/.test(id)).slice(0, 10);
}

function listing(ids: readonly string[]): string {
  return ids.length ? `: ${ids.join(', ')}` : '';
}

function sessionCount(ids: readonly string[]): string {
  return ids.length === 0
    ? 'sessions'
    : `${String(ids.length)} session${ids.length === 1 ? '' : 's'}`;
}

/** Session ids safe to send to the daemon or Spur: valid actor ids, deduped, sorted, capped. */
function lookupIds(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids.filter(
        (id) => id.length <= 128 && actorIdSchema.safeParse(`agent:project/${id}`).success,
      ),
    ),
  ]
    .sort()
    .slice(0, 200);
}

const spurSession = z.object({
  id: z.string(),
  status: z.string(),
  runtimeAlive: z.unknown().optional(),
});
type SpurSession = z.infer<typeof spurSession>;

function hasEnded(session: SpurSession): boolean {
  return (
    session.status === 'completed' ||
    session.status === 'killed' ||
    (session.status === 'errored' && session.runtimeAlive === false)
  );
}

/** One session's Spur detail: 'gone' on 404, null when the answer cannot be trusted. */
async function spurSessionDetail(
  id: string,
  base: URL,
  ports: DoctorPorts,
): Promise<SpurSession | 'gone' | null> {
  try {
    const response = await ports.fetcher(new URL(`sessions/${encodeURIComponent(id)}`, base), {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return 'gone';
    if (response.status !== 200) return null;
    const parsed = spurSession.safeParse(await response.json());
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Process sessions Spur reports as ended: completed, killed, errored with no running agent, or
 * unknown to Spur. Without a readable session list every session counts as live, and a session
 * whose detail cannot be read stays live; ids that fail validation are never sent.
 */
async function endedSessions(
  ids: readonly string[],
  baseUrl: string,
  ports: DoctorPorts,
): Promise<Set<string>> {
  const ended = new Set<string>();
  const queried = lookupIds(ids);
  if (queried.length === 0) return ended;
  const base = apiBaseUrl(baseUrl);
  let listed: SpurSession[];
  try {
    const response = await ports.fetcher(new URL('sessions', base), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return ended;
    const parsed = z.array(spurSession).safeParse(await response.json());
    if (!parsed.success) return ended;
    listed = parsed.data;
  } catch {
    return ended;
  }
  const known = new Map(listed.map((session) => [session.id, session]));
  await Promise.all(
    queried.map(async (id) => {
      const session = known.get(id) ?? (await spurSessionDetail(id, base, ports));
      if (session === 'gone' || (session !== null && hasEnded(session))) ended.add(id);
    }),
  );
  return ended;
}

/** Reload states that count for the newest install: delivered or pending, queued after it. */
type ReloadState = 'delivered' | 'pending';

const reloadRecords = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      state: z.enum(['delivered', 'pending', 'failed']),
      queuedAt: z.string().nullable(),
    }),
  ),
});

/**
 * The daemon's reload record of each named session for the newest install's version. Ids travel
 * in the body, never the URL. A record queued before that install, as after a rollback to a
 * version installed earlier, does not count; an unreachable daemon yields no records.
 */
async function reloadStates(
  ids: readonly string[],
  newest: { version: string; installedAt: number },
  address: () => URL,
  ports: DoctorPorts,
): Promise<Map<string, ReloadState>> {
  const states = new Map<string, ReloadState>();
  const sessions = lookupIds(ids);
  if (sessions.length === 0) return states;
  try {
    const response = await ports.fetcher(new URL('/v1/skills/reloads', address()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: newest.version, sessions }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) return states;
    const envelope = successEnvelopeSchema.safeParse(await response.json());
    const parsed = reloadRecords.safeParse(envelope.data?.value);
    if (!parsed.success) return states;
    for (const record of parsed.data.sessions) {
      const queuedAt = record.queuedAt === null ? Number.NaN : Date.parse(record.queuedAt);
      if (
        record.state !== 'failed' &&
        sessions.includes(record.id) &&
        Number.isFinite(queuedAt) &&
        queuedAt >= newest.installedAt
      ) {
        states.set(record.id, record.state);
      }
    }
  } catch {
    // Without records every stale session is listed under stop and wake.
  }
  return states;
}

const skillLink = '.agents/skills/spur-board';
const codexVisibilityFix =
  "Add .agents/skills/spur-board to the Spur project's symlinks in its config and start a new session.";
const spurProjectList = z.array(z.object({ id: z.string(), path: z.string() }));
const spurProjectConfig = z.object({
  symlinks: z.array(z.string()).optional(),
  defaultAgent: z.string().optional(),
});

/** Spur's own project list is the only source of each project's main checkout path. */
async function spurProjectPaths(
  baseUrl: string,
  ports: DoctorPorts,
): Promise<Map<string, string> | null> {
  try {
    const response = await ports.fetcher(new URL('projects', apiBaseUrl(baseUrl)), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const parsed = spurProjectList.safeParse(await response.json());
    return parsed.success
      ? new Map(parsed.data.map((project) => [project.id, project.path]))
      : null;
  } catch {
    return null;
  }
}

function spurProjectEntry(
  ports: DoctorPorts,
  path: string,
  id: string,
): { symlinks: string[]; defaultAgent?: string } | null {
  for (const file of ['spur.yaml', 'spur.yml']) {
    let value: unknown;
    try {
      value = YAML.parse(ports.readText(join(path, file)));
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || !('projects' in value)) continue;
    const projects = value.projects;
    if (!projects || typeof projects !== 'object' || !Object.hasOwn(projects, id)) continue;
    const parsed = spurProjectConfig.safeParse((projects as Record<string, unknown>)[id]);
    if (!parsed.success) continue;
    return {
      symlinks: (parsed.data.symlinks ?? []).map((entry) =>
        entry.replace(/^\.\//, '').replace(/\/+$/, ''),
      ),
      ...(parsed.data.defaultAgent === undefined ? {} : { defaultAgent: parsed.data.defaultAgent }),
    };
  }
  return null;
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
  const webOrigin = resolveWebOrigin(config.web);
  checks.push({
    ...result('web', true, ''),
    present: webOrigin === undefined ? ['off'] : ['on', webOrigin],
  });
  const range = config.stand.portRange ?? DEFAULT_STAND_PORT_RANGE;
  const collisions = [
    ['http.port', config.http.port],
    ['web.port', config.web.port],
  ] as const;
  const overlaps = collisions
    .filter(([, port]) => port !== undefined && port >= range.min && port <= range.max)
    .map(([field, port]) => `${field} ${String(port)}`);
  checks.push(
    overlaps.length === 0
      ? result('stand.port_range', true, '')
      : warning(
          'stand.port_range',
          `Implicit stand port range ${String(range.min)}..${String(range.max)} overlaps ${overlaps.join(', ')}. Set a nonoverlapping stand.portRange. The stand refuses the overlapping ports.`,
        ),
  );
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

  const processes = ports.sessions();
  const ended = await endedSessions(
    processes.map((session) => session.id),
    config.adapters.spur.baseUrl,
    ports,
  );
  // Every session check reads only sessions Spur does not report as ended.
  const sessions = processes.filter((session) => !ended.has(session.id));
  const live = sessions[0];
  const spurBoard =
    live === undefined ? null : ports.run('board', ['--version'], { HOME: home, PATH: live.path });
  checks.push(
    live === undefined
      ? warning('path.spur', 'Start a Spur session, then rerun board doctor.')
      : result(
          'path.spur',
          spurBoard?.exitCode === 0,
          'Install board into the live Spur session PATH.',
        ),
  );
  const configured = new Set(
    config.projects.flatMap((project) => project.spurProjects.map((spur) => spur.name)),
  );
  const codexSessions = sessions.filter(
    (session) => session.codexHome && session.project && configured.has(session.project),
  );
  const projectPaths =
    configured.size === 0 ? null : await spurProjectPaths(config.adapters.spur.baseUrl, ports);
  const states = new Map<string, 'ok' | 'broken' | 'unknown'>();
  const missing: string[] = [];
  if (projectPaths !== null) {
    // Mirrors the copies installIntoHome writes in skills.ts.
    const codexHome = env['CODEX_HOME'];
    const installed = new Set<string>();
    for (const copy of [
      join(home, '.claude', 'skills', 'spur-board'),
      codexHome
        ? join(resolve(codexHome), 'skills', 'spur-board')
        : join(home, '.codex', 'skills', 'spur-board'),
    ]) {
      try {
        installed.add(ports.realPath(copy));
      } catch {
        // A missing copy cannot be a link target.
      }
    }
    for (const name of configured) {
      const path = projectPaths.get(name);
      if (path === undefined) {
        missing.push(name);
        continue;
      }
      const entry = spurProjectEntry(ports, path, name);
      let linkReal: string | null = null;
      try {
        linkReal = ports.realPath(join(path, skillLink));
      } catch {
        // A missing link is a broken install when the project is used by Codex.
      }
      const listed = entry?.symlinks.includes(skillLink) ?? false;
      const used =
        codexSessions.some((session) => session.project === name) ||
        entry?.defaultAgent === 'codex' ||
        listed ||
        linkReal !== null;
      // Without a readable entry only a link to a foreign target is a certain break; deciding a
      // missing link by the live sessions would make the result depend on which ones run.
      const foreignLink = linkReal !== null && !installed.has(linkReal);
      states.set(
        name,
        entry === null
          ? foreignLink
            ? 'broken'
            : 'unknown'
          : used && (linkReal === null || foreignLink || !listed)
            ? 'broken'
            : 'ok',
      );
    }
  }
  const unknown = [...states].filter(([, state]) => state === 'unknown').map(([name]) => name);
  checks.push(
    configured.size === 0
      ? result('skills.codex_visibility', true, codexVisibilityFix)
      : projectPaths === null
        ? warning(
            'skills.codex_visibility',
            'Start Spur or correct adapters.spur.baseUrl in config.yaml, then rerun board doctor to check the Codex skill install.',
          )
        : [...states.values()].includes('broken')
          ? result('skills.codex_visibility', false, codexVisibilityFix)
          : missing.length > 0 || unknown.length > 0
            ? warning(
                'skills.codex_visibility',
                [
                  ...(missing.length > 0
                    ? [
                        `Correct spurProjects or projects[].spurProjects in config.yaml or register these projects in Spur${listing(safeIds(missing))}.`,
                      ]
                    : []),
                  ...(unknown.length > 0
                    ? [
                        `Check that projects.<id>.symlinks in each project's spur.yaml lists .agents/skills/spur-board${listing(safeIds(unknown))}.`,
                      ]
                    : []),
                ].join(' '),
              )
            : result('skills.codex_visibility', true, codexVisibilityFix),
  );
  const oldSessions = codexSessions.filter(
    (session) =>
      session.project !== undefined &&
      states.get(session.project) === 'ok' &&
      !(
        (session.cwd !== undefined &&
          ports.exists(join(session.cwd, '.agents', 'skills', 'spur-board', 'SKILL.md'))) ||
        (session.codexHome !== undefined &&
          ports.exists(join(session.codexHome, 'skills', 'spur-board', 'SKILL.md')))
      ),
  );
  checks.push(
    oldSessions.length > 0
      ? warning(
          'sessions.codex_skill',
          `Start new Spur sessions to replace Codex sessions created before the skill link${listing(safeIds([...new Set(oldSessions.map((session) => session.id))]))}; Spur links .agents/skills/spur-board only into new worktrees.`,
        )
      : result('sessions.codex_skill', true, 'Start new Spur sessions.'),
  );

  const version = ports.productVersion();
  const stamps = ['.claude', '.codex'].flatMap((agent) =>
    ['spur-board', 'spur-board-setup'].map((skill) =>
      stamp(ports, join(home, agent, 'skills', skill, '.spur-board-install.json')),
    ),
  );
  const newest = stamps.reduce<(typeof stamps)[number]>(
    (latest, entry) =>
      entry !== null && (latest === null || entry.installedAt > latest.installedAt)
        ? entry
        : latest,
    null,
  );
  const latestInstall = newest?.installedAt ?? -Infinity;
  // Only sessions of a configured Spur project read the board skill.
  const connected = sessions.filter(
    (session) => session.project !== undefined && configured.has(session.project),
  );
  // Spur lists one entry per pane or process, so one session can appear several times.
  const staleSessions = [
    ...new Set(
      connected
        .filter((session) => session.startAt !== undefined && session.startAt < latestInstall)
        .map((session) => session.id),
    ),
  ];
  const undatedSessions = [
    ...new Set(
      connected.filter((session) => session.startAt === undefined).map((session) => session.id),
    ),
  ];
  const listed = [...new Set([...staleSessions, ...undatedSessions])];
  const reloads =
    newest === null
      ? new Map<string, ReloadState>()
      : await reloadStates(
          listed,
          newest,
          () => resolveDaemonAddress(env, home, config.http.port),
          ports,
        );
  const unreached = staleSessions.filter((id) => reloads.get(id) === undefined);
  const unknownStarts = undatedSessions.some((id) => reloads.get(id) === undefined);
  const pending = listed.filter((id) => reloads.get(id) === 'pending');
  const forVersion = newest === null ? '' : ` for ${newest.version}`;
  checks.push(
    unreached.length > 0 || unknownStarts || pending.length > 0
      ? warning(
          'sessions.stale',
          [
            ...(unreached.length > 0 || unknownStarts
              ? [
                  `Stop and wake ${sessionCount(unreached)} started before the last skill install that have no delivered reload message${forVersion}${listing(safeIds(unreached))}; stopping and waking restarts the agent and keeps the conversation. A session can instead read the spur-board skill file again: ~/.claude/skills/spur-board/SKILL.md for Claude Code, ~/.codex/skills/spur-board/SKILL.md for Codex ($CODEX_HOME/skills/spur-board/SKILL.md when set); doctor keeps listing it after that.${unknownStarts ? ' Do the same for connected sessions whose start time is unavailable.' : ''}`,
                ]
              : []),
            ...(pending.length > 0
              ? [
                  `The board's reload message${forVersion} is still queued for ${sessionCount(pending)}${listing(safeIds(pending))}; rerun board doctor in a minute.`,
                ]
              : []),
          ].join(' '),
        )
      : result('sessions.stale', true, 'Ask older sessions to re-read the spur-board skill.'),
  );

  // The probe uses the port the daemon listens on, never the client's BOARD_DAEMON_URL.
  const portFix = await checkHttpPort(config.http.port, {
    bind: ports.bind,
    run: (command, args) => Promise.resolve(ports.run(command, args)),
  });
  checks.push(result('http.port', portFix === null, portFix ?? ''));
  checks.push(databasePrivate(join(dataDirectory(env, home), 'board.sqlite'), ports));

  let remote: { version: string; checks: DoctorCheck[] } | null = null;
  try {
    const address = resolveDaemonAddress(env, home, config.http.port);
    const response = await ports.fetcher(new URL('/v1/doctor', address), {
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const parsed = remoteDoctorReportSchema.safeParse(await response.json());
      if (parsed.success) remote = parsed.data;
    }
  } catch {
    // A stopped daemon is itself one actionable failure; local checks remain visible.
  }
  checks.push(result('daemon.available', remote !== null, 'Start or restart the user service.'));
  const secrets = localSecrets(config, join(dirname(configFile(env, home)), 'secrets.env'), ports);
  const daemonSecrets = remote?.checks.find((check) => check.id === 'secrets');
  checks.push(
    secrets.status === 'pass' && daemonSecrets?.status === 'fail'
      ? {
          ...secrets,
          status: 'fail',
          blocking: true,
          fix:
            daemonSecrets.fix ??
            'Add the missing required keys to secrets.env and restart the daemon.',
        }
      : secrets,
  );
  const slackConfigured = Boolean(
    config.slack.channels.feed || config.slack.channels.orchestrators,
  );
  if (remote === null) {
    checks.push(
      ...remoteIdSet(slackConfigured)
        .filter((id) => id !== 'secrets')
        .map((id) =>
          warning(
            id,
            id === 'slack.configured'
              ? 'Slack is not configured: questions addressed to you are only visible through board inbox. Run the spur-board-setup skill to configure slack.channels.'
              : 'Start the daemon, then rerun board doctor to complete this check.',
          ),
        ),
    );
  } else {
    const localIds = new Set([...checks.map((check) => check.id), 'versions']);
    checks.push(...remoteMerge(remote.checks, localIds, slackConfigured));
  }
  const availableVersions = [
    ...(currentBoard.exitCode === 0 ? [currentBoard.stdout.trim()] : []),
    ...(spurBoard?.exitCode === 0 ? [spurBoard.stdout.trim()] : []),
    ...(remote === null ? [] : [remote.version]),
    ...stamps.flatMap((entry) => (entry === null ? [] : [entry.version])),
  ];
  checks.push(
    result(
      'versions',
      availableVersions.every((available) => available === version),
      'Install matching CLI and skills versions, then restart the daemon.',
    ),
  );
  return checks;
}

export function renderDoctor(checks: readonly DoctorCheck[], json: boolean): string {
  if (json) return JSON.stringify(checks);
  return checks
    .map((check) => {
      const present =
        check.present === undefined ? '' : ` (present: ${check.present.join(', ') || 'none'})`;
      const fix = check.fix === null ? '' : `: ${check.fix}`;
      return escapeTerminalControls(`${check.status.toUpperCase()} ${check.id}${present}${fix}`);
    })
    .join('\n');
}
