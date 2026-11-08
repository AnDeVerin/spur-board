import type { ActorId } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { Row, Tables } from '../store/schema.ts';
import { TASKLESS_FEED_KEY, journal, raiseItemWith, type RaiseItemInput } from './item-raise.ts';
import { enqueueFeedEdit, enqueueFeedLine } from './outbox.ts';

type Trx = Kysely<Tables>;

/** Raise one item generation. A repeated raise of an active key is idempotent. */
export async function raiseItem(trx: Trx, input: RaiseItemInput): Promise<Row<'operator_item'>> {
  return raiseItemWith(trx, input, enqueueFeedLine);
}

/**
 * Clear an item once; the edit waits for its line and is cancelled with a stale pending line.
 * The journal names `actor`, `system` unless an operator action cleared it.
 */
export async function clearItem(
  trx: Trx,
  itemId: number,
  at: Date,
  actor: ActorId = 'system',
): Promise<void> {
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
  await journal(trx, item, 'from_you_cleared', at, undefined, actor);
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
    key: task?.key ?? TASKLESS_FEED_KEY,
    taskId: item.task_id,
    at,
  });
}
