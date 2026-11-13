import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { startAdapters, type AdapterRunner } from '@spur-board/adapters';
import { COLUMN_IDS, configSchema, err, userIdSchema, type Config } from '@spur-board/contracts';
import { migrationsDir, openStore, readMigrations } from '@spur-board/core';
import {
  acquireLock,
  createSpurPort,
  loadConfig,
  resolvePaths,
  startInProcessDaemon,
  type InProcessDaemon,
  type InProcessOptions,
  type Paths,
} from '@spur-board/daemon/in-process';
import {
  startFakeSlackApi,
  type FakeSlackApi,
  type FakeSlackState,
} from '@spur-board/gateway-slack/testing';
import { installNetworkGuard } from '@spur-board/testkit';
import YAML from 'yaml';
import type { RouteResult } from './control.ts';
import { isShift, SHIFT_REFUSAL, startControl, type Control } from './control.ts';
import { createFakeSpur, requestUrl, type FakeSpur, type FakeSpurState } from './fake-spur.ts';
import { createFakes, type FakesState } from './fakes/fetch.ts';
import { createGithubIssuesFake } from './fakes/github-issues.ts';
import { createGithubPrFake } from './fakes/github-pr.ts';
import { createJiraFake } from './fakes/jira.ts';
import { proxyRefusal, refusal, StandRefusedError } from './guards.ts';
import {
  isStandDir,
  procStat,
  STAND_PREFIX,
  writeManifest,
  type StandManifest,
} from './manifest.ts';
import {
  createBoardClient,
  createScenarioFakes,
  mergeConfig,
  SCENARIOS,
  scenarioNames,
  type Scenario,
  type ScenarioEntities,
} from './scenarios/index.ts';
import { privateDir, restoreSnapshot, saveSnapshot, snapshotKey } from './snapshots.ts';

export { StandRefusedError } from './guards.ts';

type Env = Readonly<Record<string, string | undefined>>;

type ClickInput = Parameters<FakeSlackApi['platform']['inject']>[0];

export const WAIT_CONDITIONS = [
  'api-ready',
  'sources-polled',
  'outbox-drained',
  'scenario',
] as const;
const WAIT_STEP_MS = 100;
/** How long a `/poll` holds the control queue when a fake never answers. */
const POLL_TIMEOUT_MS = 60_000;
/** The Spur project of each role session; both are `spurProjects` of the stand project. */
const ROLE_PROJECTS = { worker: 'stand-worker', orchestrator: 'stand-qa' };
const SPUR_BASE_URL = 'http://spur.stand.invalid';
const SECRETS = {
  GITHUB_TOKEN: 'stand-dummy-github',
  JIRA_EMAIL: 'stand@stand.invalid',
  JIRA_API_TOKEN: 'stand-dummy-jira',
  SLACK_BOT_TOKEN: 'stand-dummy-slack-bot',
  SLACK_APP_TOKEN: 'stand-dummy-slack-app',
};
const OPERATOR_SLACK = 'U0STANDOP';
/** Stands for the thread reply that answers a question; Slack shows no button for it. */
const ANSWER_BUTTON = 'answer';
/** How long a click may wait for Socket Mode acknowledgements. */
const CLICK_TIMEOUT_MS = 5_000;
/**
 * How long before its first deadline a snapshot stops being restored: the restart and a default
 * `wait scenario` (30 s) must both fit before a restored row lapses.
 */
const FRESH_MARGIN_MS = 60_000;
const SEED_FAILED_NOTE =
  'The board keeps what the seed wrote before it failed; run reset for a clean stand.';

/**
 * The stand's config. Every external host is under `.stand.invalid`: Spur's and Jira's are
 * answered by in-process fakes and the network guard refuses the rest before DNS, so no request
 * leaves the machine.
 */
export function standConfig(
  port: number,
  spurBaseUrl: string = SPUR_BASE_URL,
): Record<string, unknown> {
  return {
    projects: [
      {
        id: 'stand',
        tracker: { type: 'github-issues', repo: 'stand-org/board' },
        repos: ['stand-org/board'],
        operatorGithubLogin: 'stand-agent',
        spurProjects: [
          { name: 'stand-worker', role: 'worker' },
          { name: 'stand-qa', role: 'worker' },
        ],
        columns: COLUMN_IDS.map((id) => ({
          id,
          enabled: true,
          orchestrator: id === 'qa' ? 'stand-qa' : 'none',
        })),
      },
      {
        id: 'stand-jira',
        tracker: {
          type: 'jira',
          baseUrl: 'https://jira.stand.invalid',
          jql: 'project = STAND',
          doneStatuses: ['Done'],
          readyStatuses: ['Ready for Dev'],
          projectKeys: ['STAND'],
        },
        repos: ['stand-org/service'],
        operatorGithubLogin: 'stand-agent',
      },
    ],
    operator: { slack: OPERATOR_SLACK },
    slack: { channels: { orchestrators: 'C0STANDORCH', feed: 'C0STANDFEED' } },
    digest: { tz: 'UTC' },
    http: { port },
    adapters: {
      spur: { baseUrl: spurBaseUrl, intervalMs: 2_000 },
      github: { intervalMs: 5_000 },
      githubIssues: { intervalMs: 5_000 },
      jira: { intervalMs: 5_000 },
    },
    sources: { authRetryMs: 10_000 },
    thresholds: { staleMultiplier: 1_000 },
  };
}

const CONFIG_HEADER = `# Generated by the stand; reset rewrites it.
# thresholds.staleMultiplier is 1000 so no source turns stale while the stand runs: Spur, GitHub
# pull requests, GitHub Issues and Jira answer from the stand's fakes. A scenario that tests
# staleness shifts the stand clock past the window.
`;

/** The line naming the scenario whose thresholds and adapters override the values below. */
const scenarioHeader = (name: string): string =>
  `# Scenario ${name} overrides thresholds and adapters here.\n`;

/** Every source status.get requires: spur, each tracker and each repo's PR source. */
export function requiredSources(config: Pick<Config, 'projects'>): string[] {
  return [
    'spur',
    ...config.projects.flatMap((project) => [
      project.tracker.type === 'jira'
        ? `jira:${project.id}`
        : `github-issues:${project.id}:${project.tracker.repo.toLowerCase()}`,
      ...project.repos.map((repo) => `github:${project.id}:${repo.toLowerCase()}`),
    ]),
  ];
}

type FirstAttempts = NonNullable<AdapterRunner['firstAttempts']>;
type Attempt = Awaited<FirstAttempts>[number];

/**
 * The daemon's `startAdapters`, able to start the runner again: `restart` stops the current
 * runner and starts a new one with the same arguments, then resolves its first attempts. Every
 * runner uses `standFetch` in place of the daemon's fetch.
 */
function runnerController(standFetch: typeof fetch) {
  let args: Parameters<typeof startAdapters> | undefined;
  let runner: AdapterRunner | undefined;
  let polled = false;
  let generation = 0;
  let stopped = false;
  const track = (next: AdapterRunner): FirstAttempts => {
    generation += 1;
    const mine = generation;
    polled = false;
    const attempts = next.firstAttempts ?? Promise.resolve([]);
    void attempts.then(
      () => {
        if (mine === generation) polled = true;
      },
      () => undefined,
    );
    return attempts;
  };
  const start: typeof startAdapters = (config, core, options) => {
    args = [config, core, { ...options, fetch: standFetch }];
    runner = startAdapters(...args);
    void track(runner);
    return {
      firstAttempts: runner.firstAttempts,
      // Forwards to the current runner, so a restart keeps on-demand polls working.
      pollPr: (source, ref, pollOptions) =>
        runner?.pollPr?.(source, ref, pollOptions) ??
        Promise.resolve(
          err({ kind: 'unsupported', message: 'The adapter runner polls no PR on demand.' }),
        ),
      async stop() {
        stopped = true;
        await runner?.stop();
      },
    };
  };
  return {
    start,
    polled: () => polled,
    async restart(): Promise<readonly Attempt[]> {
      if (args === undefined || runner === undefined || stopped)
        throw new Error('The adapter runner is not running.');
      await runner.stop();
      runner = startAdapters(...args);
      return track(runner);
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Create-only, never through a symlink: an existing entry or a link at the path fails the open. */
const EXCLUSIVE = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

/** Replaces `file` with a new mode-600 file. `rm` removes a symlink itself, never its target. */
function replaceFile(file: string, text: string): void {
  rmSync(file, { force: true });
  const fd = openSync(file, EXCLUSIVE, 0o600);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** A regular file owned by this user, never a symlink. */
function ownFile(path: string): boolean {
  const info = lstatSync(path);
  return !info.isSymbolicLink() && info.isFile() && info.uid === process.getuid?.();
}

/**
 * A home `up` created is private and holds nothing but its spawn log, `logs/stand.log`, in a
 * private `logs` directory. Anything else means another process prepared it, so the stand
 * refuses it before writing.
 */
function checkFreshHome(home: string): void {
  const entries = readdirSync(home);
  const logs = join(home, 'logs');
  const fresh =
    privateDir(home) &&
    entries.every((name) => name === 'logs') &&
    (entries.length === 0 ||
      (privateDir(logs) &&
        readdirSync(logs).every((name) => name === 'stand.log' && ownFile(join(logs, name)))));
  if (!fresh) throw new Error(`${home} holds files the stand did not create; refusing it.`);
}

/**
 * Creates `logs/daemon.log` exclusively, which claims the home: a second stand on it fails here.
 * The open refuses a link, and the file must still be the entry inside the private `logs`.
 */
function claimLog(home: string): number {
  const logs = join(home, 'logs');
  if (!existsSync(logs)) mkdirSync(logs, { mode: 0o700 });
  if (!privateDir(logs)) throw new Error(`${logs} is not a private directory; refusing it.`);
  const file = join(logs, 'daemon.log');
  const fd = openSync(file, EXCLUSIVE | constants.O_APPEND, 0o600);
  const opened = fstatSync(fd);
  const entry = lstatSync(file);
  if (!privateDir(logs) || opened.ino !== entry.ino || opened.dev !== entry.dev) {
    closeSync(fd);
    throw new Error(`${file} changed while it was opened; refusing the home.`);
  }
  return fd;
}

export interface StandOptions {
  /** Where stand homes live, normally `realpath(tmpdir())`. */
  root: string;
  /** A home `up` created; it must pass `isStandDir` and hold no manifest yet. */
  home?: string | undefined;
  port: number;
  env: Env;
  execArgv?: readonly string[];
  osHome: string;
  /** Binds the daemon's fatal handler to the process; called once. */
  registerFatal?: (handler: (err: unknown) => void) => void;
  /** How long the daemon may take to stop before it exits 1; the in-process default otherwise. */
  shutdownTimeoutMs?: number;
  /** Replaces the board tick; a test seam for a daemon that cannot stop cleanly. */
  tick?: NonNullable<InProcessOptions['ports']>['tick'];
  /** Replaces the wall clock of the daemon and the fakes; a test seam. */
  clock?: InProcessOptions['clock'];
  /** Replaces the configured Spur URL; a test seam, whose path prefix makes every call drift. */
  spurBaseUrl?: string;
  /** Replaces the repos the GitHub fakes know; a test seam, as polling any other is a violation. */
  githubRepos?: readonly string[];
  /** Seeds this scenario before the stand counts as started; a failed seed fails the start. */
  scenario?: string | undefined;
  /** Replaces the scenario registry; a test seam. */
  scenarios?: readonly Scenario[];
  /**
   * Replaces the migrations the snapshot key is computed from; a test seam. It feeds only the
   * key: the daemon still migrates with core's own files.
   */
  migrationsDir?: URL;
}

/** What a reset restores in place of seeding `name` again. */
interface SnapshotRecord {
  key: string;
  file: string;
  entities: ScenarioEntities;
  fakes: FakesState;
  spur: FakeSpurState;
  slack: FakeSlackState;
  /** The clock shifts the seed made, in order; a restore makes them again on the new daemon. */
  shifts: number[];
  /**
   * The earliest stand-clock time, in ms, at which a row the seed left lapses on its own: a
   * pending token request's expiry. Undefined when nothing does.
   */
  lapsesAt: number | undefined;
}

type SnapshotOutcome = 'restored' | 'taken' | 'failed';

export interface Stand {
  manifest(): StandManifest;
  /** Closes the fake and control, then stops the daemon. Idempotent; resolves its exit code. */
  stop(): Promise<number>;
  /** Resolves when the stand stopped, through `stop` or because its daemon exited on its own. */
  readonly exited: Promise<number>;
  /**
   * Resolves as soon as shutdown begins, whatever started it: a `stop` call, a failed reset or a
   * daemon that exited on its own. `exited` settles later, once teardown has finished.
   */
  readonly stopping: Promise<void>;
}

/**
 * Starts a stand: an in-process daemon on a generated home with dummy secrets, the loopback-only
 * network guard and a control endpoint. Every refusal happens before anything is created.
 */
export async function startStand(options: StandOptions): Promise<Stand> {
  const refused =
    proxyRefusal({ env: options.env, execArgv: options.execArgv ?? [] }) ??
    refusal({ root: options.root, port: options.port, env: options.env, osHome: options.osHome });
  if (refused !== undefined) throw new StandRefusedError(refused);
  const scenarios = options.scenarios ?? SCENARIOS;
  const findScenario = (name: string): Scenario | undefined =>
    scenarios.find((candidate) => candidate.name === name);
  if (options.scenario !== undefined && findScenario(options.scenario) === undefined)
    throw new Error(
      `Unknown scenario ${options.scenario}; use one of ${scenarioNames(scenarios).join(', ')}.`,
    );
  installNetworkGuard();

  const root = realpathSync(options.root);
  const spurBaseUrl = options.spurBaseUrl ?? SPUR_BASE_URL;
  const config = standConfig(options.port, spurBaseUrl);
  const parsedConfig = configSchema.parse(config);
  const required = requiredSources(parsedConfig);
  let home: string;
  if (options.home === undefined) {
    home = mkdtempSync(join(root, STAND_PREFIX));
  } else {
    if (!isStandDir(options.home, root))
      throw new Error(`${options.home} is not a stand directory under ${root}.`);
    home = realpathSync(options.home);
  }
  // A start that fails removes the home it created; a home the caller passed is the caller's.
  const created = options.home === undefined;
  const discardHome = (): void => {
    if (created) rmSync(home, { recursive: true, force: true });
  };
  // The root passed the live-home guard, but the home itself may be the live board's home.
  const homeRefused = refusal({
    root: home,
    port: options.port,
    env: options.env,
    osHome: options.osHome,
  });
  if (homeRefused !== undefined) {
    discardHome();
    throw new StandRefusedError(homeRefused);
  }
  if (!created) checkFreshHome(home);
  const id = basename(home).slice(STAND_PREFIX.length);
  const paths: Paths = resolvePaths({ BOARD_HOME: home }, options.osHome);
  const tokenPath = join(home, 'token');
  const operatorToken = randomBytes(32).toString('hex');
  const controlToken = randomBytes(32).toString('hex');
  // A session header is accepted without a token, so the role sessions must be unguessable:
  // random per stand, kept in the private manifest and reused across reset.
  const roles = {
    worker: `stand-worker-${randomBytes(12).toString('hex')}`,
    orchestrator: `stand-qa-${randomBytes(12).toString('hex')}`,
  };
  let logFd: number;
  try {
    logFd = claimLog(home);
  } catch (err) {
    discardHome();
    throw err;
  }
  const log = (text: string): void => {
    writeSync(logFd, text);
  };

  /**
   * Writes the home for a fresh daemon, with the config of `scenario` when one is named. The
   * database is the `snapshot` file when one is given, else a new one with the stand identities.
   */
  async function writeHome(
    slackUrl: string,
    scenario: string | undefined,
    snapshot?: string,
  ): Promise<void> {
    const extra = scenario === undefined ? undefined : findScenario(scenario)?.config;
    const written = extra === undefined ? config : mergeConfig(config, extra);
    // Fails here, before any file is written, rather than in the daemon's config load.
    configSchema.parse(written);
    replaceFile(
      paths.configFile,
      `${CONFIG_HEADER}${extra === undefined || scenario === undefined ? '' : scenarioHeader(scenario)}${YAML.stringify(written)}`,
    );
    replaceFile(
      paths.secretsFile,
      Object.entries({ ...SECRETS, SLACK_API_URL: slackUrl })
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
    replaceFile(tokenPath, `${operatorToken}\n`);
    if (snapshot !== undefined) {
      restoreSnapshot(snapshot, paths.dbFile, paths.lockFile);
      return;
    }
    // SQLite creates its WAL and SHM files with the database file's mode, so an owner-only empty
    // file here keeps all three owner-only. Start and reset both find no database file.
    closeSync(openSync(paths.dbFile, EXCLUSIVE, 0o600));
    await seedIdentities(paths.dbFile, operatorToken, roles, clock.now());
  }

  const base = options.clock ?? { now: () => Date.now() };
  // Only grows, also across reset and seed, so the stand clock never moves backward.
  let offsetMs = 0;
  const clock = { now: () => base.now() + offsetMs };
  // Outlives every daemon of this stand; a reset clears its state, not the object.
  const fakes = createFakes({
    now: () => clock.now(),
    modules: [
      (now) =>
        createGithubPrFake({
          now,
          repos: options.githubRepos ?? parsedConfig.projects.flatMap(({ repos }) => repos),
        }),
      (now) =>
        createGithubIssuesFake({
          now,
          repos:
            options.githubRepos ??
            parsedConfig.projects.flatMap(({ tracker }) =>
              tracker.type === 'github-issues' ? [tracker.repo] : [],
            ),
        }),
      ...parsedConfig.projects.flatMap(({ tracker }) =>
        tracker.type === 'jira' ? [(now: () => number) => createJiraFake({ now, tracker })] : [],
      ),
    ],
  });

  let fatal: ((err: unknown) => void) | undefined;
  options.registerFatal?.((err) => {
    fatal?.(err);
  });

  const startFake = (port?: number): Promise<FakeSlackApi> =>
    startFakeSlackApi({ now: () => clock.now(), ...(port === undefined ? {} : { port }) });
  /** Outlives each daemon: it closes only after the daemon using it has stopped. */
  let fake: FakeSlackApi | undefined;
  let current:
    | { daemon: InProcessDaemon; runner: ReturnType<typeof runnerController>; spur: FakeSpur }
    | undefined;
  let stopping: Promise<number> | undefined;
  /** A daemon a reset is stopping, until it stopped cleanly; stop() waits for its teardown. */
  let retiring: InProcessDaemon | undefined;
  /** Set when a reset failed; the stand then exits 1. */
  let failure: number | undefined;
  let resolveShutdownBegun: () => void = () => undefined;
  const shutdownBegun = new Promise<void>((resolve) => {
    resolveShutdownBegun = resolve;
  });
  let resolveExited: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  /** Starts a daemon with a new fake Spur, holding `spurState` when a snapshot is restored. */
  async function startDaemon(spurState?: FakeSpurState): Promise<NonNullable<typeof current>> {
    const spur = createFakeSpur({
      baseUrl: SPUR_BASE_URL,
      now: () => clock.now(),
      log,
      sessions: (['worker', 'orchestrator'] as const).map((role) => ({
        id: roles[role],
        project: ROLE_PROJECTS[role],
        branch: `stand-${role}`,
      })),
    });
    if (spurState !== undefined) spur.restore(spurState);
    const spurOrigin = new URL(SPUR_BASE_URL).origin;
    // Any other host goes to the real fetch, where the network guard refuses it.
    const standFetch: typeof fetch = (input, init) =>
      requestUrl(input).origin === spurOrigin ? spur.fetch(input, init) : fetch(input, init);
    // Only the runner reaches the GitHub and Jira fakes. `sessionFetcher` also carries doctor, its
    // link sample and Jira `/myself`, which no fake models.
    const runner = runnerController(fakes.wrap(standFetch));
    const daemon = await startInProcessDaemon({
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      paths,
      acquireLock,
      loadConfig,
      clock,
      stdout: { write: log },
      writeErr: log,
      ports: {
        startAdapters: runner.start,
        sessionFetcher: standFetch,
        spur: createSpurPort({ baseUrl: spurBaseUrl, fetch: standFetch }),
        ...(options.tick === undefined ? {} : { tick: options.tick }),
      },
      registerFatal: (handler) => {
        fatal = handler;
      },
    });
    const started = { daemon, runner, spur };
    // A daemon that exits outside reset and stop takes the stand down with it.
    void daemon.exited.then((code) => {
      if (current === started && stopping === undefined) void stop(code === 0 ? 1 : code);
    });
    return started;
  }

  let control: Control | undefined;
  const controlUrl = (): string => {
    if (control === undefined) throw new Error('The control endpoint is not running.');
    return control.url;
  };
  let manifest: StandManifest | undefined;
  /**
   * The scenario being seeded, then seeded: `entities` is set only once its seed resolved, and
   * only then does `stand.json` carry it and `wait scenario` consult its `settled`.
   */
  let scenario: { name: string; entities?: ScenarioEntities } | undefined;
  /** The last snapshot of each seeded scenario; a failed snapshot drops the scenario's record. */
  const snapshots = new Map<string, SnapshotRecord>();
  const snapshotDir = join(home, 'snapshots');
  /** Re-reads the migrations on every call, so a changed file changes the key at once. */
  const keyOf = (definition: Scenario): string =>
    snapshotKey(definition, readMigrations(options.migrationsDir ?? migrationsDir));
  /**
   * The snapshot of `name` a reset restores: its key still matches and none of its rows lapses
   * before the restored daemon, its replayed shifts and a settle wait are through. A missing file
   * is an IO fault the restore reports and stops on, not a reason to seed again.
   */
  function snapshotHit(name: string): SnapshotRecord | undefined {
    const record = snapshots.get(name);
    const definition = findScenario(name);
    if (record === undefined || definition === undefined) return undefined;
    const replayed = record.shifts.reduce((sum, shiftMs) => sum + shiftMs, 0);
    if (
      record.lapsesAt !== undefined &&
      clock.now() + replayed + FRESH_MARGIN_MS >= record.lapsesAt
    )
      return undefined;
    try {
      return record.key === keyOf(definition) ? record : undefined;
    } catch {
      // A key that cannot be computed now matches nothing; the seed then takes a new snapshot.
      return undefined;
    }
  }
  /** Aborts on stop, so a seed waiting on the board cannot hold shutdown. */
  const stopSignal = new AbortController();
  const writeCurrentManifest = (daemonUrl: string, controlUrl: string): void => {
    const self = procStat(process.pid);
    if (self === undefined) throw new Error('Cannot read this process from /proc.');
    manifest = {
      version: 1,
      id,
      home,
      pid: process.pid,
      pidStartTime: self.startTime,
      daemonUrl,
      controlUrl,
      controlToken,
      tokenPath,
      roles,
      ...(scenario?.entities === undefined
        ? {}
        : { scenario: { name: scenario.name, ...scenario.entities } }),
    };
    writeManifest(home, manifest);
  };

  async function check(
    condition: string,
  ): Promise<{ ok: true } | { ok: false; diagnostics: unknown }> {
    const running = current;
    if (running === undefined) return { ok: false, diagnostics: 'the daemon is restarting' };
    const { daemon, runner } = running;
    if (condition === 'scenario') {
      const seeded = scenario;
      if (seeded === undefined) return { ok: false, diagnostics: 'no scenario seeded' };
      const { entities } = seeded;
      if (entities === undefined) return { ok: false, diagnostics: `seeding ${seeded.name}` };
      const definition = findScenario(seeded.name);
      if (definition === undefined)
        return { ok: false, diagnostics: `unknown scenario ${seeded.name}` };
      try {
        return await definition.settled({
          board: boardFor(running).board,
          fakes: scenarioFakes,
          entities,
        });
      } catch (err) {
        return { ok: false, diagnostics: errorMessage(err) };
      }
    }
    if (condition === 'api-ready') {
      try {
        const response = await fetch(`${daemon.address}/v1/schema`, {
          signal: AbortSignal.timeout(1_000),
        });
        await response.body?.cancel();
        return response.status === 200
          ? { ok: true }
          : { ok: false, diagnostics: `GET /v1/schema answered ${String(response.status)}` };
      } catch (err) {
        return { ok: false, diagnostics: errorMessage(err) };
      }
    }
    if (condition === 'sources-polled') {
      const rows = await daemon.store.db.selectFrom('source_state').select('source').execute();
      const seen = new Set(rows.map((row) => row.source));
      const missing = required.filter((source) => !seen.has(source));
      return runner.polled() && missing.length === 0
        ? { ok: true }
        : { ok: false, diagnostics: { firstAttemptsDone: runner.polled(), missing } };
    }
    const pending = await daemon.store.db
      .selectFrom('outbox')
      .select(['id', 'kind', 'state'])
      .where('state', 'in', ['pending', 'in_flight'])
      .execute();
    return pending.length === 0 ? { ok: true } : { ok: false, diagnostics: { pending } };
  }

  const routes = {
    async wait(
      body: { condition: string; timeoutMs: number },
      signal: AbortSignal,
    ): Promise<RouteResult> {
      if (!(WAIT_CONDITIONS as readonly string[]).includes(body.condition))
        return { status: 400, body: { error: 'Unknown condition.', conditions: WAIT_CONDITIONS } };
      if (body.condition === 'scenario' && scenario === undefined)
        return {
          status: 400,
          body: { error: 'No scenario is seeded.', scenarios: scenarioNames(scenarios) },
        };
      const deadline = Date.now() + body.timeoutMs;
      for (;;) {
        const result = await check(body.condition);
        if (result.ok) return { status: 200, body: { condition: body.condition, ok: true } };
        if (signal.aborted || Date.now() >= deadline)
          return {
            status: 504,
            body: { condition: body.condition, ok: false, diagnostics: result.diagnostics },
          };
        await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
      }
    },
    async poll(body: { source?: string; timeoutMs?: number }): Promise<RouteResult> {
      if (body.source !== undefined && !required.includes(body.source))
        return { status: 400, body: { error: 'Unknown source.', sources: required } };
      const running = current;
      if (running === undefined)
        return { status: 503, body: { error: 'The daemon is not running.' } };
      const timeoutMs = body.timeoutMs ?? POLL_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, undefined);
      });
      try {
        const attempts = await Promise.race([running.runner.restart(), expired]);
        await running.daemon.tick();
        await running.daemon.outbox.pulse();
        if (attempts === undefined)
          return {
            status: 504,
            body: {
              error: `The poll did not finish in ${String(timeoutMs)} ms.`,
              note: 'A source is still waiting, usually on a fake set to hang or delay; the board ticked and pulsed anyway.',
            },
          };
        return {
          status: 200,
          body: {
            outcomes: attempts.map(({ source, outcome }) => ({
              source,
              outcome: outcome?.kind ?? 'aborted',
              ...(outcome?.kind === 'failed' ? { error: errorMessage(outcome.error) } : {}),
            })),
            note: 'poll restarts the whole adapter runner, whatever source was named: every source polls now, and backoff, gone entities and the stale window start over.',
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
    /** Moves the stand clock forward, then runs one board tick and one outbox pulse. */
    async clock(body: { shiftMs: number }): Promise<RouteResult> {
      if (!isShift(body.shiftMs)) return { status: 400, body: { error: SHIFT_REFUSAL } };
      const running = current;
      if (running === undefined)
        return { status: 503, body: { error: 'The daemon is not running.' } };
      offsetMs += body.shiftMs;
      await running.daemon.tick();
      await running.daemon.outbox.pulse();
      return {
        status: 200,
        body: {
          now: new Date(clock.now()).toISOString(),
          offsetMs,
          note: 'Timers stay real: each job sees the new time at its next run. The board ticked and pulsed once. The adapter runner kept its state; stand poll restarts it and its stale window.',
        },
      };
    },
    /**
     * Resets onto the scenario seeded last, restoring its snapshot, or seeding it again when its
     * scenario code or a migration changed; a plain reset without one.
     */
    reset(): Promise<RouteResult> {
      return restart(scenario?.name, { restore: true });
    },
    seed(body: { scenario: string }): Promise<RouteResult> {
      if (findScenario(body.scenario) === undefined)
        return Promise.resolve({
          status: 400,
          body: { error: 'Unknown scenario.', scenarios: scenarioNames(scenarios) },
        });
      return restart(body.scenario, { restore: false });
    },
    fake(body: { system: string; verb: string; args: unknown }): Promise<RouteResult> {
      if (body.system === 'github' || body.system === 'jira')
        return Promise.resolve(fakes.control(body));
      if (body.system !== 'spur')
        return Promise.resolve({
          status: 400,
          body: { error: 'Unknown fake system.', systems: ['spur', 'github', 'jira'] },
        });
      return Promise.resolve(
        current === undefined
          ? { status: 503, body: { error: 'The daemon is not running.' } }
          : current.spur.control(body.verb, body.args),
      );
    },
    violations(): Promise<RouteResult> {
      if (current === undefined)
        return Promise.resolve({ status: 503, body: { error: 'The daemon is not running.' } });
      const spur = current.spur.violations();
      const slack = fake?.violations() ?? [];
      const others = fakes.violations();
      const total = spur.total + slack.length + others.total;
      return Promise.resolve({
        status: total === 0 ? 200 : 409,
        body: {
          total,
          items: [
            ...spur.items.map((item) => ({ system: 'spur', ...item })),
            ...slack.map((item) => ({ system: 'slack', ...item })),
            ...others.items,
          ],
        },
      });
    },
    async slackOutbox(): Promise<RouteResult> {
      const api = runningFake();
      if (api === undefined) return { status: 503, body: { error: 'The daemon is not running.' } };
      const messages = await api.platform.messages();
      return {
        status: 200,
        body: {
          messages: messages.map((message, index) => ({ n: index + 1, ...message })),
          violations: api.violations(),
        },
      };
    },
    async slackClick(body: {
      message: number;
      button: string;
      text?: string;
    }): Promise<RouteResult> {
      const api = runningFake();
      if (api === undefined) return { status: 503, body: { error: 'The daemon is not running.' } };
      const target = (await api.platform.messages())[body.message - 1];
      if (target === undefined)
        return { status: 404, body: { error: `No message ${String(body.message)}.` } };
      const author = userIdSchema.parse(OPERATOR_SLACK);
      let input: ClickInput;
      if (body.button === ANSWER_BUTTON) {
        if (body.text === undefined || body.text.trim() === '')
          return { status: 400, body: { error: 'answer needs text.' } };
        input = { kind: 'message', conversation: target.conversation, author, text: body.text };
      } else {
        if (body.text !== undefined)
          return { status: 400, body: { error: 'Only answer takes text.' } };
        if (!target.actions.includes(body.button))
          return {
            status: 400,
            body: { error: 'The message has no such button.', actions: target.actions },
          };
        input = { kind: 'action', message: target.message, actionId: body.button, author };
      }
      return boundedClick(api, input);
    },
  };

  /**
   * The reset body: stops the daemon, restores the home with the config of `name` and starts a
   * fresh daemon, then seeds `name` when given. With `restore`, a matching snapshot of `name`
   * replaces the seed: its database and fake state come back and no seed runs. A failed seed
   * leaves the stand running unseeded; a failed restore stops the stand.
   */
  async function restart(
    name: string | undefined,
    { restore }: { restore: boolean },
  ): Promise<RouteResult> {
    const running = current;
    if (running === undefined)
      return { status: 503, body: { error: 'The daemon is not running.' } };
    const hit = restore && name !== undefined ? snapshotHit(name) : undefined;
    current = undefined;
    // Recorded before the restart, so `wait scenario` says what is being seeded.
    scenario = name === undefined ? undefined : { name };
    // Shared with stop(): a stop that races this reset still waits for this daemon.
    retiring = running.daemon;
    let violationsCleared = running.spur.violations().total;
    // First, so a held send cannot outlast the daemon's shutdown timeout.
    running.spur.close();
    try {
      const code = await running.daemon.stop();
      if (code !== 0) {
        // The old daemon may still hold the store and its lock: leave every file as it is.
        failure = 1;
        void stop();
        return {
          status: 500,
          body: {
            error: `The daemon did not stop cleanly (exit code ${String(code)}); reset changed no file and the stand is stopping.`,
          },
        };
      }
      retiring = undefined;
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(`${paths.dbFile}${suffix}`, { force: true });
      const previous = fake;
      if (previous === undefined) throw new Error('The fake Slack API is not running.');
      // The same port keeps SLACK_API_URL stable; a new instance drops everything it held.
      const port = Number(new URL(previous.url).port);
      fake = undefined;
      // After the daemon stopped, so a call made during its shutdown is counted too.
      violationsCleared += previous.violations().length;
      // The retiring fake may have issued a ts past the snapshot's: never issue one again.
      const { lastMicros } = previous.state();
      await previous.close();
      fake = await startFake(port);
      if (hit !== undefined)
        fake.restore({ ...hit.slack, lastMicros: Math.max(lastMicros, hit.slack.lastMicros) });
      await writeHome(fake.url, name, hit?.file);
      violationsCleared += fakes.violations().total;
      // Before the new runner starts, so its first poll sees clean state.
      fakes.reset();
      if (hit !== undefined) fakes.restore(hit.fakes);
      current = await startDaemon(hit?.spur);
      if (name !== undefined && hit !== undefined) scenario = { name, entities: hit.entities };
      // State a seed reaches through the clock lives in the runner, not the snapshot: a fresh
      // runner gets there again only through the same shifts. The clock still only moves forward.
      for (const shiftMs of hit?.shifts ?? []) {
        const shifted = await routes.clock({ shiftMs });
        if (shifted.status !== 200)
          throw new Error(`The restored clock shift answered ${String(shifted.status)}.`);
      }
      writeCurrentManifest(current.daemon.address, controlUrl());
    } catch (err) {
      failure = 1;
      void stop();
      return { status: 500, body: { error: errorMessage(err) } };
    }
    const started = current;
    const restarted = { daemonUrl: started.daemon.address, violationsCleared };
    if (name === undefined) return { status: 200, body: restarted };
    if (hit !== undefined)
      return {
        status: 200,
        body: {
          ...restarted,
          scenario: { name, ...hit.entities },
          snapshot: 'restored' satisfies SnapshotOutcome,
        },
      };
    try {
      const { entities, snapshot } = await seedScenario(name, started);
      writeCurrentManifest(started.daemon.address, controlUrl());
      return { status: 200, body: { ...restarted, scenario: { name, ...entities }, snapshot } };
    } catch (err) {
      // The stand keeps serving, unseeded: stand.json loses the scenario with `scenario` cleared.
      scenario = undefined;
      writeCurrentManifest(started.daemon.address, controlUrl());
      return {
        status: 500,
        body: { error: errorMessage(err), scenario: name, note: SEED_FAILED_NOTE },
      };
    }
  }

  /**
   * The board client of a running daemon; `notes` collects its direct writes and `onShift` hears
   * every clock shift it made.
   */
  function boardFor(running: NonNullable<typeof current>, onShift?: (shiftMs: number) => void) {
    return createBoardClient({
      daemonUrl: running.daemon.address,
      operatorToken,
      roles,
      home,
      db: running.daemon.store.db,
      poll: () => routes.poll({}),
      clock: async (shiftMs) => {
        const result = await routes.clock({ shiftMs });
        if (result.status === 200) onShift?.(shiftMs);
        return result;
      },
      check,
      signal: stopSignal.signal,
    });
  }

  const scenarioFakes = createScenarioFakes(routes);

  /**
   * Seeds `name` on the running daemon, records it with what it named and takes its snapshot.
   * Runs inside the control queue at most once at a time and never calls an HTTP control route,
   * which would wait on that queue. A throw leaves `scenario` as it was: the caller clears it.
   */
  async function seedScenario(
    name: string,
    running: NonNullable<typeof current>,
  ): Promise<{ entities: ScenarioEntities; snapshot: SnapshotOutcome }> {
    const definition = findScenario(name);
    if (definition === undefined) throw new Error(`Unknown scenario ${name}.`);
    scenario = { name };
    const shifts: number[] = [];
    const { board, notes } = boardFor(running, (shiftMs) => shifts.push(shiftMs));
    const seeded = await definition.seed(board, scenarioFakes, { now: () => clock.now() });
    const entities =
      notes.length === 0 ? seeded : { ...seeded, direct: [...(seeded.direct ?? []), ...notes] };
    scenario = { name, entities };
    return { entities, snapshot: await takeSnapshot(name, definition, running, entities, shifts) };
  }

  /**
   * When the first row of the running daemon's database lapses on its own: the earliest expiry of
   * a pending token request. Read before the copy: only a seed requests a token, so the copy holds
   * no request this misses, and one decided in between makes the bound only earlier.
   */
  async function lapsesAt(running: NonNullable<typeof current>): Promise<number | undefined> {
    const row = await running.daemon.store.db
      .selectFrom('operator_token')
      .select((eb) => eb.fn.min('expires_at').as('first'))
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return row?.first == null ? undefined : Date.parse(row.first);
  }

  /**
   * Saves the database and every fake's state for `name`, in one synchronous block after reading
   * when its rows lapse, so nothing changes between the two. A failure is logged and drops the
   * scenario's record, so a later reset seeds again rather than restoring an older snapshot; the
   * seed still counts.
   */
  async function takeSnapshot(
    name: string,
    definition: Scenario,
    running: NonNullable<typeof current>,
    entities: ScenarioEntities,
    shifts: number[],
  ): Promise<'taken' | 'failed'> {
    const previous = snapshots.get(name);
    snapshots.delete(name);
    try {
      const lapses = await lapsesAt(running);
      if (fake === undefined) throw new Error('The fake Slack API is not running.');
      const key = keyOf(definition);
      const file = join(snapshotDir, `${name}-${key}.sqlite`);
      const record: SnapshotRecord = {
        key,
        file,
        entities: structuredClone(entities),
        fakes: fakes.state(),
        spur: running.spur.state(),
        slack: fake.state(),
        shifts,
        lapsesAt: lapses,
      };
      saveSnapshot(paths.dbFile, file);
      snapshots.set(name, record);
      if (previous !== undefined && previous.file !== file) rmSync(previous.file, { force: true });
      return 'taken';
    } catch (err) {
      log(`stand snapshot failed: ${errorMessage(err)}\n`);
      return 'failed';
    }
  }

  /** The fake, unless a reset or a stop has taken the daemon away from it. */
  function runningFake(): FakeSlackApi | undefined {
    return current === undefined ? undefined : fake;
  }

  /**
   * A probe first: the fake reports success for an action sent on a closed socket, and an action
   * must not run once the bound has passed. Ephemeral replies are awaited before the ack.
   */
  async function boundedClick(api: FakeSlackApi, input: ClickInput): Promise<RouteResult> {
    const bound = AbortSignal.timeout(CLICK_TIMEOUT_MS);
    const noAck: RouteResult = {
      status: 504,
      body: { error: `No Socket Mode ack in ${String(CLICK_TIMEOUT_MS / 1_000)} s.` },
    };
    const run = async (): Promise<RouteResult> => {
      try {
        await api.emitEnvelope('probe', {});
      } catch (err) {
        return { status: 503, body: { error: errorMessage(err) } };
      }
      if (bound.aborted) return noAck;
      const seen = api.requests().length;
      await api.platform.inject(input);
      const responses = api
        .requests()
        .slice(seen)
        .filter((request) => request.method === 'chat.postEphemeral')
        .map((request) => request.params['text']);
      return { status: 200, body: { ok: true, responses } };
    };
    const expired = new Promise<RouteResult>((resolve) => {
      bound.addEventListener('abort', () => {
        resolve(noAck);
      });
    });
    return Promise.race([run(), expired]);
  }

  /**
   * Stops the stand once. The fakes behind the in-process fetch let go first, so no held request
   * stalls what follows; then control, which waits for a queued reset; then the fake Spur of any
   * daemon that reset started, and the current daemon, and only then the fake Slack API. The log
   * stays open and `exited` waits until the current daemon and any daemon a reset retired have
   * released their store and lock. A failed reset makes the result 1.
   */
  function stop(code?: number): Promise<number> {
    resolveShutdownBegun();
    stopSignal.abort();
    stopping ??= (async () => {
      fakes.release();
      current?.spur.close();
      await control?.close();
      const running = current;
      current = undefined;
      running?.spur.close();
      const daemonCode = running === undefined ? 0 : await running.daemon.stop();
      await Promise.all([running?.daemon.teardown, retiring?.teardown]);
      try {
        await fake?.close();
      } catch (err) {
        failure ??= 1;
        log(`The fake Slack API did not close: ${errorMessage(err)}\n`);
      }
      fake = undefined;
      closeSync(logFd);
      const result = code ?? failure ?? daemonCode;
      resolveExited(result);
      return result;
    })();
    return stopping;
  }

  try {
    fake = await startFake();
    await writeHome(fake.url, options.scenario);
    current = await startDaemon();
    control = await startControl({ token: controlToken, routes });
    if (options.scenario !== undefined) {
      try {
        await seedScenario(options.scenario, current);
      } catch (err) {
        scenario = undefined;
        throw err;
      }
    }
    writeCurrentManifest(current.daemon.address, control.url);
  } catch (err) {
    // Closes control, stops the daemon if it started and closes the log.
    await stop();
    discardHome();
    throw err;
  }
  return {
    manifest: () => {
      if (manifest === undefined) throw new Error('The stand has no manifest yet.');
      return manifest;
    },
    stop: () => stop(),
    exited,
    stopping: shutdownBegun,
  };
}

/**
 * One approved operator token, as an operator approval would leave it, and a running session
 * snapshot for each role session, so worker and orchestrator calls resolve before the first Spur
 * poll. The fake lists the same sessions, so a poll keeps them.
 */
async function seedIdentities(
  dbFile: string,
  token: string,
  roles: StandManifest['roles'],
  nowMs: number,
): Promise<void> {
  const store = openStore(dbFile);
  try {
    await store.transaction(async (trx) => {
      const at = new Date(nowMs).toISOString();
      for (const role of ['worker', 'orchestrator'] as const) {
        const id = roles[role];
        const spurProject = ROLE_PROJECTS[role];
        await trx
          .insertInto('session_snapshot')
          .values({
            id,
            spur_project: spurProject,
            branch: `stand-${role}`,
            pr: null,
            raw_state: 'running',
            state: 'running',
            first_seen: at,
            last_seen: at,
            ended_at: null,
            end_reason: null,
            // Valid facts: status.get parses the detail of every session it lists.
            detail: JSON.stringify({
              id,
              spurProject,
              branch: `stand-${role}`,
              pr: null,
              links: {},
              lifecycle: 'running',
              health: 'working',
              healthSince: at,
              lastActivityAt: null,
              endedAt: null,
              endReason: null,
            }),
            source: 'spur',
            observed_at: at,
          })
          .execute();
      }
      const item = await trx
        .insertInto('operator_item')
        .values({
          item_key: 'token:stand',
          raise_no: 1,
          kind: 'token_request',
          text: 'Approve operator token stand',
          url: '',
          task_id: null,
          block_id: null,
          raised_at: at,
          cleared_at: at,
          line_outbox_id: null,
          fingerprint: null,
          fact_at: null,
          source: null,
          priority: null,
          inbound_event_json: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('operator_token')
        .values({
          name: 'stand',
          hash: createHash('sha256').update(token).digest('hex'),
          folder: 'stand',
          host: 'stand',
          status: 'approved',
          requested_at: at,
          expires_at: at,
          decided_at: at,
          item_id: item.id,
        })
        .execute();
    });
  } finally {
    await store.close();
  }
}
