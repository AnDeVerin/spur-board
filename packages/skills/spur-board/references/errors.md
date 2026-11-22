# Board error hints

## Errors every command can return

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.
- `stopping`: Wait until the daemon is running again, then retry the command with its existing idempotency key if it has one; if it stays stopped, ask in your own session.

## Other error hints

- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `github_unavailable`: Follow the message: ask the operator to fix what it names, or retry a read or link once GitHub answers the board's polls; repeat a submit only by task key in shadow mode.
- `stale_comment_revision`: Read the latest comment revision, then acknowledge that revision.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `task_archived`: Ask an operator to add the task to the board again if work continues.
- `block_not_open`: Read the task with `board task <KEY>` to see the current blocks.
- `wrong_block_type`: Read the block type with `board task <KEY>` and use the operation for that type.
- `turn_closed`: Read your open turns with `board inbox` and act only on a turn listed there.
- `not_turn_taker`: Take the turn with `board inbox ack` first; only the session that took it can submit or return it.
- `submit_basis_invalid`: Use from and a nonblank reason for carried, a nonblank reason for skipped, and from only with carried.
- `submit_source_not_tested`: Choose a tested submission SHA on this task, or a carried SHA with a tested origin; otherwise test or explicitly skip with a reason.
- `head_mismatch`: Push the commit to the task's pull request branch and submit the head GitHub shows.
- `return_not_allowed`: In Dev, ask with `board ask` instead.
- `not_operator`: Ask the operator to end the wait; as its holder, submit or return the turn, or start a shorter wait.
- `turn_wait_limit`: Submit or return the turn; the operator gets an inbox item once the wait ends.
- `no_active_wait`: Read the turn with `board task <KEY>`; there is no wait left to end.
