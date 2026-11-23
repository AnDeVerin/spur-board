# Board task, inbox and comment commands

Every command can return the common errors in [errors.md](errors.md). Each entry lists its other codes; their hints are there too.

### `board status`

Purpose: List items, freshness, service health, host metrics, tasks with columnEnteredAt, turns and PRs; detail adds facts.
Arguments: none.
Flags: `--project <value>`, `--detail`, `--json`.
Use when: Get a board overview.
Avoid when: Use `board task <task>` for one task.
Example: `board status` — Show the board.
Other errors: `not_found`.

### `board task`

Purpose: Show a task; refresh reads GitHub PRs.
Arguments: `<task>`.
Flags: `--refresh`, `--detail`, `--why`, `--json`.
Use when: Inspect a task; detail adds closed turns.
Avoid when: Use `board task history <task>` for past events.
Example: `board task PROJ-123` — Show one task.
Other errors: `wrong_id_kind`, `not_found`, `github_unavailable`.

### `board task history`

Purpose: List what happened to a task, oldest first by time, leaving out facts events with nothing new to name, such as an update time alone.
Arguments: `<task>`.
Flags: `--json`.
Use when: Trace changes to one task.
Avoid when: Use `board task <task>` for current state.
Example: `board task history acme/web#42` — Show task history.
Other errors: `wrong_id_kind`, `not_found`.

### `board schema`

Purpose: Describe the operations: inputs, outputs, errors and bindings.
Arguments: none.
Flags: `--role <value>`, `--json`.
Use when: Discover operation contracts.
Avoid when: Use `board status` for board data.
Worker example: `board schema --role worker` — Describe the operations a worker may call.
Orchestrator example: `board schema --role orchestrator` — Describe the operations an orchestrator may call.
Other errors: none.

### `board inbox`

Purpose: List the comments, blocks and turns addressed to the caller and not yet handled.
Arguments: none.
Flags: `--project <value>`, `--json`.
Use when: Read items awaiting the caller.
Avoid when: Use `board inbox ack <entries>` to mark them read.
Example: `board inbox` — Read the inbox.
Other errors: `not_found`.

### `board inbox ack`

Purpose: Mark comments, blocks addressed to the caller, turns or doorbell rings as read; acking a turn makes the caller its taker.
Arguments: `<entries>`.
Flags: `--key <key>`, `--json`.
Use when: Mark handled inbox items or a ring ID like N18-1 read; an item handled before comes back under alreadyHandled. The operator acks a block ID addressed to the operator, or a turn ID to take a turn addressed to the operator, or to take over an open orchestrator turn, taken or not.
Avoid when: Use `board inbox` to inspect them first; the operator finds the turns addressed to it with `board inbox operator`.
Example: `board inbox ack C3@1 --key inbox-ack-PROJ-123-comment-revision-1432` — Acknowledge a comment revision.
Other errors: `wrong_id_kind`, `not_found`, `stale_comment_revision`, `idempotency_key_mismatch`.

### `board ask`

Purpose: Ask a blocking question; the Board routes it to the column orchestrator, the curator or the operator.
Arguments: `<task>`, `<text>`.
Flags: `--key <key>`, `--json`.
Use when: Ask a blocking question.
Avoid when: Use `board comment <task> <text>` for a nonblocking note.
Example: `board ask PROJ-123 "Which API version should the client target?" --key ask-PROJ-123-api-version-1432` — Ask which API version to target.
Other errors: `wrong_id_kind`, `not_found`, `task_archived`, `idempotency_key_mismatch`.

### `board project ask`

Purpose: Ask the operator about a project, not a task.
Arguments: `<project>`, `<text>`.
Flags: `--to <value>`, `--key <key>`, `--json`.
Use when: A question has no task.
Avoid when: Use `board ask <task> <text>` for a task question.
Example: `board project ask web "Restart?" --to operator --key project-ask-PROJ-123-restart-1432` — Ask to restart.
Other errors: `not_found`, `idempotency_key_mismatch`.

### `board comment`

Purpose: Comment on a task.
Arguments: `<task>`, `<text>`.
Flags: `--block <value>`, `--key <key>`, `--json`.
Use when: Add a new task comment.
Avoid when: Use `board comment edit <comment> <text>` to revise your comment.
Example: `board comment PROJ-123 "Target v2." --key comment-PROJ-123-note-task-1432` — Leave a note on a task.
Other errors: `wrong_id_kind`, `not_found`, `task_archived`, `idempotency_key_mismatch`.

### `board comment edit`

Purpose: Edit a comment written by the caller; the revision advances.
Arguments: `<comment>`, `<text>`.
Flags: `--key <key>`, `--json`.
Use when: Revise your existing comment.
Avoid when: Use `board comment <task> <text>` for a new comment.
Example: `board comment edit C3 "Target v3." --key comment-edit-PROJ-123-comment-1432` — Correct a comment.
Other errors: `wrong_id_kind`, `not_found`, `task_archived`, `idempotency_key_mismatch`.
