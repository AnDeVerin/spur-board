import type { ActorId, ArchiveReason } from '@spur-board/contracts';
import type { Row } from '../store/schema.ts';
import { RECONCILED_KINDS } from '../domain/fromYou.ts';
import { emit, type Trx } from './board-utils.ts';
import { closeOpenBlock } from './blocks.ts';
import { clearItem } from './feed.ts';
import { closeTurns } from './turns.ts';

/**
 * Takes a task off the board in the caller's transaction: closes its open blocks with outcome
 * `archived` and its unclosed turns, clears its board-derived items, cancels its unsent doorbells and journals
 * `task_archived`. Callers set their own extra columns (manual flags, the Done slot).
 */
export async function archiveTask(
  trx: Trx,
  input: { task: Row<'task'>; reason: ArchiveReason; actor: ActorId; at: string },
): Promise<void> {
  const { task, reason, actor, at } = input;
  const ctx = { actor, at };
  const blocks = await trx
    .selectFrom('block')
    .selectAll()
    .where('task_id', '=', task.id)
    .where('state', '=', 'open')
    .orderBy('id')
    .execute();
  for (const block of blocks) await closeOpenBlock(trx, task, block, ctx, 'archived', null);
  await closeTurns(trx, { taskId: task.id, reason: 'archived', at: new Date(at) });
  // Every state-derived item has a null block_id; the next reconcile would clear them anyway.
  const items = await trx
    .selectFrom('operator_item')
    .select('id')
    .where('kind', 'in', RECONCILED_KINDS)
    .where('task_id', '=', task.id)
    .where('cleared_at', 'is', null)
    .orderBy('id')
    .execute();
  for (const item of items) await clearItem(trx, item.id, new Date(at), actor);
  const comments = await trx
    .selectFrom('comment')
    .select('id')
    .where('task_id', '=', task.id)
    .execute();
  // A ring is cancelled even when uncertain: a repeated ring for an archived task is not worth
  // sending. A claimed ring is the sender's; it drops one that has not started (`ringTask`).
  await trx
    .updateTable('outbox')
    .set({ state: 'dead', last_error: 'superseded' })
    .where('kind', '=', 'doorbell')
    .where('state', 'in', ['pending', 'post_failed'])
    .where((eb) =>
      eb.or([
        eb(
          'id',
          'in',
          eb
            .selectFrom('notification')
            .select('last_outbox_id')
            .where('task_id', '=', task.id)
            .where('last_outbox_id', 'is not', null),
        ),
        ...comments.map((comment) =>
          eb('dedupe_key', 'like', `doorbell:comment:${String(comment.id)}:%`),
        ),
      ]),
    )
    .execute();
  await trx
    .updateTable('task')
    .set({ membership: 'archived', archive_reason: reason, last_change_at: at })
    .where('id', '=', task.id)
    .execute();
  await emit(trx, 'task_archived', task.project, task.id, at, { reason }, actor);
}
