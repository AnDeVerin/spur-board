# Boundaries and one error shape

## Catch at boundaries

- `runDaemon` writes lock and config failures with `port.writeErr`, before a logger exists; later
  failures go to the log as `{ err }`.
- A middle layer translates one known error and rethrows the rest; `logCall`
  (`packages/daemon/src/logger.ts`) logs and rethrows.
- Keep the cause when you wrap: `new AdapterError(..., { cause })`
  (`packages/adapters/src/github/client.ts`), `ConfigError` in `packages/daemon/src/config.ts`.
- HTTP, CLI and MCP turn an unknown error into `unexpected`; only HTTP logs the cause, through
  `logError` as `{ err, requestId }`. `trace` names the daemon log even for a client-side
  `client-<uuid>` requestId. Log the cause where you still hold it.

## One shape over HTTP, CLI and MCP

- Build error bodies only through `packages/contracts/src/error-renderers.ts`; the forms stay
  equal by `packages/contracts/test/errors.test.ts` `describe('error representations')`.
- Renderers take no hint (`errorInputSchema`). HTTP (the `setErrorHandler` callback) and CLI
  (`renderCliError`) patch a per-call hint after rendering; MCP (`renderMcpError`) applies one
  for `forbidden` and the `idempotencyKey` hints of `parseArguments` only, so the catalog hint
  of every other code must stand alone.
- MCP input errors are catalog `usage`: `handlerValidator` admits every argument and
  `parseArguments` rejects.
- `problemError` (`packages/cli/src/client.ts`) keeps a code only when its `status` matches the
  HTTP status, else `outcome_unknown`.
