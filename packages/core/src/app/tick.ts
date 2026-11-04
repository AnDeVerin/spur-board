import type { Config } from '@spur-board/contracts';
import type { Store } from '../store/store.ts';
import { emit } from './board-utils.ts';
import { reconcileItems } from './fromYou.ts';

function lastSaturday(now: number): number {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return start - ((date.getUTCDay() + 1) % 7) * 86_400_000;
}

/** One UTC tick, including a Saturday archive slot missed during downtime. */
export async function tickBoard(deps: {
  store: Store;
  config: Config;
  clock: { now(): number };
}): Promise<void> {
  const { store, config, clock } = deps;
  const now = clock.now();
  const at = new Date(now).toISOString();
  const slot = new Date(lastSaturday(now)).toISOString();
  await store.transaction(async (trx) => {
    const tasks = await trx
      .selectFrom('task')
      .selectAll()
      .where('membership', '!=', 'archived')
      .execute();
    for (const task of tasks) {
      if (task.terminal_at === null || task.terminal_at > slot || task.archive_slot_at === slot)
        continue;
      await trx
        .updateTable('task')
        .set({
          membership: 'archived',
          archive_reason: 'done',
          archive_slot_at: slot,
          last_change_at: at,
        })
        .where('id', '=', task.id)
        .execute();
      await emit(trx, 'task_archived', task.project, task.id, at, { reason: 'done' });
    }
    await reconcileItems(trx, config, now, false);
  });
}
