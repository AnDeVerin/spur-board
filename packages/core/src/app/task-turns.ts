import type { Selectable } from 'kysely';
import type { TurnTable } from '../store/schema.ts';
import { turnReturn, type Trx } from './board-utils.ts';
import { turnHanded } from './turns.ts';

/** How many closed turns `task.get --detail` shows. */
const DETAIL_TURNS = 5;

async function taskTurnView(trx: Trx, turn: Selectable<TurnTable>) {
  const returned = await turnReturn(trx, turn);
  return {
    id: `T${String(turn.id)}`,
    column: turn.column,
    addressee: turn.role,
    at: turn.created_at,
    taken:
      turn.acked_by === null || turn.acked_at === null
        ? null
        : { by: turn.acked_by, at: turn.acked_at },
    handed: turnHanded(turn),
    ...(returned === undefined ? {} : { returned }),
    closed:
      turn.closed_at === null || turn.closed_reason === null
        ? null
        : { at: turn.closed_at, outcome: turn.closed_reason },
  };
}

/**
 * The turns `task.get` shows: the task's unclosed turn, and with `detail` its last closed turns,
 * newest first.
 */
export async function taskTurns(trx: Trx, task: { id: number }, detail: boolean) {
  const open = await trx
    .selectFrom('turn')
    .selectAll()
    .where('task_id', '=', task.id)
    .where('closed_at', 'is', null)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  const turn = open === undefined ? null : await taskTurnView(trx, open);
  if (!detail) return { turn };
  const closed = await trx
    .selectFrom('turn')
    .selectAll()
    .where('task_id', '=', task.id)
    .where('closed_at', 'is not', null)
    .orderBy('id', 'desc')
    .limit(DETAIL_TURNS)
    .execute();
  const turns = [];
  for (const row of closed) turns.push(await taskTurnView(trx, row));
  return { turn, turns };
}
