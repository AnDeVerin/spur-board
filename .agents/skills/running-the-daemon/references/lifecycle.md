# Daemon scheduling and shutdown

## Scheduling

- Start the outbox tick immediately, then arm a `setTimeout` for one second plus under 100 ms of
  jitter after the tick settles. Never queue a second tick while one runs.
- Expire pending operator token requests on that tick, clearing their approval items and queuing
  the feed edit in the same transaction as the token state and journal event.
- Register the outbox without a gateway so Spur doorbells run; leave gateway rows pending.
- Pass the start signal to each sender tick. On stop, clear the timer and await the active tick
  before the store closes. Register the outbox with `stopStage: 'outbox'` and its gateway with
  `stopStage: 'final'` (`packages/daemon/test/outbox-module.test.ts`,
  `describe('outbox scheduler')`).
- `board-core` starts a tick immediately, then arms a 60-second `setTimeout` after it settles.
  On stop, clear the timer and await the active tick before the store closes.
- Register `systemd` last with `stopStage: 'pollers'`: its start sends READY, its stop STOPPING.
  `board-core` calls `onTick` only after a successful tick; the notifier drops WATCHDOG before
  READY and after STOPPING (`packages/daemon/test/systemd.test.ts`).
- `board-adapters` uses `startAdapters`; the runner owns per-source timers, backoff and aborts
  (`PollContext.signal`, A7 in `packages/contracts/src/adapters.ts`). Adapters never retry on
  their own (A6). Register it with `stopStage: 'pollers'`; await `runner.stop()` on stop.
- A poller uses a `setTimeout` chain, handles each tick rejection, and never overlaps ticks.
  Register it with `stopStage: 'pollers'`; `stop()` clears its timer and awaits its active tick.
- Inbound recovers, then scans every five minutes; serialize scans and live events through core.
  Start the gateway with its sink only with `SLACK_APP_TOKEN`; otherwise log. Stop inbound
  before outbox, then stop the gateway and await the sink before store close.
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
- `start(signal)` must return promptly once `signal` aborts; a module that ignores it holds up
  the whole shutdown.
