# State, journal and outbox

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
  cancels both. A gateway row with `uncertain=1` is never cancelled as stale (it may be posted):
  it goes with `maybeSent`, then its dependents.
- A doorbell's delivered ring count lives in `notification`, not `outbox.attempts`: transport
  retries reuse the same outbox row. Due rings are reconciled by their own job
  (`reconcileDueDoorbells` in `packages/core/src/app/doorbells.ts`), not in the claim transaction,
  and the sender rechecks their recipient before send.
- A doorbell retries for 30 min from its first attempt. A Spur rejection or the end of the window
  kills that ring; it ends the notification only while the ring is still its `last_outbox_id`
  (`ringUndelivered` in `packages/core/src/app/doorbells.ts`,
  `packages/core/test/app/doorbell.test.ts`).
  Archive cancels any ring that is not in flight, uncertain or not.
- A claimed feed line is rechecked against its operator item before send. If the item cleared and
  delivery has not started, cancel the line and its edit; uncertain lines recover before editing.
  Before that recheck the sender expires a lapsed token request of the item (`expireTokenOfItem`
  in `packages/core/src/app/tokens.ts`), so a late expiry sweep never posts its approval line.
- Each claim first returns rows a failed tick left `in_flight`, as `recover()` does at start
  (`releaseOrphans` in `packages/core/src/app/sender.ts`).
- Retries, the per-space limit and transport health belong to the sender
  (`packages/core/src/app/sender.ts`); it calls the gateway between its two transactions,
  never inside one (`packages/core/test/app/delivery.test.ts`, `describe('tick')`;
  `packages/core/test/app/outbox.restart.test.ts`).
- Read sender send stamps after taking the transaction's write lock; a queued writer can wait
  behind another send (`packages/core/src/app/sender.ts`,
  `packages/core/test/app/delivery.test.ts`, `describe('transport health')`).
- Event kinds and payloads follow `working-with-contracts`. JSON columns are read and written
  through `parseJson` / `toJson`.
- A column that records who did something holds an `ActorId` (`packages/core/src/store/schema.ts`):
  `operator`, `system`, or agent:project/session for an agent. Never write the bare kind there.
  This covers `submission.author`, `block.author`, `block.unblocked_by`, `comment.author`,
  `command.actor` and `dismissal.dismissed_by`. The `event` table is the exception: `actor` holds
  the kind and `actor_ref` the project and session.
