// The foreground CLI's stop wiring: which events stop the stand, and the bound on how long the
// process waits for it to stop. Kept apart from cli.ts so it can be tested without a process.
import type { Stand } from './stand.ts';

/**
 * A deadline for a process that must end (the foreground CLI). `arm` starts it once; when it
 * passes, `onTimeout` runs and `expired` resolves 1. It needs no stand, so it also bounds a start
 * still pending when a stop is asked for. In-process callers do not use it and wait for the
 * full teardown on `Stand.exited`.
 */
export function stopDeadline(
  ms: number,
  onTimeout: () => void,
): { arm(): void; expired: Promise<number> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire: (code: number) => void = () => undefined;
  const expired = new Promise<number>((resolve) => {
    expire = resolve;
  });
  return {
    arm() {
      timer ??= setTimeout(() => {
        onTimeout();
        expire(1);
      }, ms);
    },
    expired,
  };
}

/**
 * Stop wiring for `up --foreground`. Install `request` on signals and call `checkParent` on a
 * timer before startup; wrap the daemon's fatal handler with `fatal`; hand the started stand to
 * `attach`. Every stop - a signal, the launcher going away, a fatal error, or one the stand starts
 * itself - arms the deadline. `watchParent` is false for the child a detached `up` spawned: its
 * parent exits right after startup by design.
 */
export function foregroundStop(options: {
  watchParent: boolean;
  parentGone: () => boolean;
  timeoutMs: number;
  onTimeout: () => void;
}) {
  const deadline = stopDeadline(options.timeoutMs, options.onTimeout);
  let stand: Pick<Stand, 'stop' | 'stopping' | 'exited'> | undefined;
  let stopWanted = false;
  const request = (): void => {
    stopWanted = true;
    deadline.arm();
    void stand?.stop();
  };
  const checkParent = (): void => {
    if (options.watchParent && options.parentGone()) request();
  };
  return {
    request,
    checkParent,
    expired: deadline.expired,
    /** A fatal error stops the stand too, so the deadline is armed before the daemon handles it. */
    fatal(handler: (err: unknown) => void): (err: unknown) => void {
      return (err) => {
        stopWanted = true;
        deadline.arm();
        handler(err);
      };
    },
    /** Takes the started stand; a stop asked for during startup reaches it now. */
    attach(started: Pick<Stand, 'stop' | 'stopping' | 'exited'>): Promise<number> {
      stand = started;
      void started.stopping.then(() => {
        deadline.arm();
      });
      if (stopWanted) void started.stop();
      checkParent();
      return Promise.race([started.exited, deadline.expired]);
    },
  };
}
