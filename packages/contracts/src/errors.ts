import { z } from 'zod';

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
  recovery: z.output<typeof recoverySchema>;
  /** Replaces `hint` and `recovery` in MCP errors, where the agent session is the client. */
  mcp?: { hint: string; recovery: z.output<typeof recoverySchema> };
  docs: `docs/errors.md#${string}`;
  context: typeof errorContextSchema;
}

/** Named, non-secret context that callers may safely include in an error. */
export const errorContextSchema = z.strictObject({
  clientVersion: z.string().optional(),
  serverVersion: z.string().optional(),
  configPath: z.string().optional(),
  environmentVariable: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  idempotencyKey: z.string().min(1).optional(),
  causeLabel: z
    .enum(['storage_unavailable', 'transport_unavailable', 'internal_failure'])
    .optional(),
});

export const recoverySchema = z
  .strictObject({
    action: z.string().min(1),
    sideEffects: z.enum(['none', 'applied', 'unknown']),
    maxRetries: z.int().nonnegative(),
    retryTiming: z.string().min(1),
    outcomeCheck: z.string().min(1).optional(),
  })
  .refine((value) => value.sideEffects !== 'unknown' || Boolean(value.outcomeCheck), {
    message: 'Unknown outcomes require an outcome check before retry.',
  });

const noRetry = (action: string) => ({
  action,
  sideEffects: 'none' as const,
  maxRetries: 0,
  retryTiming: 'After fixing the cause.',
});
const retry = (action: string, retryTiming = 'After a short delay.') => ({
  action,
  sideEffects: 'none' as const,
  maxRetries: 3,
  retryTiming,
});
const unknownOutcome = {
  action: 'Check the outcome, then retry with the same idempotency key if needed.',
  sideEffects: 'unknown' as const,
  maxRetries: 3,
  retryTiming: 'After checking the outcome, with a short delay.',
  outcomeCheck: 'Read the task or item with `board task <KEY>` before retrying.',
};
const unexpectedOutcome = {
  action:
    'Check whether the request took effect. A read-only request can be repeated; for a mutation, retry with the same idempotency key only after checking the outcome.',
  sideEffects: 'unknown' as const,
  maxRetries: 3,
  retryTiming: 'After checking a mutation outcome, or after a short delay for a read-only request.',
  outcomeCheck:
    'Check the operation result or state before retrying a mutation; a read-only request needs no outcome check.',
};

function spec<T extends ErrorSpec>(code: string, value: Omit<T, 'docs' | 'context'>): T {
  return { ...value, docs: `docs/errors.md#${code}`, context: errorContextSchema } as T;
}

/** Every error an operation or the CLI can report, in a fixed order. */
export const ERRORS = {
  usage: spec('usage', {
    status: 400,
    exit: EXIT_CODES.usage,
    message: 'The input does not match the operation schema.',
    hint: 'Run `board schema` to see the expected input and fix the arguments.',
    recovery: noRetry('Fix the arguments using `board schema`.'),
  }),
  wrong_id_kind: spec('wrong_id_kind', {
    status: 400,
    exit: EXIT_CODES.usage,
    message: 'The ID is valid but names a different kind of object.',
    hint: 'Pass the ID kind the operation expects, e.g. B<n> for a block or a task key for a task.',
    recovery: noRetry('Pass the expected ID kind.'),
  }),
  forbidden: spec('forbidden', {
    status: 403,
    exit: EXIT_CODES.refused,
    message: 'The caller is not allowed to run this operation on this object.',
    hint: 'Check which role may run the operation in `board schema`, or ask the operator.',
    recovery: noRetry('Use an allowed role or ask the operator for access.'),
  }),
  not_found: spec('not_found', {
    status: 404,
    exit: EXIT_CODES.refused,
    message: 'The project, task, block, comment or item does not exist.',
    hint: 'Check the ID with `board status` or `board task <KEY>`.',
    recovery: noRetry('Check the ID and locate the object.'),
  }),
  not_implemented: spec('not_implemented', {
    status: 501,
    exit: EXIT_CODES.refused,
    message: 'This operation is not available in this daemon build.',
    hint: 'Ask the operator to update the daemon to a build with this operation.',
    recovery: noRetry('Update the daemon to a build with this operation.'),
  }),
  block_not_open: spec('block_not_open', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The block is already unblocked.',
    hint: 'Read the task with `board task <KEY>` to see the current blocks.',
    recovery: noRetry('Read the current blocks before choosing another action.'),
  }),
  wrong_block_type: spec('wrong_block_type', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The operation does not apply to this type of block.',
    hint: 'Read the block type with `board task <KEY>` and use the operation for that type.',
    recovery: noRetry('Use the operation for the current block type.'),
  }),
  stale_comment_revision: spec('stale_comment_revision', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The comment has a newer revision than the one acknowledged.',
    hint: 'Read the latest comment revision, then acknowledge that revision.',
    recovery: noRetry('Read the latest comment revision before acknowledging it.'),
  }),
  task_archived: spec('task_archived', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The task is archived, so it cannot change.',
    hint: 'Ask an operator to add the task to the board again if work continues.',
    recovery: noRetry('Ask an operator to add the task to the board again if work continues.'),
  }),
  link_conflict: spec('link_conflict', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'Another linked pull request prevents this manual link.',
    hint: 'Read the task links and use a different task or resolve the existing pull request link.',
    recovery: noRetry('Read the task links and resolve the blocking pull request.'),
  }),
  retry_not_applicable: spec('retry_not_applicable', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The item is not in a state that can be retried.',
    hint: 'Read the item with `board task <KEY>`; close it if it needs no retry.',
    recovery: noRetry('Read the item and close it if no retry is needed.'),
  }),
  idempotency_key_mismatch: spec('idempotency_key_mismatch', {
    status: 409,
    exit: EXIT_CODES.refused,
    message: 'The idempotency key was already used with a different input.',
    hint: 'Use a new key for a new command, or repeat the earlier input with the same key.',
    recovery: noRetry('Use a new key for new input or repeat the original input.'),
  }),
  identity_unavailable: spec('identity_unavailable', {
    status: 503,
    exit: EXIT_CODES.notApplied,
    message: 'The daemon cannot tell who the caller is right now.',
    hint: 'Ask in your own session, then retry the same command later with its existing idempotency key if it has one.',
    recovery: retry(
      'Ask in your own session, then retry the same command with its existing idempotency key if it has one.',
      'After caller identity is available; wait briefly between retries.',
    ),
  }),
  starting: spec('starting', {
    status: 503,
    exit: EXIT_CODES.notApplied,
    message: 'The daemon is still starting; nothing was applied.',
    hint: 'Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.',
    recovery: retry(
      'Wait until the daemon is ready, then retry the command with its existing idempotency key if it has one.',
      'After the daemon is ready; wait briefly between retries.',
    ),
  }),
  version_mismatch: spec('version_mismatch', {
    status: 409,
    exit: EXIT_CODES.notApplied,
    message: 'The client and daemon catalog versions do not match; nothing was applied.',
    hint: 'Run `board service restart` to update the daemon, then retry.',
    recovery: noRetry('Run `board service restart`, then retry the command.'),
    mcp: {
      hint: "Restart your agent session so `board mcp` loads the daemon's catalog; if the mismatch remains, run `board service restart`.",
      recovery: noRetry(
        'Restart your agent session; if the mismatch remains, run `board service restart`. Then retry the tool call.',
      ),
    },
  }),
  daemon_unavailable: spec('daemon_unavailable', {
    status: null,
    exit: EXIT_CODES.notApplied,
    message: 'The daemon is not running or cannot be reached; nothing was applied.',
    hint: 'Ask in your own session; the operator can check `board service status`, then run `board service restart`, or `board service install` if the service was never installed. Retry the same command with its existing idempotency key if it has one once the daemon is available.',
    recovery: retry(
      'Ask in your own session, then retry the same command with its existing idempotency key if it has one.',
      'After the daemon is available; wait briefly between retries.',
    ),
  }),
  config: spec('config', {
    status: null,
    exit: EXIT_CODES.config,
    message: 'The configuration is missing or invalid.',
    hint: 'Fix the configuration file named in the error, then run the command again.',
    recovery: noRetry('Fix the named configuration file and retry.'),
  }),
  outcome_unknown: spec('outcome_unknown', {
    status: null,
    exit: EXIT_CODES.outcomeUnknown,
    message: 'The connection was lost after the request was sent; it may have been applied.',
    hint: 'Run the command again with the same idempotency key to learn the outcome.',
    recovery: unknownOutcome,
  }),
  unexpected: spec('unexpected', {
    status: 500,
    exit: EXIT_CODES.outcomeUnknown,
    message: 'An unexpected failure occurred; the outcome may be unknown.',
    hint: 'Use the trace reference in the daemon log; repeat reads or check a mutation outcome before retrying with the same key.',
    recovery: unexpectedOutcome,
  }),
} as const satisfies Record<string, ErrorSpec>;
export type ErrorCode = keyof typeof ERRORS;

/** Codes the daemon answers with: those with an HTTP status. */
export type ServerErrorCode = {
  [K in ErrorCode]: (typeof ERRORS)[K]['status'] extends null ? never : K;
}[ErrorCode];

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const successEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  requestId: z.string().min(1),
  value: z.unknown(),
});
export const errorDetailSchema = z.strictObject({
  code: z.enum(Object.keys(ERRORS) as [ErrorCode, ...ErrorCode[]]),
  requestId: z.string().min(1),
  message: z.string(),
  hint: z.string(),
  docs: z.string(),
  recovery: recoverySchema,
  context: errorContextSchema,
  trace: z.strictObject({ requestId: z.string(), logLocation: z.literal('daemon log') }).optional(),
});
export const errorEnvelopeSchema = z.strictObject({
  ok: z.literal(false),
  requestId: z.string().min(1),
  error: errorDetailSchema,
});

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
