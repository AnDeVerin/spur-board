import {
  parseActorId,
  type ActorId,
  type Config,
  type TurnWaitOutcome,
} from '@spur-board/contracts';
import type { Selectable } from 'kysely';
import type { ItemCandidate } from '../domain/fromYou.ts';
import type { Row, TaskTable } from '../store/schema.ts';
import { emit, type Trx } from './board-utils.ts';
import { registerTurnReminder, turnWakeKey } from './doorbells.ts';

// The holder's wait on a taken turn (`task.wait`): how it ends, the tick that wakes it, the
// holders it keeps `worker_idle` off for, the operator item past the limits and its view. A wait
// is active exactly while `wait_until` is set; its end keeps `wait_reason` for the wake ring.

type Turn = Row<'turn'>;
type WaitingTurn = Pick<
  Turn,
  'id' | 'task_id' | 'wait_since' | 'wait_until' | 'wait_count' | 'waited_ms'
>;

const turnRef = (turnId: number) => `T${String(turnId)}`;

/**
 * Ends the active wait of `turn` as `outcome` at `at`: the time it lasted, up to its wake, joins
 * the turn's total. Nothing for a turn that is not waiting. Returns the new total.
 */
export async function endTurnWait(
  trx: Trx,
  input: {
    turn: WaitingTurn;
    project: string;
    outcome: TurnWaitOutcome;
    at: Date;
    actor?: ActorId | undefined;
  },
): Promise<number> {
  const { turn, project, outcome, at, actor } = input;
  if (turn.wait_until === null || turn.wait_since === null) return turn.waited_ms;
  const end = Math.min(at.getTime(), Date.parse(turn.wait_until));
  const waitedMs = turn.waited_ms + Math.max(0, end - Date.parse(turn.wait_since));
  await trx
    .updateTable('turn')
    .set({ wait_until: null, wait_ended_at: at.toISOString(), waited_ms: waitedMs })
    .where('id', '=', turn.id)
    .execute();
  const payload = { turn: turnRef(turn.id), outcome, waitedMs, waits: turn.wait_count };
  await emit(trx, 'turn_wait_ended', project, turn.task_id, at.toISOString(), payload, actor);
  return waitedMs;
}

/** Ends the wait of every unclosed turn of a task, before a close. */
export async function endTaskTurnWaits(
  trx: Trx,
  input: { taskId: number; outcome: TurnWaitOutcome; at: Date; actor?: ActorId | undefined },
): Promise<void> {
  const waiting = await trx
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .selectAll('turn')
    .select('task.project')
    .where('turn.task_id', '=', input.taskId)
    .where('turn.closed_at', 'is', null)
    .where('turn.wait_until', 'is not', null)
    .execute();
  for (const turn of waiting) await endTurnWait(trx, { ...input, turn, project: turn.project });
}

/** Whether the turn's waits reached the count or the total time limit. */
export function waitsUsed(config: Config, turn: Pick<Turn, 'wait_count' | 'waited_ms'>): boolean {
  const { maxWaits, maxTotalMs } = config.health.turnWait;
  return turn.wait_count >= maxWaits || turn.waited_ms >= maxTotalMs;
}

/** The holder session of a turn an agent took, or null. */
function holderSession(turn: Pick<Turn, 'acked_by'>): string | null {
  const holder = turn.acked_by === null ? null : parseActorId(turn.acked_by);
  return holder?.actor === 'agent' ? holder.actorRef.session : null;
}

/** Whether the snapshot of `session` says it ended; false without a snapshot. */
async function sessionEnded(trx: Trx, session: string): Promise<boolean> {
  const snapshot = await trx
    .selectFrom('session_snapshot')
    .select('ended_at')
    .where('id', '=', session)
    .executeTakeFirst();
  return snapshot?.ended_at != null;
}

/**
 * Whether the holder `session` of a worker turn has lost the task: `unlinked` holds the
 * `taskId:sessionId` pairs whose session link the operator removed. An orchestrator turn is
 * addressed through the column config, so a link removal does not end its hold.
 */
export function workerUnlinked(
  unlinked: ReadonlySet<string>,
  turn: Pick<Turn, 'role' | 'task_id'>,
  session: string,
): boolean {
  return turn.role === 'worker' && unlinked.has(`${String(turn.task_id)}:${session}`);
}

/** The `taskId:sessionId` pairs whose session link the operator removed. */
export async function unlinkedSessions(trx: Trx): Promise<Set<string>> {
  const removed = await trx
    .selectFrom('link')
    .select(['task_id', 'session_id'])
    .where('entity', '=', 'session')
    .where('banned', '=', 1)
    .execute();
  return new Set(removed.map((link) => `${String(link.task_id)}:${link.session_id ?? ''}`));
}

/**
 * The tick's wait ends. A wait whose agent holder's session ended ends `closed` with no ring.
 * Otherwise, once its wake time passes, it ends `limit` when the turn's waits reached a limit,
 * else `woken`, and an agent holder gets one wake ring, unless it holds a worker turn whose session
 * link the operator removed.
 */
export async function wakeWaitingTurns(trx: Trx, config: Config, at: Date): Promise<void> {
  const waiting = await trx
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .selectAll('turn')
    .select('task.project')
    .where('turn.closed_at', 'is', null)
    .where('turn.wait_until', 'is not', null)
    .orderBy('turn.id')
    .execute();
  const unlinked = waiting.length === 0 ? new Set<string>() : await unlinkedSessions(trx);
  for (const turn of waiting) {
    const session = holderSession(turn);
    if (session !== null && (await sessionEnded(trx, session))) {
      await endTurnWait(trx, { turn, project: turn.project, outcome: 'closed', at });
      continue;
    }
    if (turn.wait_until === null || turn.wait_since === null) continue;
    if (at.getTime() < Date.parse(turn.wait_until)) continue;
    const lasted = Date.parse(turn.wait_until) - Date.parse(turn.wait_since);
    const used = waitsUsed(config, { ...turn, waited_ms: turn.waited_ms + lasted });
    const outcome = used ? 'limit' : 'woken';
    await endTurnWait(trx, { turn, project: turn.project, outcome, at });
    if (session !== null && !workerUnlinked(unlinked, turn, session))
      await registerTurnReminder(
        trx,
        turn,
        session,
        at,
        turnWakeKey(turn.id, session, turn.wait_since),
      );
  }
}

/**
 * The `taskId:sessionId` pairs whose `worker_idle` stays off: the agent holder of an unclosed turn
 * while it waits, and for `health.idleInDevAfterMs` after a wait that ran out (`woken` or
 * `limit`). Only those ends come after the take with the holder still live: a take ends the wait
 * at its own time, and submit or close leave no unclosed turn. A holder whose session ended gets
 * none.
 */
export async function restingHolders(trx: Trx, config: Config, now: number): Promise<Set<string>> {
  const turns = await trx
    .selectFrom('turn')
    .select(['task_id', 'acked_by', 'acked_at', 'wait_until', 'wait_ended_at'])
    .where('closed_at', 'is', null)
    .where('acked_at', 'is not', null)
    .execute();
  const resting = new Set<string>();
  for (const turn of turns) {
    const session = holderSession(turn);
    if (session === null || turn.acked_at === null || (await sessionEnded(trx, session))) continue;
    const ended = turn.wait_ended_at === null ? null : Date.parse(turn.wait_ended_at);
    const grace =
      ended !== null &&
      ended > Date.parse(turn.acked_at) &&
      now < ended + config.health.idleInDevAfterMs;
    if (turn.wait_until !== null || grace) resting.add(`${String(turn.task_id)}:${session}`);
  }
  return resting;
}

/** Whole minutes and hours: `45m`, `2h`, `1h 30m`. */
function waitDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)}m`;
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}

/**
 * One operator item per unclosed turn of a live task whose waits reached a limit and that is not
 * waiting now: the holder keeps the turn, and the operator decides what happens next.
 */
export async function turnWaitItems(
  trx: Trx,
  config: Config,
  taskById: ReadonlyMap<number, Selectable<TaskTable>>,
): Promise<ItemCandidate[]> {
  const turns = await trx
    .selectFrom('turn')
    .selectAll()
    .where('closed_at', 'is', null)
    .where('wait_until', 'is', null)
    .where('wait_count', '>', 0)
    .orderBy('id')
    .execute();
  return turns.flatMap((turn) => {
    const task = taskById.get(turn.task_id);
    if (task === undefined || !waitsUsed(config, turn)) return [];
    return [
      {
        key: `turn-wait:${String(turn.id)}`,
        kind: 'board_observation' as const,
        taskId: task.id,
        summary: `${task.key}: turn ${turnRef(turn.id)} has waited ${waitDuration(turn.waited_ms)} for ${(turn.wait_reason ?? '').replace(/\s+/g, ' ').trim()}`,
        factAt: turn.wait_ended_at,
        source: null,
        priority: 4,
      },
    ];
  });
}

/** The active wait a turn view shows; nothing while the turn is not waiting. */
export function turnWaitView(turn: Pick<Turn, 'wait_reason' | 'wait_since' | 'wait_until'>) {
  if (turn.wait_until === null || turn.wait_since === null || turn.wait_reason === null) return {};
  return { wait: { reason: turn.wait_reason, since: turn.wait_since, wakesAt: turn.wait_until } };
}
