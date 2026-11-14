import { prSourceId, ticketFactsSchema, trackerSourceId, type Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import { parseJson } from '../store/json.ts';
import { archiveTask } from './archive.ts';
import { emit, type Trx } from './board-utils.ts';

/** Run-local completeness is the only evidence allowed to authorize filter absence. */
export async function reconcileMembership(
  trx: Trx,
  config: Config,
  completeSince: ReadonlyMap<string, string>,
  at: string,
): Promise<void> {
  const states = await trx.selectFrom('source_state').select(['source', 'blind_reason']).execute();
  const blind = new Set(
    states.filter((state) => state.blind_reason !== null).map((state) => state.source),
  );
  const tasks = await trx
    .selectFrom('task')
    .selectAll()
    .where('membership', '!=', 'archived')
    .execute();
  for (const task of tasks) {
    if (task.manual_include === 1 || task.manual_exclude === 1) continue;
    const project = config.projects.find((entry) => entry.id === task.project);
    if (project === undefined) continue;
    const ticket = await trx
      .selectFrom('ticket_snapshot')
      .selectAll()
      .where('task_id', '=', task.id)
      .executeTakeFirst();
    if (ticket === undefined) continue;
    const facts = parseJson(ticketFactsSchema, ticket.detail);
    if (facts.inFilter) continue;
    const links = await trx
      .selectFrom('link')
      .selectAll()
      .where('task_id', '=', task.id)
      .where('banned', '=', 0)
      .execute();
    let retained = false;
    for (const link of links) {
      if (link.entity === 'pr' && link.repo !== null && link.number !== null) {
        const pr = await trx
          .selectFrom('pr_snapshot')
          .select('state')
          .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
          .where('number', '=', link.number)
          .executeTakeFirst();
        if (pr?.state === 'open') retained = true;
      } else if (link.entity === 'session' && link.session_id !== null) {
        const session = await trx
          .selectFrom('session_snapshot')
          .select('ended_at')
          .where('id', '=', link.session_id)
          .executeTakeFirst();
        if (session?.ended_at === null) retained = true;
      }
    }
    if (retained) {
      if (task.membership !== 'out_of_filter') {
        await trx
          .updateTable('task')
          .set({ membership: 'out_of_filter' })
          .where('id', '=', task.id)
          .execute();
        await emit(trx, 'flag_raised', task.project, task.id, at, { flag: 'out_of_filter' });
      }
    } else {
      // Archiving needs all three kinds of source complete since the task's last change: the
      // tracker proves the task left the filter, and Spur and the repos prove no live session
      // or open PR retains it. Any of them blind or behind leaves the task for a later pass.
      const required = [
        'spur',
        trackerSourceId(project),
        ...project.repos.map((repo) => prSourceId(project.id, repo)),
      ];
      if (
        required.some((source) => {
          const complete = completeSince.get(source);
          return (
            blind.has(source) ||
            complete === undefined ||
            complete <= (task.last_change_at ?? task.created_at)
          );
        })
      )
        continue;
      if (task.membership === 'out_of_filter')
        await emit(trx, 'flag_cleared', task.project, task.id, at, { flag: 'out_of_filter' });
      await archiveTask(trx, { task, reason: 'out_of_filter', actor: 'system', at });
    }
  }
}
