import type { Trx } from './board-utils.ts';
import { courseKeyPrefix, cycleKeyPrefix } from './course-check.ts';

/**
 * The blocks of the active cycle-limit and course-check items that hold the task's turn, in item
 * order, with their addressees. The inner join leaves no item without a block.
 */
export async function holdBlocks(trx: Trx, taskId: number) {
  const items = await trx
    .selectFrom('operator_item')
    .innerJoin('block', 'block.id', 'operator_item.block_id')
    .select(['operator_item.block_id', 'block.addressee_role'])
    .where((eb) =>
      eb.or([
        eb('operator_item.item_key', 'like', `${cycleKeyPrefix(taskId)}%`),
        eb('operator_item.item_key', 'like', `${courseKeyPrefix(taskId)}%`),
      ]),
    )
    .where('operator_item.cleared_at', 'is', null)
    .orderBy('operator_item.id')
    .execute();
  return items.map((item) => ({
    id: `B${String(item.block_id)}`,
    addressee: item.addressee_role,
  }));
}
