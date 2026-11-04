# Orchestrator commands, part 3

#### `board unblock`

Purpose: Close a block: the work is done, a reason is given, or its author withdraws it.
Arguments: `<block>`.
Flags: `--reason <reason>`, `--withdraw <answer>`, `--key <key>`, `--json`.
Use when: Close an open block.
Avoid when: Use block_answer for a question answer.
Example: `board unblock B13 --reason "The build issue was resolved." --key unblock-PROJ-123-explain-why-a-code-block-no-longer-applies-orchestrator-1432` — Explain why a code block no longer applies.
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
