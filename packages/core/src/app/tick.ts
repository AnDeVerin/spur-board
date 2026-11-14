import { scanTransaction } from './secrets.ts';
import { prSourceId, type Config } from '@spur-board/contracts';
import type { Store } from '../store/store.ts';
import { archiveTask } from './archive.ts';
import { dispatchJournaled } from './dispatch.ts';
import { reconcileItems } from './fromYou.ts';
import { remindStuckTurns } from './turns.ts';
import { lastLocalSlot } from '../domain/slot.ts';

/** One board tick, including an archive slot missed during downtime. */
export async function tickBoard(deps: {
  store: Store;
  config: Config;
  clock: { now(): number };
  completeSince: ReadonlyMap<string, string>;
}): Promise<void> {
  const { store, config, clock, completeSince } = deps;
  const now = clock.now();
  const at = new Date(now).toISOString();
  const slot = new Date(
    lastLocalSlot(now, config.digest.tz, config.archive.doneWeekday),
  ).toISOString();
  await scanTransaction(store, config, async (trx) => {
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
          const source = prSourceId(project.id, repo);
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
        .set({ archive_slot_at: slot })
        .where('id', '=', task.id)
        .execute();
      await archiveTask(trx, { task, reason: 'done', actor: 'system', at });
    }
    await dispatchJournaled(trx, { config, at: new Date(now), complete: completeSince });
    await remindStuckTurns(trx, config, new Date(now));
    await reconcileItems(trx, config, now, completeSince.has('spur'));
  });
}
