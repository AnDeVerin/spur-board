---
name: working-with-storage
description: Rules for the SQLite store (packages/core/src/store/) and outbox (packages/core/src/app/{outbox,sender}.ts) - transactions, outbox, migrations and tests, PRAGMAs. Use when you edit them or write through store.transaction. Don't use for zod schemas, enums or event kinds (use working-with-contracts).
---

# Working with storage

`packages/core/src/store/` holds the SQLite store: one file, opened by `openStore`, schema in
numbered migrations. Where a test enforces a rule, the rule names it.

## When to use

- Any edit under `packages/core/src/store/`, `packages/core/test/store/` or the outbox
  (`packages/core/src/app/{outbox,sender}.ts`), and any code that writes through
  `store.transaction`.
- Not for zod schemas, enums or event kinds: use `working-with-contracts`. A migration that
  breaks stored data as users see it (its Breaking changes section lists the cases, a new required
  column and a tightened constraint among them) needs both skills: this one for the migration,
  that one for the break.

## Transactions

- Read references/transactions.md for transaction scope, locking, rollback and command rules.

## State, journal and outbox

Read references/outbox.md for atomic state, journal and outbox writes; producer, sender, ordering,
retry and actor rules.

## Migrations

- A schema change is the next numbered file under `packages/core/src/store/migrations/` plus its
  pin in `PINS` in `packages/core/test/store/migrations.test.ts`; a missing pin fails with the
  line to add (`packages/core/test/store/migrations.test.ts`, `describe('migrate')`).
- Never edit a committed migration file. Changing the pin of an existing file is a review
  blocker (`packages/core/test/store/migrations.test.ts`, `describe('migration pins')`).
- In the same commit, update the row types in `packages/core/src/store/schema.ts`, `sampleRows`
  in `packages/core/test/store/sample-rows.ts` (in foreign key order), and `INDEXES` in
  `packages/core/test/store/migrations.test.ts` (`packages/core/test/store/store.test.ts`,
  `describe('openStore')`; `packages/core/test/store/migrations.test.ts`, `describe('migrate')`).
- When moving a row type out of `schema.ts`, check its package export: `packages/core/src/index.ts`
  re-exports schema types, not types moved to another file.
- The runner owns the transaction, `foreign_keys`, `user_version` and the backup (`migrate` in
  `packages/core/src/store/migrate.ts`). A migration file has no `BEGIN`, `COMMIT`, `PRAGMA` or
  `VACUUM`.
- Back up every file with a schema before migration with `copyDatabase`, even when
  `user_version` is zero; only an empty `sqlite_schema` needs no backup
  (`packages/core/src/store/migrate.ts`).
- Copy a database only through `copyDatabase` (`packages/core/src/store/copy.ts`): `VACUUM INTO`
  a `.partial` sibling, checkpoint a target that has a non-empty `-wal` (it can hold committed
  rows; a damaged target with a missing or empty WAL is not opened), hard-link the target aside,
  remove its empty `-wal` and `-shm`, rename, then remove the link. A kill at any step leaves a complete database
  at the target path; the caller creates the directory and holds the board lock
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

## Testing a migration

What the migration tests cover and how to add a case for a migration that moves rows:
`references/testing-a-migration.md`.

## PRAGMAs and opening

Read references/opening.md for connection settings, newer-database protection and openStore.

## Changing these rules

A PR that changes `packages/core/src/store/store.ts`, `packages/core/src/store/migrate.ts` or the
tests named here updates this skill in the same PR.

## Checks

- `pnpm check`.
