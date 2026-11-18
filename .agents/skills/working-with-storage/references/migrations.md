# Migration rules

- Copy a database only through `copyDatabase` (`packages/core/src/store/copy.ts`): `VACUUM INTO` a
  `.partial` sibling created 0600, checkpoint a target that has a non-empty `-wal` (it can hold
  committed rows; a damaged target with a missing or empty WAL is not opened), hard-link the target
  aside, remove its empty `-wal` and `-shm`, rename, then remove the link. A kill at any step leaves
  a complete database at the target path; the caller creates the directory and holds the board lock
  (`packages/core/test/store/copy.test.ts`, `describe('copyDatabase')`).
- A change `ALTER TABLE` cannot make is a table rebuild in the same file. The runner turns
  foreign keys off and runs `foreign_key_check` before `COMMIT`.
- New tables are `STRICT` and follow the header of
  `packages/core/src/store/migrations/0001_init.sql`: timestamps as ISO-8601 UTC text, JSON as
  text checked by zod, flags as `CHECK (x IN (0, 1))` because SQLite bindings reject JS booleans.
  Enum columns are `TEXT` with no `CHECK`, so a new value needs no migration; a `CHECK` change
  would need a rebuild.
- Pair nullable identity columns in a partial unique index with per-entity non-null `CHECK`s:
  SQLite treats NULL values as distinct (`packages/core/src/store/migrations/0001_init.sql`).
- Store the token hash and approval metadata in `operator_token`, never the raw bearer value;
  verify the current row on every call so revocation is immediate.
- A migration that renames, removes or tightens stored data, adds a required column or changes
  what a value means is a user-visible break: follow `working-with-contracts` as well as these
  rules.
- A database newer than the code is refused by `assertNotNewer`
  (`packages/core/test/store/migrations.test.ts`, `describe('migrate')`).
