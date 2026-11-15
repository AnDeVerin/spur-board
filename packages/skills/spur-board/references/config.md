# Board configuration command

### `board config get`

Purpose: Show effective project columns, executors and Spur bindings.
Arguments: none.
Flags: `--project <value>`, `--json`.
Use when: Read configuration before rendering the Board overview.
Avoid when: Use `board status` for task state and freshness.
Example: `board config get` — Show effective configuration.
Other errors: `not_found`.
