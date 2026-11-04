# Orchestrator commands, part 1

#### `board status`

Purpose: List tasks, observations, source freshness and actionable items.
Arguments: none.
Flags: `--project <value>`, `--json`.
Use when: Get a board overview.
Avoid when: Use task_get for one task.
Example: `board status` — Show the board.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board task`

Purpose: Show a task with its blocks and comments.
Arguments: `<task>`.
Flags: `--json`.
Use when: Inspect one task now.
Avoid when: Use task_history for past events.
Example: `board task PROJ-123` — Show one task.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board task history`

Purpose: List what happened to a task, oldest first.
Arguments: `<task>`.
Flags: `--json`.
Use when: Trace changes to one task.
Avoid when: Use task_get for current state.
Example: `board task history acme/web#42` — Show the history of a task.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board schema`

Purpose: Describe the operations: inputs, outputs, errors and bindings.
Arguments: none.
Flags: `--role <value>`, `--json`.
Use when: Discover operation contracts.
Avoid when: Use status_get for board data.
Example: `board schema --role orchestrator` — Describe the operations an orchestrator may call.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board inbox`

Purpose: List the comments and blocks addressed to the caller and not yet handled.
Arguments: none.
Flags: `--project <value>`, `--json`.
Use when: Read items awaiting the caller.
Avoid when: Use inbox_ack to mark them read.
Example: `board inbox` — Read the inbox.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board inbox ack`

Purpose: Mark comments or agent-addressed blocks as read in the inbox.
Arguments: `<entries>`.
Flags: `--key <key>`, `--json`.
Use when: Mark handled inbox items read.
Avoid when: Use inbox_get to inspect them first.
Example: `board inbox ack C3@1 --key inbox-ack-PROJ-123-acknowledge-a-comment-revision-orchestrator-1432` — Acknowledge a comment revision.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `stale_comment_revision`: Read the latest comment revision, then acknowledge that revision.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board ask`

Purpose: Ask the operator a question; the task is blocked until it is answered.
Arguments: `<task>`, `<text>`.
Flags: `--key <key>`, `--json`.
Use when: Ask a blocking question.
Avoid when: Use comment_add for a nonblocking note.
Example: `board ask PROJ-123 "Which API version should the client target?" --key ask-PROJ-123-ask-which-api-version-to-target-orchestrator-1432` — Ask which API version to target.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `task_archived`: Ask an operator to add the task to the board again if work continues.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.
