import type { SpurPort } from '@spur-board/core';

const SEND_TIMEOUT_MS = 8_000;
const ERROR_TEXT_LIMIT = 200;

/** The request Spur's own `spur send` makes; the doctor probe sends the same one. */
export function spurSendRequest(
  baseUrl: string,
  session: string,
  text: string,
): { url: URL; init: RequestInit } {
  return {
    url: new URL(
      `sessions/${encodeURIComponent(session)}/send`,
      new URL(`${baseUrl.replace(/\/$/, '')}/`),
    ),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    },
  };
}

/** The `error` string of a Spur error body, cut to a bounded length; null when unreadable. */
export async function spurErrorText(response: Response): Promise<string | null> {
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== 'object' || !('error' in value)) return null;
    return typeof value.error === 'string' ? value.error.slice(0, ERROR_TEXT_LIMIT) : null;
  } catch {
    return null;
  }
}

/** Send a doorbell through the Spur HTTP API; runs no executable, so PATH does not matter. */
export function createSpurPort(options: {
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): SpurPort {
  const fetcher = options.fetcher ?? fetch;
  return {
    async send(session, text) {
      const { url, init } = spurSendRequest(options.baseUrl, session, text);
      let response: Response;
      try {
        response = await fetcher(url, {
          ...init,
          signal: AbortSignal.timeout(options.timeoutMs ?? SEND_TIMEOUT_MS),
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'TimeoutError')
          throw new Error('Spur send timed out', { cause });
        throw new Error('Spur API unreachable', { cause });
      }
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const error = await spurErrorText(response);
      throw new Error(
        `Spur send failed with HTTP ${String(response.status)}${error === null ? '' : `: ${error}`}`,
      );
    },
  };
}
