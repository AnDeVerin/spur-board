import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { dataDirectory, resolveDaemonAddress } from './config.ts';
import { CliError } from './exit-codes.ts';
import {
  renderUserUnit,
  runCommand,
  servicePaths,
  stopService,
  type CommandResult,
} from './service.ts';

/** Runs a command; only the npm calls pass `env`. */
export type UpdateRunner = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export interface UpdatePorts {
  runner: UpdateRunner;
  confirm: (question: string) => Promise<boolean>;
  packageRoot: string;
  stdinIsTTY: boolean;
  readyTimeoutMs: number;
  firstPollTimeoutMs: number;
  lockWaitMs: number;
  doctorRecheckMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface UpdateOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  stdoutIsTTY: boolean;
  progress: (text: string) => void;
  ports?: Partial<UpdatePorts> | undefined;
}

const stateSchema = z.object({
  schema: z.literal(1),
  status: z.enum(['in-progress', 'succeeded', 'rolled-back', 'rollback-failed']),
  from: z.string(),
  to: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  prefix: z.string(),
  packageRoot: z.string(),
  snapshot: z.string(),
  dbFile: z.string(),
  dbBackup: z.string().nullable(),
  reason: z.string().nullable(),
  /** Set once a rollback decided to restore the database, so a retry keeps that decision. */
  restoreDatabase: z.boolean().optional(),
});
type UpdateState = z.output<typeof stateSchema>;

const doctorSchema = z.array(
  z.object({
    id: z.string(),
    status: z.string(),
    blocking: z.boolean(),
    fix: z.string().nullable(),
  }),
);
type DoctorReport = z.output<typeof doctorSchema>;

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MCP_LINE =
  'Restart agent sessions that run `board mcp` so the MCP server loads the new catalog.';

function defaultPorts(): UpdatePorts {
  return {
    runner: runCommand,
    confirm: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await prompt.question(question)).trim());
      } finally {
        prompt.close();
      }
    },
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
    stdinIsTTY: process.stdin.isTTY,
    readyTimeoutMs: 120_000,
    firstPollTimeoutMs: 300_000,
    lockWaitMs: 20_000,
    doctorRecheckMs: 6_000,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    now: Date.now,
  };
}

/** A step failure: the step name goes into the hint of the error the caller raises. */
class StepError extends Error {
  readonly step: string;

  constructor(step: string, detail: string) {
    super(detail);
    this.step = step;
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The child's JSON error as `code: hint`, else its trimmed output. */
function childDetail(result: CommandResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  try {
    const parsed = z
      .object({ error: z.object({ code: z.string(), hint: z.string() }) })
      .safeParse(JSON.parse(text));
    if (parsed.success) return `${parsed.data.error.code}: ${parsed.data.error.hint}`;
  } catch {
    // Not JSON; use the text.
  }
  return text.replace(/\s*\n\s*/g, ' ') || `exit ${String(result.exitCode)}`;
}

function config(hint: string): CliError {
  return new CliError('config', undefined, undefined, hint);
}

function migrationCount(packageRoot: string): number | undefined {
  try {
    return readdirSync(join(packageRoot, 'dist', 'migrations')).filter((name) =>
      name.endsWith('.sql'),
    ).length;
  } catch {
    return undefined;
  }
}

/**
 * Whether the database is restored: the version being left has another migration count than
 * the snapshot, or either count cannot be read.
 */
function schemaChanged(leaving: number | undefined, snapshot: string): boolean {
  return leaving === undefined || leaving !== migrationCount(snapshot);
}

function lockHolder(lockFile: string): string | undefined {
  try {
    const pid = readFileSync(lockFile, 'utf8').trim();
    return /^\d+$/.test(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readState(file: string): UpdateState | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Reported below.
  }
  throw config(`Update state ${file} is not readable; remove it only after checking the install.`);
}

function writeState(file: string, state: UpdateState): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function compareCore(left: string, right: string): number {
  const parts = (version: string) => version.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function unitLines(text: string): { execStart: string; environment: string[] } {
  const lines = text.split('\n');
  return {
    execStart: lines.find((line) => line.startsWith('ExecStart=')) ?? '(no ExecStart line)',
    environment: lines.filter((line) => line.startsWith('Environment=')).sort(),
  };
}

interface Probe {
  status: number;
  instance: string | undefined;
  body: string;
}

function probe(address: URL, path: string): Promise<Probe | undefined> {
  const url = new URL(path, address);
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  return new Promise((resolve) => {
    const request = get(url, { agent: false, signal: AbortSignal.timeout(2_000) }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        const instance = response.headers['x-board-instance'];
        resolve({
          status: response.statusCode ?? 0,
          instance: typeof instance === 'string' ? instance : undefined,
          body,
        });
      });
      response.on('error', () => {
        resolve(undefined);
      });
    });
    request.once('error', () => {
      resolve(undefined);
    });
  });
}

/** Runs one update or rollback; the ports and paths are fixed for its whole run. */
class Updater {
  readonly ports: UpdatePorts;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly progress: (step: string) => void;
  readonly address: URL;
  readonly dataDir: string;
  readonly updateDir: string;
  readonly stateFile: string;
  readonly dbFile: string;
  readonly lockFile: string;

  constructor(options: UpdateOptions, label: string) {
    this.ports = { ...defaultPorts(), ...options.ports };
    this.env = options.env;
    this.home = options.home;
    this.progress = (step) => {
      options.progress(`${label}: ${step}\n`);
    };
    this.address = resolveDaemonAddress(options.env, options.home);
    this.dataDir = dataDirectory(options.env, options.home);
    this.updateDir = join(this.dataDir, 'update');
    this.stateFile = join(this.updateDir, 'state.json');
    this.dbFile = join(this.dataDir, 'board.sqlite');
    this.lockFile = join(this.dataDir, 'board.lock');
  }

  bin(packageRoot: string): string {
    return join(packageRoot, 'dist', 'bin.mjs');
  }

  npmEnv(): NodeJS.ProcessEnv {
    const path = this.env['PATH'];
    const node = dirname(process.execPath);
    return { ...this.env, PATH: path ? `${node}:${path}` : node };
  }

  async child(packageRoot: string, step: string, args: readonly string[]): Promise<string> {
    const result = await this.ports.runner(process.execPath, [this.bin(packageRoot), ...args]);
    if (result.exitCode !== 0) throw new StepError(step, childDetail(result));
    return result.stdout;
  }

  /** A doctor run: exit 0 or 1 with a parsable check list is a result; else a StepError. */
  async doctor(packageRoot: string): Promise<DoctorReport> {
    const result = await this.ports.runner(process.execPath, [
      this.bin(packageRoot),
      '--json',
      'doctor',
    ]);
    if (result.exitCode === 0 || result.exitCode === 1) {
      try {
        const parsed = doctorSchema.safeParse(JSON.parse(result.stdout));
        if (parsed.success) return parsed.data;
      } catch {
        // Reported below.
      }
    }
    throw new StepError(
      'doctor',
      `the doctor child returned no check list: ${childDetail(result)}`,
    );
  }

  async instance(): Promise<string | undefined> {
    const answer = await probe(this.address, '/v1/schema');
    return answer?.status === 200 ? answer.instance : undefined;
  }

  /** Polls /v1/schema until it answers 200, from an instance other than `previous` when given. */
  async waitReady(previous: string | undefined): Promise<void> {
    const deadline = this.ports.now() + this.ports.readyTimeoutMs;
    for (;;) {
      const answer = await probe(this.address, '/v1/schema');
      if (answer?.status === 200 && (previous === undefined || answer.instance !== previous)) {
        return;
      }
      if (this.ports.now() >= deadline) break;
      await this.ports.sleep(1_000);
    }
    throw new StepError(
      'readiness',
      `the daemon was not ready at ${this.address.origin}/v1/schema within ${String(this.ports.readyTimeoutMs / 1000)} s`,
    );
  }

  async waitFirstPoll(): Promise<'done' | 'timeout' | 'unsupported'> {
    const deadline = this.ports.now() + this.ports.firstPollTimeoutMs;
    for (;;) {
      const answer = await probe(this.address, '/v1/health');
      if (answer?.status === 404) return 'unsupported';
      if (answer?.status === 200) {
        try {
          if ((JSON.parse(answer.body) as { firstPollDone?: unknown }).firstPollDone === true) {
            return 'done';
          }
        } catch {
          // Keep polling.
        }
      }
      if (this.ports.now() >= deadline) return 'timeout';
      await this.ports.sleep(2_000);
    }
  }

  async stop(): Promise<void> {
    this.progress('stop');
    try {
      await stopService({ env: this.env, home: this.home, runner: this.ports.runner });
    } catch (error) {
      throw new StepError('stop', detailOf(error));
    }
  }

  /** Stops the service and waits for the lock; a failed stop is fine when no process holds it. */
  async stopAndWaitLock(): Promise<void> {
    try {
      await this.stop();
    } catch (error) {
      this.progress(`stop failed (${detailOf(error)}); checking the lock`);
    }
    await this.waitLock();
  }

  /** Waits until no process holds the board lock, so no daemon has the database open. */
  async waitLock(): Promise<void> {
    this.progress('lock wait');
    const deadline = this.ports.now() + this.ports.lockWaitMs;
    for (;;) {
      const result = await this.ports.runner('flock', ['-n', '-E', '75', this.lockFile, 'true']);
      if (result.exitCode === 0) return;
      // `-E 75` marks a held lock; any other exit is an error that waiting does not fix.
      if (result.exitCode !== 75) {
        const stderr = result.stderr.trim();
        throw new StepError(
          'lock wait',
          `checking the database lock ${this.lockFile} with flock failed (exit ${String(result.exitCode)})${stderr ? `: ${stderr}` : ''}`,
        );
      }
      if (this.ports.now() >= deadline) break;
      await this.ports.sleep(500);
    }
    const pid = lockHolder(this.lockFile);
    throw new StepError(
      'lock wait',
      `the database lock ${this.lockFile} is still held${pid === undefined ? '' : ` by PID ${pid}`}; stop that process`,
    );
  }

  /** Brings the service back after a failure before any change; returns a failure note. */
  async restart(packageRoot: string): Promise<string> {
    this.progress('restart');
    try {
      await this.child(packageRoot, 'service install', ['--json', 'service', 'install']);
      await this.waitReady(undefined);
      return '';
    } catch (error) {
      return ` The service did not start again: ${detailOf(error)}.`;
    }
  }

  finish(state: UpdateState, status: UpdateState['status'], reason: string | null): void {
    writeState(this.stateFile, {
      ...state,
      status,
      reason,
      finishedAt: new Date(this.ports.now()).toISOString(),
    });
  }

  /**
   * Puts the snapshot package back and, when `restoreDatabase`, the backup database. `stopped`
   * holds the instance seen before the caller's own stop and lock wait; without it this stops.
   */
  async rollback(
    state: UpdateState,
    restoreDatabase: boolean,
    reason: string,
    stopped?: { previous: string | undefined },
  ): Promise<'restored' | 'kept'> {
    const current = { ...state, ...(restoreDatabase ? { restoreDatabase } : {}) };
    let step = 'stop';
    try {
      writeState(this.stateFile, current);
      let previous = stopped?.previous;
      if (stopped === undefined) {
        previous = await this.instance();
        step = 'lock wait';
        await this.stopAndWaitLock();
      }
      return await this.restore(current, restoreDatabase, reason, previous, (next) => {
        step = next;
      });
    } catch (error) {
      const failed = error instanceof StepError ? error.step : step;
      const detail = detailOf(error);
      try {
        this.finish(current, 'rollback-failed', `${failed}: ${detail}`);
      } catch {
        // The error below still names the step; the state keeps its last status.
      }
      throw new CliError(
        'rollback_failed',
        undefined,
        undefined,
        `Rolling back to ${state.from} failed at ${failed}: ${detail}. Fix it, then run \`board rollback --yes\`. The package snapshot is ${state.snapshot}${state.dbBackup === null ? '' : ` and the database backup is ${state.dbBackup}`}.`,
      );
    }
  }

  private async restore(
    state: UpdateState,
    restoreDatabase: boolean,
    reason: string,
    previous: string | undefined,
    at: (step: string) => void,
  ): Promise<'restored' | 'kept'> {
    at('package restore');
    this.progress('package restore');
    restorePackage(state.snapshot, state.packageRoot);
    if (restoreDatabase && state.dbBackup !== null) {
      at('database restore');
      this.progress('database restore');
      await this.child(state.packageRoot, 'database restore', [
        'copy-database',
        state.dbBackup,
        state.dbFile,
      ]);
    }
    this.progress('service install');
    await this.child(state.packageRoot, 'service install', ['--json', 'service', 'install']);
    this.progress('readiness');
    await this.waitReady(previous);
    this.progress('skills install');
    await this.child(state.packageRoot, 'skills install', ['--json', 'skills', 'install']);
    this.finish(state, 'rolled-back', reason);
    return restoreDatabase && state.dbBackup !== null ? 'restored' : 'kept';
  }
}

/** Swaps the package dir for the snapshot; a failed copy puts the original dir back. */
function restorePackage(snapshot: string, packageRoot: string): void {
  const aside = `${packageRoot}.rollback-${randomUUID()}`;
  renameSync(packageRoot, aside);
  try {
    cpSync(snapshot, packageRoot, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    rmSync(packageRoot, { recursive: true, force: true });
    renameSync(aside, packageRoot);
    throw new StepError('package restore', `copying ${snapshot} failed: ${detailOf(error)}`);
  }
  rmSync(aside, { recursive: true, force: true });
}

function packageLayout(packageRoot: string): { root: string; prefix: string } {
  let root: string;
  try {
    root = realpathSync(packageRoot);
  } catch {
    throw config(`The package directory ${packageRoot} cannot be read.`);
  }
  const modules = dirname(root);
  const lib = dirname(modules);
  if (basename(root) !== 'spur-board' || basename(modules) !== 'node_modules') {
    throw config(
      `This package at ${root} is not a global npm install; update it the way it was installed.`,
    );
  }
  if (basename(lib) !== 'lib') {
    throw config(`The package at ${root} is not under <prefix>/lib/node_modules.`);
  }
  try {
    accessSync(modules, constants.W_OK);
  } catch {
    throw config(`${modules} is not writable by this user; Board update needs a user npm prefix.`);
  }
  return { root, prefix: dirname(lib) };
}

function packageVersion(root: string): string {
  try {
    const version = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version?: unknown;
      }
    ).version;
    if (typeof version === 'string' && version) return version;
  } catch {
    // Reported below.
  }
  throw config(`The version of the package at ${root} cannot be read.`);
}

/** The `changed` field of a `service install` result, or null when it cannot be read. */
function changedField(stdout: string): boolean | null {
  try {
    const parsed = z.object({ changed: z.boolean() }).safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.changed : null;
  } catch {
    return null;
  }
}

function blockingIds(report: DoctorReport): Set<string> {
  return new Set(report.filter((check) => check.blocking).map((check) => check.id));
}

/** `board update [version]`: preflight, snapshot, stop, backup, install, then health checks. */
export async function updatePackage(
  options: UpdateOptions,
  requested: string | undefined,
): Promise<Record<string, unknown>> {
  const updater = new Updater(options, 'update');
  const { ports } = updater;
  const { root, prefix } = packageLayout(ports.packageRoot);
  const from = packageVersion(root);

  const previous = readState(updater.stateFile);
  if (previous?.status === 'in-progress' || previous?.status === 'rollback-failed') {
    throw config(
      `The update from ${previous.from} to ${previous.to} did not finish (state ${previous.status}); run \`board rollback --yes\` first.`,
    );
  }

  const unitPaths = servicePaths({
    env: options.env,
    home: options.home,
    nodePath: process.execPath,
    daemonEntry: join(root, 'dist', 'daemon.mjs'),
  });
  let unitText: string;
  try {
    unitText = readFileSync(unitPaths.unitFile, 'utf8');
  } catch {
    throw config(
      `Unit file ${unitPaths.unitFile} is not installed; run \`board service install\` first.`,
    );
  }
  const unit = unitLines(unitText);
  const expected = unitLines(renderUserUnit(unitPaths));
  const mismatch =
    unit.execStart !== expected.execStart
      ? [unit.execStart, expected.execStart]
      : unit.environment.join('\n') !== expected.environment.join('\n')
        ? [
            unit.environment.join(' ') || '(no Environment line)',
            expected.environment.join(' ') || '(no Environment line)',
          ]
        : undefined;
  if (mismatch) {
    throw config(
      `The service unit has ${mismatch[0] ?? ''} but this shell gives ${mismatch[1] ?? ''}; run \`board update\` from the environment the service was installed from, or run \`board service install\` first.`,
    );
  }

  const before = await probe(updater.address, '/v1/schema');
  if (before?.status !== 200) {
    throw config(
      `The daemon is not ready at ${updater.address.origin} (${before === undefined ? 'no answer' : `HTTP ${String(before.status)}`}); Board update needs a running daemon. Check \`board service status\`.`,
    );
  }

  if (requested !== undefined && !VERSION.test(requested)) {
    throw new CliError(
      'usage',
      undefined,
      undefined,
      `Version ${requested} is not a version like 1.2.3; omit it for the latest.`,
    );
  }
  const npmEnv = updater.npmEnv();
  const spec = `spur-board@${requested ?? 'latest'}`;
  const view = await ports.runner('npm', ['view', spec, 'version', '--json'], npmEnv);
  if (view.exitCode !== 0 && !/E404/.test(view.stderr)) {
    throw config(`npm view ${spec} failed: ${childDetail(view)}`);
  }
  let to: string | undefined;
  try {
    const parsed: unknown = view.exitCode === 0 ? JSON.parse(view.stdout || 'null') : null;
    const value = Array.isArray(parsed) ? (parsed.at(-1) as unknown) : parsed;
    to = typeof value === 'string' && value ? value : undefined;
  } catch {
    to = undefined;
  }
  if (to === undefined) {
    throw new CliError('usage', undefined, undefined, `There is no published version ${spec}.`);
  }
  if (to === from) return { from, to, changed: false };
  if (compareCore(to, from) < 0) {
    throw new CliError(
      'usage',
      undefined,
      undefined,
      `Version ${to} is older than the installed ${from}; to go back to the version before the last update, run \`board rollback\`.`,
    );
  }

  const target = `spur-board@${to}`;
  const npmArgs = ['--engine-strict', '--prefix', prefix, '--no-audit', '--no-fund', target];
  const dryRun = await ports.runner('npm', ['install', '-g', '--dry-run', ...npmArgs], npmEnv);
  if (dryRun.exitCode !== 0) {
    throw config(`${target} cannot be installed with this Node: ${childDetail(dryRun)}`);
  }

  updater.progress('doctor');
  let baseline: DoctorReport;
  try {
    baseline = await updater.doctor(root);
  } catch (error) {
    throw config(`Before the update, ${detailOf(error)}. Run \`board doctor\` to see why.`);
  }
  const blockedBefore = blockingIds(baseline);

  // Abort phase: nothing in the package or database has changed yet.
  updater.progress('snapshot');
  const snapshot = join(updater.updateDir, `package-${from}`);
  const partial = `${snapshot}.partial`;
  try {
    mkdirSync(updater.updateDir, { recursive: true, mode: 0o700 });
    rmSync(partial, { recursive: true, force: true });
    cpSync(root, partial, { recursive: true, verbatimSymlinks: true });
    rmSync(snapshot, { recursive: true, force: true });
    renameSync(partial, snapshot);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw config(`Could not snapshot the package to ${snapshot}: ${detailOf(error)}`);
  }
  let state: UpdateState = {
    schema: 1,
    status: 'in-progress',
    from,
    to,
    startedAt: new Date(ports.now()).toISOString(),
    finishedAt: null,
    prefix,
    packageRoot: root,
    snapshot,
    dbFile: updater.dbFile,
    dbBackup: null,
    reason: null,
  };
  writeState(updater.stateFile, state);
  for (const name of readdirSync(updater.updateDir)) {
    if (
      (name.startsWith('package-') && join(updater.updateDir, name) !== snapshot) ||
      name === 'db'
    ) {
      rmSync(join(updater.updateDir, name), { recursive: true, force: true });
    }
  }

  try {
    await updater.stop();
    await updater.waitLock();
    updater.progress('database backup');
    const backupDir = join(updater.updateDir, 'db');
    const backup = join(backupDir, 'board.sqlite');
    try {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      chmodSync(backupDir, 0o700);
    } catch (error) {
      throw new StepError('database backup', detailOf(error));
    }
    await updater.child(root, 'database backup', ['copy-database', updater.dbFile, backup]);
    state = { ...state, dbBackup: backup };
    writeState(updater.stateFile, state);
  } catch (error) {
    const failure =
      error instanceof StepError ? error : new StepError('database backup', detailOf(error));
    const restart = await updater.restart(root);
    const reason = `${failure.step}: ${failure.message}`;
    updater.finish(state, 'rolled-back', reason);
    throw new CliError(
      'update_rolled_back',
      undefined,
      undefined,
      `Update to ${to} stopped at ${failure.step}: ${failure.message}. The package and database were not changed.${restart}`,
    );
  }

  // Rollback phase: from the install on, a failure puts the snapshot back.
  let leaving: number | undefined;
  let installed = false;
  try {
    updater.progress('npm install');
    const install = await ports.runner('npm', ['install', '-g', ...npmArgs], npmEnv);
    // The one read of the installed tree: its schema decides the database restore.
    leaving = migrationCount(root);
    installed = true;
    if (install.exitCode !== 0) throw new StepError('npm install', childDetail(install));
    updater.progress('service install');
    const unitChanged = changedField(
      await updater.child(root, 'service install', ['--json', 'service', 'install']),
    );
    updater.progress('readiness');
    await updater.waitReady(before.instance);
    updater.progress('skills install');
    await updater.child(root, 'skills install', ['--json', 'skills', 'install']);
    updater.progress('first poll');
    const firstPoll = await updater.waitFirstPoll();
    updater.progress('doctor');
    let report = await updater.doctor(root);
    const newly = [...blockingIds(report)].filter((id) => !blockedBefore.has(id));
    if (newly.length > 0) {
      await ports.sleep(ports.doctorRecheckMs);
      report = await updater.doctor(root);
      const still = blockingIds(report);
      const persistent = newly.filter((id) => still.has(id));
      if (persistent.length > 0) {
        throw new StepError('doctor', `newly blocking checks: ${persistent.join(', ')}`);
      }
    }
    updater.finish(state, 'succeeded', null);
    const stale = report.find((check) => check.id === 'sessions.stale');
    const operator = [
      MCP_LINE,
      ...(stale?.status === 'warning' && stale.fix !== null
        ? [`Stop and wake these Spur sessions so they load the new skill: ${stale.fix}`]
        : []),
      ...(firstPoll === 'timeout'
        ? [
            'Sources have not finished their first poll yet; watch `board status` until warming up ends.',
          ]
        : []),
    ];
    return {
      from,
      to,
      changed: true,
      unitChanged,
      database: {
        backup: state.dbBackup,
        schemaChanged: schemaChanged(leaving, snapshot),
      },
      firstPoll,
      operator,
    };
  } catch (error) {
    const failure = error instanceof StepError ? error : new StepError('update', detailOf(error));
    if (!installed) leaving = migrationCount(root);
    const restoreDatabase = schemaChanged(leaving, snapshot);
    const reason = `${failure.step}: ${failure.message}`;
    const database = await updater.rollback(state, restoreDatabase, reason);
    throw new CliError(
      'update_rolled_back',
      undefined,
      undefined,
      `Update to ${to} failed at ${failure.step}: ${failure.message}. Version ${from} is back and its database was ${database === 'restored' ? 'restored from the backup taken before the update' : 'kept'}.`,
    );
  }
}

/** `board rollback`: go back to the version before the last update, after consent. */
export async function rollbackPackage(
  options: UpdateOptions,
  yes: boolean,
): Promise<Record<string, unknown>> {
  const updater = new Updater(options, 'rollback');
  const { ports } = updater;
  const state = readState(updater.stateFile);
  if (
    state === undefined ||
    !['in-progress', 'succeeded', 'rollback-failed'].includes(state.status)
  ) {
    throw config(
      `No update to roll back${state === undefined ? '' : ` (the last one ended ${state.status})`}.`,
    );
  }
  const restoreDatabase =
    state.dbBackup !== null &&
    (state.restoreDatabase === true ||
      schemaChanged(migrationCount(state.packageRoot), state.snapshot));
  const lost = restoreDatabase
    ? `Board changes and journal events recorded after ${state.startedAt}.`
    : state.dbBackup === null
      ? 'Nothing: no database backup was taken, so the current database was kept.'
      : 'Nothing: the schema did not change, so the current database was kept.';
  options.progress(
    `rollback: from ${state.to} to ${state.from}; the database is ${restoreDatabase ? 'restored from the backup' : 'kept'}. Lost: ${lost}\n`,
  );
  if (!yes) {
    if (!(ports.stdinIsTTY && options.stdoutIsTTY)) {
      throw new CliError(
        'usage',
        undefined,
        undefined,
        'Read what is lost above, then rerun with --yes.',
      );
    }
    if (!(await ports.confirm('Continue? [y/N] '))) {
      return { from: state.to, to: state.from, rolledBack: false };
    }
  }

  const previous = await updater.instance();
  try {
    await updater.stopAndWaitLock();
  } catch (error) {
    const failure = error instanceof StepError ? error : new StepError('stop', detailOf(error));
    const restart = await updater.restart(state.packageRoot);
    throw config(
      `Rollback stopped at ${failure.step}: ${failure.message}. Nothing was changed.${restart}`,
    );
  }
  const reason = `rollback requested after ${state.status === 'succeeded' ? 'the update' : `state ${state.status}`}`;
  const database = await updater.rollback(state, restoreDatabase, reason, { previous });
  return {
    from: state.to,
    to: state.from,
    database,
    lost,
    operator: [MCP_LINE],
  };
}
