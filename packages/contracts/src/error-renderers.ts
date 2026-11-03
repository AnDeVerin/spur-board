import { z } from 'zod';
import { ERRORS, errorContextSchema, type ErrorCode, type ServerErrorCode } from './errors.ts';

/** One validated input supplies every transport representation. */
export const errorInputSchema = z.strictObject({
  code: z.enum(Object.keys(ERRORS) as [ErrorCode, ...ErrorCode[]]),
  requestId: z.string().min(1),
  context: errorContextSchema.optional(),
});
export type ErrorInput = z.output<typeof errorInputSchema>;

function fields(input: ErrorInput) {
  const { code, requestId, context } = errorInputSchema.parse(input);
  const spec = ERRORS[code];
  const trace = code === 'unexpected' ? { requestId, logLocation: 'daemon log' } : undefined;
  return {
    code,
    requestId,
    message: spec.message,
    hint: spec.hint,
    docs: spec.docs,
    recovery: spec.recovery,
    context: context ?? {},
    ...(trace ? { trace } : {}),
  };
}

export function renderHttpProblem(input: ErrorInput & { code: ServerErrorCode }) {
  const value = fields(input);
  const spec = ERRORS[value.code];
  if (spec.status === null)
    throw new Error('HTTP problems require a server error code, not a client-side code.');
  return {
    status: spec.status,
    body: {
      type: `https://spur-board.dev/docs/errors${spec.docs}`,
      title: spec.message,
      status: spec.status,
      ...value,
    },
  };
}

export function renderMcpError(input: ErrorInput) {
  const content = fields(input);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: renderStderrError(input) }],
    structuredContent: content,
  };
}

export function renderJsonError(input: ErrorInput) {
  return { ok: false as const, requestId: input.requestId, error: fields(input) };
}

export function renderStderrError(input: ErrorInput): string {
  const value = fields(input);
  const context = Object.entries(value.context);
  return [
    `Error ${value.code}: ${value.message}`,
    `Fix: ${value.hint}`,
    `Side effects: ${value.recovery.sideEffects}`,
    `Recovery: ${value.recovery.action}`,
    `Retry: ${String(value.recovery.maxRetries)} maximum; ${value.recovery.retryTiming}`,
    ...(value.recovery.sideEffects === 'unknown' && value.recovery.outcomeCheck
      ? [`Outcome check: ${value.recovery.outcomeCheck}`]
      : []),
    `Docs: ${value.docs}`,
    ...(context.length
      ? [`Context: ${context.map(([key, item]) => `${key}=${item ?? ''}`).join(', ')}`]
      : []),
    ...('trace' in value ? [`Trace: ${value.trace.requestId} in ${value.trace.logLocation}`] : []),
    `Request ID: ${value.requestId}`,
    '',
  ].join('\n');
}
