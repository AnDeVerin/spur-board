// `pnpm stand <command>`: a disposable board for agents and tests, one process per stand.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolvePaths } from '@spur-board/daemon/in-process';
import { scrubEnv } from '@spur-board/testkit';
import { z } from 'zod';
import { callLocal, MAX_SHIFT_MS } from './control.ts';
import { parseFakeArgs } from './fake-spur.ts';
import { liveBoardDirs, proxyRefusal, refusal, StandRefusedError } from './guards.ts';
import {
  isLive,
  isStandDir,
  watchProcess,
  liveStands,
  MANIFEST_FILE,
  prune,
  procStat,
  removeStand,
  STAND_PREFIX,
  standAt,
  type StandManifest,
} from './manifest.ts';
import {
  BOARD_CLI,
  blockedBoardCommand,
  roleEnv,
  ROLES,
  standEnv,
  TRUSTED_PATH,
  type StandRole,
} from './roles.ts';
import { foregroundStop } from './foreground.ts';
import { scenarioNames } from './scenarios/index.ts';
import { pickWebPort, startStand, WAIT_CONDITIONS } from './stand.ts';

const SELF = fileURLToPath(import.meta.url);
// Read as soon as this module runs: a parent that exits while the stand starts must still stop
// it. A parent gone before Node has loaded this module is not seen.
const STARTUP_PARENT = process.ppid;
const UP_TIMEOUT_MS = 30_000;
const DOWN_TIMEOUT_MS = 15_000;
/** Below DOWN_TIMEOUT_MS, so a hung foreground stand exits before `down` escalates to SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;
const PARENT_CHECK_MS = 1_000;
const WAIT_DEFAULT_S = 30;
const WAIT_MAX_S = 600;
const FAKE_TIMEOUT_MS = 10_000;
const DEFAULT_FAKE_REPO = 'stand-org/board';
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

const USAGE = `Usage: pnpm stand <command>

  up [--port N] [--web-port N] [--scenario S] [--foreground [--watch-pid PID]]
                                  start a stand, seeded with scenario S when given. The API port
                                  is 0 or a port from the live stand.portRange (default 0). When
                                  the live web.publicOrigin has {port}, the web port comes from
                                  that range, by default the first free one, and up prints the
                                  webUrl. In the foreground it stops with its parent; a launcher
                                  that may exit first passes itself:
                                  pnpm stand up --foreground --watch-pid $$
  down                            stop the stand and remove its home
  status [--json]                 show the stand and whether its API answers
  logs [--stand]                  print the daemon log (--stand: the stand process log)
  board [--as role] <args...>     run the board CLI against the stand (${ROLES.join(', ')})
  mcp [--as role]                 run the board MCP server against the stand
  wait <condition> [--timeout s]  wait for ${WAIT_CONDITIONS.join(', ')} (default ${String(WAIT_DEFAULT_S)} s)
  poll [source]                   restart every source's poll now (source is only checked to
                                  exist), then tick and pulse the outbox
  reset                           stop the daemon, restore the home and start it again with the
                                  last seeded scenario's database and fake snapshot, seeding it
                                  again when its code or a migration changed or the clock passed
                                  a pending token request's expiry; restored rows keep their
                                  seeded times. This drops the violation log: read it first
  clock +<n><s|m|h|d>             move the stand clock forward (never back), then tick and pulse
                                  the outbox; timers stay real. stand poll after a shift
                                  restarts the stale window
  seed <scenario>                 reset onto the scenario's config and seed it with fresh times,
                                  replacing its snapshot; then wait scenario. Scenarios: ${scenarioNames().join(', ')}
  fake slack outbox               list the messages posted to the fake Slack and any call to a
                                  Slack method it lacks
  fake slack click <n> <button> [--text <text>]
                                  press a button on outbox message n as the operator. The button
                                  answer takes --text: a thread reply, as Slack has no such button
  fake slack post --text <text>   post a new operator message in the orchestrators channel;
                                  prints its fake Slack message number, the <n> click takes
  fake spur session <id> [--state s] [--status s] [--project p] [--branch b] [--retain]
                    [--queue hold|deliver]
                                  create or update a session in the fake Spur; --queue hold keeps
                                  later sends in its Spur queue, --queue deliver empties it
  fake spur restart               change the Spur instance id
  fake spur fail <delay|refuse|hang|5xx> [--route list|detail|send|all] [--ms n] [--status 5xx]
                                  fail a route until clear; delay needs --ms (1-60000)
  fake spur clear                 drop every failure rule
  fake spur inspect               print sessions, rules, requests, sends and violations
  fake github fail <mode> [--times n]
                                  delay <ms>, refuse, hang, auth (401), rate-limit <seconds>,
                                  server-error [status] or clear; lasts until clear or reset, or
                                  for n requests with --times
  fake github inspect             print the GraphQL requests the fake answered
  fake github pr <n> <verb> [--repo owner/name]
                                  create [--seed '<json>'], approve, ci-red, ci-green, merge,
                                  close, reopen, conflict or push <sha>; reopen requires CLOSED;
                                  --repo defaults to ${DEFAULT_FAKE_REPO}
  fake github pr <n> comment [--author login] [--bot]
  fake github pr <n> review <approved|changes-requested|commented> [--author login] [--bot]
                                  [--threads n]
                                  add a comment, or a review on the head, at the stand clock;
                                  the author defaults to stand-reviewer, or stand-bot with --bot;
                                  --threads opens n unresolved review threads with the review
  fake github pr <n> resolve [--thread id]
                                  resolve the review thread id (PRRT_<n>_<i>), or every thread
  fake github pr <n> edit <index>
                                  edit comment <index> (0 is the oldest) at the stand clock;
                                  the pull request's updatedAt stays
  fake github issue <n> <verb> [--repo owner/name]
                                  open [--title t] (create, or reopen a closed issue), close,
                                  label [name...] (replaces the labels; none clears them) or
                                  milestone [title] (none clears it); --repo as for pr
  fake jira issue <KEY> [--status s] [--title t]
                                  create ticket KEY (at To Do), or change its status or title;
                                  statuses: To Do, Ready for Dev, In Progress, In Review, Done
  fake jira fail <mode> [--times n]
                                  the modes of fake github fail, for Jira alone
  violations                      print requests no fake models; exit 1 if there are any

Every command but up takes --home <dir> to pick one of several stands.
Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.
`;

const MCP_USAGE = `Usage: pnpm stand mcp [--as ${ROLES.join('|')}] [--home <dir>]

Serve the board MCP server over stdio against the stand, as the given role
(default operator). Takes no other arguments.
`;

class UsageError extends Error {}

const SHIFT_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses `clock` arguments: exactly one `+<n><s|m|h|d>` shift, and `--home`. */
function parseClockArgs(args: string[]): { shiftMs: number; home: string | undefined } {
  // A `-5m` would reach parseArgs as an unknown option; name the real rule instead.
  if (args.some((arg) => /^-\d/.test(arg)))
    throw new UsageError('the stand clock only moves forward; pass +<n><s|m|h|d>');
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { home: { type: 'string' } },
  });
  if (positionals.length !== 1) throw new UsageError('clock takes one shift, +<n><s|m|h|d>');
  const match = /^\+([1-9]\d*)([smhd])$/.exec(positionals[0] ?? '');
  if (match === null)
    throw new UsageError(
      'clock takes a shift of +<n><s|m|h|d> with n above 0; the stand clock only moves forward',
    );
  const shiftMs = Number(match[1]) * SHIFT_UNIT_MS[match[2] as keyof typeof SHIFT_UNIT_MS];
  if (shiftMs > MAX_SHIFT_MS) throw new UsageError('clock moves at most 365 days per call');
  return { shiftMs, home: values.home };
}

const FAKE_PR_VERBS = [
  'create',
  'approve',
  'ci-red',
  'ci-green',
  'merge',
  'close',
  'reopen',
  'conflict',
  'push',
  'comment',
  'review',
  'resolve',
  'edit',
];
const REVIEW_STATES = new Map([
  ['approved', 'APPROVED'],
  ['changes-requested', 'CHANGES_REQUESTED'],
  ['commented', 'COMMENTED'],
]);
const FAKE_ISSUE_VERBS = ['open', 'close', 'label', 'milestone'];

const out = (text: string): void => {
  process.stdout.write(text);
};
const err = (text: string): void => {
  process.stderr.write(text);
};

function root(): string {
  return realpathSync(tmpdir());
}

function parsePort(value: string | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a number, got ${value}`);
  return Number(value);
}

/** The stand a command acts on: `--home`, else the single live stand of this user. */
function target(home: string | undefined): StandManifest {
  const dir = root();
  if (home !== undefined) {
    const manifest = standAt(home, dir);
    if (manifest === undefined)
      throw new UsageError(
        `${home} is not a stand directory under ${dir} with a ${MANIFEST_FILE} naming it`,
      );
    return manifest;
  }
  const live = liveStands(dir);
  const [only] = live;
  if (only === undefined || live.length > 1)
    throw new UsageError(
      live.length === 0
        ? `No live stand under ${dir}; run pnpm stand up`
        : `Several live stands; pick one with --home:\n${live.map((m) => `  ${m.home}`).join('\n')}`,
    );
  return only;
}

function publicView(manifest: StandManifest): Record<string, unknown> {
  const { id, home, pid, daemonUrl, webUrl, controlUrl, scenario } = manifest;
  return {
    id,
    home,
    pid,
    daemonUrl,
    ...(webUrl === undefined ? {} : { webUrl }),
    controlUrl,
    ...(scenario === undefined ? {} : { scenario }),
  };
}

/** The name, after checking it is a known scenario. */
function scenarioName(value: string | undefined): string {
  const names = scenarioNames();
  if (value === undefined || !names.includes(value))
    throw new UsageError(`Unknown scenario ${value ?? '(none)'}; use one of ${names.join(', ')}`);
  return value;
}

async function control(manifest: StandManifest, route: string, body: unknown, timeoutMs: number) {
  const response = await callLocal(`${manifest.controlUrl}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${manifest.controlToken}` },
    body: JSON.stringify(body),
    timeoutMs,
  });
  out(response.body.endsWith('\n') ? response.body : `${response.body}\n`);
  return response.status >= 200 && response.status < 300 ? 0 : 1;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Removes verified-dead stands under the root and says which. */
function pruneDead(): void {
  for (const { dir, result } of prune(root(), liveBoardDirs(process.env, homedir())))
    if (result === 'removed') err(`removed dead stand ${dir}\n`);
}

/**
 * The first free stand web port, or undefined with a note on stderr when the live
 * `web.publicOrigin` has no `{port}`: the stand then runs API-only.
 */
async function defaultWebPort(
  port: number,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number | undefined> {
  const webPort = await pickWebPort({ port, env, osHome: homedir() });
  if (webPort === undefined)
    err(
      `No stand web URL: it needs web.publicOrigin with {port} in the live config ${resolvePaths(env, homedir()).configFile}. The stand runs API-only.\n`,
    );
  return webPort;
}

async function upForeground(options: {
  port: number;
  webPort?: number;
  /** The live BOARD_HOME of the `up` that spawned this detached child. */
  liveHome?: string;
  scenario?: string;
  home?: string;
  detached: boolean;
  watchPid?: number;
}) {
  // With --watch-pid the launcher names the process to outlive; else the parent seen at load.
  let parentGone: () => boolean = () => process.ppid !== STARTUP_PARENT;
  if (options.watchPid !== undefined) {
    const watch = watchProcess(options.watchPid);
    if (watch === undefined)
      throw new Error(`The watched process ${String(options.watchPid)} is already gone.`);
    parentGone = watch;
  }
  // The live BOARD_HOME reaches a detached child through argv, never its environment.
  const env = {
    ...process.env,
    ...(options.liveHome === undefined ? {} : { BOARD_HOME: options.liveHome }),
  };
  const execArgv = [...process.execArgv];
  const refused =
    proxyRefusal({ env, execArgv }) ??
    refusal({
      root: root(),
      port: options.port,
      webPort: options.webPort,
      env,
      osHome: homedir(),
    });
  if (refused !== undefined) throw new StandRefusedError(refused);
  // A detached child takes the port its `up` picked, or none.
  const webPort =
    options.webPort ?? (options.detached ? undefined : await defaultWebPort(options.port, env));
  // A detached child was spawned by an `up` that already pruned.
  if (!options.detached) pruneDead();
  scrubEnv(process.env);
  // The daemon lock spawns flock by name; only trusted directories may provide it.
  process.env['PATH'] = TRUSTED_PATH;
  // This process must end: any stop arms a deadline, past which the CLI exits 1 even if startup
  // or a module stop hangs. Watching starts before startup, so a launcher that leaves while the
  // stand starts still counts. A detached child does not watch: its parent exits by design.
  const stopper = foregroundStop({
    watchParent: !options.detached,
    parentGone,
    timeoutMs: STOP_TIMEOUT_MS,
    onTimeout: () => {
      err(`The stand did not stop within ${String(STOP_TIMEOUT_MS / 1_000)} s; exiting.\n`);
    },
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, stopper.request);
  stopper.checkParent();
  if (!options.detached) setInterval(stopper.checkParent, PARENT_CHECK_MS).unref();
  const result = await Promise.race([
    startStand({
      root: root(),
      home: options.home,
      port: options.port,
      webPort,
      scenario: options.scenario,
      env,
      execArgv,
      osHome: homedir(),
      registerFatal: (handler) => {
        const fatal = stopper.fatal(handler);
        process.on('uncaughtException', fatal);
        process.on('unhandledRejection', fatal);
      },
    }),
    stopper.expired,
  ]);
  if (typeof result === 'number') return result;
  out(`${JSON.stringify(publicView(result.manifest()))}\n`);
  return stopper.attach(result);
}

async function up(
  port: number,
  requestedWebPort: number | undefined,
  scenario: string | undefined,
): Promise<number> {
  const dir = root();
  const refused = refusal({
    root: dir,
    port,
    webPort: requestedWebPort,
    env: process.env,
    osHome: homedir(),
  });
  if (refused !== undefined) throw new StandRefusedError(refused);
  const webPort = requestedWebPort ?? (await defaultWebPort(port, process.env));
  const liveHome = process.env['BOARD_HOME'] ?? '';
  pruneDead();
  const home = mkdtempSync(join(dir, STAND_PREFIX));
  mkdirSync(join(home, 'logs'), { mode: 0o700 });
  const logFile = join(home, 'logs', 'stand.log');
  const log = openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [
      SELF,
      'up',
      '--foreground',
      '--detached',
      '--home',
      home,
      '--port',
      String(port),
      ...(webPort === undefined ? [] : ['--web-port', String(webPort)]),
      ...(liveHome === '' ? [] : ['--live-home', liveHome]),
      ...(scenario === undefined ? [] : ['--scenario', scenario]),
    ],
    { detached: true, env: standEnv(process.env), stdio: ['ignore', log, log] },
  );
  let exitSeen = false;
  // A function, so each check after an await reads the flag anew.
  const exited = (): boolean => exitSeen;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exitSeen = true;
      resolve();
    });
  });
  child.unref();
  const deadline = Date.now() + UP_TIMEOUT_MS;
  while (Date.now() < deadline && !exited()) {
    const manifest = standAt(home, dir);
    if (manifest !== undefined) {
      out(`${JSON.stringify(publicView(manifest))}\n`);
      return 0;
    }
    await sleep(100);
  }
  err(`The stand did not start${exited() ? '' : ' in time'}. Log:\n`);
  err(`${readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n')}\n`);
  // The child may be writing to its home right now: it must be gone before the home is removed.
  const killGroup = (signal: NodeJS.Signals): void => {
    if (exited() || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  const exitWithin = (ms: number): Promise<void> => Promise.race([exit, sleep(ms)]);
  killGroup('SIGTERM');
  await exitWithin(DOWN_TIMEOUT_MS);
  killGroup('SIGKILL');
  await exitWithin(5_000);
  if (!exited()) {
    err(`Kept ${home}: the stand process ${String(child.pid)} did not exit.\n`);
    return 1;
  }
  // This invocation created the home, so it removes it; it has no manifest for removeStand.
  if (isStandDir(home, dir)) rmSync(home, { recursive: true, force: true });
  return 1;
}

async function waitGone(manifest: StandManifest, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isLive(manifest)) return true;
    await sleep(100);
  }
  return !isLive(manifest);
}

/** Signals the stand's group (or pid) only while the pid still has the manifest's start time. */
function signalStand(manifest: StandManifest, signal: NodeJS.Signals): void {
  const stat = procStat(manifest.pid);
  if (stat?.startTime !== manifest.pidStartTime) return;
  try {
    process.kill(stat.pgrp === manifest.pid ? -manifest.pid : manifest.pid, signal);
  } catch {
    // Gone between the check and the signal.
  }
}

async function down(manifest: StandManifest): Promise<number> {
  signalStand(manifest, 'SIGTERM');
  if (!(await waitGone(manifest, DOWN_TIMEOUT_MS))) {
    signalStand(manifest, 'SIGKILL');
    await waitGone(manifest, 5_000);
  }
  const result = removeStand(manifest.home, root(), liveBoardDirs(process.env, homedir()));
  if (result !== 'removed') {
    err(`Kept ${manifest.home}: ${result.kept}\n`);
    return 1;
  }
  out(`stopped and removed ${manifest.home}\n`);
  return 0;
}

/** The size of the stand's violation log; null when its control endpoint does not say. */
async function violationCount(manifest: StandManifest): Promise<number | null> {
  try {
    const response = await callLocal(`${manifest.controlUrl}/violations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manifest.controlToken}` },
      body: '{}',
      timeoutMs: 2_000,
    });
    if (response.status !== 200 && response.status !== 409) return null;
    return z.object({ total: z.number() }).parse(JSON.parse(response.body)).total;
  } catch {
    return null;
  }
}

async function status(manifest: StandManifest, json: boolean): Promise<number> {
  let apiReady = false;
  try {
    const response = await callLocal(`${manifest.daemonUrl}/v1/schema`, {
      method: 'GET',
      timeoutMs: 2_000,
    });
    apiReady = response.status === 200;
  } catch {
    apiReady = false;
  }
  const view = {
    ...publicView(manifest),
    alive: isLive(manifest),
    apiReady,
    violations: await violationCount(manifest),
  };
  out(
    json
      ? `${JSON.stringify(view)}\n`
      : `${Object.entries(view)
          // An object (the scenario) prints as JSON; null prints as null either way.
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
          )
          .join('\n')}\n`,
  );
  return 0;
}

function role(value: string | undefined): StandRole {
  if (value === undefined) return 'operator';
  if (!(ROLES as readonly string[]).includes(value))
    throw new UsageError(`--as must be one of ${ROLES.join(', ')}`);
  return value as StandRole;
}

/** Splits the stand's own leading `--home` and `--as` from the arguments passed through. */
function leading(args: readonly string[]): { home?: string; as?: string; rest: string[] } {
  const result: { home?: string; as?: string; rest: string[] } = { rest: [] };
  let i = 0;
  for (; i < args.length; i += 2) {
    const name = args[i];
    if (name !== '--home' && name !== '--as') break;
    const value = args[i + 1];
    if (value === undefined) throw new UsageError(`${name} needs a value`);
    if (name === '--home') result.home = value;
    else result.as = value;
  }
  result.rest = args.slice(i);
  return result;
}

function runBoard(manifest: StandManifest, as: StandRole, args: string[]): Promise<number> {
  const child = spawn(process.execPath, [BOARD_CLI, ...args], {
    env: roleEnv(manifest, as, process.env),
    stdio: 'inherit',
  });
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

function wholeNumber(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value))
    throw new UsageError(`${name} must be a whole number, got ${value ?? 'nothing'}`);
  return Number(value);
}

function failureBody(args: readonly string[]): Record<string, unknown> {
  const [mode, value, ...extra] = args;
  const arity = (count: number): void => {
    if (extra.length > 0 || (count === 0 && value !== undefined))
      throw new UsageError(`fail ${mode ?? ''} takes ${String(count)} value(s)`);
  };
  switch (mode) {
    case 'delay':
      arity(1);
      return { mode, ms: wholeNumber(value, 'delay') };
    case 'rate-limit':
      arity(1);
      return { mode, seconds: wholeNumber(value, 'rate-limit') };
    case 'server-error':
      arity(1);
      return value === undefined ? { mode } : { mode, status: wholeNumber(value, 'status') };
    case 'refuse':
    case 'hang':
    case 'auth':
    case 'clear':
      arity(0);
      return { mode };
    case undefined:
    default:
      throw new UsageError(
        'fail needs delay <ms>, refuse, hang, auth, rate-limit <seconds>, server-error [status] or clear',
      );
  }
}

function seedOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError('--seed must be JSON');
  }
}

function prBody(
  args: readonly string[],
  values: {
    repo?: string | undefined;
    seed?: string | undefined;
    author?: string | undefined;
    bot?: boolean | undefined;
    threads?: string | undefined;
    thread?: string | undefined;
  },
): Record<string, unknown> {
  const [number, verb, value, ...extra] = args;
  if (number === undefined || !/^[1-9]\d*$/.test(number))
    throw new UsageError('pr needs a pull request number');
  if (verb === undefined) throw new UsageError('pr needs a verb');
  if (!FAKE_PR_VERBS.includes(verb))
    throw new UsageError(`pr verb must be one of ${FAKE_PR_VERBS.join(', ')}`);
  const takesValue = verb === 'push' || verb === 'review' || verb === 'edit';
  if (extra.length > 0 || takesValue !== (value !== undefined))
    throw new UsageError(
      verb === 'push'
        ? 'push needs one sha'
        : verb === 'review'
          ? `review needs one state: ${[...REVIEW_STATES.keys()].join(', ')}`
          : verb === 'edit'
            ? 'edit needs one comment index'
            : `${verb} takes no value`,
    );
  if (verb === 'edit' && !/^(0|[1-9]\d*)$/.test(value ?? ''))
    throw new UsageError('edit needs a comment index: 0 or a positive integer');
  const state = verb === 'review' && value !== undefined ? REVIEW_STATES.get(value) : undefined;
  if (verb === 'review' && state === undefined)
    throw new UsageError(`review state must be one of ${[...REVIEW_STATES.keys()].join(', ')}`);
  if (values.seed !== undefined && verb !== 'create')
    throw new UsageError('--seed goes only with create');
  const feedback = verb === 'comment' || verb === 'review';
  if (!feedback && (values.author !== undefined || values.bot !== undefined))
    throw new UsageError('--author and --bot go only with comment or review');
  if (values.threads !== undefined && verb !== 'review')
    throw new UsageError('--threads goes only with review');
  if (values.threads !== undefined && !/^(0|[1-9]\d*)$/.test(values.threads))
    throw new UsageError(`--threads must be a whole number, got ${values.threads}`);
  if (values.thread !== undefined && verb !== 'resolve')
    throw new UsageError('--thread goes only with resolve');
  return {
    system: 'github',
    verb,
    args: {
      repo: values.repo ?? DEFAULT_FAKE_REPO,
      number: Number(number),
      ...(verb === 'push' ? { sha: value } : {}),
      ...(verb === 'edit' ? { index: Number(value) } : {}),
      ...(state === undefined ? {} : { state }),
      ...(values.author === undefined ? {} : { author: values.author }),
      ...(values.bot === true ? { bot: true } : {}),
      ...(values.threads === undefined ? {} : { threads: Number(values.threads) }),
      ...(values.thread === undefined ? {} : { thread: values.thread }),
      ...(values.seed === undefined ? {} : { seed: seedOf(values.seed) }),
    },
  };
}

function issueBody(
  args: readonly string[],
  values: { repo?: string | undefined; title?: string | undefined },
): Record<string, unknown> {
  const [number, verb, ...names] = args;
  if (number === undefined || !/^[1-9]\d*$/.test(number))
    throw new UsageError('issue needs an issue number');
  if (verb === undefined) throw new UsageError('issue needs a verb');
  if (!FAKE_ISSUE_VERBS.includes(verb))
    throw new UsageError(`issue verb must be one of ${FAKE_ISSUE_VERBS.join(', ')}`);
  if (values.title !== undefined && verb !== 'open')
    throw new UsageError('--title goes only with open');
  const target = { repo: values.repo ?? DEFAULT_FAKE_REPO, number: Number(number) };
  const body = (extra: Record<string, unknown> = {}) => ({
    system: 'github',
    verb: `issue-${verb}`,
    args: { ...target, ...extra },
  });
  if (verb === 'label') return body({ labels: names });
  if (verb === 'milestone') {
    if (names.length > 1) throw new UsageError('milestone takes at most one title');
    return body({ milestone: names[0] ?? null });
  }
  if (names.length > 0) throw new UsageError(`${verb} takes no value`);
  return body(values.title === undefined ? {} : { title: values.title });
}

function jiraIssueBody(
  args: readonly string[],
  values: { status?: string | undefined; title?: string | undefined },
): Record<string, unknown> {
  const [key, ...extra] = args;
  if (key === undefined || !JIRA_KEY.test(key) || extra.length > 0)
    throw new UsageError('jira issue needs one key such as STAND-1');
  return {
    system: 'jira',
    verb: 'issue',
    args: {
      key,
      ...(values.status === undefined ? {} : { status: values.status }),
      ...(values.title === undefined ? {} : { title: values.title }),
    },
  };
}

/** Maps the arguments of `stand fake github` and `stand fake jira` to a `/fake` control body. */
export function fakeBody(
  positionals: readonly string[],
  values: {
    repo?: string | undefined;
    seed?: string | undefined;
    title?: string | undefined;
    status?: string | undefined;
    author?: string | undefined;
    bot?: boolean | undefined;
    threads?: string | undefined;
    thread?: string | undefined;
    times?: string | undefined;
  },
): Record<string, unknown> {
  const [first, kind, ...rest] = positionals;
  const fail = (first === 'github' || first === 'jira') && kind === 'fail';
  if (values.times !== undefined && (!fail || rest[0] === 'clear'))
    throw new UsageError('--times goes only with fake github|jira fail <mode> other than clear');
  const pr = first === 'github' && kind === 'pr';
  const issue = first === 'github' && kind === 'issue';
  const jiraIssue = first === 'jira' && kind === 'issue';
  if (!pr && !issue && values.repo !== undefined)
    throw new UsageError('--repo goes only with fake github pr or issue');
  if (!pr && values.seed !== undefined)
    throw new UsageError('--seed goes only with fake github pr');
  if (!pr && (values.author !== undefined || values.bot !== undefined))
    throw new UsageError('--author and --bot go only with fake github pr');
  if (!pr && (values.threads !== undefined || values.thread !== undefined))
    throw new UsageError('--threads and --thread go only with fake github pr');
  if (!issue && !jiraIssue && values.title !== undefined)
    throw new UsageError('--title goes only with fake github issue or fake jira issue');
  if (!jiraIssue && values.status !== undefined)
    throw new UsageError('--status goes only with fake jira issue');
  if (pr) return prBody(rest, values);
  if (issue) return issueBody(rest, values);
  if (jiraIssue) return jiraIssueBody(rest, values);
  if (fail) {
    const args = failureBody(rest);
    if (values.times === undefined) return { system: first, verb: 'fail', args };
    if (!/^[1-9]\d*$/.test(values.times))
      throw new UsageError(`--times must be a positive whole number, got ${values.times}`);
    return { system: first, verb: 'fail', args: { ...args, times: Number(values.times) } };
  }
  if (first === 'github' && kind === 'inspect') {
    if (rest.length > 0) throw new UsageError('fake github inspect takes no arguments');
    return { system: 'github', verb: 'inspect', args: {} };
  }
  if (first === 'jira') throw new UsageError('fake jira needs fail <mode> or issue <KEY>');
  throw new UsageError('fake github needs fail <mode>, inspect, pr <n> <verb> or issue <n> <verb>');
}

/**
 * `fake slack outbox`, `fake slack click <n> <button> [--text <text>]` and
 * `fake slack post --text <text>`.
 */
function fakeSlack(home: string | undefined, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { home: { type: 'string' }, text: { type: 'string' } },
  });
  const manifest = (): StandManifest => target(values.home ?? home);
  const [verb, ...rest] = positionals;
  if (verb === 'outbox') {
    if (rest.length > 0 || values.text !== undefined)
      throw new UsageError('fake slack outbox takes no arguments');
    return control(manifest(), '/fake/slack/outbox', {}, 10_000);
  }
  if (verb === 'post') {
    if (rest.length > 0 || values.text === undefined)
      throw new UsageError('fake slack post needs --text and no other argument');
    // Queued behind a reset, so it gets the same bound as one.
    return control(manifest(), '/fake/slack/post', { text: values.text }, 120_000);
  }
  if (verb !== 'click') throw new UsageError('fake slack needs outbox, click or post');
  const [message, button, ...extra] = rest;
  if (
    message === undefined ||
    !/^[1-9]\d*$/.test(message) ||
    button === undefined ||
    extra.length > 0
  )
    throw new UsageError('fake slack click needs a message number and a button');
  // Queued behind a reset, so it gets the same bound as one.
  return control(
    manifest(),
    '/fake/slack/click',
    {
      message: Number(message),
      button,
      ...(values.text === undefined ? {} : { text: values.text }),
    },
    120_000,
  );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    (command === undefined ? err : out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'board' || command === 'mcp') {
    const parsed = leading(args);
    if (
      command === 'mcp' &&
      parsed.rest.length === 1 &&
      ['--help', '-h'].includes(parsed.rest[0] ?? '')
    ) {
      out(MCP_USAGE);
      return 0;
    }
    const manifest = target(parsed.home);
    const as = role(parsed.as);
    if (command === 'mcp') {
      if (parsed.rest.length > 0) throw new UsageError('mcp takes no arguments');
      return runBoard(manifest, as, ['mcp']);
    }
    if (parsed.rest.length === 0) throw new UsageError('board needs a command');
    const blocked = blockedBoardCommand(parsed.rest);
    if (blocked !== undefined) throw new UsageError(blocked);
    return runBoard(manifest, as, parsed.rest);
  }
  if (command === 'fake') {
    const parsed = leading(args);
    if (parsed.as !== undefined) throw new UsageError('fake does not take --as');
    if (parsed.rest[0] === 'slack') return fakeSlack(parsed.home, parsed.rest.slice(1));
    if (parsed.rest[0] === 'github' || parsed.rest[0] === 'jira') {
      const { values, positionals } = parseArgs({
        args: parsed.rest,
        allowPositionals: true,
        options: {
          home: { type: 'string' },
          repo: { type: 'string' },
          seed: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          author: { type: 'string' },
          bot: { type: 'boolean' },
          threads: { type: 'string' },
          thread: { type: 'string' },
          times: { type: 'string' },
        },
      });
      const body = fakeBody(positionals, values);
      return control(target(values.home ?? parsed.home), '/fake', body, FAKE_TIMEOUT_MS);
    }
    const fake = parseFakeArgs(parsed.rest);
    if (!fake.ok) throw new UsageError(fake.error);
    return control(target(parsed.home), '/fake', fake.value, 120_000);
  }
  if (command === 'clock') {
    // Checked before any call, so a bad shift exits 2 without touching the stand.
    const { shiftMs, home } = parseClockArgs(args);
    return control(target(home), '/clock', { shiftMs }, 120_000);
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      port: { type: 'string' },
      'web-port': { type: 'string' },
      foreground: { type: 'boolean' },
      detached: { type: 'boolean' },
      'live-home': { type: 'string' },
      json: { type: 'boolean' },
      stand: { type: 'boolean' },
      timeout: { type: 'string' },
      'watch-pid': { type: 'string' },
      scenario: { type: 'string' },
    },
  });
  if (command !== 'up' && values.scenario !== undefined)
    throw new UsageError('--scenario goes only with up; seed takes the name itself');
  switch (command) {
    case 'up': {
      const port = parsePort(values.port, '--port');
      const rawWebPort = values['web-port'];
      const webPort = rawWebPort === undefined ? undefined : parsePort(rawWebPort, '--web-port');
      const liveHome = values['live-home'];
      const scenario = values.scenario === undefined ? undefined : scenarioName(values.scenario);
      if (!values.foreground) {
        if (
          values.home !== undefined ||
          values.detached ||
          values['watch-pid'] !== undefined ||
          liveHome !== undefined
        )
          throw new UsageError(
            'up takes --home, --detached, --watch-pid and --live-home only with --foreground',
          );
        return up(port, webPort, scenario);
      }
      if (liveHome !== undefined && !values.detached)
        throw new UsageError('--live-home goes only with --detached');
      if (liveHome === '') throw new UsageError('--live-home needs a path');
      const watch = values['watch-pid'];
      if (watch !== undefined && (!/^[1-9]\d*$/.test(watch) || values.detached))
        throw new UsageError('--watch-pid takes a process id and only goes with --foreground');
      return upForeground({
        ...(watch === undefined ? {} : { watchPid: Number(watch) }),
        port,
        ...(webPort === undefined ? {} : { webPort }),
        ...(liveHome === undefined ? {} : { liveHome }),
        ...(scenario === undefined ? {} : { scenario }),
        ...(values.home === undefined ? {} : { home: values.home }),
        detached: values.detached ?? false,
      });
    }
    case 'down':
      return down(target(values.home));
    case 'status':
      return status(target(values.home), values.json ?? false);
    case 'logs': {
      const manifest = target(values.home);
      const file = join(manifest.home, 'logs', values.stand ? 'stand.log' : 'daemon.log');
      if (existsSync(file)) out(readFileSync(file, 'utf8'));
      return 0;
    }
    case 'wait': {
      const [condition, ...extra] = positionals;
      if (condition === undefined || extra.length > 0)
        throw new UsageError('wait needs one condition');
      const seconds = values.timeout === undefined ? WAIT_DEFAULT_S : Number(values.timeout);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > WAIT_MAX_S)
        throw new UsageError(`--timeout is seconds from 0 to ${String(WAIT_MAX_S)}`);
      return control(
        target(values.home),
        '/wait',
        { condition, timeoutMs: seconds * 1_000 },
        seconds * 1_000 + 5_000,
      );
    }
    case 'poll': {
      if (positionals.length > 1) throw new UsageError('poll takes at most one source');
      const [source] = positionals;
      return control(target(values.home), '/poll', source === undefined ? {} : { source }, 120_000);
    }
    case 'reset':
      return control(target(values.home), '/reset', {}, 120_000);
    case 'seed': {
      const [name, ...extra] = positionals;
      if (extra.length > 0) throw new UsageError('seed takes one scenario');
      // Checked before any call, so an unknown name exits 2 without touching the stand.
      const scenario = scenarioName(name);
      return control(target(values.home), '/seed', { scenario }, 120_000);
    }
    case 'violations':
      if (positionals.length > 0) throw new UsageError('violations takes no arguments');
      return control(target(values.home), '/violations', {}, 5_000);
    default:
      throw new UsageError(`Unknown command ${command}`);
  }
}

/** Exits once stdout and stderr have flushed, so a pipe gets every byte written before. */
function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(exitAfterFlush, (error: unknown) => {
    if (error instanceof StandRefusedError) {
      err(`stand refused (${error.reason}): ${error.message}\n`);
      exitAfterFlush(3);
      return;
    }
    if (
      error instanceof UsageError ||
      (error instanceof TypeError &&
        'code' in error &&
        String(error.code).startsWith('ERR_PARSE_ARGS'))
    ) {
      err(`${error.message}\nRun pnpm stand help for the commands.\n`);
      exitAfterFlush(2);
      return;
    }
    err(`stand: ${error instanceof Error ? error.message : String(error)}\n`);
    exitAfterFlush(1);
  });
}
