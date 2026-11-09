/**
 * systemd readiness and watchdog notifications for `Type=notify` units.
 *
 * Node has no unix datagram sockets, so each state is sent by spawning `systemd-notify <STATE>`.
 * The sender is a child of the main PID, which is why the unit sets `NotifyAccess=all`.
 * `systemd-notify` waits until systemd has processed the message unless `--no-block` is given;
 * the spawn is fire-and-forget, so the daemon never waits on it. The child gets only
 * `NOTIFY_SOCKET` and `PATH`, never the daemon environment that holds the secrets.
 */
import { spawn } from 'node:child_process';
import type { Module } from './lifecycle.ts';

const NOTIFY_TIMEOUT_MS = 5_000;

export type NotifySend = (state: string) => void;

interface NotifyLog {
  error(obj: object, msg: string): void;
}

export interface SystemdNotifier {
  ready(): void;
  watchdog(): void;
  stopping(): void;
}

function spawnSender(socket: string, path: string | undefined, log: NotifyLog): NotifySend {
  return (state) => {
    let settled = false;
    const fail = (fields: object): void => {
      if (settled) return;
      settled = true;
      log.error({ ...fields, state }, 'systemd notify failed');
    };
    const child = spawn('systemd-notify', [state], {
      env: { NOTIFY_SOCKET: socket, PATH: path ?? '/usr/bin:/bin' },
      stdio: 'ignore',
      timeout: NOTIFY_TIMEOUT_MS,
    });
    child.once('error', (err) => {
      fail({ err });
    });
    child.once('exit', (code, signal) => {
      if (code === 0) settled = true;
      else fail({ code, signal });
    });
  };
}

/**
 * No-op without `NOTIFY_SOCKET`. READY is sent once; WATCHDOG only between READY and STOPPING,
 * and only when systemd asked for it (`WATCHDOG_USEC`, `WATCHDOG_PID`); STOPPING only after READY.
 */
export function createSystemdNotifier(options: {
  env: Readonly<Record<string, string | undefined>>;
  pid: number;
  log: NotifyLog;
  send?: NotifySend;
}): SystemdNotifier {
  const { env, pid, log } = options;
  const socket = env.NOTIFY_SOCKET;
  if (socket === undefined || socket === '') return { ready() {}, watchdog() {}, stopping() {} };
  const send = options.send ?? spawnSender(socket, env.PATH, log);
  const watchdogWanted =
    env.WATCHDOG_USEC !== undefined &&
    (env.WATCHDOG_PID === undefined || env.WATCHDOG_PID === String(pid));
  let phase: 'starting' | 'ready' | 'stopping' = 'starting';
  const notify = (state: string): void => {
    try {
      send(state);
    } catch (err) {
      log.error({ err, state }, 'systemd notify failed');
    }
  };
  return {
    ready() {
      if (phase !== 'starting') return;
      phase = 'ready';
      notify('READY=1');
    },
    watchdog() {
      if (!watchdogWanted || phase !== 'ready') return;
      notify('WATCHDOG=1');
    },
    stopping() {
      if (phase !== 'ready') return;
      phase = 'stopping';
      notify('STOPPING=1');
    },
  };
}

/**
 * READY is sent from the `ready` hook, after every module started and the daemon state became
 * `ready`, so HTTP `/v1/schema` already answers 200 when systemd releases the unit. A failed or
 * aborted start runs no hook and sends nothing.
 */
export function createSystemdModule(notifier: SystemdNotifier): Module {
  return {
    start() {
      return Promise.resolve();
    },
    ready() {
      notifier.ready();
    },
    stop() {
      notifier.stopping();
      return Promise.resolve();
    },
  };
}
