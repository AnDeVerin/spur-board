import {
  conversationRefSchema,
  messageRefSchema,
  type ConversationRef,
  type MessageRef,
} from '@spur-board/contracts';
import { z } from 'zod';

// Each field accepts '' as before; unknown keys are stripped.
const slackRefWire = z.object({ channel: z.string(), ts: z.string(), threadTs: z.string() });

export type SlackRef = z.output<typeof slackRefWire>;

export function conversationRef(channel: string, ts: string): ConversationRef {
  return conversationRefSchema.parse(JSON.stringify({ channel, ts, threadTs: ts }));
}

export function messageRef(channel: string, ts: string, threadTs: string): MessageRef {
  return messageRefSchema.parse(JSON.stringify({ channel, ts, threadTs }));
}

export function parseRef(value: string): SlackRef | null {
  try {
    return slackRefWire.safeParse(JSON.parse(value)).data ?? null;
  } catch {
    return null;
  }
}
