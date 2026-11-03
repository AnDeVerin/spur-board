---
name: working-with-storage
description: Rules for the SQLite store in packages/core/src/store/ - transactions, snapshots with events, migrations and their tests, PRAGMAs. Use when you change the store or a migration, or write through store.transaction. Don't use for zod schemas, enums or event kinds (use working-with-contracts).
---

# Working with storage

`packages/core/src/store/` holds the SQLite store: one file, opened by `openStore`, schema in
numbered migrations. Where a test enforces a rule, the rule names it.

## When to use

- Any edit under `packages/core/src/store/` or `packages/core/test/store/`, and any code that
  writes through `store.transaction`.
- Not for zod schemas, enums, event kinds or breaking changes in stored data: use
  `working-with-contracts`.
- Outbox, inbox and idempotency keys are not covered yet: #32, #35.

## Transactions

- Write only inside `store.transaction(fn)`, through the `trx` it passes. Never use `store.db` or
  call `store.transaction` again inside `fn`: both wait for the lock `fn` holds and deadlock
  (`Store` in `packages/core/src/store/store.ts`).
- `store.transaction` is the only place that starts a transaction. It sends `BEGIN IMMEDIATE`, so
  the write lock is held from the start.
- One unit of work is one `store.transaction`: a tick, one observed batch, one command. Tick and
  observe code does not exist yet (#31); #31 updates this section with its callers.
- No IO inside `fn`: no network, file or child process, no await other than `trx` queries. Fetch
  first, then write. Why: the lock is held for all of `fn`, other writers give up after the
  5000 ms busy timeout, and a rollback cannot undo a side effect.
- No lint checks the last two rules; the reviewer judges them. The transaction itself is pinned
  by 'commits on return and holds the write lock from BEGIN' and
  'rolls back a write when the function throws'.

## Snapshots and journal

- An upsert of `pr_snapshot`, `ticket_snapshot` or `session_snapshot` and the `event` rows that
  describe the change go in the same transaction. A crash between two transactions would leave
  one without the other.
- Event kinds and payloads follow `working-with-contracts`. JSON columns are read and written
  through `parseJson` / `toJson`.

## Migrations

- A schema change is the next numbered file under `packages/core/src/store/migrations/` plus its
  pin in `PINS` in `packages/core/test/store/migrations.test.ts`; a missing pin fails with the
  line to add. The file name rule is enforced by
  'rejects a gap or a misnamed migration file'.
- Never edit a committed migration file. Changing the pin of an existing file is a review
  blocker; 'matches every committed migration file' fails on any edit.
- In the same commit, update the row types in `packages/core/src/store/schema.ts`, `sampleRows`
  in `packages/core/test/store/sample-rows.ts` (in foreign key order), and `INDEXES` in
  `packages/core/test/store/migrations.test.ts`. Checked by 'round-trips one row per table' and
  'creates every table and index from an empty file'.
- The runner owns the transaction, `foreign_keys`, `user_version` and the backup (`migrate` in
  `packages/core/src/store/migrate.ts`). A migration file has no `BEGIN`, `COMMIT`, `PRAGMA` or
  `VACUUM`.
- A change `ALTER TABLE` cannot make is a table rebuild in the same file. The runner turns
  foreign keys off and runs `foreign_key_check` before `COMMIT`.
- New tables are `STRICT` and follow the header of
  `packages/core/src/store/migrations/0001_init.sql`: timestamps as ISO-8601 UTC text, JSON as
  text checked by zod, flags as `CHECK (x IN (0, 1))`. Enum columns are `TEXT` with no `CHECK`, so
  a new value needs no migration; a `CHECK` change would need a rebuild.
- Renaming or removing stored data is a user-visible break: follow `working-with-contracts`.
- A database newer than the code is refused (`assertNotNewer`), pinned by
  'refuses a database newer than the code'.

## Testing a migration

- 'creates every table and index from an empty file' runs the real chain from an empty file only.
- 'keeps rows written at N-1 when migrating to N' and
  'rolls back every pending migration when one throws and keeps the backup' test the runner with
  the synthetic `probe` and `failing` migrations, not a real file and its predecessor.
- A migration that changes or moves rows adds its own case in
  `packages/core/test/store/migrations.test.ts`: open a `rawDb`, `migrate` with
  `real.slice(0, N - 1)`, insert rows in the N-1 shape with raw SQL, `migrate` with `real`, then
  assert on the rows.
- Until a committed fixture from a released version exists, build the N-1 state by hand.
- The PR that adds the second migration derives the test's hard-coded versions from
  `real.length`: the `probe` and `failing` versions and names become `real.length + 1` and
  `real.length + 2`, and the `store.migration` expectations, the `user_version` values and the
  version literals in error matchers follow from it. Each changed expected value goes under
  Changed checks (`gitflow`).

## PRAGMAs and opening

- `journal_mode = WAL`: readers do not block the writer.
- `synchronous = NORMAL`: safe under WAL; a power loss may drop the last commits but does not
  corrupt the file.
- `foreign_keys = ON`: SQLite has it off by default, per connection.
- Busy timeout 5000 ms, set on purpose in the `Database` constructor so a driver default cannot
  lower it.
- Nothing that writes the file (the WAL switch, any write) runs before `assertNotNewer`, so a
  newer database stays byte for byte as it was. The busy timeout is a connection setting and
  writes nothing.
- Production code opens the store only through `openStore`.
- Pinned by 'sets WAL, NORMAL sync, foreign keys and busy timeout on open'.

## Changing these rules

A PR that changes `packages/core/src/store/store.ts`, `packages/core/src/store/migrate.ts` or the
tests named here updates this skill in the same PR.

## Checks

- `pnpm check`.
