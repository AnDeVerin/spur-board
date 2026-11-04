# Store transactions

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
- The reviewer judges inbound boundaries and no-IO; transaction behavior is checked in
  `packages/core/test/store/store.test.ts`, `describe('store.transaction')`.
- Catalog mutations go through `createApply`; inbound events call `replayOperation` inside their
  transaction. The `(actor, key)` lookup, effect and `command` row commit together. A retry of an
  inbound item reuses that transaction's `trx`; it never starts a nested transaction.
