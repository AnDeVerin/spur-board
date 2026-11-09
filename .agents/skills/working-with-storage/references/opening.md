# Opening the SQLite store

## PRAGMAs and opening

- `journal_mode = WAL`: readers do not block the writer.
- `synchronous = NORMAL`: safe under WAL; a power loss may drop the last commits but does not
  corrupt the file.
- `foreign_keys = ON`: SQLite has it off by default, per connection.
- Busy timeout 5000 ms, set on purpose in the `Database` constructor so a driver default cannot
  lower it.
- Nothing that writes the file (the WAL switch, any write) runs before `assertNotNewer`, so a
  newer database stays byte for byte as it was (`packages/core/test/store/migrations.test.ts`,
  `describe('migrate')`). The busy timeout is a connection setting and writes nothing.
- Production code opens the store only through `openStore`, except `copyDatabase`, which opens
  raw read-write connections with no PRAGMA, migration or version check: the source for the
  copy, and an existing target that has a `-wal` only for `wal_checkpoint(TRUNCATE)` before
  the swap.
- `openDatabase` skips version and migration checks and is test-only; it is not exported from
  `packages/core/src/index.ts`.
- An up-to-date `openStore` takes no migration write lock (`packages/core/src/store/migrate.ts`),
  so a second reader can open the database.
- Before migrating a database that already has a schema, write a backup with `copyDatabase`,
  named with its prior version and a timestamp (`packages/core/src/store/migrate.ts`,
  `backupPath`).
- In tests that need `Store.close()` to release a newly opened file, run one query first:
  Kysely initializes its driver lazily and skips `destroy()` before initialization
  (`packages/core/src/store/store.ts`).
- Check: `packages/core/test/store/store.test.ts`, `describe('openStore')`.
