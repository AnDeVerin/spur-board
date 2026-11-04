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
  completeSince: ReadonlyMap<string, string>;
}): Promise<void> {
  const { store, config, clock, completeSince } = deps;
  const now = clock.now();
  const at = new Date(now).toISOString();
  const slot = new Date(lastSaturday(now)).toISOString();
  await store.transaction(async (trx) => {
    const sourceStates = await trx
      .selectFrom('source_state')
      .select(['source', 'blind_reason'])
      .execute();
    const blind = new Set(
      sourceStates.filter((source) => source.blind_reason !== null).map((source) => source.source),
    );
    const tasks = await trx
      .selectFrom('task')
      .selectAll()
      .where('membership', '!=', 'archived')
      .execute();
    for (const task of tasks) {
      if (task.terminal_at === null || task.terminal_at > slot || task.archive_slot_at === slot)
        continue;
      const project = config.projects.find((entry) => entry.id === task.project);
      if (
        project === undefined ||
        project.repos.some((repo) => {
          const source = `github:${project.id}:${repo.toLowerCase()}`;
          const complete = completeSince.get(source);
          return (
            blind.has(source) ||
            complete === undefined ||
            complete <= (task.last_change_at ?? task.created_at)
          );
        })
      )
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
    await reconcileItems(trx, config, now, completeSince.has('spur'));
  });
}
