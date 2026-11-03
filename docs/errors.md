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
    "docs": "#usage",
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
Recovery: Use an allowed role or ask the operator for access.  
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
    "docs": "#wrong_id_kind",
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

## forbidden

The caller is not allowed to run this operation on this object.

HTTP: 403  
Exit code: 1  
Hint: Check which role may run the operation in `board schema`, or ask the operator.  
Recovery: Check the ID and locate the object.  
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
    "docs": "#forbidden",
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

## not_found

The project, task, block, comment or item does not exist.

HTTP: 404  
Exit code: 1  
Hint: Check the ID with `board status` or `board task <KEY>`.  
Recovery: Read the current blocks before choosing another action.  
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
    "docs": "#not_found",
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

## block_not_open

The block is already unblocked.

HTTP: 409  
Exit code: 1  
Hint: Read the task with `board task <KEY>` to see the current blocks.  
Recovery: Use the operation for the current block type.  
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
    "docs": "#block_not_open",
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

## wrong_block_type

The operation does not apply to this type of block.

HTTP: 409  
Exit code: 1  
Hint: Read the block type with `board task <KEY>` and use the operation for that type.  
Recovery: Add the task to the board again if work continues.  
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
    "docs": "#wrong_block_type",
    "recovery": {
      "action": "Add the task to the board again if work continues.",
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
Hint: Add the task to the board again with `board task add <KEY>` if work goes on.  
Recovery: Read the item and close it if no retry is needed.  
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
    "hint": "Add the task to the board again with `board task add <KEY>` if work goes on.",
    "docs": "#task_archived",
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

## retry_not_applicable

The item is not in a state that can be retried.

HTTP: 409  
Exit code: 1  
Hint: Read the item with `board task <KEY>`; close it if it needs no retry.  
Recovery: Use a new key for new input or repeat the original input.  
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
    "docs": "#retry_not_applicable",
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

## idempotency_key_mismatch

The idempotency key was already used with a different input.

HTTP: 409  
Exit code: 1  
Hint: Use a new key for a new command, or repeat the earlier input with the same key.  
Recovery: Restore caller identity, then run the command again.  
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
    "docs": "#idempotency_key_mismatch",
    "recovery": {
      "action": "Restore caller identity, then run the command again.",
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
Hint: Retry shortly; run the command from inside a spur session or as the operator.  
Recovery: Start the daemon, then retry the command.  
Side effects: none  
Retry: maximum 3; After a short delay.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "identity_unavailable",
    "requestId": "req-example-123",
    "message": "The daemon cannot tell who the caller is right now.",
    "hint": "Retry shortly; run the command from inside a spur session or as the operator.",
    "docs": "#identity_unavailable",
    "recovery": {
      "action": "Start the daemon, then retry the command.",
      "sideEffects": "none",
      "maxRetries": 3,
      "retryTiming": "After a short delay."
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
    "docs": "#version_mismatch",
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
Hint: Start the daemon, then run the command again.  
Recovery: Start the daemon and retry the command.  
Side effects: none  
Retry: maximum 3; After a short delay.

Example:

```json
{
  "ok": false,
  "requestId": "req-example-123",
  "error": {
    "code": "daemon_unavailable",
    "requestId": "req-example-123",
    "message": "The daemon is not running or cannot be reached; nothing was applied.",
    "hint": "Start the daemon, then run the command again.",
    "docs": "#daemon_unavailable",
    "recovery": {
      "action": "Start the daemon and retry the command.",
      "sideEffects": "none",
      "maxRetries": 3,
      "retryTiming": "After a short delay."
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
    "docs": "#config",
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
    "docs": "#outcome_unknown",
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
Hint: Check the trace reference in the daemon log and confirm the outcome before retrying.  
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
    "code": "unexpected",
    "requestId": "req-example-123",
    "message": "An unexpected failure occurred; the outcome may be unknown.",
    "hint": "Check the trace reference in the daemon log and confirm the outcome before retrying.",
    "docs": "#unexpected",
    "recovery": {
      "action": "Check the outcome, then retry with the same idempotency key if needed.",
      "sideEffects": "unknown",
      "maxRetries": 3,
      "retryTiming": "After checking the outcome, with a short delay.",
      "outcomeCheck": "Read the task or item with `board task <KEY>` before retrying."
    },
    "context": {},
    "trace": {
      "requestId": "req-example-123",
      "logLocation": "daemon log"
    }
  }
}
```
