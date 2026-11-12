# Add an enum value

- Add it to the list where it is defined, at its place by meaning, not at the end. `COLUMNS`
  order is the board's left-to-right order, enforced by `checkBoard`.
- Update its pin where one exists: `packages/contracts/test/enums.test.ts` for lists in
  `packages/contracts/src/enums.ts`, the fixture `Record` in
  `packages/contracts/test/gateway/schemas.test.ts` for gateway kinds. A changed expected value is
  a Changed checks entry (`gitflow`).
- Run `pnpm typecheck` and handle every exhaustive switch (`assertNever`).
- A list config uses: run `pnpm gen:config-schema`.
- A new `COLUMNS` entry also changes `ADDRESSEE_ROLES`, the config JSON Schema, and the default
  board of every project that omits `columns`: update the default-board test in
  `packages/contracts/test/config.test.ts` and say so in the PR Description. With
  `required: true`, every config that lists `columns` without it fails: a user-visible break.
- A new value in a list the journal uses is not breaking. A `COLUMNS[].name` change is display
  text only.
- A list an operation schema uses also changes the catalog and the MCP tool schemas. Run
  `pnpm gen` and commit the rewritten `packages/contracts/ops.snapshot.json`. `pnpm gen` does not
  regenerate `packages/cli/test/__snapshots__/mcp.test.ts.snap`: update it from the repo root with
  `pnpm exec vitest run --project unit -u packages/cli/test/mcp.test.ts`, read the diff, and list
  it under Changed checks.
- A test that checks a fixed fixture writes its expected value out. Built from a list that grows,
  such as `COLUMN_IDS`, it breaks on every new value while the fixture stays the same.
