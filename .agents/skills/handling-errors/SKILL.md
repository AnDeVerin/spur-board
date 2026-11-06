---
name: handling-errors
description: Rules for errors - Result vs throw, retries, the ERRORS catalog, hints, exit codes, boundary catches, one shape over HTTP, CLI and MCP. Use when you add or change an error code, hint, exit code or catch, or review such a diff. Don't use for an operation's error list (use working-with-contracts).
---

# Handling errors

## Result, throw or retry

- Return a `Result` (`ok`/`err` in `packages/contracts/src/errors.ts`) when callers handle the
  failure differently: `parseRef` in `packages/contracts/src/ids.ts` has three callers.
- Throw `CommandError` (`packages/core/src/app/commands.ts`) or `CliError`
  (`packages/cli/src/exit-codes.ts`) when the failure ends the request.
- Translate a domain error at the layer edge: `rule` in `packages/core/src/app/blocks.ts` turns
  `BlockRuleError` into `CommandError` and rethrows anything else.
- There is no `retryable` flag; retry guidance is `recovery` (`sideEffects`, `maxRetries`).
- One owner retries: the adapter runner (`nextDelay` in `packages/adapters/src/runner/policy.ts`)
  and the outbox sender (`packages/core/src/app/sender.ts`). Gateways make one attempt (G1, G2 in
  `packages/contracts/src/gateway/gateway.ts`).

## Catalog

- Every code is an `ERRORS` entry in `packages/contracts/src/errors.ts`; the wire fields are
  `errorDetailSchema`: `code`, `requestId`, `message`, `hint`, `docs`, `recovery`, `context`,
  optional `trace`.
- Adding or changing a code: follow `.agents/skills/handling-errors/references/add-a-code.md`.

## Catch at boundaries

- Catch only at a boundary: HTTP `setErrorHandler` (`packages/core/src/api/server.ts`), CLI
  `runCli` (`packages/cli/src/cli.ts`), the MCP tool callback (`packages/cli/src/mcp.ts`),
  `runDaemon` (`packages/daemon/src/lifecycle.ts`), and background loops: the adapter runner,
  purge `onError` (`packages/daemon/src/composition.ts`), inbound dispatch.
- `runDaemon` writes lock and config failures with `port.writeErr`, before a logger exists; later
  failures go to the log as `{ err }`.
- A middle layer translates one known error and rethrows the rest; `logCall`
  (`packages/daemon/src/logger.ts`) logs and rethrows.
- Keep the cause when you wrap: `new AdapterError(..., { cause })`
  (`packages/adapters/src/github/client.ts`), `ConfigError` in `packages/daemon/src/config.ts`.
- Log a cause as `err` through `ctx.log`; a cause or stack never reaches the wire.
- The HTTP, CLI and MCP boundaries turn an unknown error into `unexpected` without logging its
  cause, and `trace` names the daemon log even for a client-side `client-<uuid>` requestId. Log
  the cause where you still hold it.

## One shape over HTTP, CLI and MCP

- Build error bodies only through `packages/contracts/src/error-renderers.ts`; the forms stay
  equal by `packages/contracts/test/errors.test.ts` `describe('error representations')`.
- Renderers take no hint (`errorInputSchema`). HTTP (the `setErrorHandler` callback) and CLI
  (`renderCliError`) patch a per-call hint after rendering; MCP (`renderMcpError`) does not, so
  the catalog hint must stand alone.
- MCP input errors are catalog `usage`: `handlerValidator` admits every argument and
  `parseArguments` rejects.
- `problemError` (`packages/cli/src/client.ts`) keeps a code only when its `status` matches the
  HTTP status, else `outcome_unknown`.

## Exit codes

- `EXIT_CODES`: 0 ok, 1 refused, 2 usage, 3 not applied, 4 config, 5 outcome unknown.
- 3: the daemon could not evaluate the call, so nothing applied; retry after the hint's step.
  A call the daemon evaluated and rejected is 1, even if it can pass later.
- 5: it may have applied; check, then retry with the same key (`renderCliError` adds
  `retry with --key`, MCP adds `idempotencyKey` to `context`).

## Hints

- `message` says what happened; `hint` is the imperative next step.
- Backticked `board <command>` spans in catalog `message`, `hint` and `recovery` are resolved by
  `packages/cli/test/commands.test.ts` `describe('catalog commands')`; check `mcp` and per-call
  hints by hand.
- An operator-only step says "ask the operator" or "Ask in your own session" (`forbidden`,
  `daemon_unavailable`).
- No secrets, no stacks. Other text rules are checked by `packages/contracts/test/errors.test.ts`
  `describe('error catalog')`.
- Add an `mcp` variant only when the agent's next step differs (`version_mismatch`).

## Checks

- `pnpm gen`, then `pnpm check`.
