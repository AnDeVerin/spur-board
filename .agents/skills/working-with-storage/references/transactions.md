# Store transactions

## Transactions

- Write through `scanTransaction(store, config, fn)` (`packages/core/src/app/secrets.ts`); it
  runs `fn` in `store.transaction` and passes its `trx`. It is required when `fn` can reach a
  gateway outbox producer (`packages/core/src/app/outbox.ts`) or `scanConfig`: outside a scan
  they throw `Gateway outbox requires a secret scan transaction`. `enqueueDoorbell` is the
  exception: doorbell rows skip the scan, so it also works in a plain
  `store.transaction`.
- Use plain `store.transaction(fn)` only for a body that reaches neither, as
  `purgeExpiredCommands` in `packages/core/src/app/commands.ts` and `createQuery` in
  `packages/core/src/app/queries.ts` do.
- Inside `fn`, write only through `trx`. Never use `store.db` or call `store.transaction` or
  `scanTransaction` again inside `fn`: each waits for the connection `fn` holds and deadlocks
  (`Store` in `packages/core/src/store/store.ts`).
- `store.transaction` is the only place application code starts a transaction; `scanTransaction`
  starts each pass through it. It sends `BEGIN IMMEDIATE`, so the write lock is held from the
  start.
- Keep each `tickBoard` tick, accepted observation batch, source-state report,
  notice and `createApply` command in its own transaction. Persist their state changes and
  journal events together so a failed unit rolls back as a whole.
- Keep each inbound event in one transaction. On handler failure, roll back, then journal the
  failure and create the linked operator item in a separate transaction before resolving the sink.
- No IO inside `fn`: no network, file or child process, no await other than `trx` queries. Fetch
  first, then write; a side effect goes out through the outbox after commit (next section). Why:
  the lock is held for all of `fn`, other writers give up after the 5000 ms busy timeout, and a
  rollback cannot undo a side effect.
- The reviewer judges inbound boundaries and no-IO; transaction behavior is checked in
  `packages/core/test/store/store.test.ts`, `describe('store.transaction')`.
- Catalog mutations go through `createApply`; inbound events call `replayOperation` inside their
  transaction. The `(actor, key)` lookup, effect and `command` row commit together. A retry of an
  inbound item reuses that transaction's `trx`; it never starts a nested transaction.
- Probe `BEGIN IMMEDIATE` on a second connection with `timeout: 0` before the callback's first
  write; later probes cannot distinguish an immediate lock from a deferred one
  (`packages/core/test/store/store.test.ts`, `describe('store.transaction')`).
- Share one Store in in-process concurrency tests: its connection mutex queues transactions;
  two native SQLite connections can block the event loop while waiting for the writer
  (`packages/core/src/store/store.ts`, `packages/core/test/app/restart.test.ts`).
- Check whether a caller awaits a write through a failure path; a following query can queue
  behind an unawaited transaction and hide the missing await
  (`packages/core/src/app/commands.ts`, `packages/core/test/app/restart.test.ts`).
- `scanTransaction` may run `fn` more than once, up to 32 passes: a pass that meets an unscanned
  gateway string rolls back, producers in it return without inserting, and the pass replays after
  the scan. So `fn` is deterministic and has no effect outside the store: no IO, no log, no write
  to an outer variable except a value captured once on the first pass. Return what the caller
  needs and apply it after the call, as `runTick` in `packages/core/src/app/sender.ts` sets
  `downRecorded`. `fn` must build the same gateway strings on every pass. A time that lands in
  one, such as an outbox payload, is read before the call, or captured once on the first pass
  after the write lock and reused on every replay, as `runTick` does with the send-time token
  expiry
  (`packages/core/test/app/tokens.test.ts`, `expires a request at send time under a clock that
  moves on every read` and `expires a request that lapses while its send waits for the write
  lock`). A fresh time read on each pass keeps the replay going to its limit
  (`packages/core/test/app/observe.test.ts`, `describe('a clock that moves during the
  transaction')`). A time that stays in the database may be read inside, after the write lock, as
  `start` in `packages/core/src/app/sender.ts` does.
