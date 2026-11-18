# Daemon logging

- Write JSON lines to stdout through `createLogger` in `packages/daemon/src/logger.ts`.
- Before the logger exists (lock and config failures), errors go to stderr through
  `ProcessPort.writeErr`.
- Use the `redacting` destination wrapper: censor credential keys at any depth and known secret
  values, raw or JSON-escaped. Withhold a line that cannot be censored; leave short values alone.
- Logged fields: `module`, `err`, `signal`, `pending`, `call`, `duration_ms`, `outcome`,
  `requestId`, `method`, `path`, `status`, `port`. Name new entity IDs as contracts do, e.g.
  `taskId`.
- Wrap external calls in `ctx.logCall`; it logs duration and outcome, then rethrows.
- Parse every response with zod or an adapter export; `wireWalkerBans` in `eslint.config.js`
  covers daemon sources except `logger.ts`.
- Log sender ticks and Spur doorbell sends (`spur.send`, HTTP to `adapters.spur.baseUrl`) through
  the outbox module's `ctx.logCall`.
- Wrap adapter HTTP calls through `board-adapters.logCall`. Log each runner failure
  (`onPollFailure`) at warn as `adapter poll failed` with `source`, `step`, `kind`, `err` and an
  invalid batch's `issues` (`packages/daemon/test/board-modules.test.ts`). Journal unknown Spur
  state/status notices through core; log a Spur restart once through the module logger.
