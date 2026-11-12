# Board error hints

## Errors every command can return

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

## Other error hints

- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `stale_comment_revision`: Read the latest comment revision, then acknowledge that revision.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `task_archived`: Ask an operator to add the task to the board again if work continues.
- `block_not_open`: Read the task with `board task <KEY>` to see the current blocks.
- `wrong_block_type`: Read the block type with `board task <KEY>` and use the operation for that type.
- `turn_closed`: Read your open turns with `board inbox` and act only on a turn listed there.
- `not_turn_taker`: Take the turn with `board inbox ack` first; only the session that took it can submit or return it.
- `head_mismatch`: Push the commit to the task's pull request branch and submit its head; if the task has none, ask the operator to link the pull request with `board link` first.
- `github_unavailable`: Wait until GitHub answers, then submit again.
- `return_not_allowed`: In Dev, ask with `board ask` instead.
