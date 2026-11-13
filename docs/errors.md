# Errors

Each error has a stable code, recovery guidance, and request ID.

## usage

The input does not match the operation schema.

HTTP: 400  
Exit code: 2  
Hint: Run `board schema` to see the expected input and fix the arguments.  
Recovery: Fix the arguments using `board schema`.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "usage",
    "requestId": "req-example-123",
    "message": "The input does not match the operation schema.",
    "hint": "Run `board schema` to see the expected input and fix the arguments.",
    "docs": "docs/errors.md#usage",
    "recovery": {
      "action": "Fix the arguments using `board schema`.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## wrong_id_kind

The ID is valid but names a different kind of object.

HTTP: 400  
Exit code: 2  
Hint: Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.  
Recovery: Pass the expected ID kind.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "wrong_id_kind",
    "requestId": "req-example-123",
    "message": "The ID is valid but names a different kind of object.",
    "hint": "Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.",
    "docs": "docs/errors.md#wrong_id_kind",
    "recovery": {
      "action": "Pass the expected ID kind.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## forbidden

The caller is not allowed to run this operation on this object.

HTTP: 403  
Exit code: 1  
Hint: Check which role may run the operation in `board schema`, or ask the operator.  
Recovery: Use an allowed role or ask the operator for access.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "forbidden",
    "requestId": "req-example-123",
    "message": "The caller is not allowed to run this operation on this object.",
    "hint": "Check which role may run the operation in `board schema`, or ask the operator.",
    "docs": "docs/errors.md#forbidden",
    "recovery": {
      "action": "Use an allowed role or ask the operator for access.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## not_found

The project, task, block, comment or item does not exist.

HTTP: 404  
Exit code: 1  
Hint: Check the ID with `board status` or `board task <KEY>`.  
Recovery: Check the ID and locate the object.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "not_found",
    "requestId": "req-example-123",
    "message": "The project, task, block, comment or item does not exist.",
    "hint": "Check the ID with `board status` or `board task <KEY>`.",
    "docs": "docs/errors.md#not_found",
    "recovery": {
      "action": "Check the ID and locate the object.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## not_implemented

This operation is not available in this daemon build.

HTTP: 501  
Exit code: 1  
Hint: Ask the operator to update the daemon to a build with this operation.  
Recovery: Update the daemon to a build with this operation.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "not_implemented",
    "requestId": "req-example-123",
    "message": "This operation is not available in this daemon build.",
    "hint": "Ask the operator to update the daemon to a build with this operation.",
    "docs": "docs/errors.md#not_implemented",
    "recovery": {
      "action": "Update the daemon to a build with this operation.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## block_not_open

The block is already unblocked.

HTTP: 409  
Exit code: 1  
Hint: Read the task with `board task <KEY>` to see the current blocks.  
Recovery: Read the current blocks before choosing another action.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "block_not_open",
    "requestId": "req-example-123",
    "message": "The block is already unblocked.",
    "hint": "Read the task with `board task <KEY>` to see the current blocks.",
    "docs": "docs/errors.md#block_not_open",
    "recovery": {
      "action": "Read the current blocks before choosing another action.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## wrong_block_type

The operation does not apply to this type of block.

HTTP: 409  
Exit code: 1  
Hint: Read the block type with `board task <KEY>` and use the operation for that type.  
Recovery: Use the operation for the current block type.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "wrong_block_type",
    "requestId": "req-example-123",
    "message": "The operation does not apply to this type of block.",
    "hint": "Read the block type with `board task <KEY>` and use the operation for that type.",
    "docs": "docs/errors.md#wrong_block_type",
    "recovery": {
      "action": "Use the operation for the current block type.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## stale_comment_revision

The comment has a newer revision than the one acknowledged.

HTTP: 409  
Exit code: 1  
Hint: Read the latest comment revision, then acknowledge that revision.  
Recovery: Read the latest comment revision before acknowledging it.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "stale_comment_revision",
    "requestId": "req-example-123",
    "message": "The comment has a newer revision than the one acknowledged.",
    "hint": "Read the latest comment revision, then acknowledge that revision.",
    "docs": "docs/errors.md#stale_comment_revision",
    "recovery": {
      "action": "Read the latest comment revision before acknowledging it.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## turn_closed

The turn is closed: the task was submitted, moved or archived since.

HTTP: 409  
Exit code: 1  
Hint: Read your open turns with `board inbox` and act only on a turn listed there.  
Recovery: Read your open turns and act only on a turn listed there.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "turn_closed",
    "requestId": "req-example-123",
    "message": "The turn is closed: the task was submitted, moved or archived since.",
    "hint": "Read your open turns with `board inbox` and act only on a turn listed there.",
    "docs": "docs/errors.md#turn_closed",
    "recovery": {
      "action": "Read your open turns and act only on a turn listed there.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## not_turn_taker

This session has not taken the turn.

HTTP: 409  
Exit code: 1  
Hint: Take the turn with `board inbox ack` first; only the session that took it can submit or return it.  
Recovery: Take the turn first; only the session that took it can submit or return it.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "not_turn_taker",
    "requestId": "req-example-123",
    "message": "This session has not taken the turn.",
    "hint": "Take the turn with `board inbox ack` first; only the session that took it can submit or return it.",
    "docs": "docs/errors.md#not_turn_taker",
    "recovery": {
      "action": "Take the turn first; only the session that took it can submit or return it.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## head_mismatch

The commit is not the head of the task's pull request, or the task has none.

HTTP: 409  
Exit code: 1  
Hint: Push the commit to the task's pull request branch and submit its head; if the task has none, ask the operator to link the pull request with `board link` first.  
Recovery: Push the commit to the task's pull request branch and submit its head; if the task has none, ask the operator to link the pull request first.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "head_mismatch",
    "requestId": "req-example-123",
    "message": "The commit is not the head of the task's pull request, or the task has none.",
    "hint": "Push the commit to the task's pull request branch and submit its head; if the task has none, ask the operator to link the pull request with `board link` first.",
    "docs": "docs/errors.md#head_mismatch",
    "recovery": {
      "action": "Push the commit to the task's pull request branch and submit its head; if the task has none, ask the operator to link the pull request first.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## return_not_allowed

A task can be returned to Dev only from a column right of Dev.

HTTP: 409  
Exit code: 1  
Hint: In Dev, ask with `board ask` instead.  
Recovery: In Dev, ask with a block instead of returning the task.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "return_not_allowed",
    "requestId": "req-example-123",
    "message": "A task can be returned to Dev only from a column right of Dev.",
    "hint": "In Dev, ask with `board ask` instead.",
    "docs": "docs/errors.md#return_not_allowed",
    "recovery": {
      "action": "In Dev, ask with a block instead of returning the task.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## move_not_allowed

The task cannot be corrected to that column.

HTTP: 409  
Exit code: 1  
Hint: Read why with `board task <KEY> --why`; pick an enabled column, and unlink a merged pull request with `board unlink` first.  
Recovery: Read why the task is where it is; pick an enabled column, and unlink a merged pull request first.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "move_not_allowed",
    "requestId": "req-example-123",
    "message": "The task cannot be corrected to that column.",
    "hint": "Read why with `board task <KEY> --why`; pick an enabled column, and unlink a merged pull request with `board unlink` first.",
    "docs": "docs/errors.md#move_not_allowed",
    "recovery": {
      "action": "Read why the task is where it is; pick an enabled column, and unlink a merged pull request first.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## task_archived

The task is archived, so it cannot change.

HTTP: 409  
Exit code: 1  
Hint: Ask an operator to add the task to the board again if work continues.  
Recovery: Ask an operator to add the task to the board again if work continues.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "task_archived",
    "requestId": "req-example-123",
    "message": "The task is archived, so it cannot change.",
    "hint": "Ask an operator to add the task to the board again if work continues.",
    "docs": "docs/errors.md#task_archived",
    "recovery": {
      "action": "Ask an operator to add the task to the board again if work continues.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## link_conflict

Another linked pull request prevents this manual link.

HTTP: 409  
Exit code: 1  
Hint: Read the task links and use a different task or resolve the existing pull request link.  
Recovery: Read the task links and resolve the blocking pull request.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "link_conflict",
    "requestId": "req-example-123",
    "message": "Another linked pull request prevents this manual link.",
    "hint": "Read the task links and use a different task or resolve the existing pull request link.",
    "docs": "docs/errors.md#link_conflict",
    "recovery": {
      "action": "Read the task links and resolve the blocking pull request.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## retry_not_applicable

The item is not in a state that can be retried.

HTTP: 409  
Exit code: 1  
Hint: Read the item with `board task <KEY>`; close it if it needs no retry.  
Recovery: Read the item and close it if no retry is needed.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "retry_not_applicable",
    "requestId": "req-example-123",
    "message": "The item is not in a state that can be retried.",
    "hint": "Read the item with `board task <KEY>`; close it if it needs no retry.",
    "docs": "docs/errors.md#retry_not_applicable",
    "recovery": {
      "action": "Read the item and close it if no retry is needed.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## idempotency_key_mismatch

The idempotency key was already used with a different input.

HTTP: 409  
Exit code: 1  
Hint: Use a new key for a new command, or repeat the earlier input with the same key.  
Recovery: Use a new key for new input or repeat the original input.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "idempotency_key_mismatch",
    "requestId": "req-example-123",
    "message": "The idempotency key was already used with a different input.",
    "hint": "Use a new key for a new command, or repeat the earlier input with the same key.",
    "docs": "docs/errors.md#idempotency_key_mismatch",
    "recovery": {
      "action": "Use a new key for new input or repeat the original input.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## identity_unavailable

The daemon cannot tell who the caller is right now.

HTTP: 503  
Exit code: 3  
Hint: Ask in your own session, then retry the same command later with its existing idempotency key if it has one.  
Recovery: Ask in your own session, then retry the same command with its existing idempotency key if it has one.  
Side effects: none  
Retry: maximum 3; After caller identity is available; wait briefly between retries.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "identity_unavailable",
    "requestId": "req-example-123",
    "message": "The daemon cannot tell who the caller is right now.",
    "hint": "Ask in your own session, then retry the same command later with its existing idempotency key if it has one.",
    "docs": "docs/errors.md#identity_unavailable",
    "recovery": {
      "action": "Ask in your own session, then retry the same command with its existing idempotency key if it has one.",
      "sideEffects": "none",
      "maxRetries": 3,
      "retryTiming": "After caller identity is available; wait briefly between retries."
    },
    "context": {}
  }
}
```

## starting

The daemon is still starting; nothing was applied.

HTTP: 503  
Exit code: 3  
Hint: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.  
Recovery: Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.  
Side effects: none  
Retry: maximum 3; After the daemon is ready; wait briefly between retries.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "starting",
    "requestId": "req-example-123",
    "message": "The daemon is still starting; nothing was applied.",
    "hint": "Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.",
    "docs": "docs/errors.md#starting",
    "recovery": {
      "action": "Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.",
      "sideEffects": "none",
      "maxRetries": 3,
      "retryTiming": "After the daemon is ready; wait briefly between retries."
    },
    "context": {}
  }
}
```

## github_unavailable

GitHub did not confirm the pull request head; nothing was applied.

HTTP: 503  
Exit code: 3  
Hint: Wait until GitHub answers, then submit again.  
Recovery: Wait until GitHub answers, then submit again.  
Side effects: none  
Retry: maximum 3; After GitHub is reachable; wait briefly between retries.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "github_unavailable",
    "requestId": "req-example-123",
    "message": "GitHub did not confirm the pull request head; nothing was applied.",
    "hint": "Wait until GitHub answers, then submit again.",
    "docs": "docs/errors.md#github_unavailable",
    "recovery": {
      "action": "Wait until GitHub answers, then submit again.",
      "sideEffects": "none",
      "maxRetries": 3,
      "retryTiming": "After GitHub is reachable; wait briefly between retries."
    },
    "context": {}
  }
}
```

## version_mismatch

The client and daemon catalog versions do not match; nothing was applied.

HTTP: 409  
Exit code: 3  
Hint: Run `board service restart` to update the daemon, then retry.  
Recovery: Run `board service restart`, then retry the command.  
MCP hint: Restart your agent session so `board mcp` loads the daemon's catalog; if the mismatch remains, run `board service restart`.  
MCP recovery: Restart your agent session; if the mismatch remains, run `board service restart`. Then retry the tool call.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "version_mismatch",
    "requestId": "req-example-123",
    "message": "The client and daemon catalog versions do not match; nothing was applied.",
    "hint": "Run `board service restart` to update the daemon, then retry.",
    "docs": "docs/errors.md#version_mismatch",
    "recovery": {
      "action": "Run `board service restart`, then retry the command.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## daemon_unavailable

The daemon is not running or cannot be reached; nothing was applied.

HTTP: client-side  
Exit code: 3  
Hint: Ask in your own session; the operator can check `board service status`, then run `board service restart`, or `board service install` if the service was never installed. Retry the same command with its existing idempotency key if it has one once the daemon is available.  
Recovery: Ask in your own session, then retry the same command with its existing idempotency key if it has one.  
Side effects: none  
Retry: maximum 3; After the daemon is available; wait briefly between retries.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "daemon_unavailable",
    "requestId": "req-example-123",
    "message": "The daemon is not running or cannot be reached; nothing was applied.",
    "hint": "Ask in your own session; the operator can check `board service status`, then run `board service restart`, or `board service install` if the service was never installed. Retry the same command with its existing idempotency key if it has one once the daemon is available.",
    "docs": "docs/errors.md#daemon_unavailable",
    "recovery": {
      "action": "Ask in your own session, then retry the same command with its existing idempotency key if it has one.",
      "sideEffects": "none",
      "maxRetries": 3,
      "retryTiming": "After the daemon is available; wait briefly between retries."
    },
    "context": {}
  }
}
```

## config

The configuration is missing or invalid.

HTTP: client-side  
Exit code: 4  
Hint: Fix the configuration file named in the error, then run the command again.  
Recovery: Fix the named configuration file and retry.  
MCP hint: Fix the variable named in `context.environmentVariable` where `board mcp` starts. Only when `context.configPath` is also present, making that config.yaml valid with an `http.port` works instead; `board doctor --offline` names what is wrong in it.  
MCP recovery: Fix the named variable or config.yaml, restarting your agent session after a variable change, then retry the tool call.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "config",
    "requestId": "req-example-123",
    "message": "The configuration is missing or invalid.",
    "hint": "Fix the configuration file named in the error, then run the command again.",
    "docs": "docs/errors.md#config",
    "recovery": {
      "action": "Fix the named configuration file and retry.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## identity_missing

No caller identity was found: this is not a Spur session and no .spur-board/token was found walking up from the current folder.

HTTP: client-side  
Exit code: 4  
Hint: Run the command in a Spur session of a project listed in config.yaml, or run `board token create --name <name> --into <folder>` and ask the operator to approve the request in Slack.  
Recovery: Get a caller identity as the fix says, then run the command again.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "identity_missing",
    "requestId": "req-example-123",
    "message": "No caller identity was found: this is not a Spur session and no .spur-board/token was found walking up from the current folder.",
    "hint": "Run the command in a Spur session of a project listed in config.yaml, or run `board token create --name <name> --into <folder>` and ask the operator to approve the request in Slack.",
    "docs": "docs/errors.md#identity_missing",
    "recovery": {
      "action": "Get a caller identity as the fix says, then run the command again.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## service_start_failed

The service unit is installed, but the service did not start.

HTTP: client-side  
Exit code: 4  
Hint: Read why it failed with `journalctl --user -u spur-board.service -n 100` and run `board doctor`; systemd keeps restarting the service until the cause is fixed.  
Recovery: Fix the cause shown by `journalctl --user -u spur-board.service -n 100` and `board doctor`, then run `board service restart`.  
Side effects: applied  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "service_start_failed",
    "requestId": "req-example-123",
    "message": "The service unit is installed, but the service did not start.",
    "hint": "Read why it failed with `journalctl --user -u spur-board.service -n 100` and run `board doctor`; systemd keeps restarting the service until the cause is fixed.",
    "docs": "docs/errors.md#service_start_failed",
    "recovery": {
      "action": "Fix the cause shown by `journalctl --user -u spur-board.service -n 100` and `board doctor`, then run `board service restart`.",
      "sideEffects": "applied",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## update_rolled_back

The update failed, so the board is back on the version it ran before.

HTTP: client-side  
Exit code: 4  
Hint: Fix the cause named in this error, then run `board update` again.  
Recovery: Fix the reported cause, then run `board update` again.  
Side effects: none  
Retry: maximum 0; After fixing the cause.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "update_rolled_back",
    "requestId": "req-example-123",
    "message": "The update failed, so the board is back on the version it ran before.",
    "hint": "Fix the cause named in this error, then run `board update` again.",
    "docs": "docs/errors.md#update_rolled_back",
    "recovery": {
      "action": "Fix the reported cause, then run `board update` again.",
      "sideEffects": "none",
      "maxRetries": 0,
      "retryTiming": "After fixing the cause."
    },
    "context": {}
  }
}
```

## rollback_failed

A rollback step failed; the package, database or service may be only partly restored.

HTTP: client-side  
Exit code: 4  
Hint: Fix the step named in this error, then run `board rollback --yes` again.  
Recovery: Fix the reported step, then run `board rollback --yes`.  
Side effects: applied  
Retry: maximum 0; After fixing the reported step.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "rollback_failed",
    "requestId": "req-example-123",
    "message": "A rollback step failed; the package, database or service may be only partly restored.",
    "hint": "Fix the step named in this error, then run `board rollback --yes` again.",
    "docs": "docs/errors.md#rollback_failed",
    "recovery": {
      "action": "Fix the reported step, then run `board rollback --yes`.",
      "sideEffects": "applied",
      "maxRetries": 0,
      "retryTiming": "After fixing the reported step."
    },
    "context": {}
  }
}
```

## outcome_unknown

The connection was lost after the request was sent; it may have been applied.

HTTP: client-side  
Exit code: 5  
Hint: Run the command again with the same idempotency key to learn the outcome.  
Recovery: Check the outcome, then retry with the same idempotency key if needed.  
Side effects: unknown  
Retry: maximum 3; After checking the outcome, with a short delay.
Outcome check: Read the task or item with `board task <KEY>` before retrying.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "outcome_unknown",
    "requestId": "req-example-123",
    "message": "The connection was lost after the request was sent; it may have been applied.",
    "hint": "Run the command again with the same idempotency key to learn the outcome.",
    "docs": "docs/errors.md#outcome_unknown",
    "recovery": {
      "action": "Check the outcome, then retry with the same idempotency key if needed.",
      "sideEffects": "unknown",
      "maxRetries": 3,
      "retryTiming": "After checking the outcome, with a short delay.",
      "outcomeCheck": "Read the task or item with `board task <KEY>` before retrying."
    },
    "context": {}
  }
}
```

## unexpected

An unexpected failure occurred; the outcome may be unknown.

HTTP: 500  
Exit code: 5  
Hint: Use the trace reference in the daemon log; repeat reads or check a mutation outcome before retrying with the same key.  
Recovery: Check whether the request took effect. A read-only request can be repeated; for a mutation, retry with the same idempotency key only after checking the outcome.  
Side effects: unknown  
Retry: maximum 3; After checking a mutation outcome, or after a short delay for a read-only request.
Outcome check: Check the operation result or state before retrying a mutation; a read-only request needs no outcome check.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "unexpected",
    "requestId": "req-example-123",
    "message": "An unexpected failure occurred; the outcome may be unknown.",
    "hint": "Use the trace reference in the daemon log; repeat reads or check a mutation outcome before retrying with the same key.",
    "docs": "docs/errors.md#unexpected",
    "recovery": {
      "action": "Check whether the request took effect. A read-only request can be repeated; for a mutation, retry with the same idempotency key only after checking the outcome.",
      "sideEffects": "unknown",
      "maxRetries": 3,
      "retryTiming": "After checking a mutation outcome, or after a short delay for a read-only request.",
      "outcomeCheck": "Check the operation result or state before retrying a mutation; a read-only request needs no outcome check."
    },
    "context": {},
    "trace": {
      "requestId": "req-example-123",
      "logLocation": "daemon log"
    }
  }
}
```
