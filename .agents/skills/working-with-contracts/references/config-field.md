# Add a config field

- Make the leaf optional or give it `.default(v)`. A new section object gets `.prefault({})`, not
  `.default({})`, so its inner defaults fill. A new required key is a user-visible break.
- Never a secret: the "has no secret-like property names" test fails.
- Run `pnpm gen:config-schema` and commit `packages/contracts/config.schema.json`; the "matches
  the committed config.schema.json" test fails when it is stale.
- Assert the default under `describe('fixtures')`, or set the field in a YAML fixture in
  `packages/contracts/test/fixtures/` when a real project would set it.
- Add an `invalid configs` row with the message and `→ at <path>`. A custom message goes through
  the `error` callback (pattern: `columnConfig`) or `ctx.addIssue` with `path` (pattern:
  `rejectDuplicates`).
