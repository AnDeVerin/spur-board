/**
 * Process exit codes of the CLI. `notApplied` (3) means the command certainly did not take
 * effect; `outcomeUnknown` (5) means it may have, so the caller retries with the same key.
 */
export const EXIT_CODES = {
  ok: 0,
  refused: 1,
  usage: 2,
  notApplied: 3,
  config: 4,
  outcomeUnknown: 5,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

interface ErrorSpec {
  /** HTTP status the daemon answers with, or `null` for an error raised by the client. */
  status: number | null;
  exit: ExitCode;
  message: string;
  /** What to do next. */
  hint: string;
}

/** Every error an operation or the CLI can report, in a fixed order. */
export const ERRORS = {
  usage: {
    status: 400,
    exit: EXIT_CODES.usage,
    message: 'The input does not match the operation schema.',
    hint: 'Run `board schema` to see the expected input and fix the arguments.',
  },
  wrong_id_kind: {
    status: 400,
    exit: EXIT_CODES.usage,
    message: 'The ID is valid but names a different kind of object.',
    hint: 'Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.',
  },
  forbidden: {
    status: 403,
    exit: EXIT_CODES.refused,
    message: 'The caller is not allowed to run this operation on this object.',
    hint: 'Check which role may run the operation in `board schema`, or ask the operator.',
  },
  not_found: {
    status: 404,
    exit: EXIT_CODES.refused,
    message: 'The project, task, block, comment or item does not exist.',
    hint: 'Check the ID with `board status` or `board task <KEY>`.',
  },
  block_not_open: {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The block is already unblocked.',
    hint: 'Read the task with `board task <KEY>` to see the current blocks.',
  },
  wrong_block_type: {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The operation does not apply to this type of block.',
    hint: 'Read the block type with `board task <KEY>` and use the operation for that type.',
  },
  task_archived: {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The task is archived, so it cannot change.',
    hint: 'Add the task to the board again with `board task add <KEY>` if work goes on.',
  },
  retry_not_applicable: {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The item is not in a state that can be retried.',
    hint: 'Read the item with `board task <KEY>`; close it if it needs no retry.',
  },
  idempotency_key_mismatch: {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The idempotency key was already used with a different input.',
    hint: 'Use a new key for a new command, or repeat the earlier input with the same key.',
  },
  identity_unavailable: {
    status: 503,
    exit: EXIT_CODES.notApplied,
    message: 'The daemon cannot tell who the caller is right now.',
    hint: 'Retry shortly; run the command from inside a spur session or as the operator.',
  },
  daemon_unavailable: {
    status: null,
    exit: EXIT_CODES.notApplied,
    message: 'The daemon is not running or cannot be reached; nothing was applied.',
    hint: 'Start the daemon, then run the command again.',
  },
  config: {
    status: null,
    exit: EXIT_CODES.config,
    message: 'The configuration is missing or invalid.',
    hint: 'Fix the configuration file named in the error, then run the command again.',
  },
  outcome_unknown: {
    status: null,
    exit: EXIT_CODES.outcomeUnknown,
    message: 'The connection was lost after the request was sent; it may have been applied.',
    hint: 'Run the command again with the same idempotency key to learn the outcome.',
  },
} as const satisfies Record<string, ErrorSpec>;
export type ErrorCode = keyof typeof ERRORS;

/** Codes the daemon answers with: those with an HTTP status. */
export type ServerErrorCode = {
  [K in ErrorCode]: (typeof ERRORS)[K]['status'] extends null ? never : K;
}[ErrorCode];

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
