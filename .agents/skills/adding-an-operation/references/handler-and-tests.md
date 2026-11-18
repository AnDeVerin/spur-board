# Handler, tests and reference operations

## Core handler

- A mutation that must read an external source first adds `prepare`: `createApply` runs it after
  the input and key checks, a stored-key replay check and a read-only authorization, before the
  transaction, and passes its result as `ctx.prepared`. A stored key skips `prepare`, and a
  same-key call waits for the one in flight. `prepare` never writes. Reference: `task.submit` in
  `packages/core/src/app/turn-commands.ts`.
- `createOperationRegistry` returns the total `OperationHandlers`
  (`packages/core/src/app/operations.ts`), so a catalog entry without a registration fails
  `tsc`. `OperationRegistry` stays `Partial` for transports, and `dispatchOperation` answers
  `not_implemented` when the requested handler is missing or has a mismatched `id`. The coverage
  test is in
  `packages/core/test/app/registry.test.ts`.

## Tests to extend

- The literal table under `describe('grants')` in `packages/contracts/test/ops.test.ts`.
- The non-destructive pin under `describe('catalog')` there, for a `destructive: false` entry.
- `packages/cli/test/__snapshots__/mcp.test.ts.snap`: rerun `packages/cli/test/mcp.test.ts` with
  `-u` and read the diff.
- A handler test in `packages/core/test/app/` that goes through `createOperationRegistry`.
- A daemon integration test in `packages/daemon/test/` when the operation reaches a gateway.
- Each changed expected value above, and the snap that `pnpm guardrails` reports, is a Changed
  checks entry (`gitflow`).

## Reference operations

- `comment.add`, the plain mutation: its entry in `packages/contracts/src/ops/catalog.ts` ->
  `add` in `createBlockMutations` -> `addComment` (both `packages/core/src/app/blocks.ts`) ->
  `'comment.add'` in `createOperationRegistry` -> `dispatchOperation` -> `/v1/ops/:id` ->
  `createProgram` and `createMcpServer`. Tests: `describe('production query handlers')` in
  `packages/core/test/app/queries.test.ts`, which calls it through `createOperationRegistry`, and
  `describe('board mcp')` in `packages/cli/test/mcp.test.ts`.
- `block.ask`, through a gateway: `packages/daemon/test/worker-question.integration.test.ts`.
- `link.add`, a union input with `cli.modes` (`linkModes` in the catalog) and a migration
  (`packages/core/src/store/migrations/0010_manual_links.sql`); handler `createLinkMutations` in
  `packages/core/src/app/links.ts`.
