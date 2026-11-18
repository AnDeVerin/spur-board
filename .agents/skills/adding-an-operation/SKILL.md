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
- `prepare` for a mutation that reads an external source first, and how the registry types catch
  a missing handler: `references/handler-and-tests.md`.

## 3. Store

- A new table or column is a migration in `packages/core/src/store/migrations/` plus its types
  in `packages/core/src/store/schema.ts`; follow `working-with-storage`.

## 4. HTTP, CLI and MCP

- No per-operation code. `/v1/ops/:id` in `packages/core/src/api/ops-route.ts`, `createProgram` in
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
  `.github/workflows/ci.yml` fails on a diff or an untracked page. Put a new visible operation on
  its catalog neighbours' page in `scripts/gen-skill.ts`.
- Any catalog change moves the `version` in `packages/contracts/ops.snapshot.json`: a running
  daemon and live `board mcp` sessions answer `version_mismatch` until both restart. Say so in
  the PR Description.

## 7. Tests to extend

- The tests to extend and their Changed checks entries: `references/handler-and-tests.md`.

## 8. Reference operations

- `comment.add`, `block.ask` and `link.add`, traced from catalog to tests:
  `references/handler-and-tests.md`.
