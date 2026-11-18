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

- Catch only at a boundary: HTTP `setErrorHandler` (`packages/core/src/api/ops-route.ts`), CLI
  `runCli` (`packages/cli/src/cli.ts`), the MCP tool callback (`packages/cli/src/mcp.ts`),
  `runDaemon` (`packages/daemon/src/lifecycle.ts`), and background loops: the adapter runner,
  purge `onError` (`packages/daemon/src/composition.ts`), inbound dispatch, Socket Mode `track`
  (`packages/gateway-slack/src/socket.ts`, reported through `onError`).
- Log a cause as `err` through `ctx.log`; a cause or stack never reaches the wire.
- Errors before the logger, middle layers, wrapping a cause and unknown errors:
  `references/boundaries.md`.

## One shape over HTTP, CLI and MCP

- Renderers, per-call hints, MCP input errors and `problemError`: `references/boundaries.md`.

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
