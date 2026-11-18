# Board configuration commands

### `board config get`

Purpose: Show effective project columns, executors, Spur bindings and web origins.
Arguments: none.
Flags: `--project <value>`, `--json`.
Use when: Read configuration before rendering the Board overview.
Avoid when: Use `board status` for task state and freshness.
Example: `board config get` — Show effective configuration.
Other errors: `not_found`.

### `board columns describe`

Purpose: Describe effective column exit rules, returns, executors and escalation.
Arguments: none.
Flags: `--project <value>`, `--json`.
Use when: Read the project column policy before deciding how to progress work; selected sessions are project-level choices, not task-specific recipients.
Avoid when: Use `board task <task>` with why for a task’s current gates and turn, or `board config get` for compact bindings and web origins.
Example: `board columns describe --project web` — Describe project column policies.
Other errors: `not_found`.
