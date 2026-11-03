import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebClient,
  type WebClientOptions,
} from '@slack/web-api';
import type { DeliveryResult } from '@spur-board/contracts';

export interface ApiConfig {
  token: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Both SDK retry paths are disabled: the core outbox schedules every retry. */
export function createApi(config: ApiConfig, Client: typeof WebClient = WebClient): WebClient {
  const options: WebClientOptions = {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.apiUrl === undefined ? {} : { slackApiUrl: config.apiUrl }),
  };
  if (options.timeout === undefined || options.timeout <= 0) {
    throw new Error('requestTimeoutMs must be positive');
  }
  return new Client(config.token, options);
}

const transportErrors = new Set([
  'not_in_channel',
  'channel_not_found',
  'is_archived',
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'missing_scope',
]);
const messageErrors = new Set([
  'invalid_blocks',
  'msg_too_long',
  'no_text',
  'cant_update_message',
  'message_not_found',
]);

function afterMs(value: number | string | undefined): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

/** Map one SDK failure to the gateway result contract. */
export function apiFailure(error: unknown): DeliveryResult {
  if (error instanceof WebAPIRateLimitedError) {
    const wait = afterMs(error.retryAfter);
    return { status: 'retry', uncertain: false, ...(wait === undefined ? {} : { afterMs: wait }) };
  }
  if (error instanceof WebAPIPlatformError) {
    const reason = error.data.error;
    if (transportErrors.has(reason)) {
      return { status: 'failed', permanent: true, scope: 'transport', reason };
    }
    if (messageErrors.has(reason)) {
      return { status: 'failed', permanent: true, scope: 'message', reason };
    }
  }
  if (error instanceof WebAPIHTTPError && error.statusCode === 429) {
    const wait = afterMs(error.headers['retry-after'] ?? error.headers['Retry-After']);
    return { status: 'retry', uncertain: false, ...(wait === undefined ? {} : { afterMs: wait }) };
  }
  return { status: 'retry', uncertain: true };
}

export function isAlreadyReacted(error: unknown): boolean {
  return error instanceof WebAPIPlatformError && error.data.error === 'already_reacted';
}
