import {
  columnTurnTimings,
  parseActorId,
  sessionFactsSchema,
  type Config,
} from '@spur-board/contracts';
import type { Row } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import {
  cancelledRingState,
  isTurnWakeKey,
  registerTurnReminder,
  turnReminderKey,
} from './doorbells.ts';
import { unlinkedSessions, workerUnlinked } from './turn-waits.ts';
import { taskProject } from './turns.ts';

// When the holder of a taken turn sits quiet: the reminder, the stuck-turn rule and the sender's
// check that a queued reminder is still due.

type TurnPlace = Pick<Row<'turn'>, 'role' | 'column'>;

/**
 * How long the holder of a taken turn may sit quiet before it is reminded, then flagged: the column
 * `quietTurnAfterMs` for its named orchestrator's turn (by role: a worker turn can stay in a column
 * a config change named), else `health.idleInDevAfterMs`.
 */
export function stuckTurnAfterMs(config: Config, projectId: string, turn: TurnPlace): number {
  const own = turn.role === `orchestrator:${turn.column}`;
  const timings = own ? columnTurnTimings(config, projectId, turn.column) : null;
  return timings?.quietTurnAfterMs ?? config.health.idleInDevAfterMs;
}

/**
 * Since when a holder session sits idle: from its end, or from when it began `waiting` at its
 * prompt. Null for any other health, an unknown one, or a detail that does not parse.
 */
function idleSince(session: Row<'session_snapshot'>): string | null {
  if (session.ended_at !== null) return session.ended_at;
  let detail: unknown;
  try {
    detail = JSON.parse(session.detail);
  } catch {
    return null;
  }
  const fact = sessionFactsSchema.safeParse(detail);
  return fact.success && fact.data.health === 'waiting' ? fact.data.healthSince : null;
}

/** The latest of ISO instants, compared as instants. */
function latest(values: readonly string[]): string {
  return new Date(Math.max(...values.map((value) => Date.parse(value)))).toISOString();
}

/**
 * Every taken, unclosed agent turn with its holder's session id, whether that session ended, and
 * the reminder of the current holder's current take, so an earlier episode's reminder never counts
 * and one cancelled unsent counts as none. `delivered` is whether that reminder reached the holder
 * or may have: a ring killed after an uncertain send counts, so the one-ring limit hides no stuck
 * turn.
 * `quietSince` is when the holder last had something to do: the take, the start of its idle
 * spell, the end of its last wait, or the close of its last question on the task. Null while the
 * holder works, waits (`task.wait`), has an open question on the task, or has no readable
 * snapshot. A worker turn whose holder's session link the operator removed is left out: the holder
 * no longer works the task. An orchestrator turn is addressed through the column config, so a link
 * removal does not end its hold.
 */
export async function quietTurns(trx: Trx) {
  const turns = await trx
    .selectFrom('turn')
    .selectAll()
    .where('closed_at', 'is', null)
    .where('acked_at', 'is not', null)
    .where('role', '!=', 'operator')
    .orderBy('id')
    .execute();
  const unlinked = await unlinkedSessions(trx);
  const quiet = [];
  for (const turn of turns) {
    if (turn.acked_by === null || turn.acked_at === null) continue;
    const holder = parseActorId(turn.acked_by);
    if (holder?.actor !== 'agent') continue;
    const sessionId = holder.actorRef.session;
    if (workerUnlinked(unlinked, turn, sessionId)) continue;
    const session = await trx
      .selectFrom('session_snapshot')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    const idle = session === undefined ? null : idleSince(session);
    const blocks = await trx
      .selectFrom('block')
      .select(['state', 'unblocked_at'])
      .where('task_id', '=', turn.task_id)
      .where('author', '=', turn.acked_by)
      .execute();
    const asking = blocks.some((block) => block.state === 'open');
    const unblocked = blocks.flatMap((block) =>
      block.unblocked_at === null ? [] : [block.unblocked_at],
    );
    const row = await trx
      .selectFrom('notification')
      .selectAll()
      .where('source_key', '=', turnReminderKey(turn.id, sessionId, turn.acked_at))
      .executeTakeFirst();
    const cancelled = row === undefined ? null : await cancelledRingState(trx, row);
    quiet.push({
      turn,
      sessionId,
      ended: session !== undefined && session.ended_at !== null,
      quietSince:
        idle === null || asking || turn.wait_until !== null
          ? null
          : latest([
              turn.acked_at,
              idle,
              ...unblocked,
              ...(turn.wait_ended_at === null ? [] : [turn.wait_ended_at]),
            ]),
      reminder: cancelled === 'unsent' ? undefined : row,
      delivered: row !== undefined && (row.rings >= 1 || cancelled === 'maybe_out'),
    });
  }
  return quiet;
}

/** Whether Spur is blind, so a holder's health is unknown. */
async function spurBlind(trx: Trx): Promise<boolean> {
  const spur = await trx
    .selectFrom('source_state')
    .select('blind_reason')
    .where('source', '=', 'spur')
    .executeTakeFirst();
  return spur !== undefined && spur.blind_reason !== null;
}

/**
 * Registers one reminder per take to the holder of each turn quiet for `stuckTurnAfterMs`;
 * `takeTurn` drops the unsent reminder of an earlier take. Nothing while Spur is blind, since the holder's health
 * is then unknown.
 */
export async function remindStuckTurns(trx: Trx, config: Config, at: Date): Promise<void> {
  if (await spurBlind(trx)) return;
  for (const { turn, sessionId, ended, quietSince, reminder } of await quietTurns(trx)) {
    if (ended || quietSince === null || reminder !== undefined) continue;
    const threshold = stuckTurnAfterMs(config, await taskProject(trx, turn.task_id), turn);
    if (at.getTime() < Date.parse(quietSince) + threshold) continue;
    await registerTurnReminder(trx, turn, sessionId, at);
  }
}

/**
 * Whether a queued ring may go out at `at`. A turn reminder goes out only under the rule
 * `remindStuckTurns` registers it by: its holder's current take is quiet for `stuckTurnAfterMs`.
 * Otherwise the sender defers it, so a question opened after it was queued holds it until the
 * question closes and a fresh quiet period passes, and blind Spur holds it until Spur reports again.
 * A wait's wake ring is due unless Spur is blind. Every other ring is due.
 */
export async function ringDue(
  trx: Trx,
  notificationId: number,
  config: Config,
  at: Date,
): Promise<boolean> {
  const n = await trx
    .selectFrom('notification')
    .select(['kind', 'source_key'])
    .where('id', '=', notificationId)
    .executeTakeFirst();
  if (n?.kind !== 'turn_reminder') return true;
  if (await spurBlind(trx)) return false;
  if (isTurnWakeKey(n.source_key)) return true;
  const quiet = (await quietTurns(trx)).find((entry) => entry.reminder?.id === notificationId);
  if (quiet === undefined || quiet.ended || quiet.quietSince === null) return false;
  const project = await taskProject(trx, quiet.turn.task_id);
  return (
    at.getTime() >= Date.parse(quiet.quietSince) + stuckTurnAfterMs(config, project, quiet.turn)
  );
}
