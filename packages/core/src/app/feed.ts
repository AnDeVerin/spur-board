import { EVENT_VERSION, eventPayloadSchemas } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { toJson } from '../store/json.ts';
import type { Row, Tables } from '../store/schema.ts';
import { enqueueFeedEdit, enqueueFeedLine } from './outbox.ts';

type Trx = Kysely<Tables>;

const NO_FEED = new Set(['post_failed', 'answer_undelivered', 'transport_health']);

async function journal(
  trx: Trx,
  item: Row<'operator_item'>,
  kind: 'from_you_raised' | 'from_you_cleared',
  at: Date,
): Promise<void> {
  const task =
    item.task_id === null
      ? undefined
      : await trx
          .selectFrom('task')
          .select(['project'])
          .where('id', '=', item.task_id)
          .executeTakeFirstOrThrow();
  await trx
    .insertInto('event')
    .values({
      at: at.toISOString(),
      project: task?.project ?? 'board',
      task_id: item.task_id,
      kind,
      actor: 'system',
      actor_ref: null,
      payload: toJson(eventPayloadSchemas[kind], { item: `I${String(item.id)}` }),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}

/** Raise one item generation. A repeated raise of an active key is idempotent. */
export async function raiseItem(
  trx: Trx,
  input: {
    itemKey: string;
    kind: string;
    text: string;
    url: string;
    taskId: number | null;
    blockId: number | null;
    at: Date;
    fingerprint?: string;
    factAt?: string | null;
    source?: string | null;
    priority?: number;
    suppressFeed?: boolean;
  },
): Promise<Row<'operator_item'>> {
  const active = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('item_key', '=', input.itemKey)
    .where('cleared_at', 'is', null)
    .executeTakeFirst();
  if (active !== undefined) return active;
  const previous = await trx
    .selectFrom('operator_item')
    .select('raise_no')
    .where('item_key', '=', input.itemKey)
    .orderBy('raise_no', 'desc')
    .executeTakeFirst();
  let item = await trx
    .insertInto('operator_item')
    .values({
      item_key: input.itemKey,
      raise_no: (previous?.raise_no ?? 0) + 1,
      kind: input.kind,
      text: input.text,
      url: input.url,
      task_id: input.taskId,
      block_id: input.blockId,
      raised_at: input.at.toISOString(),
      cleared_at: null,
      line_outbox_id: null,
      fingerprint: input.fingerprint ?? null,
      fact_at: input.factAt ?? null,
      source: input.source ?? null,
      priority: input.priority ?? null,
      inbound_event_json: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, item, 'from_you_raised', input.at);
  if (!NO_FEED.has(item.kind) && !input.suppressFeed) {
    const task =
      item.task_id === null
        ? null
        : await trx
            .selectFrom('task')
            .select('key')
            .where('id', '=', item.task_id)
            .executeTakeFirstOrThrow();
    const key = task?.key ?? 'board';
    const line = await enqueueFeedLine(trx, {
      itemId: item.id,
      itemKey: item.item_key,
      raise: item.raise_no,
      key,
      text: item.text,
      title: `${key}: ${item.text}`,
      url: item.url,
      taskId: item.task_id,
      ...(item.kind === 'worker_not_reading'
        ? {
            actions: [
              { id: `item:${String(item.id)}:retry`, label: 'Retry' },
              { id: `item:${String(item.id)}:close`, label: 'Close' },
            ],
          }
        : item.kind === 'inbound_failure'
          ? {
              actions: [
                { id: `item:${String(item.id)}:retry`, label: 'Retry' },
                { id: `item:${String(item.id)}:close`, label: 'Close' },
              ],
            }
          : item.kind === 'inbound_gap' || item.kind === 'answer_author_unavailable'
            ? { actions: [{ id: `item:${String(item.id)}:close`, label: 'Close' }] }
            : {}),
      at: input.at,
    });
    item = await trx
      .updateTable('operator_item')
      .set({ line_outbox_id: line })
      .where('id', '=', item.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return item;
}

/** Clear an item once; the edit waits for its line and is cancelled with a stale pending line. */
export async function clearItem(trx: Trx, itemId: number, at: Date): Promise<void> {
  const current = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();
  if (current.cleared_at !== null) return;
  const item = await trx
    .updateTable('operator_item')
    .set({ cleared_at: at.toISOString() })
    .where('id', '=', itemId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, item, 'from_you_cleared', at);
  if (item.line_outbox_id === null) return;
  const task =
    item.task_id === null
      ? null
      : await trx
          .selectFrom('task')
          .select('key')
          .where('id', '=', item.task_id)
          .executeTakeFirstOrThrow();
  await enqueueFeedEdit(trx, {
    itemKey: item.item_key,
    raise: item.raise_no,
    lineId: item.line_outbox_id,
    key: task?.key ?? 'board',
    taskId: item.task_id,
    at,
  });
}
