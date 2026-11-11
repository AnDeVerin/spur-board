import { z } from 'zod';
import { ERRORS, errorContextSchema, type ErrorCode, type ServerErrorCode } from './errors.ts';

/** One validated input supplies every transport representation. */
export const errorInputSchema = z.strictObject({
  code: z.enum(Object.keys(ERRORS) as [ErrorCode, ...ErrorCode[]]),
  requestId: z.string().min(1),
  context: errorContextSchema.optional(),
});
export type ErrorInput = z.output<typeof errorInputSchema>;

function fields(input: ErrorInput, transport: 'mcp' | 'default' = 'default') {
  const { code, requestId, context } = errorInputSchema.parse(input);
  const spec = ERRORS[code];
  const guidance = (transport === 'mcp' ? spec.mcp : undefined) ?? spec;
  const trace = code === 'unexpected' ? { requestId, logLocation: 'daemon log' } : undefined;
  return {
    code,
    requestId,
    message: spec.message,
    hint: guidance.hint,
    docs: spec.docs,
    recovery: guidance.recovery,
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
      type: `https://spur-board.dev/${spec.docs}`,
      title: spec.message,
      status: spec.status,
      ...value,
    },
  };
}

/** `hint` replaces the catalog hint for one call; `errorInputSchema` stays hint-free. */
export function renderMcpError(input: ErrorInput, hint?: string) {
  const rendered = fields(input, 'mcp');
  const content = hint === undefined ? rendered : { ...rendered, hint };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: renderLines(content) }],
    structuredContent: content,
  };
}

export function renderJsonError(input: ErrorInput) {
  return { ok: false as const, requestId: input.requestId, error: fields(input) };
}

export function renderStderrError(input: ErrorInput): string {
  return renderLines(fields(input));
}

function renderLines(value: ReturnType<typeof fields>): string {
  const context = Object.entries(value.context);
  return [
    `error: ${value.code}: ${value.message}`,
    `fix: ${value.hint}`,
    `side effects: ${value.recovery.sideEffects}${value.recovery.sideEffects === 'none' ? ' (the command was not applied)' : ''}`,
    `recovery: ${value.recovery.action}`,
    `retry: ${String(value.recovery.maxRetries)} maximum; ${value.recovery.retryTiming}`,
    ...(value.recovery.sideEffects === 'unknown' && value.recovery.outcomeCheck
      ? [`outcome check: ${value.recovery.outcomeCheck}`]
      : []),
    `docs: ${value.docs}`,
    ...(context.length
      ? [`context: ${context.map(([key, item]) => `${key}=${item ?? ''}`).join(', ')}`]
      : []),
    ...('trace' in value ? [`trace: ${value.trace.requestId} in ${value.trace.logLocation}`] : []),
    `requestId: ${value.requestId}`,
    '',
  ].join('\n');
}
