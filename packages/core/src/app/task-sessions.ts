import { sessionFactsSchema } from '@spur-board/contracts';
import { parseJson } from '../store/json.ts';
import type { Trx } from './board-utils.ts';

/** Current facts of the effective session links that task.get exposes. */
export async function taskSessions(trx: Trx, taskId: number) {
  const sessions = await trx
    .selectFrom('link')
    .innerJoin('session_snapshot', 'session_snapshot.id', 'link.session_id')
    .select('session_snapshot.detail')
    .where('link.task_id', '=', taskId)
    .where('link.entity', '=', 'session')
    .where('link.banned', '=', 0)
    .orderBy('link.id')
    .execute();
  return sessions.map((row) => {
    const facts = parseJson(sessionFactsSchema, row.detail);
    return {
      ...facts,
      links: Object.entries(facts.links).map(([label, url]) => ({ label, url })),
    };
  });
}
