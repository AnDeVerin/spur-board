# Testing a migration

How `packages/core/test/store/migrations.test.ts` covers migrations, and what a new one adds.

- 'creates every table and index from an empty file' runs the real chain from an empty file only.
- 'keeps rows written at N-1 when migrating to N' and
  'rolls back every pending migration when one throws and keeps the backup' test the runner with
  the synthetic `probe` and `failing` migrations, not a real file and its predecessor.
- A migration that changes or moves rows adds its own case in
  `packages/core/test/store/migrations.test.ts`: open a `rawDb`, `migrate` with
  `real.slice(0, N - 1)`, insert rows in the N-1 shape with raw SQL, `migrate` with `real`, then
  assert on the rows.
- Until a committed fixture from a released version exists, build the N-1 state by hand.
- The test derives every version from `real.length`: `probe` and `failing` are
  `real.length + 1` and `+ 2`, and the `store.migration` expectations, `user_version` values and
  error matchers follow. A new migration changes none of these values; keep it that way.
