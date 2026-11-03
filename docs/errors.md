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

## task_archived

The task is archived, so it cannot change.

HTTP: 409  
Exit code: 1  
Hint: Add the task to the board again with `board task add <KEY>` if work goes on.  
Recovery: Add the task to the board again if work continues.  
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
    "docs": "docs/errors.md#task_archived",
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
Hint: Ask in your own session; the operator can run `board service start`. Retry the same command with its existing idempotency key if it has one once the daemon is available.  
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
    "hint": "Ask in your own session; the operator can run `board service start`. Retry the same command with its existing idempotency key if it has one once the daemon is available.",
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
