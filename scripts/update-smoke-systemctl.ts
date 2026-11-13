// A stateful fake `systemctl` for scripts/update-smoke.ts. The stand writes a `#!/bin/sh` wrapper
// into `<root>/fake-bin/systemctl` that sets the three UPDATE_SMOKE_* variables and execs this
// file, so the CLI under test finds it first on PATH and never reaches the real user manager.
//   UPDATE_SMOKE_SYSTEMD - state dir: calls.log, daemon.pid (the MainPID of show), daemon.log
//   UPDATE_SMOKE_UNIT    - the unit file `board service install` writes
//   UPDATE_SMOKE_PORT    - the daemon's fixed http.port, polled after a start
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

export interface ParsedUnit {
  command: string[];
  environment: Record<string, string>;
}

/** Splits a unit value into its double-quoted arguments, undoing `unitArgument` in service.ts. */
function unitArguments(value: string): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === ' ') {
      index += 1;
      continue;
    }
    if (value[index] !== '"') throw new Error(`Unquoted unit argument in: ${value}`);
    let text = '';
    index += 1;
    for (;;) {
      const char = value[index];
      if (char === undefined) throw new Error(`Unterminated unit argument in: ${value}`);
      index += 1;
      if (char === '"') break;
      if (char === '\\') {
        const next = value[index];
        if (next === undefined) throw new Error(`Dangling escape in: ${value}`);
        text += next;
        index += 1;
      } else {
        text += char;
      }
    }
    result.push(text.replaceAll('%%', '%'));
  }
  return result;
}

/** The `ExecStart=` command and the `Environment=` pairs of a unit written by `renderUserUnit`. */
export function parseUnit(text: string): ParsedUnit {
  let command: string[] | undefined;
  const environment: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('ExecStart=')) command = unitArguments(line.slice('ExecStart='.length));
    if (line.startsWith('Environment=')) {
      for (const pair of unitArguments(line.slice('Environment='.length))) {
        const equals = pair.indexOf('=');
        if (equals <= 0) throw new Error(`Invalid Environment entry: ${pair}`);
        environment[pair.slice(0, equals)] = pair.slice(equals + 1);
      }
    }
  }
  if (command === undefined || command.length === 0) throw new Error('The unit has no ExecStart.');
  return { command, environment };
}

/**
 * The `MainPID` and `ExecStart` lines `systemctl show` prints for the unit, in the format of
 * systemd 249; `mainPid` is 0 while the service does not run.
 */
export function showProperties(text: string, mainPid: number): string {
  const unit = parseUnit(text);
  return [
    `MainPID=${String(mainPid)}`,
    `ExecStart={ path=${unit.command[0] ?? ''} ; argv[]=${unit.command.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=${String(mainPid)} ; code=(null) ; status=0/0 }`,
    '',
  ].join('\n');
}

interface Recorded {
  pid: number;
  entry: string;
}

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`fake systemctl: ${name} is not set`);
  return value;
}

function pidFile(): string {
  return join(setting('UPDATE_SMOKE_SYSTEMD'), 'daemon.pid');
}

function recorded(): Recorded | undefined {
  try {
    return JSON.parse(readFileSync(pidFile(), 'utf8')) as Recorded;
  } catch {
    return undefined;
  }
}

/** True while the recorded daemon runs; a reused PID or a zombie does not count. */
function alive(daemon: Recorded): boolean {
  try {
    const cmdline = readFileSync(`/proc/${String(daemon.pid)}/cmdline`, 'utf8').split('\0');
    const stat = readFileSync(`/proc/${String(daemon.pid)}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return cmdline.includes(daemon.entry) && state !== 'Z';
  } catch {
    return false;
  }
}

function running(): Recorded | undefined {
  const daemon = recorded();
  return daemon !== undefined && alive(daemon) ? daemon : undefined;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitGone(daemon: Recorded, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(daemon)) return true;
    await pause(100);
  }
  return !alive(daemon);
}

/** SIGTERM, then SIGKILL after TimeoutStopSec, like systemd; only the recorded daemon. */
async function stop(): Promise<void> {
  const daemon = running();
  if (daemon !== undefined) {
    process.kill(daemon.pid, 'SIGTERM');
    if (!(await waitGone(daemon, STOP_TIMEOUT_MS))) {
      process.kill(daemon.pid, 'SIGKILL');
      await waitGone(daemon, 5_000);
    }
  }
  rmSync(pidFile(), { force: true });
}

function schemaReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(
      { host: '127.0.0.1', port, path: '/v1/schema', agent: false, timeout: 2_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.once('timeout', () => request.destroy());
    request.once('error', () => {
      resolve(false);
    });
  });
}

/** Starts the unit's command detached and waits for `/v1/schema`, like a `Type=notify` start. */
async function start(): Promise<number> {
  const unit = parseUnit(readFileSync(setting('UPDATE_SMOKE_UNIT'), 'utf8'));
  const port = Number(setting('UPDATE_SMOKE_PORT'));
  const [binary, ...args] = unit.command;
  if (binary === undefined || args[0] === undefined) throw new Error('ExecStart has no entry.');
  const env: NodeJS.ProcessEnv = { ...process.env, ...unit.environment };
  for (const name of Object.keys(env)) {
    if (name.startsWith('UPDATE_SMOKE_')) Reflect.deleteProperty(env, name);
  }
  const logFile = join(setting('UPDATE_SMOKE_SYSTEMD'), 'daemon.log');
  appendFileSync(logFile, `--- fake systemctl: start ${unit.command.join(' ')}\n`);
  const log = openSync(logFile, 'a');
  const child = spawn(binary, args, { detached: true, stdio: ['ignore', log, log], env });
  closeSync(log);
  if (child.pid === undefined) throw new Error(`Could not spawn ${binary}`);
  writeFileSync(pidFile(), JSON.stringify({ pid: child.pid, entry: args[0] }));
  let exited: string | undefined;
  child.once('exit', (code, signal) => {
    exited = signal ?? `code=${String(code)}`;
  });
  child.once('error', (error) => {
    exited = error.message;
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined) break;
    if (await schemaReady(port)) {
      child.unref();
      return 0;
    }
    await pause(250);
  }
  if (exited === undefined) {
    child.kill('SIGKILL');
    process.stderr.write('Job for spur-board.service failed: start timed out.\n');
  } else {
    process.stderr.write(`Job for spur-board.service failed: main process exited, ${exited}.\n`);
  }
  rmSync(pidFile(), { force: true });
  return 1;
}

async function main(args: readonly string[]): Promise<number> {
  appendFileSync(join(setting('UPDATE_SMOKE_SYSTEMD'), 'calls.log'), `${args.join(' ')}\n`);
  const verb = args.find((arg) => !arg.startsWith('--'));
  const now = args.includes('--now');
  switch (verb) {
    case 'daemon-reload':
      return 0;
    case 'show':
      process.stdout.write(
        showProperties(readFileSync(setting('UPDATE_SMOKE_UNIT'), 'utf8'), running()?.pid ?? 0),
      );
      return 0;
    case 'is-enabled':
      process.stdout.write('enabled\n');
      return 0;
    case 'is-active':
      if (running() !== undefined) {
        process.stdout.write('active\n');
        return 0;
      }
      process.stdout.write('inactive\n');
      return 3;
    case 'enable':
    case 'start':
      if ((verb === 'start' || now) && running() === undefined) return start();
      return 0;
    case 'restart':
      await stop();
      return start();
    case 'stop':
      await stop();
      return 0;
    case 'disable':
      if (now) await stop();
      return 0;
    case undefined:
    default:
      process.stderr.write(`fake systemctl: unsupported call: ${args.join(' ')}\n`);
      return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
