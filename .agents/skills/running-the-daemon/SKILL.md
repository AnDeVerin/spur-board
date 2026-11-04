---
name: running-the-daemon
description: Rules for packages/daemon/ - modules, config and secrets, logging and redaction, pollers, shutdown, the lock. Use when you change packages/daemon/ or write a module or poller the daemon runs. Don't use for config schema fields (use working-with-contracts) or the store (use working-with-storage).
---

# Running the daemon

`main` binds the process; `runDaemon` runs lock, config, logger, store, modules, then
`daemon ready`. Where a test or lint enforces a rule, the rule names it.

## When to use

- Any edit under `packages/daemon/`, and any module, poller or timer the daemon runs.
- Not for config schema fields (use `working-with-contracts`) or the store and its transactions
  (use `working-with-storage`).

## Composition root and modules

- `main` binds the real process (signal and fatal handlers, exit, stdout, stderr), the
  environment, the home directory and wall time, and passes them to `runDaemon` as dependencies;
  tests pass fakes. One exception: `acquireLock` writes `process.pid` into the lock file, pinned
  by 'creates the directory and writes its PID'.
- A module is a `Module`: `start(signal)` and `stop()`. Register it in the `modules` list in
  `main`, in start order, as a `ModuleEntry` with `name`, `stopStage` and
  `module: createX(ctxFor('<name>'))`.
- `main` registers `board-core` and `board-adapters` through `createBoardModules` in
  `board-modules.ts`. Build one observation core from `board-core` context and pass it to the
  adapter runner; keep its timer and runner state inside that composition instance.
- A module gets everything through its `ModuleContext`: `config`, `secrets`, `store`, `log`,
  `clock`, `logCall`, `state`. No module-level state, singletons or imports of another module's
  internals; two daemons in one test process must not share anything.
- Daemon code reaches the store only through `ctx.store`, which `main` opens with `openStore` from
  `@spur-board/core`. No lint checks this; the reviewer judges it. The lint boundary itself is
  wider: only core and daemon may import the SQLite driver, pinned by
  `describe('sqlite driver boundary')` in `packages/testkit/test/lint-rules.test.ts`.
- Modules start one at a time. A start that throws or rejects gets no `stop()`: its start owns
  its own cleanup. Pinned by 'start failure stops started modules'.
- `state()` is `starting` until every module is up, then `ready`, then `stopping`. Pinned by
  'reports starting until all modules are up' and 'module states move to ready and then stopping'.
- Read time from `ctx.clock` in `packages/daemon/` and in every module built from `ctxFor`; a
  `Clock` is the only source of wall time there and only `main` binds `Date.now`. Pinned by
  'module context carries the clock and a bound logCall'.
- Test `runDaemon` with injected fakes; never use `vi.mock` in daemon tests. Process and lock
  tests spawn a real daemon and take a real flock.

## Config and secrets

- `loadConfig` in `packages/daemon/src/config.ts` validates `config.yaml` through `configSchema`
  and reads the optional `secrets.env`. A new config field is a contracts change: follow
  `working-with-contracts`.
- Invalid config raises `ConfigError` with field paths and a hint before the database exists;
  missing files and invalid YAML also raise `ConfigError` with their location.
- `secrets.env` is refused when group or others have any permission on it, pinned by
  'refuses a secrets.env readable by others'.
- Secrets live only in `secrets.env`, never in config; pinned by 'has no secret-like property
  names'. The daemon never writes them to the environment; modules read `ctx.secrets`.
- `resolvePaths` places the files: `BOARD_HOME` holds all four, else the XDG directories.
- Pass `ctx.secrets` to `startAdapters`. It composes Jira, GitHub PR, GitHub Issues and Spur
  sources; missing tracker credentials produce blind source reports instead of stopping startup.

## Logging

- The daemon writes JSON lines to stdout through `createLogger` in
  `packages/daemon/src/logger.ts`. There is no stdio mode; stdio surfaces are left to #54 and #51.
- Before the logger exists (lock and config failures), errors go to stderr through
  `ProcessPort.writeErr`.
- Log through `ctx.log`, the child logger carrying `module`. No console output, no second logger.
- Redact through the destination wrapper: censor credential keys at any depth and known secret
  values even inside text. Withhold a line that cannot be censored; leave short values alone.
- Fields the code writes: `module`, `err`, `signal`, `pending`, `call`, `duration_ms`, `outcome`.
  A new entity ID takes its contracts field name, e.g. `taskId`.
- Wrap external calls in `ctx.logCall`; it logs duration and outcome, then rethrows.
- Log sender ticks and `spur send` child calls through the outbox module's `ctx.logCall`.
- Wrap adapter HTTP calls through `board-adapters.logCall`. Journal unknown Spur
  state/status notices through core; log a Spur restart once through the module logger.

## Scheduling

- Start the outbox tick immediately, then arm a `setTimeout` for one second plus under 100 ms of
  jitter after the tick settles. Never queue a second tick while one runs.
- Pass the start signal to each sender tick. On stop, clear the timer and await the active tick
  before the store closes. Register the outbox with `stopStage: 'outbox'` and its gateway with
  `stopStage: 'final'`. Pinned by 'skips timer ticks while a delivery is active'.
- `board-core` starts a tick immediately, then arms a 60-second `setTimeout` after it settles.
  On stop, clear the timer and await the active tick before the store closes.
- `board-adapters` uses `startAdapters`; the runner owns per-source timers, backoff and aborts
  (`PollContext.signal`, A7 in `packages/contracts/src/adapters.ts`). Adapters never retry on
  their own (A6). Register it with `stopStage: 'pollers'`; await `runner.stop()` on stop.
- Keep the sole `setInterval` in `main` (`KEEPALIVE_MS`) until a module owns a server.
- Handle each tick promise; `@typescript-eslint/no-floating-promises` rejects an unhandled one.

## Shutdown

- SIGTERM or SIGINT runs one shutdown: state `stopping`, the shutdown timer armed, the start
  `signal` aborted, the in-flight start awaited, then `stop()` stage by stage in `STOP_STAGES`
  order (`'pollers'`, then `'outbox'`, then `'final'`), modules within a stage in parallel, then
  the store closed and the lock released. Pinned by 'starts and stops in order',
  'signal during a start stops started modules' and
  'a start that rejects after the abort is part of the stop'.
- Pick `stopStage` by what the module does: `'pollers'` for anything that observes, `'final'`
  for HTTP, gateways and `board-core` (the comment on `STOP_STAGES`). `board-adapters` stops in
  `'pollers'` before `board-core` waits for its active tick in `'final'`. Do not add a stage without
  changing `STOP_STAGES` and 'starts and stops in order'.
- A stop past `DEFAULT_SHUTDOWN_TIMEOUT_MS` exits 1 and logs pending modules. A failed stop logs
  and still lets the others stop.
- Exit through `ProcessPort.exit` once. A fatal error exits 1 immediately without module stop.
- `start(signal)` must return promptly once `signal` aborts; a module that ignores it holds up
  the whole shutdown.

## Single instance

- `acquireLock` in `packages/daemon/src/lock.ts` takes an exclusive flock on the lock file
  before anything else. The kernel drops it when the process dies; the file is never unlinked.
  Needs `flock` from util-linux.
- A second daemon fails with `LockHeldError`, naming the file and PID.

## Changing these rules

A PR that changes `packages/daemon/src/` or the tests named here updates this skill in the same
PR.

## Checks

- `pnpm check`.
- `pnpm test packages/daemon`.
