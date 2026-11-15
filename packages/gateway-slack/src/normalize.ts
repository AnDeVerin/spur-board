import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SLACK_COMMAND,
  interactionRefSchema,
  userIdSchema,
  type InboundEvent,
  type InteractionRef,
  type SpaceId,
} from '@spur-board/contracts';
import type { SlackChannels } from './deliver.ts';
import { conversationRef, messageRef } from './ref.ts';
import { originKeyFromBlocks } from './render.ts';
import { parseCommand } from './commands.ts';
import { fieldsOf, itemsOf, textOf } from './wire.ts';

type RecordValue = Record<string, unknown>;

function iso(ts: string): string | undefined {
  const at = new Date(Number(ts) * 1000);
  return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
}

function sourceUrl(channel: string, ts?: string): string {
  const channelUrl = `https://app.slack.com/archives/${encodeURIComponent(channel)}`;
  return ts === undefined ? channelUrl : `${channelUrl}/p${ts.replace('.', '')}`;
}

function sourceSpace(channel: string, channels: SlackChannels): SpaceId | null {
  if (channel === channels.feed) return 'feed';
  if (channel === channels.orchestrators) return 'orchestrators';
  return null;
}

export interface BotIdentity {
  userId: string;
  botId?: string;
}

export interface NormalizeContext {
  bot: BotIdentity;
  /** The configured spaces; a conversation's first message names the one it was posted in. */
  channels: SlackChannels;
  root?: unknown;
  rootTs?: string;
}

/** An opaque interaction still carries the data needed for an ephemeral response. */
function interactionRef(channel: string, user: string, triggerId: string): InteractionRef {
  return interactionRefSchema.parse(JSON.stringify({ channel, user, triggerId }));
}

export function parseInteractionRef(value: string): { channel: string; user: string } | null {
  try {
    const parsed = fieldsOf(JSON.parse(value));
    if (parsed === null) return null;
    const channel = textOf(parsed.channel);
    const user = textOf(parsed.user);
    return channel === undefined || user === undefined ? null : { channel, user };
  } catch {
    return null;
  }
}

function rootKey(context: NormalizeContext): string | undefined {
  return originKeyFromBlocks(fieldsOf(context.root)?.blocks);
}

function own(message: RecordValue, bot: BotIdentity): boolean {
  return (
    message.subtype === 'bot_message' ||
    (bot.botId !== undefined && message.bot_id === bot.botId) ||
    textOf(message.user) === bot.userId
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
  const ts = textOf(message.ts);
  const user = textOf(message.user);
  if (ts === undefined || user === undefined || own(message, context.bot)) return null;
  const threadTs = textOf(message.thread_ts) ?? context.rootTs ?? ts;
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
  const source = fieldsOf(payload);
  if (source === null) return [];
  if (source.subtype === 'message_deleted') {
    const deletedTs = textOf(source.deleted_ts);
    const previous = fieldsOf(source.previous_message);
    if (own(source, context.bot) || (previous !== null && own(previous, context.bot))) return [];
    const priorThreadTs = textOf(previous?.thread_ts);
    const priorOriginKey = originKeyFromBlocks(previous?.blocks);
    const rootIsDeleted =
      deletedTs !== undefined &&
      textOf(previous?.ts) === deletedTs &&
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
        rootMessage: messageRef(channel, threadTs, threadTs),
        sourceUrl: sourceUrl(channel, deletedTs),
        ...(originKey === undefined ? {} : { originKey }),
      },
    ];
  }

  const changed = source.subtype === 'message_changed';
  const message = changed ? fieldsOf(source.message) : source;
  if (message === null) return [];
  const base = messageBase(message, context);
  const body = text(message.text);
  if (base === null || body === undefined) return [];
  const edited = fieldsOf(message.edited);
  const editedTs = textOf(edited?.ts);
  const editAt = editedTs === undefined ? undefined : iso(editedTs);
  const eventBase = {
    conversation: conversationRef(channel, base.threadTs),
    message: messageRef(channel, base.ts, base.threadTs),
    rootMessage: messageRef(channel, base.threadTs, base.threadTs),
    sourceUrl: sourceUrl(channel, base.ts),
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
  // Only a conversation's first message names its space; replies keep the shape they were
  // stored with before the field existed, so a recovered reply replays under its stored key.
  const space: { sourceSpace?: SpaceId | null } =
    base.threadTs === base.ts ? { sourceSpace: sourceSpace(channel, context.channels) } : {};
  const events: InboundEvent[] = [
    { kind, dedupeKey: `slack:${channel}:${base.ts}`, ...eventBase, at: messageAt, ...space },
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
  channels: SlackChannels,
  root?: unknown,
  commandName = DEFAULT_SLACK_COMMAND,
): InboundEvent[] {
  const body = fieldsOf(payload);
  if (body === null) return [];
  const triggerId = textOf(body.trigger_id);
  if (triggerId === undefined) return [];
  const user = textOf(fieldsOf(body.user)?.id) ?? textOf(body.user_id);
  if (user === undefined) return [];
  const author = userIdSchema.parse(user);
  if (type === 'slash_commands') {
    const name = textOf(body.command);
    if (name === undefined) return [];
    const channel = textOf(body.channel_id);
    if (channel === undefined) return [];
    return [
      {
        kind: 'command',
        name,
        dedupeKey: `slack:${triggerId}`,
        interaction: interactionRef(channel, user, triggerId),
        author,
        text: text(body.text) ?? '',
        ...(name === commandName
          ? { command: parseCommand(text(body.text) ?? '', commandName) }
          : {}),
        sourceUrl: sourceUrl(channel),
        sourceSpace: sourceSpace(channel, channels),
      },
    ];
  }
  if (type !== 'interactive' && type !== 'block_actions') return [];
  const channel = textOf(fieldsOf(body.channel)?.id);
  const message = fieldsOf(body.message);
  const ts = textOf(message?.ts);
  const threadTs = textOf(message?.thread_ts) ?? ts;
  const action = fieldsOf(itemsOf(body.actions)?.[0]);
  const actionId = textOf(action?.action_id);
  if (
    channel === undefined ||
    ts === undefined ||
    threadTs === undefined ||
    actionId === undefined
  ) {
    return [];
  }
  const originKey = originKeyFromBlocks(
    root === undefined ? message?.blocks : fieldsOf(root)?.blocks,
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
      rootMessage: messageRef(channel, threadTs, threadTs),
      sourceUrl: sourceUrl(channel, ts),
      sourceSpace: sourceSpace(channel, channels),
      ...(originKey === undefined ? {} : { originKey }),
    },
  ];
}
