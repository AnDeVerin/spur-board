// Maps a failed HTTP response to the AdapterError the runner schedules by (A6).
import { AdapterError } from '@spur-board/contracts';

export interface HttpFailure {
  status: number;
  headers: Headers;
  body?: string | undefined;
}

/** Classifies a failed response; `now` is the current time in epoch milliseconds. */
export function classifyHttpFailure(failure: HttpFailure, now: number): AdapterError {
  const { status, headers } = failure;
  const message = `HTTP ${String(status)}`;
  const throttled =
    status === 429 ||
    (status === 403 &&
      (headers.get('x-ratelimit-remaining')?.trim() === '0' ||
        headers.has('retry-after') ||
        /rate limit/i.test(failure.body ?? '')));
  if (throttled) return new AdapterError('throttled', message, { retryAt: retryAt(headers, now) });
  if (status === 401 || status === 403) return new AdapterError('auth', message);
  return new AdapterError('transient', message);
}

function retryAt(headers: Headers, now: number): Date | undefined {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter) {
    const at = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
    if (!Number.isNaN(at)) return new Date(at);
  }
  const reset = headers.get('x-ratelimit-reset')?.trim();
  if (reset) {
    const at = /^\d+(\.\d+)?$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset);
    if (!Number.isNaN(at)) return new Date(at);
  }
  return undefined;
}

/** Longest a GitHub or Jira request may take, body read included. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Runs one request under `signal` and a {@link REQUEST_TIMEOUT_MS} timer. A timeout rejects as a
 * `transient` error with `message`; a caller abort passes through unchanged.
 */
export async function withTimeout<T>(
  signal: AbortSignal,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort(new DOMException(message, 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);
  try {
    return await work(AbortSignal.any([signal, timer.signal]));
  } catch (cause) {
    if (timer.signal.aborted && !signal.aborted)
      throw new AdapterError('transient', message, { cause });
    throw cause;
  } finally {
    clearTimeout(handle);
  }
}
