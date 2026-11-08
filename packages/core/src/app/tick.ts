import { scanTransaction } from './secrets.ts';
import type { Config } from '@spur-board/contracts';
import type { Store } from '../store/store.ts';
import { archiveTask } from './archive.ts';
import { reconcileItems } from './fromYou.ts';

function lastArchiveSlot(now: number, config: Config): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.digest.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (time: number): string => {
    const parts = formatter.formatToParts(time);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year === undefined || month === undefined || day === undefined)
      throw new Error('Archive timezone did not yield a local date');
    return `${year}-${month}-${day}`;
  };
  const [year = 0, month = 0, day = 0] = localDate(now).split('-').map(Number);
  const localMidnight = Date.UTC(year, month - 1, day);
  const weekday = new Date(localMidnight).getUTCDay();
  const target = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ].indexOf(config.archive.doneWeekday);
  const targetUtcDate = localMidnight - ((weekday - target + 7) % 7) * 86_400_000;
  const targetDate = new Date(targetUtcDate).toISOString().slice(0, 10);
  let lower = targetUtcDate - 2 * 86_400_000;
  let upper = targetUtcDate + 2 * 86_400_000;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDate(middle) < targetDate) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

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
  const slot = new Date(lastArchiveSlot(now, config)).toISOString();
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
        .set({ archive_slot_at: slot })
        .where('id', '=', task.id)
        .execute();
      await archiveTask(trx, { task, reason: 'done', actor: 'system', at });
    }
    await reconcileItems(trx, config, now, completeSince.has('spur'));
  });
}
