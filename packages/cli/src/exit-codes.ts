import { randomUUID } from 'node:crypto';
import {
  ERRORS,
  errorEnvelopeSchema,
  renderJsonError,
  type ErrorCode,
} from '@spur-board/contracts';

type ErrorContext = Parameters<typeof renderJsonError>[0]['context'];

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly context: ErrorContext | undefined;
  readonly requestId: string;
  readonly hint: string | undefined;

  constructor(
    code: ErrorCode,
    context?: ErrorContext,
    requestId: string = `client-${randomUUID()}`,
    hint?: string,
  ) {
    super(ERRORS[code].message);
    this.name = 'CliError';
    this.code = code;
    this.context = context;
    this.requestId = requestId;
    this.hint = hint;
  }
}

export function errorExitCode(error: CliError): number {
  return ERRORS[error.code].exit;
}

export function renderCliError(error: CliError, json: boolean, key?: string): string {
  const envelope = renderJsonError({
    code: error.code,
    requestId: error.requestId,
    ...(error.context ? { context: error.context } : {}),
  });
  const recoveryHint = key && ERRORS[error.code].exit === 5 ? `retry with --key ${key}` : null;
  const hint = [error.hint ?? envelope.error.hint, recoveryHint].filter(Boolean).join(' ');
  const value = errorEnvelopeSchema.parse({
    ...envelope,
    error: { ...envelope.error, hint },
  });
  if (json) return JSON.stringify(value);
  return [
    `error: ${value.error.code}: ${value.error.message}`,
    `fix: ${value.error.hint}`,
    `side effects: ${value.error.recovery.sideEffects}`,
    `recovery: ${value.error.recovery.action}`,
    `requestId: ${value.requestId}`,
  ].join('\n');
}
