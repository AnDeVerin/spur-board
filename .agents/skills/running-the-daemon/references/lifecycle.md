# Daemon scheduling and shutdown

## Scheduling

- Every daemon loop is a `createJob` (`packages/daemon/src/scheduler.ts`): it runs at once (or,
  with `first: 'await'`, before `start` resolves), then arms a `setTimeout` for `intervalMs` plus
  under `jitterMs` (default 0) after the run settles. Runs never overlap; `trigger` queues behind
  the active run; a failed run goes to `onError`; `stop` clears the timer and awaits the active
  run (`packages/daemon/test/scheduler.test.ts`, `describe('createJob')`).
- The outbox module runs three jobs every `tickMs` (1 s) plus under `jitterMs` (100 ms): the
  sender tick, token expiry and doorbell reconcile. Each logs its own failure, so a failing token
  or doorbell job never blocks delivery. `pulse` reconciles, then ticks. Token expiry clears the
  approval items and queues the feed edit in the same transaction as the token state and journal
  event. The sender also expires a lapsed request before posting its approval line
  (`expireTokenOfItem`, `packages/core/test/app/tokens.test.ts`); keep both.
- Register the outbox without a gateway so Spur doorbells run; leave gateway rows pending.
- Pass the start signal to each sender tick. On stop, stop the jobs and await their active runs
  before the store closes. Register the outbox with `stopStage: 'outbox'` and its gateway with
  `stopStage: 'final'` (`packages/daemon/test/outbox-module.test.ts`,
  `describe('outbox scheduler')`).
- `board-core` ticks at once, then every 60 seconds after a tick settles.
- Command retention awaits its first purge in `start`, then purges daily; a failed first purge
  rejects `start` (`packages/daemon/test/scheduler.test.ts`,
  `describe('composed command retention')`).
- Register `systemd` last with `stopStage: 'pollers'`: its `ready` hook sends READY, its stop
  STOPPING. `board-core` calls `onTick` only after a successful tick; the notifier drops WATCHDOG
  before READY and after STOPPING (`packages/daemon/test/systemd.test.ts`).
- A module's optional `ready()` hook runs synchronously, in start order, once the state is
  `ready`; a failed or aborted start runs none. A hook that throws logs `ready failed`, skips the
  later hooks and runs the failed shutdown, exit code 1 (`packages/daemon/test/lifecycle.test.ts`,
  `describe('ready hooks')`).
- `board-adapters` uses `startAdapters`; the runner owns per-source timers, backoff and aborts
  (`PollContext.signal`, A7 in `packages/contracts/src/adapters.ts`). Adapters never retry on
  their own (A6), except the GitHub PR poll's chunk halving. Register it with `stopStage: 'pollers'`; await `runner.stop()` on stop.
- A poller is a `createJob`. Register it with `stopStage: 'pollers'`.
- Inbound recovers, then scans every five minutes; serialize scans and live events through core.
  Start the gateway with its sink only with `SLACK_APP_TOKEN`; otherwise log. Stop inbound
  before outbox, then stop the gateway and await the sink before store close.
- The gateway sink also routes `connection` events to the outbox module, isolated from inbound:
  inbound's result is the gateway's ack, the outbox logs its own failure. The outbox ignores them
  after stop and awaits the update in flight before the store closes
  (`packages/daemon/test/transport-health.integration.test.ts`, `describe('gateway sink wiring')`).
- Keep the sole `setInterval` in `main` (`KEEPALIVE_MS`) until a module owns a server.

## Shutdown

- SIGTERM or SIGINT runs one shutdown: state `stopping`, the shutdown timer armed, the start
  `signal` aborted, the in-flight start awaited, then `stop()` stage by stage in `STOP_STAGES`
  order (`'pollers'`, then `'outbox'`, then `'final'`), modules within a stage in parallel, then
  the store closed and the lock released (`packages/daemon/test/lifecycle.test.ts`,
  `describe('runDaemon')`).
- Pick `stopStage` by what the module does: `'pollers'` for anything that observes, `'final'`
  for HTTP, gateways and `board-core` (the comment on `STOP_STAGES`). `board-adapters` stops in
  `'pollers'` before `board-core` waits for its active tick in `'final'`. Do not add a stage without
  changing `STOP_STAGES` and its lifecycle check.
- A stop past `DEFAULT_SHUTDOWN_TIMEOUT_MS` exits 1 and logs `pending` modules. A failed stop
  still lets the others stop.
- Every exit goes through `ProcessPort.exit` exactly once. A fatal error exits 1 at once,
  without module stop (`packages/daemon/test/lifecycle.test.ts`, `describe('runDaemon')`).
- `startInProcessDaemon` (`packages/daemon/src/in-process.ts`) lives on after a fatal exit, so
  it then runs module stop. Its `teardown` settles once module stop, store close and lock
  release finish, even after a fatal exit or the shutdown timeout
  (`packages/daemon/test/in-process.test.ts`, `describe('startInProcessDaemon')`).
- `start(signal)` must return promptly once `signal` aborts; a module that ignores it holds up
  the whole shutdown.
