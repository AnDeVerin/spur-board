import type { Config } from '@spur-board/contracts';
import type { Selectable } from 'kysely';
import { threadsGated } from '../domain/gates.ts';
import type { TaskTable, TurnTable } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import { prFacts } from './course-check.ts';
import { turnHanded } from './turns.ts';

type Turn = Selectable<TurnTable>;
type Project = Config['projects'][number];

/**
 * The unresolved review threads a Dev turn lists, read live from the task's PR snapshot: only on a
 * project requiring resolved threads and an open PR, and only threads with an id and a link (facts
 * stored by an earlier version lack them). Undefined when none.
 */
async function turnThreads(trx: Trx, taskId: number, project: Project | undefined, turn: Turn) {
  if (turn.column !== 'dev' || project === undefined || !threadsGated(project)) return undefined;
  const pr = await prFacts(trx, taskId);
  if (pr?.state !== 'open') return undefined;
  const threads = pr.reviewThreads.flatMap(({ resolved, id, url, outdated }) =>
    resolved || id === undefined || url === undefined
      ? []
      : [{ id, url, outdated: outdated ?? false }],
  );
  return threads.length === 0 ? undefined : threads;
}

/** A turn as the worker and `task.get --why` read it, with the threads of a Dev turn. */
export async function turnView(
  trx: Trx,
  turn: Turn,
  task: Pick<Selectable<TaskTable>, 'id' | 'key'>,
  project: Project | undefined,
) {
  const threads = await turnThreads(trx, task.id, project, turn);
  return {
    id: `T${String(turn.id)}`,
    task: task.key,
    column: turn.column,
    addressee: turn.role,
    reason: turn.reason,
    handed: turnHanded(turn),
    head: turn.head_sha,
    at: turn.created_at,
    taken:
      turn.acked_by === null || turn.acked_at === null
        ? null
        : { by: turn.acked_by, at: turn.acked_at },
    ...(threads === undefined ? {} : { threads }),
  };
}
