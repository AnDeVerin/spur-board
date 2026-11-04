# Worker commands, part 2

#### `board comment`

Purpose: Comment on a task.
Arguments: `<task>`, `<text>`.
Flags: `--block <value>`, `--key <key>`, `--json`.
Use when: Add a new task comment.
Avoid when: Use comment_edit to revise your comment.
Example: `board comment PROJ-123 "Target v2." --key comment-PROJ-123-leave-a-note-on-a-task-worker-1432` — Leave a note on a task.
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

#### `board comment edit`

Purpose: Edit a comment written by the caller; the revision advances.
Arguments: `<comment>`, `<text>`.
Flags: `--key <key>`, `--json`.
Use when: Revise your existing comment.
Avoid when: Use comment_add for a new comment.
Example: `board comment edit C3 "Target v3." --key comment-edit-PROJ-123-correct-a-comment-worker-1432` — Correct a comment.
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

#### `board escalate`

Purpose: Pass a block on to the next addressee up the chain.
Arguments: `<block>`.
Flags: `--key <key>`, `--json`.
Use when: Escalate an open block.
Avoid when: Use block_answer to answer a question.
Example: `board escalate B13 --key escalate-PROJ-123-escalate-a-failing-build-to-the-operator-worker-1432` — Escalate a failing build to the operator.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `block_not_open`: Read the task with `board task <KEY>` to see the current blocks.
- `task_archived`: Ask an operator to add the task to the board again if work continues.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board answer`

Purpose: Answer a question block; the answer becomes a comment and the block closes.
Arguments: `<block>`, `<text>`.
Flags: `--key <key>`, `--json`.
Use when: Answer an open question.
Avoid when: Use block_unblock to close without an answer.
Example: `board answer B12 "Target v2." --key answer-PROJ-123-answer-a-question-worker-1432` — Answer a question.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `block_not_open`: Read the task with `board task <KEY>` to see the current blocks.
- `wrong_block_type`: Read the block type with `board task <KEY>` and use the operation for that type.
- `task_archived`: Ask an operator to add the task to the board again if work continues.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.

#### `board unblock`

Purpose: Close a block: the work is done, a reason is given, or its author withdraws it.
Arguments: `<block>`.
Flags: `--done [ref]`, `--reason <reason>`, `--withdraw <answer>`, `--key <key>`, `--json`.
Use when: Close an open block.
Avoid when: Use block_answer for a question answer.
Example: `board unblock B13 --done example/web#9 --key unblock-PROJ-123-unblock-after-fixing-the-build-worker-1432` — Unblock after fixing the build.
Errors:

- `usage`: Run `board schema` to see the expected input and fix the arguments.
- `wrong_id_kind`: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.
- `forbidden`: Check which role may run the operation in `board schema`, or ask the operator.
- `not_found`: Check the ID with `board status` or `board task <KEY>`.
- `not_implemented`: Ask the operator to update the daemon to a build with this operation.
- `block_not_open`: Read the task with `board task <KEY>` to see the current blocks.
- `task_archived`: Ask an operator to add the task to the board again if work continues.
- `idempotency_key_mismatch`: Use a new key for a new command, or repeat the earlier input with the same key.
- `identity_unavailable`: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.
- `starting`: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.
