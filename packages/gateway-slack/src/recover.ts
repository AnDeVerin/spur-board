import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WebClient } from '@slack/web-api';
import type { InboundEvent, RecoverRequest } from '@spur-board/contracts';
import { apiFailure, IncompleteHistoryError, readMessages } from './api.ts';
import { normalizeMessage, type BotIdentity } from './normalize.ts';
import { parseRef } from './ref.ts';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Milliseconds of a Slack ts, read from its digits so float error cannot shift the millisecond. */
function tsMillis(ts: string): number {
  const [seconds = '', fraction = ''] = ts.split('.');
  if (!/^\d+$/.test(seconds) || !/^\d*$/.test(fraction)) return Number.NaN;
  return Number(seconds) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
}

/**
 * The bounds are clock readings in whole milliseconds, so a message counts by its millisecond:
 * one posted later within the millisecond `until` was read in is still inside the window.
 */
function inInterval(ts: string | undefined, from: number, until: number): boolean {
  if (ts === undefined) return false;
  const at = tsMillis(ts);
  return Number.isFinite(at) && at >= from && at <= until;
}

/** Total time one thread read may spend waiting on rate limits before it becomes a `gap`. */
const READ_WAIT_BUDGET_MS = 10_000;

/** Least budget one retry costs, so a `Retry-After: 0` cannot retry forever. */
const MIN_RETRY_CHARGE_MS = 1000;

const ABORTED = Symbol('aborted');

/**
 * Settles with `promise`, or with `ABORTED` once `signal` aborts. The SDK call cannot be
 * cancelled, so a losing read is left to its own timeout and its outcome is dropped.
 */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise;
  promise.catch(() => {});
  if (signal.aborted) return Promise.resolve(ABORTED);
  const abort = Promise.withResolvers<typeof ABORTED>();
  const onAbort = () => {
    abort.resolve(ABORTED);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([promise, abort.promise]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/**
 * Waits out rate limits within `READ_WAIT_BUDGET_MS`, each retry costing at least
 * `MIN_RETRY_CHARGE_MS`; a wait past what remains throws
 * `IncompleteHistoryError` without sleeping. Returns `ABORTED` once `signal` aborts.
 */
async function readThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  signal: AbortSignal | undefined,
): Promise<unknown[] | typeof ABORTED> {
  let budget = READ_WAIT_BUDGET_MS;
  for (;;) {
    if (signal?.aborted === true) return ABORTED;
    try {
      return await untilAborted(readMessages(client, { channel, threadTs, signal }), signal);
    } catch (error) {
      const result = apiFailure(error);
      if (result.status !== 'retry' || result.uncertain) throw error;
      const wait = result.afterMs ?? 1000;
      const charge = Math.max(wait, MIN_RETRY_CHARGE_MS);
      if (charge > budget)
        throw new IncompleteHistoryError('rate limit wait exceeds the read budget');
      budget -= charge;
      // The wait rejects only on abort, which the next turn of the loop returns on.
      await delay(wait, undefined, { signal }).catch(() => undefined);
    }
  }
}

function gap(conversation: RecoverRequest['conversations'][number]['ref']): InboundEvent {
  return { kind: 'gap', dedupeKey: `slack:gap:${randomUUID()}`, conversation };
}

/** A scan is driven solely by its request; the core owns cursors and deduplication. */
export async function* recoverThreads(
  client: WebClient,
  request: RecoverRequest,
  botIdentity: () => Promise<BotIdentity>,
  now: () => number,
): AsyncIterable<InboundEvent> {
  const until = now();
  const from = request.since.getTime();
  if (!Number.isFinite(from) || from > until) return;
  const signal = request.signal;
  const bot = await untilAborted(botIdentity(), signal);
  if (bot === ABORTED) return;
  for (const conversation of request.conversations) {
    if (signal?.aborted === true) return;
    const addressed = parseRef(conversation.ref);
    if (addressed === null) {
      yield gap(conversation.ref);
      continue;
    }
    let history: unknown[] | typeof ABORTED;
    try {
      history = await readThread(client, addressed.channel, addressed.threadTs, signal);
    } catch (error) {
      const result = apiFailure(error);
      if (error instanceof IncompleteHistoryError || result.status === 'failed') {
        yield gap(conversation.ref);
        continue;
      }
      throw error;
    }
    if (history === ABORTED) return;
    const root = history.find((message) => string(record(message)?.ts) === addressed.threadTs);
    if (root === undefined) {
      yield gap(conversation.ref);
      continue;
    }
    const after = conversation.after === undefined ? null : parseRef(conversation.after);
    const anchor = after?.ts;
    if (
      conversation.after !== undefined &&
      (after === null ||
        after.channel !== addressed.channel ||
        after.threadTs !== addressed.threadTs ||
        !history.some((message) => string(record(message)?.ts) === anchor))
    ) {
      yield gap(conversation.ref);
    }
    for (const message of history) {
      const source = record(message);
      if (source === null) continue;
      const events = normalizeMessage(addressed.channel, source, {
        bot,
        root,
        rootTs: addressed.threadTs,
      });
      for (const event of events) {
        if (event.kind === 'message' || event.kind === 'mention') {
          const ts = parseRef(event.message)?.ts;
          if (
            inInterval(ts, from, until) &&
            (anchor === undefined || Number(ts) > Number(anchor))
          ) {
            yield event;
          }
        } else if (event.kind === 'message_edited') {
          if (inInterval(string(record(source.edited)?.ts), from, until)) yield event;
        } else if (event.kind === 'message_deleted') {
          if (inInterval(string(source.event_ts), from, until)) yield event;
        }
      }
    }
  }
}
