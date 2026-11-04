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
- Production code opens the store only through `openStore`.
- Check: `packages/core/test/store/store.test.ts`, `describe('openStore')`.
