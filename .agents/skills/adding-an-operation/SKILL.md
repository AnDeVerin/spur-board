---
name: adding-an-operation
description: Path of an operation from catalog to handler, store, CLI, MCP, generated files and tests. Use when you add or change an entry in packages/contracts/src/ops/catalog.ts or its handler. Don't use for field or break rules (use working-with-contracts) or CLI/MCP output (use designing-agent-surfaces).
---

# Adding an operation

One catalog entry drives the daemon route, the CLI command and the MCP tool. Work the steps in
path order. A PR that changes this path or these rules updates this skill in the same PR.

## 1. Catalog entry

- Add the entry to `OPERATIONS` in `packages/contracts/src/ops/catalog.ts`; shapes, grants,
  errors and bindings follow `.agents/skills/working-with-contracts/references/operation.md`,
  which names each check in `describe('catalog')` and `describe('snapshot')` of
  `packages/contracts/test/ops.test.ts`.

## 2. Core handler

- Write a `Mutation<'<id>'>` (`packages/core/src/app/commands.ts`) or `Query<'<id>'>`
  (`packages/core/src/app/queries.ts`) in the matching module under `packages/core/src/app/`, and
  register it in `createOperationRegistry` (`packages/core/src/app/registry.ts`).
- A mutation that must read an external source first adds `prepare`: `createApply` runs it after
  the input and key checks and a read-only authorization, before the transaction, and passes
  its result as `ctx.prepared`. `prepare` never writes. Reference: `task.submit` in
  `packages/core/src/app/turn-commands.ts`.
- `createOperationRegistry` returns the total `OperationHandlers`
  (`packages/core/src/app/operations.ts`), so a catalog entry without a registration fails
  `tsc`. `OperationRegistry` stays `Partial` for transports, and `dispatchOperation` answers
  `not_implemented` when the requested handler is missing or has a mismatched `id`. The coverage
  test is in
  `packages/core/test/app/registry.test.ts`.

## 3. Store

- A new table or column is a migration in `packages/core/src/store/migrations/` plus its types
  in `packages/core/src/store/schema.ts`; follow `working-with-storage`.

## 4. HTTP, CLI and MCP

- No per-operation code. `/v1/ops/:id` in `packages/core/src/api/server.ts`, `createProgram` in
  `packages/cli/src/cli.ts` and `createMcpServer` in `packages/cli/src/mcp.ts` loop over the
  catalog. An operation that seems to need a special case there needs a catalog field instead;
  raise it in the issue before implementing.
- Command, tool and output conventions: `designing-agent-surfaces`.

## 5. MCP annotations

- Leave `mcp.destructive` unset unless the mutation passes the additive rule under "Bindings" in
  `.agents/skills/working-with-contracts/references/operation.md`. Decide it by reading every
  write the handler reaches, helpers included; the pin sees only the catalog.

## 6. Generated files

- Run `pnpm gen` and commit every file it changes: `packages/contracts/ops.snapshot.json`, the
  product skill `packages/skills/spur-board/SKILL.md` with its pages in
  `packages/skills/spur-board/references/`, and `docs/cli.md`. The gen job in
  `.github/workflows/ci.yml` fails on a diff or an untracked page.
- Any catalog change moves the `version` in `packages/contracts/ops.snapshot.json`: a running
  daemon and live `board mcp` sessions answer `version_mismatch` until both restart. Say so in
  the PR Description.

## 7. Tests to extend

- The literal table under `describe('grants')` in `packages/contracts/test/ops.test.ts`.
- The non-destructive pin under `describe('catalog')` there, for a `destructive: false` entry.
- `packages/cli/test/__snapshots__/mcp.test.ts.snap`: rerun `packages/cli/test/mcp.test.ts` with
  `-u` and read the diff.
- A handler test in `packages/core/test/app/` that goes through `createOperationRegistry`.
- A daemon integration test in `packages/daemon/test/` when the operation reaches a gateway.
- Each changed expected value above, and the snap that `pnpm guardrails` reports, is a Changed
  checks entry (`gitflow`).

## 8. Reference operations

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
