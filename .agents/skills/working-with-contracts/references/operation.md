# Add or change an operation

The catalog is `OPERATIONS` in `packages/contracts/src/ops/catalog.ts`. The daemon route, the
CLI and the MCP tools are to be generated from it, so one entry is the whole contract. The tests named
here are in `packages/contracts/test/ops.test.ts`.

## Entry

- Build every entry with `defineOperation` (`packages/contracts/src/ops/define.ts`). It adds the
  common errors, the MCP name (`id` with `.` -> `_`) and the idempotency key bindings.
- Input and output are `z.strictObject`, or a `z.discriminatedUnion` on `mode` of strict objects.
  Every property has `.describe()`; the "describes every property and closes every object" test
  fails otherwise.
- An object without properties is allowed only for the two opaque JSON Schema payloads in the
  `schema.get` output; the "opaque payloads only at the two named schema.get fields" test pins
  them.
- No `.transform` or `.preprocess`. `catalogSnapshotBody` converts inputs in both modes and
  outputs in output mode, so a `.transform` throws; a `.preprocess` passes, so review rejects it.
- Never put the idempotency key in an input schema; `defineOperation` binds `--key` and
  `idempotencyKey` for every mutation and `null` for every query.
- IDs use `blockIdSchema`, `commentIdSchema`, `itemIdSchema`, `taskKeySchema`; actors use
  `actorIdSchema` (`packages/contracts/src/ids.ts`). A wrong-kind ID then gives `wrong_id_kind`
  through `errorCodeOf`.
- A comment in any output is `commentSchema`, reused as is, never a copy: the "comment shape"
  tests compare it. Every `at` or `*At` field is `z.iso.datetime()`.
- `cli.args` name input properties, present in every union branch.
- At least one example; every example input and output must parse.

## Grants and errors

- Grants are `'any'` or a list of rules `{grant, mode?, blockTypes?}` from `GRANTS`. A `mode`
  names a branch of the input's `mode` discriminator. A caller that matches no rule gets
  `forbidden`, including a block-type mismatch inside a rule.
- `preconditions.blockTypes` is the state check: a block of another type gives
  `wrong_block_type`. List `wrong_block_type` only on an operation with preconditions.
- List only the operation's own errors. `usage`, `forbidden`, `identity_unavailable`, `starting`
  and `not_implemented` (and `idempotency_key_mismatch` for a mutation) are added for you
  (`COMMON_ERRORS` in `packages/contracts/src/ops/define.ts`). Only codes with an HTTP status;
  client-side codes never appear.
- Adding or changing an error code, hint or exit code: read `handling-errors`.
- A mutation that changes a task lists `task_archived`; the test pins the exceptions.
- Update the literal table under `describe('grants')`. A changed row is a changed expected value:
  list it under Changed checks (`gitflow`).

## Bindings

- Every operation has a CLI command and an MCP name, both unique.
- Slack only for the operations in the exceptions list of the "binds every op to CLI and MCP"
  test; adding one changes that list, a Changed checks entry.
- A union input declares `cli.modes`: one `{mode, flag, value}` per branch, e.g. `--done` filling
  `ref`, or `value: null` for a bare flag. A plain input has none. The "binds one CLI flag per
  branch" test checks it.
- A union input's JSON Schema root is `oneOf` with no `type`; the MCP generator has to add
  `type: 'object'`.

## Snapshot

- Run `pnpm gen:ops-snapshot` and commit `packages/contracts/ops.snapshot.json`. The snapshot test
  fails with `ops.snapshot.json is stale: run pnpm gen:ops-snapshot` otherwise. Never edit it by
  hand.
- Its `version` is the sha256 of the rest of the file; there is no runtime version constant.
  The `schema.get` example uses a placeholder version.

## Exports

- Export a symbol only when `src/index.ts` re-exports it or another `src/` or `scripts/` file
  imports it; knip fails on an export used only in its own file.

## Breaking changes

- User-visible breaks: removing or renaming an operation or a field, a new required input
  field, a tightened input constraint, a removed output field, a changed error code. Follow
  "Breaking changes" in `SKILL.md`; operations need no expand step.
- A new operation, a new optional input field or a new output field is not breaking.
