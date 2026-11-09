---
name: running-the-daemon
description: Rules for packages/daemon/ - modules, config and secrets, logging and redaction, pollers, shutdown, the lock. Use when you change packages/daemon/ or write a module or poller the daemon runs. Don't use for config schema fields (use working-with-contracts) or the store (use working-with-storage).
---

# Running the daemon

## Composition root and modules

- `main` binds signals, exit, streams, environment, home and wall time; `runDaemon` receives them
  as dependencies so tests pass fakes. `acquireLock` writes `process.pid` into the lock file.
- Register modules in start order as `ModuleEntry` values with `name`, `stopStage` and
  `module: createX(ctxFor('<name>'))`. Each has `start(signal)` and `stop()`.
- Register `board-core` and `board-adapters` through `createBoardModules`. Share one observation
  core with the runner; keep timers and runner state in that instance.
- In `main`, pass that core to board modules; share one operation registry with HTTP and inbound,
  including `schema.get`.
- A module gets `config`, `secrets`, `store`, `log`, `clock`, `logCall` and `state` through
  `ModuleContext`. No shared state, singletons or imports of another module's internals.
- Use `ctx.store`; only `main` opens it. Only core and daemon import SQLite (`sqlite driver
  boundary`).
- Modules start one at a time. A start that throws or rejects gets no `stop()`: its start owns
  its own cleanup (`packages/daemon/test/lifecycle.test.ts`, `describe('runDaemon')`).
- `state()` is `starting` until every module is up, then `ready`, then `stopping`
  (`packages/daemon/test/lifecycle.test.ts`, `describe('runDaemon')`).
- Read time through `ctx.clock` in daemon modules; only `main` binds `Date.now`
  (`packages/daemon/test/lifecycle.test.ts`, `describe('runDaemon')`).
- Test `runDaemon` with injected fakes, never `vi.mock`; process and lock tests use a real daemon
  and flock.

## Config and secrets

- `loadConfig` in `packages/daemon/src/config.ts` validates `config.yaml` through `configSchema`
  and reads the optional `secrets.env`. A new config field is a contracts change: follow
  `working-with-contracts`.
- Invalid config raises `ConfigError` before storage: schema errors list field paths and a hint;
  missing files name the file, and YAML errors include line and column.
- Refuse `secrets.env` when `mode & 0o077` is nonzero, including write-only access.
- Keep secrets in `secrets.env`, never config or the environment; modules read `ctx.secrets`.
- `resolvePaths` places the files: `BOARD_HOME` holds all four, else the XDG directories.
- Pass `ctx.secrets` to `startAdapters`. It composes Jira, GitHub PR, GitHub Issues and Spur
  sources; missing tracker credentials produce blind source reports instead of stopping startup.

## Logging

- Write JSON lines to stdout through `createLogger` in `packages/daemon/src/logger.ts`.
- Before the logger exists (lock and config failures), errors go to stderr through
  `ProcessPort.writeErr`.
- Log through `ctx.log`, the child logger carrying `module`. No console output, no second logger.
- Use the `redacting` destination wrapper: censor credential keys at any depth and known secret
  values, raw or JSON-escaped. Withhold a line that cannot be censored; leave short values alone.
- Logged fields: `module`, `err`, `signal`, `pending`, `call`, `duration_ms`, `outcome`,
  `requestId`, `method`, `path`, `status`, `port`. Name new entity IDs as contracts do, e.g.
  `taskId`.
- Wrap external calls in `ctx.logCall`; it logs duration and outcome, then rethrows.
- Log sender ticks and Spur doorbell sends (`spur.send`, HTTP to `adapters.spur.baseUrl`) through
  the outbox module's `ctx.logCall`.
- Wrap adapter HTTP calls through `board-adapters.logCall`. Log each runner failure
  (`onPollFailure`) at warn as `adapter poll failed` with `source`, `step`, `kind`, `err` and an
  invalid batch's `issues` (`packages/daemon/test/board-modules.test.ts`). Journal unknown Spur
  state/status notices through core; log a Spur restart once through the module logger.

## HTTP

Read references/http.md for startup, authentication, operation registry and request logging.

## Scheduling and shutdown

Read references/lifecycle.md for poller, timer, stage and signal rules.

## Single instance

- `acquireLock` in `packages/daemon/src/lock.ts` takes an exclusive flock on the lock file
  before anything else. The kernel drops it when the process dies; the file is never unlinked.
  Needs `flock` from util-linux.
- A second daemon fails with `LockHeldError`, naming the file and PID.
