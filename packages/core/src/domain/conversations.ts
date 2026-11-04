import {
  conversationRefSchema,
  messageRefSchema,
  type ConversationRef,
  type MessageRef,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { outboxBodySchema } from '../app/outbox.ts';
import type { Row, Tables } from '../store/schema.ts';

type Trx = Kysely<Tables>;
type Conversation = Row<'conversation'>;

/**
 * The ref is the routing key. An origin key can register a second thread opened after an
 * uncertain delivery, but never selects a different block by task membership or recency.
 */
export async function resolveBlockConversation(
  trx: Trx,
  input: {
    gateway: string;
    ref: ConversationRef;
    originKey?: string;
    rootMessage: MessageRef;
    at: string;
  },
): Promise<{ conversation: Conversation; registered: boolean } | undefined> {
  const existing = await trx
    .selectFrom('conversation')
    .selectAll()
    .where('gateway', '=', input.gateway)
    .where('ref', '=', input.ref)
    .where('purpose', '=', 'block')
    .executeTakeFirst();
  if (existing !== undefined) return { conversation: existing, registered: false };
  if (input.originKey === undefined) return undefined;
  const opened = await trx
    .selectFrom('outbox')
    .select(['payload'])
    .where('kind', '=', 'conversation.open')
    .where('dedupe_key', '=', input.originKey)
    .executeTakeFirst();
  if (opened === undefined) return undefined;
  const parsed = outboxBodySchema.safeParse({
    kind: 'conversation.open',
    payload: JSON.parse(opened.payload) as unknown,
  });
  if (!parsed.success || parsed.data.kind !== 'conversation.open') return undefined;
  const block = await trx
    .selectFrom('block')
    .select(['id', 'state', 'unblocked_at', 'created_at'])
    .where('id', '=', parsed.data.payload.blockId)
    .executeTakeFirst();
  if (block === undefined) return undefined;
  const row = await trx
    .insertInto('conversation')
    .values({
      gateway: input.gateway,
      ref: conversationRefSchema.parse(input.ref),
      space: 'orchestrators',
      task_id: parsed.data.payload.taskId,
      block_id: block.id,
      purpose: 'block',
      state: block.state === 'open' ? 'open' : 'closed',
      root_message_ref: messageRefSchema.parse(input.rootMessage),
      after_message_ref: null,
      // Recovery must include replies sent before this thread was first observed.
      created_at: block.created_at,
      closed_at: block.state === 'open' ? null : (block.unblocked_at ?? input.at),
    })
    .onConflict((oc) => oc.columns(['gateway', 'ref']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (row !== undefined) return { conversation: row, registered: true };
  const raced = await trx
    .selectFrom('conversation')
    .selectAll()
    .where('gateway', '=', input.gateway)
    .where('ref', '=', input.ref)
    .where('purpose', '=', 'block')
    .executeTakeFirst();
  return raced === undefined ? undefined : { conversation: raced, registered: false };
}

/** Older recovered messages cannot replace a newer cursor. Edits never call this function. */
export async function advanceConversationCursor(
  trx: Trx,
  conversation: Conversation,
  message: MessageRef,
  at: string,
): Promise<void> {
  if (conversation.after_message_ref !== null) {
    const last = await trx
      .selectFrom('comment')
      .select('created_at')
      .where('conversation_ref', '=', conversation.ref)
      .where('message_ref', '=', conversation.after_message_ref)
      .executeTakeFirst();
    if (last !== undefined && last.created_at > at) return;
  }
  await trx
    .updateTable('conversation')
    .set({ after_message_ref: message })
    .where('gateway', '=', conversation.gateway)
    .where('ref', '=', conversation.ref)
    .execute();
}

/** Distinct block conversations to pass to recovery, with seven days of closed history. */
export async function conversationsForRecovery(
  trx: Trx,
  gateway: string,
  now: Date,
): Promise<{ rows: Conversation[]; since: Date }> {
  const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await trx
    .selectFrom('conversation')
    .selectAll()
    .where('gateway', '=', gateway)
    .where('purpose', '=', 'block')
    .where((eb) => eb.or([eb('state', '=', 'open'), eb('closed_at', '>=', cutoff)]))
    .orderBy('created_at')
    .execute();
  const since = rows[0] === undefined ? now : new Date(rows[0].created_at);
  return { rows, since };
}
