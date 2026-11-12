# Board command reference

Every command can return the common errors below. Each entry lists its other codes; find their hints here too.

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

### `board status`

Purpose: List actionable items, source freshness and compact tasks; detail adds full facts and links.
Arguments: none.
Flags: `--project <value>`, `--detail`, `--json`.
Use when: Get a board overview; pass detail for full ticket, pull request and session facts.
Avoid when: Use `board task <task>` for one task.
Example: `board status` — Show the board.
Other errors: `not_found`.

### `board task`

Purpose: Show a task with its links, blocks and comments.
Arguments: `<task>`.
Flags: `--json`.
Use when: Inspect one task now.
Avoid when: Use `board task history <task>` for past events.
Example: `board task PROJ-123` — Show one task.
Other errors: `wrong_id_kind`, `not_found`.

### `board task history`

Purpose: List what happened to a task, oldest first.
Arguments: `<task>`.
Flags: `--json`.
Use when: Trace changes to one task.
Avoid when: Use `board task <task>` for current state.
Example: `board task history acme/web#42` — Show the history of a task.
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

Purpose: Mark comments, agent-addressed blocks or turns as read; acking a turn makes the caller its taker.
Arguments: `<entries>`.
Flags: `--key <key>`, `--json`.
Use when: Mark handled inbox items read.
Avoid when: Use `board inbox` to inspect them first.
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

### `board block`

Purpose: Block a task on a dependency or an external party.
Arguments: `<task>`.
Flags: `--type <value>`, `--reason <value>`, `--key <key>`, `--json`.
Use when: Record a dependency or external block.
Avoid when: Use `board ask <task> <text>` for a question.
Example: `board block PROJ-123 --type dependency --reason "Needs PROJ-120 merged first." --key block-PROJ-123-another-task-1432` — Wait for another task.
Other errors: `wrong_id_kind`, `not_found`, `task_archived`, `idempotency_key_mismatch`.

### `board escalate`

Purpose: Pass a block on to the next addressee up the chain.
Arguments: `<block>`.
Flags: `--note <value>`, `--key <key>`, `--json`.
Use when: Escalate an open block.
Avoid when: Use `board answer <block> <text>` to answer a question.
Example: `board escalate B13 --key escalate-PROJ-123-failing-build-1432` — Escalate a failing build to the operator.
Other errors: `wrong_id_kind`, `not_found`, `block_not_open`, `task_archived`, `idempotency_key_mismatch`.

### `board answer`

Purpose: Answer a question block; the answer becomes a comment and the block closes.
Arguments: `<block>`, `<text>`.
Flags: `--key <key>`, `--json`.
Use when: Answer an open question.
Avoid when: Use `board unblock <block>` to close without an answer.
Example: `board answer B12 "Target v2." --key answer-PROJ-123-question-1432` — Answer a question.
Other errors: `wrong_id_kind`, `not_found`, `block_not_open`, `wrong_block_type`, `task_archived`, `idempotency_key_mismatch`.

### `board unblock`

Purpose: Close a block: the work is done, a reason is given, or its author withdraws it.
Arguments: `<block>`.
Flags: `--done [ref]`, `--reason <reason>`, `--withdraw <answer>`, `--key <key>`, `--json`.
Modes by role: worker: `--done`, `--reason`, `--withdraw`; orchestrator: `--reason`, `--withdraw`.
Use when: Close an open block.
Avoid when: Use `board answer <block> <text>` for a question answer.
Worker example: `board unblock B13 --done example/web#9 --key unblock-PROJ-123-fixing-build-1432` — Unblock after fixing the build.
Orchestrator example: `board unblock B13 --reason "The build issue was resolved." --key unblock-PROJ-123-code-block-1432` — Explain why a code block no longer applies.
Other errors: `wrong_id_kind`, `not_found`, `block_not_open`, `task_archived`, `idempotency_key_mismatch`.
