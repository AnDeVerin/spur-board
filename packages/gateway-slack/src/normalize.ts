import { randomUUID } from 'node:crypto';
import {
  interactionRefSchema,
  userIdSchema,
  type InboundEvent,
  type InteractionRef,
} from '@spur-board/contracts';
import { conversationRef, messageRef } from './ref.ts';
import { originKeyFromBlocks } from './render.ts';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function iso(ts: string): string | undefined {
  const at = new Date(Number(ts) * 1000);
  return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
}

export interface BotIdentity {
  userId: string;
  botId?: string;
}

export interface NormalizeContext {
  bot: BotIdentity;
  root?: unknown;
  rootTs?: string;
}

/** An opaque interaction still carries the data needed for an ephemeral response. */
function interactionRef(channel: string, user: string, triggerId: string): InteractionRef {
  return interactionRefSchema.parse(JSON.stringify({ channel, user, triggerId }));
}

export function parseInteractionRef(value: string): { channel: string; user: string } | null {
  try {
    const parsed = record(JSON.parse(value));
    if (parsed === null) return null;
    const channel = string(parsed.channel);
    const user = string(parsed.user);
    return channel === undefined || user === undefined ? null : { channel, user };
  } catch {
    return null;
  }
}

function rootKey(context: NormalizeContext): string | undefined {
  return originKeyFromBlocks(record(context.root)?.blocks);
}

function own(message: RecordValue, bot: BotIdentity): boolean {
  return (
    message.subtype === 'bot_message' ||
    (bot.botId !== undefined && message.bot_id === bot.botId) ||
    string(message.user) === bot.userId
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function messageBase(
  message: RecordValue,
  context: NormalizeContext,
): {
  ts: string;
  threadTs: string;
  author: ReturnType<typeof userIdSchema.parse>;
  originKey?: string;
} | null {
  const ts = string(message.ts);
  const user = string(message.user);
  if (ts === undefined || user === undefined || own(message, context.bot)) return null;
  const threadTs = string(message.thread_ts) ?? context.rootTs ?? ts;
  const originKey = rootKey(context);
  return {
    ts,
    threadTs,
    author: userIdSchema.parse(user),
    ...(originKey === undefined ? {} : { originKey }),
  };
}

/** The same message mapper is used for Socket Mode payloads and thread-history records. */
export function normalizeMessage(
  channel: string,
  payload: unknown,
  context: NormalizeContext,
): InboundEvent[] {
  const source = record(payload);
  if (source === null) return [];
  if (source.subtype === 'message_deleted') {
    const deletedTs = string(source.deleted_ts);
    const previous = record(source.previous_message);
    if (own(source, context.bot) || (previous !== null && own(previous, context.bot))) return [];
    const priorThreadTs = string(previous?.thread_ts);
    const priorOriginKey = originKeyFromBlocks(previous?.blocks);
    const rootIsDeleted =
      deletedTs !== undefined &&
      string(previous?.ts) === deletedTs &&
      (priorThreadTs === deletedTs ||
        (priorThreadTs === undefined && priorOriginKey !== undefined));
    const threadTs = priorThreadTs ?? (rootIsDeleted ? deletedTs : undefined);
    if (deletedTs === undefined || threadTs === undefined) {
      return [{ kind: 'gap', dedupeKey: `slack:gap:${randomUUID()}` }];
    }
    const originKey = rootIsDeleted ? priorOriginKey : rootKey(context);
    return [
      {
        kind: 'message_deleted',
        dedupeKey: `slack:${channel}:${deletedTs}:deleted`,
        conversation: conversationRef(channel, threadTs),
        message: messageRef(channel, deletedTs, threadTs),
        ...(originKey === undefined ? {} : { originKey }),
      },
    ];
  }

  const changed = source.subtype === 'message_changed';
  const message = changed ? record(source.message) : source;
  if (message === null) return [];
  const base = messageBase(message, context);
  const body = text(message.text);
  if (base === null || body === undefined) return [];
  const edited = record(message.edited);
  const editedTs = string(edited?.ts);
  const editAt = editedTs === undefined ? undefined : iso(editedTs);
  const eventBase = {
    conversation: conversationRef(channel, base.threadTs),
    message: messageRef(channel, base.ts, base.threadTs),
    author: base.author,
    text: body,
    ...(base.originKey === undefined ? {} : { originKey: base.originKey }),
  };
  if (changed) {
    if (body.length === 0 || editedTs === undefined || editAt === undefined) return [];
    return [
      {
        kind: 'message_edited',
        dedupeKey: `slack:${channel}:${base.ts}:edit:${editedTs}`,
        ...eventBase,
        at: editAt,
      },
    ];
  }
  const messageAt = iso(base.ts);
  if (messageAt === undefined) return [];
  const kind =
    base.threadTs === base.ts && body.includes(`<@${context.bot.userId}>`) ? 'mention' : 'message';
  const events: InboundEvent[] = [
    { kind, dedupeKey: `slack:${channel}:${base.ts}`, ...eventBase, at: messageAt },
  ];
  if (editAt !== undefined && editedTs !== undefined && body.length > 0) {
    events.push({
      kind: 'message_edited',
      dedupeKey: `slack:${channel}:${base.ts}:edit:${editedTs}`,
      ...eventBase,
      at: editAt,
    });
  }
  return events;
}

/** Actions and commands share the same stable trigger identity as their Slack retry. */
export function normalizeInteraction(
  type: string,
  payload: unknown,
  root?: unknown,
): InboundEvent[] {
  const body = record(payload);
  if (body === null) return [];
  const triggerId = string(body.trigger_id);
  if (triggerId === undefined) return [];
  const user = string(record(body.user)?.id) ?? string(body.user_id);
  if (user === undefined) return [];
  const author = userIdSchema.parse(user);
  if (type === 'slash_commands') {
    const channel = string(body.channel_id);
    if (channel === undefined) return [];
    return [
      {
        kind: 'command',
        dedupeKey: `slack:${triggerId}`,
        interaction: interactionRef(channel, user, triggerId),
        author,
        text: text(body.text) ?? '',
      },
    ];
  }
  if (type !== 'interactive' && type !== 'block_actions') return [];
  const channel = string(record(body.channel)?.id);
  const message = record(body.message);
  const ts = string(message?.ts);
  const threadTs = string(message?.thread_ts) ?? ts;
  const actions = body.actions;
  const action = Array.isArray(actions) ? record(actions[0]) : null;
  const actionId = string(action?.action_id);
  if (
    channel === undefined ||
    ts === undefined ||
    threadTs === undefined ||
    actionId === undefined
  ) {
    return [];
  }
  const originKey = originKeyFromBlocks(
    root === undefined ? message?.blocks : record(root)?.blocks,
  );
  return [
    {
      kind: 'action',
      dedupeKey: `slack:${triggerId}`,
      interaction: interactionRef(channel, user, triggerId),
      actionId,
      author,
      conversation: conversationRef(channel, threadTs),
      message: messageRef(channel, ts, threadTs),
      ...(originKey === undefined ? {} : { originKey }),
    },
  ];
}
