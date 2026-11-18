# Board block and turn commands

Every command can return the common errors in [errors.md](errors.md). Each entry lists its other codes; their hints are there too.

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
Example: `board escalate B13 --key escalate-PROJ-123-failing-build-1432` — Escalate a failing build.
Other errors: `wrong_id_kind`, `not_found`, `block_not_open`, `task_archived`, `idempotency_key_mismatch`.

### `board answer`

Purpose: Answer a question; the block closes unless it is an operator conversation.
Arguments: `<block>`, `<text>`.
Flags: `--note <value>`, `--key <key>`, `--json`.
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
Worker example: `board unblock B13 --done example/web#9 --key unblock-PROJ-123-fix-1432` — Unblock after a fix.
Orchestrator example: `board unblock B13 --reason "The build issue was resolved." --key unblock-PROJ-123-code-block-1432` — Explain why a code block no longer applies.
Other errors: `wrong_id_kind`, `not_found`, `block_not_open`, `task_archived`, `idempotency_key_mismatch`.

### `board submit`

Purpose: Submit the task's pull request head for a turn the caller took; the turn closes; a pending result is final.
Arguments: `<turn>`, `<sha>`.
Flags: `--basis <value>`, `--from <value>`, `--reason <value>`, `--key <key>`, `--json`.
Use when: Hand in the work of a turn you took, at the pull request head. Declare tested (default), carried from a tested origin on this task, or skipped; carried requires from and reason, skipped requires reason. While the project dispatcher is in shadow mode no turn opens: the column executor submits with the task key.
Avoid when: Use `board return <turn> <reason>` to send the task back to Dev instead.
Example: `board submit T4 9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4 --key submit-PROJ-123-submit-pull-1432` — Submit the pull request head.
Other errors: `wrong_id_kind`, `not_found`, `turn_closed`, `not_turn_taker`, `submit_basis_invalid`, `submit_source_not_tested`, `head_mismatch`, `task_archived`, `idempotency_key_mismatch`, `github_unavailable`.

### `board return`

Purpose: Return the task of a turn the caller took to Dev; the reason opens a worker code block.
Arguments: `<turn>`, `<reason>`.
Flags: `--findings <value>`, `--key <key>`, `--json`.
Use when: Send the task back to Dev when the work needs code changes.
Avoid when: Use `board submit <turn> <sha>` to hand in the work instead.
Example: `board return T4 "Handle the empty list in the parser." --key return-PROJ-123-return-reviewed-1432` — Return a reviewed task to Dev.
Other errors: `wrong_id_kind`, `not_found`, `turn_closed`, `not_turn_taker`, `return_not_allowed`, `task_archived`, `idempotency_key_mismatch`.
