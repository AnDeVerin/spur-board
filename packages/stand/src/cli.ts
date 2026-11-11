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
import { scrubEnv } from '@spur-board/testkit';
import { z } from 'zod';
import { callLocal } from './control.ts';
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
import { startStand, WAIT_CONDITIONS } from './stand.ts';

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

const USAGE = `Usage: pnpm stand <command>

  up [--port N] [--foreground [--watch-pid PID]]
                                  start a stand (port 0 or 4780-4799; default 0). In the
                                  foreground it stops with its parent; a launcher that may exit
                                  first passes itself: pnpm stand up --foreground --watch-pid $$
  down                            stop the stand and remove its home
  status [--json]                 show the stand and whether its API answers
  logs [--stand]                  print the daemon log (--stand: the stand process log)
  board [--as role] <args...>     run the board CLI against the stand (operator, worker, orchestrator)
  mcp [--as role]                 run the board MCP server against the stand
  wait <condition> [--timeout s]  wait for ${WAIT_CONDITIONS.join(', ')} (default ${String(WAIT_DEFAULT_S)} s)
                                  outbox-drained needs a messenger gateway, which the stand lacks yet
  poll [source]                   restart every source's poll now (source is only checked to
                                  exist), then tick and pulse the outbox
  reset                           stop the daemon, restore the home and start it again; this
                                  drops the violation log, so read it first
  fake spur session <id> [--state s] [--status s] [--project p] [--branch b] [--retain]
                                  create or update a session in the fake Spur
  fake spur restart               change the Spur instance id
  fake spur fail <delay|refuse|hang|5xx> [--route list|detail|send|all] [--ms n] [--status 5xx]
                                  fail a route until clear; delay needs --ms (1-60000)
  fake spur clear                 drop every failure rule
  fake spur inspect               print sessions, rules, requests, sends and violations
  fake github fail <mode>         delay <ms>, refuse, hang, rate-limit <seconds>,
                                  server-error [status] or clear; lasts until clear or reset
  fake github pr <n> <verb> [--repo owner/name]
                                  create [--seed '<json>'], approve, ci-red, ci-green, merge,
                                  conflict or push <sha>; --repo defaults to ${DEFAULT_FAKE_REPO}
  violations                      print requests no fake models; exit 1 if there are any

Every command but up takes --home <dir> to pick one of several stands.
Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.
`;

class UsageError extends Error {}

const FAKE_PR_VERBS = ['create', 'approve', 'ci-red', 'ci-green', 'merge', 'conflict', 'push'];

const out = (text: string): void => {
  process.stdout.write(text);
};
const err = (text: string): void => {
  process.stderr.write(text);
};

function root(): string {
  return realpathSync(tmpdir());
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new UsageError(`--port must be a number, got ${value}`);
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
  const { id, home, pid, daemonUrl, controlUrl } = manifest;
  return { id, home, pid, daemonUrl, controlUrl };
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

async function upForeground(options: {
  port: number;
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
  const env = { ...process.env };
  const execArgv = [...process.execArgv];
  const refused =
    proxyRefusal({ env, execArgv }) ??
    refusal({ root: root(), port: options.port, env, osHome: homedir() });
  if (refused !== undefined) throw new StandRefusedError(refused);
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

async function up(port: number): Promise<number> {
  const dir = root();
  const refused = refusal({ root: dir, port, env: process.env, osHome: homedir() });
  if (refused !== undefined) throw new StandRefusedError(refused);
  pruneDead();
  const home = mkdtempSync(join(dir, STAND_PREFIX));
  mkdirSync(join(home, 'logs'), { mode: 0o700 });
  const logFile = join(home, 'logs', 'stand.log');
  const log = openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [SELF, 'up', '--foreground', '--detached', '--home', home, '--port', String(port)],
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
          .map(([key, value]) => `${key}: ${String(value)}`)
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
    case 'clear':
      arity(0);
      return { mode };
    default:
      throw new UsageError(
        'fail needs delay <ms>, refuse, hang, rate-limit <seconds>, server-error [status] or clear',
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
  values: { repo?: string | undefined; seed?: string | undefined },
): Record<string, unknown> {
  const [number, verb, value, ...extra] = args;
  if (number === undefined || !/^[1-9]\d*$/.test(number))
    throw new UsageError('pr needs a pull request number');
  if (verb === undefined) throw new UsageError('pr needs a verb');
  if (!FAKE_PR_VERBS.includes(verb))
    throw new UsageError(`pr verb must be one of ${FAKE_PR_VERBS.join(', ')}`);
  if (extra.length > 0 || (verb === 'push') !== (value !== undefined))
    throw new UsageError(verb === 'push' ? 'push needs one sha' : `${verb} takes no value`);
  if (values.seed !== undefined && verb !== 'create')
    throw new UsageError('--seed goes only with create');
  return {
    system: 'github',
    verb,
    args: {
      repo: values.repo ?? DEFAULT_FAKE_REPO,
      number: Number(number),
      ...(value === undefined ? {} : { sha: value }),
      ...(values.seed === undefined ? {} : { seed: seedOf(values.seed) }),
    },
  };
}

/** Maps the arguments of `stand fake github` to the body of a `/fake` control call. */
export function fakeBody(
  positionals: readonly string[],
  values: { repo?: string | undefined; seed?: string | undefined },
): Record<string, unknown> {
  const [first, kind, ...rest] = positionals;
  const pr = first === 'github' && kind === 'pr';
  if (!pr && (values.repo !== undefined || values.seed !== undefined))
    throw new UsageError('--repo and --seed go only with fake github pr');
  if (pr) return prBody(rest, values);
  if (first === 'github' && kind === 'fail')
    return { system: 'github', verb: 'fail', args: failureBody(rest) };
  throw new UsageError('fake github needs fail <mode> or pr <n> <verb>');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    (command === undefined ? err : out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'board' || command === 'mcp') {
    const parsed = leading(args);
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
    if (parsed.rest[0] === 'github') {
      const { values, positionals } = parseArgs({
        args: parsed.rest,
        allowPositionals: true,
        options: {
          home: { type: 'string' },
          repo: { type: 'string' },
          seed: { type: 'string' },
        },
      });
      const body = fakeBody(positionals, values);
      return control(target(values.home ?? parsed.home), '/fake', body, FAKE_TIMEOUT_MS);
    }
    const fake = parseFakeArgs(parsed.rest);
    if (!fake.ok) throw new UsageError(fake.error);
    return control(target(parsed.home), '/fake', fake.value, 120_000);
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      port: { type: 'string' },
      foreground: { type: 'boolean' },
      detached: { type: 'boolean' },
      json: { type: 'boolean' },
      stand: { type: 'boolean' },
      timeout: { type: 'string' },
      'watch-pid': { type: 'string' },
    },
  });
  switch (command) {
    case 'up': {
      const port = parsePort(values.port);
      if (!values.foreground) {
        if (values.home !== undefined || values.detached || values['watch-pid'] !== undefined)
          throw new UsageError(
            'up takes --home, --detached and --watch-pid only with --foreground',
          );
        return up(port);
      }
      const watch = values['watch-pid'];
      if (watch !== undefined && (!/^[1-9]\d*$/.test(watch) || values.detached))
        throw new UsageError('--watch-pid takes a process id and only goes with --foreground');
      return upForeground({
        ...(watch === undefined ? {} : { watchPid: Number(watch) }),
        port,
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
      err(`${error.message}\n\n${USAGE}`);
      exitAfterFlush(2);
      return;
    }
    err(`stand: ${error instanceof Error ? error.message : String(error)}\n`);
    exitAfterFlush(1);
  });
}
