---
name: running-the-daemon
description: Rules for packages/daemon/ - modules, config and secrets, logging and redaction, pollers, shutdown, the lock. Use when you change packages/daemon/ or write a module or poller the daemon runs. Don't use for config schema fields (use working-with-contracts) or the store (use working-with-storage).
---

# Running the daemon

`packages/daemon/` is the daemon process: `main` in `packages/daemon/src/main.ts` binds the real
process, and `runDaemon` in `packages/daemon/src/lifecycle.ts` runs lock, config, logger, store,
modules, then `daemon ready`. Where a test or lint rule enforces a rule, the rule names it.

## When to use

- Any edit under `packages/daemon/`, and any module, poller or timer the daemon runs.
- Not for config schema fields (use `working-with-contracts`) or the store and its transactions
  (use `working-with-storage`).
- Not covered yet: the systemd unit (#57), the watchdog and runbook (#41), HTTP routes, the real
  `503 starting` answer and the origin guard (#52), the MCP stdio server (#54), CLI output (#51),
  the poller and adapter runner (#23).

## Composition root and modules

- `main` is the only place that touches the real process, environment, home directory and wall
  time. It passes them to `runDaemon` as dependencies; tests pass fakes.
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
- Daemon tests use fakes passed as dependencies, never `vi.mock`; pinned for daemon tests by
  'keeps the vi.mock ban on %s'.

## Config and secrets

- `loadConfig` in `packages/daemon/src/config.ts` validates `config.yaml` through `configSchema`
  and reads the optional `secrets.env`. A new config field is a contracts change: follow
  `working-with-contracts`.
- A bad config fails with a `ConfigError` listing each field by path, with a hint, before the
  database exists. Pinned by 'lists each invalid field by path, with a hint' and
  'invalid config exits 1 before creating the database'.
- `secrets.env` is refused when group or others have any permission on it, pinned by
  'refuses a secrets.env readable by others'.
- Secrets live only in `secrets.env`, never in config; pinned by 'has no secret-like property
  names'. The daemon never writes them to the environment; modules read `ctx.secrets`.
- `resolvePaths` places the files: `BOARD_HOME` holds all four, else the XDG directories.

## Logging

- The daemon writes JSON lines to stdout through `createLogger` in
  `packages/daemon/src/logger.ts`. There is no stdio mode; stdio surfaces are left to #54 and #51.
- Before the logger exists (lock and config failures), errors go to stderr through
  `ProcessPort.writeErr`.
- Log through `ctx.log`, the child logger carrying `module`. No console output, no second logger.
- Redaction is the `redacting` destination wrapper, not pino `redact`: it censors credential keys
  at any depth and replaces known secret values, raw and JSON-escaped. Pinned by 'redacts secret
  values and credential keys everywhere', 'censors credential keys at any depth and in any
  casing', 'withholds a line it cannot censor instead of writing it raw' and 'leaves short secret
  values alone'.
- Fields the code writes: `module`, `err`, `signal`, `pending`, `call`, `duration_ms`, `outcome`.
  A new entity ID takes its contracts field name, e.g. `taskId`.
- Wrap every external call in `ctx.logCall`, which logs `call`, `duration_ms` and `outcome` and
  rethrows. Pinned by 'logs ok at info with the duration from the clock'.

## Pollers

No poller runner exists yet; #23 adds it and updates this section. Until then a poller follows
this shape:

- A `setTimeout` chain armed after the previous tick settles, with jitter. Never `setInterval`;
  ticks must not overlap.
- Pass the start `signal` into every call (`PollContext.signal`, A7 in
  `packages/contracts/src/adapters.ts`). Backoff state is per poller; an adapter never retries on
  its own (A6).
- `stopStage: 'pollers'`. `stop()` clears the pending timer and awaits the current tick.
- The one `setInterval` is the keepalive in `main` (`KEEPALIVE_MS`): no module owns a server yet,
  so nothing else holds the event loop open. The PR whose module first owns a server removes it.
- `@typescript-eslint/no-floating-promises` refuses an unhandled promise; a deliberate one is
  `void`.

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
- A stop that hangs past `DEFAULT_SHUTDOWN_TIMEOUT_MS` exits 1 and logs the `pending` modules,
  pinned by 'exits 1 when a stop hangs'. A failed stop logs and still lets the others stop.
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

A PR that changes `packages/daemon/src/` or the tests named here updates this skill in the same
PR. The runner PR (#23) replaces the Pollers section with its real rules and numbers.

## Checks

- `pnpm check`.
- `pnpm test packages/daemon`.
