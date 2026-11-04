// Runtime-validated part of the gateway contract: what a gateway hands back to core.
import { z } from 'zod';

/** Opaque, gateway-issued reference to a conversation. Core stores it and never parses it. */
export const conversationRefSchema = z.string().min(1).brand<'ConversationRef'>();
export type ConversationRef = z.output<typeof conversationRefSchema>;

/** Opaque, gateway-issued reference to one message. */
export const messageRefSchema = z.string().min(1).brand<'MessageRef'>();
export type MessageRef = z.output<typeof messageRefSchema>;

/** Opaque reference to a user interaction (an action press or a command) that can be answered. */
export const interactionRefSchema = z.string().min(1).brand<'InteractionRef'>();
export type InteractionRef = z.output<typeof interactionRefSchema>;

/** Platform user id, passed through unchanged. Core decides who the operator is. */
export const userIdSchema = z.string().min(1).brand<'UserId'>();
export type UserId = z.output<typeof userIdSchema>;

/** Logical spaces core delivers into; each gateway maps them to its own destinations. */
export const SPACE_IDS = ['orchestrators', 'feed'] as const;
export type SpaceId = (typeof SPACE_IDS)[number];

export const INBOUND_EVENT_KINDS = [
  'message',
  'message_edited',
  'message_deleted',
  'action',
  'command',
  'mention',
  'gap',
  'connection',
] as const;
export type InboundEventKind = (typeof INBOUND_EVENT_KINDS)[number];

export const DELIVERY_STATUSES = ['delivered', 'retry', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * `transport`: the gateway or a whole space cannot be reached; the space's pending rows wait.
 * `message`: only this message was rejected; only its row fails.
 */
export const FAILURE_SCOPES = ['transport', 'message'] as const;
export type FailureScope = (typeof FAILURE_SCOPES)[number];

export const CONNECTION_STATES = ['up', 'down'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

const dedupeKey = z.string().min(1);
/** UTC ISO 8601 timestamp. */
const at = z.iso.datetime();
/** Plain text; the gateway converts platform markup before it reaches core. */
const text = z.string();
/** Deep link to the source message, or to the source space for a command. */
const sourceUrl = z.url();
/** Configured board space for an interaction, or null when it came from outside. */
const sourceSpace = z.enum(SPACE_IDS).nullable();

const messageEventSchema = z.strictObject({
  kind: z.literal('message'),
  dedupeKey,
  conversation: conversationRefSchema,
  message: messageRefSchema,
  rootMessage: messageRefSchema,
  sourceUrl,
  author: userIdSchema,
  text,
  at,
  originKey: z.string().min(1).optional(),
});

/** `message` is the original message, `text` the new text and `at` the edit time. */
const messageEditedEventSchema = z.strictObject({
  kind: z.literal('message_edited'),
  dedupeKey,
  conversation: conversationRefSchema,
  message: messageRefSchema,
  rootMessage: messageRefSchema,
  sourceUrl,
  author: userIdSchema,
  text,
  at,
  originKey: z.string().min(1).optional(),
});

const messageDeletedEventSchema = z.strictObject({
  kind: z.literal('message_deleted'),
  dedupeKey,
  conversation: conversationRefSchema,
  message: messageRefSchema,
  rootMessage: messageRefSchema,
  sourceUrl,
  originKey: z.string().min(1).optional(),
});

const actionEventSchema = z.strictObject({
  kind: z.literal('action'),
  dedupeKey,
  interaction: interactionRefSchema,
  actionId: z.string().min(1),
  author: userIdSchema,
  conversation: conversationRefSchema,
  message: messageRefSchema,
  rootMessage: messageRefSchema,
  sourceUrl,
  sourceSpace,
  originKey: z.string().min(1).optional(),
});

/** `text` is the command's argument text. */
const commandEventSchema = z.strictObject({
  kind: z.literal('command'),
  dedupeKey,
  interaction: interactionRefSchema,
  author: userIdSchema,
  text,
  sourceUrl,
  sourceSpace,
});

const mentionEventSchema = z.strictObject({
  kind: z.literal('mention'),
  dedupeKey,
  conversation: conversationRefSchema,
  message: messageRefSchema,
  rootMessage: messageRefSchema,
  sourceUrl,
  author: userIdSchema,
  text,
  at,
  originKey: z.string().min(1).optional(),
});

/** History may be missing. Without `conversation` the gap covers the whole gateway. */
const gapEventSchema = z.strictObject({
  kind: z.literal('gap'),
  dedupeKey,
  conversation: conversationRefSchema.optional(),
});

const connectionEventSchema = z.strictObject({
  kind: z.literal('connection'),
  dedupeKey,
  state: z.enum(CONNECTION_STATES),
});

export const inboundEventSchema = z.discriminatedUnion('kind', [
  messageEventSchema,
  messageEditedEventSchema,
  messageDeletedEventSchema,
  actionEventSchema,
  commandEventSchema,
  mentionEventSchema,
  gapEventSchema,
  connectionEventSchema,
]);
export type InboundEvent = z.output<typeof inboundEventSchema>;

export const deliveryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('delivered'),
    /** Set when the target was `open`: the new conversation. */
    conversation: conversationRefSchema.optional(),
    message: messageRefSchema,
    permalink: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal('retry'),
    afterMs: z.int().min(0).optional(),
    /** True when the attempt may have reached the platform; the next attempt sets `maybeSent`. */
    uncertain: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    permanent: z.literal(true),
    reason: z.string().min(1),
    scope: z.enum(FAILURE_SCOPES),
  }),
]);
export type DeliveryResult = z.output<typeof deliveryResultSchema>;
