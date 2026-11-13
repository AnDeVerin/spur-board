/**
 * systemd user-unit policy shared by the CLI unit writer and the daemon's board tick.
 *
 * The daemon notifies systemd by spawning `systemd-notify`, so the notifying process is a child
 * of the main PID: the unit needs `NotifyAccess=all`. `WATCHDOG_MS` is three board ticks, so a
 * single slow or failed tick does not restart the daemon. `UMask=0077` makes every file the daemon
 * creates owner-only.
 */

export const BOARD_TICK_MS = 60_000;

const WATCHDOG_MS = 3 * BOARD_TICK_MS;

export const SYSTEMD_SERVICE_SETTINGS: readonly string[] = [
  'Type=notify',
  'NotifyAccess=all',
  `WatchdogSec=${String(WATCHDOG_MS)}ms`,
  'Restart=on-failure',
  'RestartSec=5s',
  'TimeoutStopSec=15s',
  'UMask=0077',
];
