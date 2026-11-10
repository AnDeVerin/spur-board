import { randomUUID } from 'node:crypto';
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

function inInterval(ts: string | undefined, from: number, until: number): boolean {
  if (ts === undefined) return false;
  const at = Number(ts) * 1000;
  return Number.isFinite(at) && at >= from && at <= until;
}

async function readThread(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<unknown[]> {
  for (;;) {
    try {
      return await readMessages(client, { channel, threadTs });
    } catch (error) {
      const result = apiFailure(error);
      if (result.status !== 'retry' || result.uncertain) throw error;
      await new Promise((resolve) => setTimeout(resolve, result.afterMs ?? 1000));
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
  const bot = await botIdentity();
  for (const conversation of request.conversations) {
    const addressed = parseRef(conversation.ref);
    if (addressed === null) {
      yield gap(conversation.ref);
      continue;
    }
    let history: unknown[];
    try {
      history = await readThread(client, addressed.channel, addressed.threadTs);
    } catch (error) {
      const result = apiFailure(error);
      if (error instanceof IncompleteHistoryError || result.status === 'failed') {
        yield gap(conversation.ref);
        continue;
      }
      throw error;
    }
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
