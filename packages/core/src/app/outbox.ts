// Outbox kinds, their payloads and the producers that write them inside the caller's transaction.
import { createHash } from 'node:crypto';
import {
  conversationRefSchema,
  messageRefSchema,
  PERSONA_ROLES,
  taskKeySchema,
  type ActorId,
  type Persona,
  type Action,
  type RichText,
  type SpaceId,
} from '@spur-board/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Tables } from '../store/schema.ts';
import { taskUrl } from './doorbells.ts';
import { raiseItem } from './feed.ts';
import { SCAN_PENDING, checkGatewayStrings } from './secrets.ts';

export const OUTBOX_KINDS = [
  'conversation.open',
  'conversation.reply',
  'conversation.close',
  'feed.line',
  'feed.line.edit',
  'doorbell',
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** The space a kind is delivered into; doorbells go to Spur, not to a gateway space. */
export const KIND_SPACE = {
  'conversation.open': 'orchestrators',
  'conversation.reply': 'orchestrators',
  'conversation.close': 'orchestrators',
  'feed.line': 'feed',
  'feed.line.edit': 'feed',
  doorbell: null,
} as const satisfies Record<OutboxKind, SpaceId | null>;

/** Lower goes first within a space. */
export const KIND_PRIORITY = {
  'conversation.open': 0,
  'conversation.reply': 0,
  'conversation.close': 1,
  'feed.line': 2,
  'feed.line.edit': 2,
  doorbell: 0,
} as const satisfies Record<OutboxKind, number>;

const persona = z.strictObject({ name: z.string().min(1), role: z.enum(PERSONA_ROLES) });
const id = z.int().positive();

const closePayload = z.strictObject({
  key: taskKeySchema,
  text: z.string(),
  persona,
  taskId: id,
  blockId: id,
  commentId: id.nullable(),
  targetConversation: conversationRefSchema.optional(),
});
const openPayload = closePayload.extend({ title: z.string().min(1) });
const replyPayload = closePayload.extend({ commentId: id });
const feedLineEditPayload = z.strictObject({
  key: z.string().min(1),
  text: z.string(),
  persona,
  itemKey: z.string().min(1),
  taskId: id.optional(),
});
const feedLinePayload = feedLineEditPayload.extend({ title: z.string().min(1) });
const feedLineWithLinkPayload = feedLinePayload.extend({
  itemId: id.optional(),
  url: z.url().optional(),
  actions: z.array(z.strictObject({ id: z.string(), label: z.string() })).optional(),
});
const doorbellPayload = z.strictObject({
  session: z.string().min(1),
  text: z.string(),
  notificationId: id.optional(),
  ring: z.int().min(1).max(3).optional(),
});

/** A row's kind with its parsed payload. */
export const outboxBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation.open'), payload: openPayload }),
  z.strictObject({ kind: z.literal('conversation.reply'), payload: replyPayload }),
  z.strictObject({ kind: z.literal('conversation.close'), payload: closePayload }),
  z.strictObject({ kind: z.literal('feed.line'), payload: feedLineWithLinkPayload }),
  z.strictObject({ kind: z.literal('feed.line.edit'), payload: feedLineEditPayload }),
  z.strictObject({ kind: z.literal('doorbell'), payload: doorbellPayload }),
]);
export type OutboxBody = z.output<typeof outboxBodySchema>;

/** `outbox.external_ref` of a done gateway row: the thread's conversation and the message. */
export const deliveredRefSchema = z.strictObject({
  conversation: conversationRefSchema,
  message: messageRefSchema,
  permalink: z.string().min(1),
});
export type DeliveredRef = z.output<typeof deliveredRefSchema>;

/** Every delivered text starts with the task key; the text follows as a quote. */
export function renderBody(key: string, text: string): RichText {
  return [
    { kind: 'paragraph', children: [{ kind: 'text', text: key }] },
    { kind: 'quote', children: [{ kind: 'text', text }] },
  ];
}

type Trx = Kysely<Tables>;

/** A distinct semantic ring. Transport retries reuse this row and its text. */
export async function enqueueDoorbell(
  trx: Trx,
  input: { notificationId: number; ring: number; session: string; text: string; at: Date },
): Promise<number> {
  const row = await insertOutbox(trx, {
    kind: 'doorbell',
    dedupeKey: `doorbell:${String(input.notificationId)}:${input.session}:${String(input.ring)}`,
    payload: {
      notificationId: input.notificationId,
      ring: input.ring,
      session: input.session,
      text: input.text,
    },
    parent: null,
    at: input.at,
  });
  if (row.id === null) throw new Error('Doorbell cannot be blocked by gateway scan');
  return row.id;
}

/** The key includes the item raise, so a restart cannot add a second line. */
export async function enqueueFeedLine(
  trx: Trx,
  input: {
    itemId: number;
    itemKey: string;
    raise: number;
    key: string;
    text: string;
    title: string;
    url: string;
    taskId: number | null;
    actions?: readonly Action[];
    at: Date;
  },
): Promise<number | null> {
  const row = await insertOutbox(trx, {
    kind: 'feed.line',
    dedupeKey: `feed.line:${input.itemKey}:${String(input.raise)}`,
    payload: {
      key: input.key,
      text: input.text,
      title: input.title,
      persona: { name: 'board', role: 'board' },
      itemKey: input.itemKey,
      itemId: input.itemId,
      taskId: input.taskId ?? undefined,
      ...(input.url === '' ? {} : { url: input.url }),
      actions: input.actions,
    },
    parent: null,
    at: input.at,
  });
  return row.id;
}

/** One installation or upgrade announcement per published version. */
export async function enqueueLiveFeedLine(
  trx: Trx,
  input: { version: string; text: string; at: Date },
): Promise<number | null> {
  const row = await insertOutbox(trx, {
    kind: 'feed.line',
    dedupeKey: `doctor:live:${input.version}`,
    payload: {
      key: 'spur-board',
      text: input.text,
      title: 'spur-board is live',
      persona: { name: 'board', role: 'board' },
      itemKey: `doctor:live:${input.version}`,
    },
    parent: null,
    at: input.at,
  });
  return row.id;
}

export async function enqueueFeedEdit(
  trx: Trx,
  input: {
    itemKey: string;
    raise: number;
    lineId: number;
    key: string;
    taskId: number | null;
    at: Date;
  },
): Promise<number | null> {
  const row = await insertOutbox(trx, {
    kind: 'feed.line.edit',
    dedupeKey: `feed.line.edit:${input.itemKey}:${String(input.raise)}`,
    payload: {
      key: input.key,
      text: '✓ cleared',
      persona: { name: 'board', role: 'board' },
      itemKey: input.itemKey,
      taskId: input.taskId ?? undefined,
    },
    parent: input.lineId,
    at: input.at,
  });
  return row.id;
}

function payloadStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(payloadStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(payloadStrings);
  }
  return [];
}

/** Inserts a row unless its dedupe key exists; returns the row's id and whether it is new. */
async function insertOutbox(
  trx: Trx,
  row: { kind: OutboxKind; dedupeKey: string; payload: unknown; parent: number | null; at: Date },
): Promise<{ id: number | null; inserted: boolean }> {
  if (row.kind !== 'doorbell') {
    const payload = row.payload;
    if (payload === null || typeof payload !== 'object' || !('key' in payload)) {
      throw new Error('Invalid gateway outbox payload');
    }
    // Scan every payload string, including the outward text, title, name, URL and action labels.
    const rule = checkGatewayStrings(payloadStrings(payload));
    if (rule === SCAN_PENDING) return { id: null, inserted: false };
    if (rule !== null) {
      // A blocked notice cannot raise another blocked notice if its own link is unsafe.
      if (
        row.kind === 'feed.line' &&
        'itemKey' in payload &&
        typeof payload.itemKey === 'string' &&
        payload.itemKey.startsWith('secret-post:')
      ) {
        return { id: null, inserted: false };
      }
      const commentId = 'commentId' in payload ? payload.commentId : null;
      if (typeof commentId === 'number') {
        await trx
          .updateTable('comment')
          .set({ delivery_state: 'post_blocked' })
          .where('id', '=', commentId)
          .execute();
      }
      const key = typeof payload.key === 'string' ? payload.key : 'the task';
      const safeKey = checkGatewayStrings([key]) === null ? key : 'the task';
      const taskId =
        'taskId' in payload && typeof payload.taskId === 'number' ? payload.taskId : null;
      const blockId =
        'blockId' in payload && typeof payload.blockId === 'number' ? payload.blockId : null;
      const task =
        taskId === null
          ? null
          : await trx
              .selectFrom('task')
              .selectAll()
              .where('id', '=', taskId)
              .executeTakeFirstOrThrow();
      await raiseItem(trx, {
        itemKey: `secret-post:${createHash('sha256').update(row.dedupeKey).digest('hex')}`,
        kind: 'post_blocked',
        text: `text on ${safeKey} not sent: looks like a secret (${rule}), read \`board task ${safeKey}\``,
        url: task === null ? '' : taskUrl(task),
        taskId,
        blockId,
        at: row.at,
        rule,
        source: row.kind,
      });
      return { id: null, inserted: false };
    }
  }
  const inserted = await trx
    .insertInto('outbox')
    .values({
      kind: row.kind,
      dedupe_key: row.dedupeKey,
      // Checked by the sender before it is sent: a bad payload goes dead, not the caller's tx.
      payload: JSON.stringify(row.payload),
      state: 'pending',
      next_at: row.at.toISOString(),
      last_error: null,
      external_ref: null,
      parent_outbox_id: row.parent,
      first_attempt_at: null,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted !== undefined) return { id: inserted.id, inserted: true };
  const existing = await trx
    .selectFrom('outbox')
    .select('id')
    .where('dedupe_key', '=', row.dedupeKey)
    .executeTakeFirstOrThrow();
  return { id: existing.id, inserted: false };
}

async function markCommentPending(trx: Trx, commentId: number): Promise<void> {
  await trx
    .updateTable('comment')
    .set({ delivery_state: 'pending' })
    .where('id', '=', commentId)
    .execute();
}

/**
 * Writes the `conversation.open` row of a block addressed to the operator by someone else.
 * Returns the row id, or null and writes nothing for any other block, so callers may call it
 * for every new block. The text is the comment's when given, else the block's reason.
 */
export async function enqueueConversationOpen(
  trx: Trx,
  input: { blockId: number; commentId: number | null; persona: Persona; at: Date },
): Promise<number | null> {
  const block = await trx
    .selectFrom('block')
    .innerJoin('task', 'task.id', 'block.task_id')
    .select([
      'block.id',
      'block.reason',
      'block.author',
      'block.addressee_role',
      'task.id as taskId',
      'task.key',
    ])
    .where('block.id', '=', input.blockId)
    .executeTakeFirstOrThrow();
  if (block.addressee_role !== 'operator' || block.author === 'operator') return null;
  const comment =
    input.commentId === null
      ? undefined
      : await trx
          .selectFrom('comment')
          .select('text')
          .where('id', '=', input.commentId)
          .executeTakeFirstOrThrow();
  const payload: z.input<typeof openPayload> = {
    key: block.key,
    title: `${block.key} ${block.reason}`,
    text: comment?.text ?? block.reason,
    persona: input.persona,
    taskId: block.taskId,
    blockId: block.id,
    commentId: input.commentId,
  };
  const row = await insertOutbox(trx, {
    kind: 'conversation.open',
    dedupeKey: `conversation.open:block:${String(block.id)}`,
    payload,
    parent: null,
    at: input.at,
  });
  if (row.inserted && input.commentId !== null) await markCommentPending(trx, input.commentId);
  return row.id;
}

/**
 * Writes the `conversation.reply` row of a later comment on a block whose open row exists.
 * The row waits for the thread's latest open, reply or close row. Returns null and writes
 * nothing when there is no such row or it is dead: a dead thread takes no more replies.
 */
export async function enqueueConversationReply(
  trx: Trx,
  input: { commentId: number; persona: Persona; at: Date },
): Promise<number | null> {
  const comment = await trx
    .selectFrom('comment')
    .innerJoin('task', 'task.id', 'comment.task_id')
    .select(['comment.id', 'comment.text', 'comment.block_id', 'task.id as taskId', 'task.key'])
    .where('comment.id', '=', input.commentId)
    .executeTakeFirstOrThrow();
  const blockId = comment.block_id;
  if (blockId === null) return null;
  const tail = await trx
    .selectFrom('outbox')
    .select(['id', 'state'])
    .where('kind', 'in', ['conversation.open', 'conversation.reply', 'conversation.close'])
    .where(sql<number>`json_extract(payload, '$.blockId')`, '=', blockId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (tail === undefined || tail.state === 'dead') return null;
  const payload: z.input<typeof replyPayload> = {
    key: comment.key,
    text: comment.text,
    persona: input.persona,
    taskId: comment.taskId,
    blockId,
    commentId: comment.id,
  };
  const row = await insertOutbox(trx, {
    kind: 'conversation.reply',
    dedupeKey: `conversation.reply:comment:${String(comment.id)}`,
    payload,
    parent: tail.id,
    at: input.at,
  });
  if (row.inserted) await markCommentPending(trx, comment.id);
  return row.id;
}

/** Queues a close for every registered thread and for an open whose result is still unknown. */
export async function enqueueConversationClose(
  trx: Trx,
  input: { blockId: number; outcome: string; actor: ActorId; at: Date },
): Promise<void> {
  const block = await trx
    .selectFrom('block')
    .innerJoin('task', 'task.id', 'block.task_id')
    .select(['task.id as taskId', 'task.key', 'block.id'])
    .where('block.id', '=', input.blockId)
    .executeTakeFirstOrThrow();
  const tail = await trx
    .selectFrom('outbox')
    .select(['id', 'state'])
    .where('kind', 'in', ['conversation.open', 'conversation.reply'])
    .where(sql<number>`json_extract(payload, '$.blockId')`, '=', input.blockId)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  const open = await trx
    .selectFrom('outbox')
    .select(['id', 'state'])
    .where('kind', '=', 'conversation.open')
    .where(sql<number>`json_extract(payload, '$.blockId')`, '=', input.blockId)
    .executeTakeFirst();
  const parent = tail?.state === 'dead' ? null : (tail?.id ?? null);
  const conversations = await trx
    .selectFrom('conversation')
    .select('ref')
    .where('block_id', '=', input.blockId)
    .execute();
  const payload = {
    key: block.key,
    text: `resolved: ${input.outcome} (${input.actor})`,
    persona: { name: 'board', role: 'board' } as const,
    taskId: block.taskId,
    blockId: block.id,
    commentId: null,
  };
  for (const conversation of conversations) {
    const ref = conversationRefSchema.parse(conversation.ref);
    const hash = createHash('sha256').update(ref).digest('hex');
    await insertOutbox(trx, {
      kind: 'conversation.close',
      dedupeKey: `conversation.close:block:${String(block.id)}:ref:${hash}`,
      payload: { ...payload, targetConversation: ref },
      parent,
      at: input.at,
    });
  }
  if (open !== undefined && open.state !== 'done' && open.state !== 'dead') {
    await insertOutbox(trx, {
      kind: 'conversation.close',
      dedupeKey: `conversation.close:block:${String(block.id)}:pending:${String(open.id)}`,
      payload,
      parent: tail?.state === 'dead' ? open.id : (tail?.id ?? open.id),
      at: input.at,
    });
  }
  await trx
    .updateTable('conversation')
    .set({ state: 'closed', closed_at: input.at.toISOString() })
    .where('block_id', '=', input.blockId)
    .where('state', '=', 'open')
    .execute();
}

export async function enqueueInboundDoorbell(
  trx: Trx,
  input: { key: string; session: string; text: string; at: Date },
): Promise<void> {
  await insertOutbox(trx, {
    kind: 'doorbell',
    dedupeKey: input.key,
    payload: { session: input.session, text: input.text },
    parent: null,
    at: input.at,
  });
}
