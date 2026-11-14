// Outbox kinds, their payloads and the producers that write them inside the caller's transaction.
import { createHash } from 'node:crypto';
import {
  actorIdSchema,
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
import { taskUrl } from './board-utils.ts';
import { raiseItemWith } from './item-raise.ts';
import { SCAN_PENDING, checkGatewayStrings, scanConfig } from './secrets.ts';

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

const persona = z.strictObject({
  name: z.string().min(1),
  role: z.enum(PERSONA_ROLES),
  icon: z.string().min(1).optional(),
});
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
/** `text` is the line's summary; a row without `resolved` predates the resolved rendering. */
const feedEditPayload = feedLineEditPayload.extend({
  url: z.url().optional(),
  resolved: z.strictObject({ by: actorIdSchema, at: z.iso.datetime() }).optional(),
});
export type FeedEditPayload = z.output<typeof feedEditPayload>;
/** A curator answer's question and answer, shortened; a row without it renders `text`. */
const exchange = z.strictObject({
  block: z.string().min(1),
  taskTitle: z.string().min(1).optional(),
  question: z.string(),
  answer: z.string(),
  note: z.string().min(1).optional(),
  askedBy: z.string().min(1),
  answeredBy: z.string().min(1),
  outcome: z.literal('unblocked'),
});
const feedLineWithLinkPayload = feedLinePayload.extend({
  itemId: id.optional(),
  url: z.url().optional(),
  actions: z.array(z.strictObject({ id: z.string(), label: z.string() })).optional(),
  exchange: exchange.optional(),
});
type FeedLinePayload = z.output<typeof feedLineWithLinkPayload>;
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
  z.strictObject({ kind: z.literal('feed.line.edit'), payload: feedEditPayload }),
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

/**
 * A curator answer line: the task link and title, the question, the answer, the note, then the
 * block, who asked, who answered and the outcome as muted details.
 */
export function exchangeBody(
  payload: Pick<FeedLinePayload, 'key' | 'url'> & { exchange: z.output<typeof exchange> },
): RichText {
  const { exchange: line } = payload;
  return [
    {
      kind: 'paragraph',
      children: [
        payload.url === undefined
          ? { kind: 'text', text: payload.key }
          : { kind: 'link', url: payload.url, text: payload.key },
        ...(line.taskTitle === undefined
          ? []
          : [{ kind: 'text' as const, text: ` ${line.taskTitle}` }]),
      ],
    },
    {
      kind: 'paragraph',
      children: [
        { kind: 'emphasis', text: 'Question:' },
        { kind: 'text', text: ` ${line.question}` },
      ],
    },
    {
      kind: 'paragraph',
      children: [
        { kind: 'emphasis', text: 'Answer:' },
        { kind: 'text', text: ` ${line.answer}` },
      ],
    },
    ...(line.note === undefined
      ? []
      : [{ kind: 'paragraph' as const, children: [{ kind: 'italic' as const, text: line.note }] }]),
    {
      kind: 'context',
      children: [
        {
          kind: 'text',
          text: `${line.block} · asked by ${line.askedBy} · answered by ${line.answeredBy} · ${line.outcome}`,
        },
      ],
    },
  ];
}

type Trx = Kysely<Tables>;

/**
 * A distinct semantic ring. Transport retries reuse this row and its text. A restarted series
 * (`series` > 0), a ring after the task was archived (`archives` > 0) and a ring after a move
 * killed an earlier one (`moves` > 0) get their own keys, so a cancelled ring does not block its
 * replacement; unsuffixed keys stay as before.
 */
export async function enqueueDoorbell(
  trx: Trx,
  input: {
    notificationId: number;
    ring: number;
    session: string;
    text: string;
    at: Date;
    series?: number;
    archives?: number;
    moves?: number;
  },
): Promise<number> {
  const series = input.series ?? 0;
  const archives = input.archives ?? 0;
  const moves = input.moves ?? 0;
  const row = await insertOutbox(trx, {
    kind: 'doorbell',
    dedupeKey: `doorbell:${String(input.notificationId)}:${input.session}:${String(input.ring)}${
      series > 0 ? `:s${String(series)}` : ''
    }${archives > 0 ? `:a${String(archives)}` : ''}${moves > 0 ? `:m${String(moves)}` : ''}`,
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

const QUESTION_CHARS = 120;
const ANSWER_CHARS = 200;
const NOTE_CHARS = 200;
const TITLE_CHARS = 80;

/** Collapses whitespace and cuts by code points to `limit`, ending a cut text with `…`. */
function shorten(text: string, limit: number): string {
  const points = Array.from(text.replace(/\s+/g, ' ').trim());
  return points.length <= limit ? points.join('') : `${points.slice(0, limit - 1).join('')}…`;
}

/** One line per curator answer; the key names the answer comment, so a retry adds none. */
export async function enqueueCuratorAnswerLine(
  trx: Trx,
  input: {
    taskId: number;
    key: string;
    url: string;
    blockId: number;
    commentId: number;
    asker: string;
    question: string;
    answer: string;
    note?: string | undefined;
    taskTitle?: string | undefined;
    persona: Persona;
    /** `project/session` of the curator session that answered. */
    answeredBy: string;
    at: Date;
  },
): Promise<void> {
  const block = `B${String(input.blockId)}`;
  const itemKey = `curator-answer:comment:${String(input.commentId)}`;
  const note = input.note === undefined ? '' : shorten(input.note, NOTE_CHARS);
  const taskTitle = input.taskTitle === undefined ? '' : shorten(input.taskTitle, TITLE_CHARS);
  await insertOutbox(trx, {
    kind: 'feed.line',
    dedupeKey: `feed.line:${itemKey}`,
    payload: {
      key: input.key,
      text: `${block} · ${input.asker} asked: ${shorten(input.question, QUESTION_CHARS)} → curator answered: ${shorten(input.answer, ANSWER_CHARS)}`,
      title: `${input.key} ${block} answered by curator`,
      persona: input.persona,
      itemKey,
      taskId: input.taskId,
      ...(input.url === '' ? {} : { url: input.url }),
      exchange: {
        block,
        ...(taskTitle === '' ? {} : { taskTitle }),
        question: shorten(input.question, QUESTION_CHARS),
        answer: shorten(input.answer, ANSWER_CHARS),
        ...(note === '' ? {} : { note }),
        askedBy: input.asker,
        answeredBy: input.answeredBy,
        outcome: 'unblocked',
      },
    },
    parent: null,
    at: input.at,
  });
}

export async function enqueueFeedEdit(
  trx: Trx,
  input: {
    itemKey: string;
    raise: number;
    lineId: number;
    key: string;
    taskId: number | null;
    /** The line's summary, struck through in the edit. */
    summary: string;
    /** The line's link; empty for a line without one. */
    url: string;
    by: ActorId;
    at: Date;
  },
): Promise<number | null> {
  const row = await insertOutbox(trx, {
    kind: 'feed.line.edit',
    dedupeKey: `feed.line.edit:${input.itemKey}:${String(input.raise)}`,
    payload: {
      key: input.key,
      text: input.summary,
      persona: { name: 'board', role: 'board' },
      itemKey: input.itemKey,
      taskId: input.taskId ?? undefined,
      ...(input.url === '' ? {} : { url: input.url }),
      resolved: { by: input.by, at: input.at.toISOString() },
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

/**
 * Keeps a gateway text that looks like a secret unsent: its comment goes `post_blocked` and a
 * `post_blocked` item names the task. A blocked notice never raises another one.
 */
async function blockPost(
  trx: Trx,
  row: { kind: OutboxKind; dedupeKey: string; at: Date },
  payload: object & { key: unknown },
  rule: string,
): Promise<void> {
  // A blocked notice cannot raise another blocked notice if its own link is unsafe.
  if (
    row.kind === 'feed.line' &&
    'itemKey' in payload &&
    typeof payload.itemKey === 'string' &&
    payload.itemKey.startsWith('secret-post:')
  ) {
    return;
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
  const taskId = 'taskId' in payload && typeof payload.taskId === 'number' ? payload.taskId : null;
  const blockId =
    'blockId' in payload && typeof payload.blockId === 'number' ? payload.blockId : null;
  const task =
    taskId === null
      ? null
      : await trx.selectFrom('task').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow();
  await raiseItemWith(
    trx,
    {
      itemKey: `secret-post:${createHash('sha256').update(row.dedupeKey).digest('hex')}`,
      kind: 'post_blocked',
      text: `text on ${safeKey} not sent: looks like a secret (${rule}), read \`board task ${safeKey}\``,
      url: task === null ? '' : taskUrl(task, scanConfig()),
      taskId,
      blockId,
      at: row.at,
      rule,
      source: row.kind,
    },
    enqueueFeedLine,
  );
}

/**
 * Scans a stored gateway row's payload again before it is resent, with the rules used at
 * insert. A hit is handled as at insert (`blockPost`); the caller keeps the row unsent.
 * Returns the rule, null when clean, or `SCAN_PENDING` (the scan transaction re-runs).
 */
export async function rescanStoredPost(
  trx: Trx,
  row: { kind: OutboxKind; dedupe_key: string; payload: string },
  at: Date,
): Promise<string | null | typeof SCAN_PENDING> {
  if (row.kind === 'doorbell') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    // The sender kills an unreadable payload before it sends anything.
    return null;
  }
  if (payload === null || typeof payload !== 'object' || !('key' in payload)) return null;
  const rule = checkGatewayStrings(payloadStrings(payload));
  if (rule !== null && rule !== SCAN_PENDING) {
    await blockPost(trx, { kind: row.kind, dedupeKey: row.dedupe_key, at }, payload, rule);
  }
  return rule;
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
      await blockPost(trx, row, payload, rule);
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
    text: `resolved: ${input.outcome === 'archived' ? 'task archived' : input.outcome} (${input.actor})`,
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
