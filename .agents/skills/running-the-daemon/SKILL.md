---
name: running-the-daemon
description: Rules for packages/daemon/ - modules, config and secrets, logging and redaction, pollers, shutdown, the lock. Use when you change packages/daemon/ or write a module or poller the daemon runs. Don't use for config schema fields (use working-with-contracts) or the store (use working-with-storage).
---

# Running the daemon

`main` binds the process; `runDaemon` starts lock, config, logger, store and modules, then logs
`daemon ready`. Tests and lint enforce the named rules below.

## When to use

- Any edit under `packages/daemon/`, and any module, poller or timer the daemon runs.
- Not for config schema fields (use `working-with-contracts`) or the store and its transactions
  (use `working-with-storage`).

## Composition root and modules

- `main` binds signals, exit, streams, environment, home and wall time; `runDaemon` receives them
  as dependencies so tests pass fakes. `acquireLock` writes `process.pid` into the lock file.
- A module is a `Module`: `start(signal)` and `stop()`. Register it in the `modules` list in
  `main`, in start order, as a `ModuleEntry` with `name`, `stopStage` and
  `module: createX(ctxFor('<name>'))`.
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
- Lifecycle tests drive `runDaemon` with fakes passed as dependencies; no daemon test uses
  `vi.mock`, pinned by 'keeps the vi.mock ban on %s'. The process and lock tests in
  `packages/daemon/test/` spawn a real daemon and take a real flock on purpose.

## Config and secrets

- `loadConfig` in `packages/daemon/src/config.ts` validates `config.yaml` through `configSchema`
  and reads the optional `secrets.env`. A new config field is a contracts change: follow
  `working-with-contracts`.
- A config that fails `configSchema` throws a `ConfigError` listing each invalid field by path,
  with a hint, before the database exists. Pinned by 'lists each invalid field by path, with a
  hint' and 'invalid config exits 1 before creating the database'. A missing file and invalid
  YAML also throw a `ConfigError`, without field paths: pinned by 'names the missing config file'
  and 'reports a YAML syntax error with line and column'.
- `secrets.env` is refused when group or others have any permission on it, pinned by
  'refuses a secrets.env readable by others'.
- Secrets live only in `secrets.env`, never in config; pinned by 'has no secret-like property
  names'. The daemon never writes them to the environment; modules read `ctx.secrets`.
- `resolvePaths` places the files: `BOARD_HOME` holds all four, else the XDG directories.

## Logging

- Write JSON lines to stdout through `createLogger` in `packages/daemon/src/logger.ts`.
- Before the logger exists (lock and config failures), errors go to stderr through
  `ProcessPort.writeErr`.
- Log through `ctx.log`, the child logger carrying `module`. No console output, no second logger.
- Use the `redacting` destination wrapper: censor credential keys at any depth and known secret
  values, raw or JSON-escaped. Withhold a line that cannot be censored; leave short values alone.
- Fields the code writes: `module`, `err`, `signal`, `pending`, `call`, `duration_ms`, `outcome`,
  `requestId`, `method`, `path`, `status`.
  A new entity ID takes its contracts field name, e.g. `taskId`.
- Wrap every external call in `ctx.logCall`, which logs `call`, `duration_ms` and `outcome` and
  rethrows. Pinned by 'logs ok at info with the duration from the clock'.
- Log sender ticks and `spur send` child calls through the outbox module's `ctx.logCall`.

## HTTP

- Register `createHttpModule(ctxFor('http'))` last, including when Slack is absent. Its listener
  starts before `state()` becomes `ready`; until then it answers `503 starting`. Process tests in
  `packages/daemon/test/main.test.ts` cover both paths.
- Bind with `listenApiServer` on `127.0.0.1` and the configured `http.port`. The module reads a
  session snapshot through core, then uses a bounded live Spur lookup on a miss. Wrap that call
  in `ctx.logCall`; reject bearer tokens until a verifier is provided.
- Log each request with `requestId`, method, path and status through `ctx.log`. Do not log the
  query string. Register HTTP at `stopStage: 'final'` so outbox delivery finishes before close.

## Scheduling

- Start the outbox tick immediately, then arm a `setTimeout` for one second plus under 100 ms of
  jitter after the tick settles. Never queue a second tick while one runs.
- Pass the start signal to each sender tick. On stop, clear the timer and await the active tick
  before the store closes. Register the outbox with `stopStage: 'outbox'` and its gateway with
  `stopStage: 'final'`. Pinned by 'skips timer ticks while a delivery is active'.
- A poller uses a `setTimeout` chain with jitter and passes `PollContext.signal` into each call.
  Backoff belongs to the poller; an adapter does not retry.
- Register a poller with `stopStage: 'pollers'`; `stop()` clears its timer and awaits its tick.
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
  for HTTP, gateways and core (the comment on `STOP_STAGES`). Do not add a stage without
  changing `STOP_STAGES` and 'starts and stops in order'.
- A stop past `DEFAULT_SHUTDOWN_TIMEOUT_MS` exits 1 and logs `pending` modules. A failed stop
  logs and lets the others stop.
- Every exit goes through `ProcessPort.exit` exactly once. Pinned by 'two signals run one
  shutdown' and 'fatal during shutdown exits once'. A fatal error exits 1 at once, with no
  module stop, pinned by 'fatal error exits 1'.
- `start(signal)` must return promptly once `signal` aborts; a module that ignores it holds up
  the whole shutdown.

## Single instance

- `acquireLock` in `packages/daemon/src/lock.ts` takes an exclusive flock on the lock file
  before anything else. The kernel drops it when the process dies; the file is never unlinked.
  Needs `flock` from util-linux.
- A second daemon fails with `LockHeldError`, naming the file and PID. Pinned by 'refuses a
  second holder and names the file and PID' and 'refuses a second daemon and recovers after the
  first is killed'.

## Changing these rules

A PR that changes `packages/daemon/src/` or the tests named here updates this skill in the same PR.

## Checks

- `pnpm check`.
- `pnpm test packages/daemon`.
