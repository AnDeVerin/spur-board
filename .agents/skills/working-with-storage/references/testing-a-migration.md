# Testing a migration

How `packages/core/test/store/migrations.test.ts` covers migrations, and what a new one adds.

- The empty-file case in `packages/core/test/store/migrations.test.ts`, `describe('migrate')`,
  runs the real chain from an empty file.
- The runner retention and rollback cases there use synthetic `probe` and `failing` migrations;
  other cases in that block exercise real predecessor migrations.
- A migration that changes or moves rows adds its own case in
  `packages/core/test/store/migrations.test.ts`: open a `rawDb`, `migrate` with
  `real.slice(0, N - 1)`, insert rows in the N-1 shape with raw SQL, `migrate` with `real`, then
  assert on the rows.
- Until a committed fixture from a released version exists, build the N-1 state by hand.
- Append a new `ALTER TABLE` column last in `sampleRows`; the row round-trip check compares its
  key order with SQLite column order (`packages/core/test/store/store.test.ts`,
  `describe('openStore')`).
- For a partial unique index, assert its metadata and positive inserts that should remain
  allowed (`packages/core/test/store/migrations.test.ts`, `describe('migrate')`;
  `packages/core/test/store/store.test.ts`, `describe('openStore')`).
- Compare SQLite sidecar directory listings after closing connections; open handles can leave
  sidecars visible (`packages/core/test/store/migrations.test.ts`).
- The test derives every version from `real.length`: `probe` and `failing` are
  `real.length + 1` and `+ 2`, and the `store.migration` expectations, `user_version` values and
  error matchers follow. A new migration changes none of these values; keep it that way.
