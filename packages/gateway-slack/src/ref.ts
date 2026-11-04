import {
  conversationRefSchema,
  messageRefSchema,
  type ConversationRef,
  type MessageRef,
} from '@spur-board/contracts';

export interface SlackRef {
  channel: string;
  ts: string;
  threadTs: string;
}

export function conversationRef(channel: string, ts: string): ConversationRef {
  return conversationRefSchema.parse(JSON.stringify({ channel, ts, threadTs: ts }));
}

export function messageRef(channel: string, ts: string, threadTs: string): MessageRef {
  return messageRefSchema.parse(JSON.stringify({ channel, ts, threadTs }));
}

export function parseRef(value: string): SlackRef | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('channel' in parsed) || typeof parsed.channel !== 'string') return null;
    if (!('ts' in parsed) || typeof parsed.ts !== 'string') return null;
    if (!('threadTs' in parsed) || typeof parsed.threadTs !== 'string') return null;
    return { channel: parsed.channel, ts: parsed.ts, threadTs: parsed.threadTs };
  } catch {
    return null;
  }
}
