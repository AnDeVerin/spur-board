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

- Write only inside `store.transaction(fn)`, through the `trx` it passes. Never use `store.db` or
  call `store.transaction` again inside `fn`: both wait for the connection `fn` holds and deadlock
  (`Store` in `packages/core/src/store/store.ts`).
- `store.transaction` is the only place application code starts a transaction. It sends
  `BEGIN IMMEDIATE`, so the write lock is held from the start.
- Keep each `tickBoard` tick, accepted observation batch, source-state report,
  notice and `createApply` command in its own `store.transaction`. Persist their state changes and
  journal events together so a failed unit rolls back as a whole.
- Keep each inbound event in one `store.transaction`. On handler failure, roll back, then journal the
  failure and create the linked operator item in a separate transaction before resolving the sink.
- No IO inside `fn`: no network, file or child process, no await other than `trx` queries. Fetch
  first, then write; a side effect goes out through the outbox after commit (next section). Why:
  the lock is held for all of `fn`, other writers give up after the 5000 ms busy timeout, and a
  rollback cannot undo a side effect.
- No lint checks the last two rules; the reviewer judges them. The transaction itself is pinned
  by 'commits on return and holds the write lock from BEGIN' and
  'rolls back a write when the function throws'.
- Catalog mutations go through `createApply`; inbound events call `replayOperation` inside their
  transaction. The `(actor, key)` lookup, effect and `command` row commit together. A retry of an
  inbound item reuses that transaction's `trx`; it never starts a nested transaction.

## State, journal and outbox

- A state change, the `event` rows that describe it and the `outbox` rows for its side effects go
  in one transaction. A state change is any write to the board's tables: a `pr_snapshot`,
  `ticket_snapshot` or `session_snapshot` upsert, a `block`, `comment`, `submission` or `command`
  row. A crash between two transactions would leave one without the other.
- A side effect (a message, a call to GitHub) is never performed inside `fn`: it is recorded as
  an `outbox` row, and the sender does the IO after commit. So a rollback has nothing to undo.
- Write outbox rows only through the producers in `packages/core/src/app/outbox.ts`, with the
  caller's `trx`. A new kind gets its payload schema, `KIND_SPACE` and `KIND_PRIORITY` entries
  there; the space comes from the kind, never from the payload.
- A row that must follow another (reply, close, edit) sets `parent_outbox_id` to the thread's
  latest row; none is written under a dead one. A row under a dead parent dies `superseded`.
  A `feed.line.edit` written before its line is sent means the item was cleared: the sender
  cancels both. A row with `uncertain=1` is never cancelled as stale (it may be posted): it goes
  with `maybeSent`, then its dependents.
- A doorbell's delivered ring count lives in `notification`, not `outbox.attempts`: transport
  retries reuse the same outbox row. Reconcile due rings and recheck their recipient before send.
- A claimed feed line is rechecked against its operator item before send. If the item cleared and
  delivery has not started, cancel the line and its edit; uncertain lines recover before editing.
- Retries, the per-space limit and transport health belong to the sender
  (`packages/core/src/app/sender.ts`); it calls the gateway between its two transactions,
  never inside one. Pinned by `packages/core/test/app/delivery.test.ts` and
  `packages/core/test/app/outbox.restart.test.ts`.
- Event kinds and payloads follow `working-with-contracts`. JSON columns are read and written
  through `parseJson` / `toJson`.
- A column that records who did something holds an `ActorId` (`packages/core/src/store/schema.ts`):
  `operator`, `system`, or agent:project/session for an agent. Never write the bare kind there.
  This covers `submission.author`, `block.author`, `block.unblocked_by`, `comment.author`,
  `command.actor` and `dismissal.dismissed_by`. The `event` table is the exception: `actor` holds
  the kind and `actor_ref` the project and session.

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
- A migration that renames, removes or tightens stored data, adds a required column or changes
  what a value means is a user-visible break: follow `working-with-contracts` as well as these
  rules.
- A database newer than the code is refused (`assertNotNewer`), pinned by
  'refuses a database newer than the code'.

## Testing a migration

What the migration tests cover and how to add a case for a migration that moves rows:
`references/testing-a-migration.md`.

## PRAGMAs and opening

- `journal_mode = WAL`: readers do not block the writer.
- `synchronous = NORMAL`: safe under WAL; a power loss may drop the last commits but does not
  corrupt the file.
- `foreign_keys = ON`: SQLite has it off by default, per connection.
- Busy timeout 5000 ms, set on purpose in the `Database` constructor so a driver default cannot
  lower it.
- Nothing that writes the file (the WAL switch, any write) runs before `assertNotNewer`, so a
  newer database stays byte for byte as it was; 'refuses a database newer than the code' compares
  the file hash before and after. The busy timeout is a connection setting and writes nothing.
- Production code opens the store only through `openStore`.
- Pinned by 'sets WAL, NORMAL sync, foreign keys and busy timeout on open'.

## Changing these rules

A PR that changes `packages/core/src/store/store.ts`, `packages/core/src/store/migrate.ts` or the
tests named here updates this skill in the same PR.

## Checks

- `pnpm check`.
