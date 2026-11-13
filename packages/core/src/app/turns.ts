import {
  parseActorId,
  sessionFactsSchema,
  turnHandedSchema,
  type ActorId,
  type AddresseeRole,
  type ColumnId,
  type Config,
  type PrEntityRef,
} from '@spur-board/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { parseAddressee } from '../domain/blocks/blocks.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Row, Tables } from '../store/schema.ts';
import { taskPr, taskUrl } from './board-utils.ts';
import { CommandError } from './commands.ts';
import {
  acknowledgeNotification,
  cancelledRingState,
  closeTurnNotification,
  linkedSession,
  notificationAddressedTo,
  registerTurnNotification,
  registerTurnReminder,
  turnReminderKey,
} from './doorbells.ts';
import { clearItem, raiseItem } from './feed.ts';

// A turn hands a task's column visit `(column, column_epoch)` to the column's executor. Every
// function takes `at` from the caller, so it is safe inside a scan transaction.

type Trx = Kysely<Tables>;
type Turn = Row<'turn'>;
type Handed = z.output<typeof turnHandedSchema>;

const handedSchema = z.array(turnHandedSchema);

const turnItemKey = (turnId: number) => `turn:${String(turnId)}`;

/**
 * Who executes a column's turn: its orchestrator project, the operator, or for a column with
 * no orchestrator the live worker, else the operator.
 */
export function turnExecutor(
  column: ColumnId,
  columnOrchestrator: string,
  hasLiveWorker: boolean,
): AddresseeRole {
  if (columnOrchestrator === 'operator') return 'operator';
  if (columnOrchestrator === 'none') return hasLiveWorker ? 'worker' : 'operator';
  return `orchestrator:${column}`;
}

/** A turn is open while its executor has taken it and it is not closed. */
export function isTurnOpen(turn: Pick<Turn, 'acked_at' | 'closed_at'>): boolean {
  return turn.acked_at !== null && turn.closed_at === null;
}

/** The feedback a stored turn handed over. */
export function turnHanded(turn: Pick<Turn, 'handed'>): Handed[] {
  return parseJson(handedSchema, turn.handed);
}

/** The newest notification of a turn; an operator turn has none. */
export async function turnNotification(trx: Trx, turnId: number) {
  return trx
    .selectFrom('notification')
    .selectAll()
    .where('turn_id', '=', turnId)
    .where('kind', '=', 'turn')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

/**
 * Opens a turn for the executor of the task's current column. The unclosed turn of the same
 * visit is returned unchanged; an unclosed turn of an earlier visit is closed as moved first.
 * An agent executor gets a ringing notification, the operator one `turn` item.
 */
export async function openTurn(
  trx: Trx,
  input: { task: Row<'task'>; reason: string; handed: readonly Handed[]; at: Date; config: Config },
): Promise<Turn> {
  const { task, reason, handed, at, config } = input;
  const unclosed = await trx
    .selectFrom('turn')
    .selectAll()
    .where('task_id', '=', task.id)
    .where('closed_at', 'is', null)
    .executeTakeFirst();
  if (unclosed?.column === task.column && unclosed.epoch === task.column_epoch) return unclosed;
  if (unclosed !== undefined) await closeTurns(trx, { taskId: task.id, reason: 'moved', at });
  const orchestrator =
    config.projects
      .find((project) => project.id === task.project)
      ?.columns.find((column) => column.id === task.column)?.orchestrator ?? 'none';
  const hasLiveWorker =
    orchestrator === 'none' && (await linkedSession(trx, task.id, 'worker')) !== undefined;
  const role = turnExecutor(task.column, orchestrator, hasLiveWorker);
  const pr = await taskPr(trx, task.id);
  const snapshot =
    pr === null
      ? undefined
      : await trx
          .selectFrom('pr_snapshot')
          .select('head_sha')
          .where(sql<boolean>`lower(repo) = ${pr.repo.toLowerCase()}`)
          .where('number', '=', pr.number)
          .executeTakeFirst();
  const last = await trx
    .selectFrom('turn')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('task_id', '=', task.id)
    .where('column', '=', task.column)
    .where('epoch', '=', task.column_epoch)
    .executeTakeFirst();
  const turn = await trx
    .insertInto('turn')
    .values({
      task_id: task.id,
      column: task.column,
      epoch: task.column_epoch,
      seq: (last?.seq ?? 0) + 1,
      role,
      reason,
      handed: toJson(handedSchema, [...handed]),
      acked_by: null,
      acked_at: null,
      closed_at: null,
      closed_reason: null,
      created_at: at.toISOString(),
      head_sha: snapshot?.head_sha.toLowerCase() ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (role === 'operator') {
    await raiseItem(trx, {
      itemKey: turnItemKey(turn.id),
      kind: 'turn',
      text: `turn T${String(turn.id)} on ${task.key}: ${reason}`,
      url: taskUrl(task, config),
      taskId: task.id,
      blockId: null,
      at,
    });
  } else {
    await registerTurnNotification(trx, turn, at);
  }
  return turn;
}

/**
 * Takes a turn for `actor`. False for a missing, closed, operator or taken worker turn. An
 * untaken turn needs its unread notification addressed to the actor; a taken orchestrator turn
 * may be taken over by whoever its notification is now addressed to. Others get `forbidden`.
 * Every take starts a new ownership episode: an unsent reminder of an earlier one is acked, so
 * `ringStillCurrent` drops its ring.
 */
export async function takeTurn(
  trx: Trx,
  input: { turnId: number; actor: ActorId; at: Date; config: Config },
): Promise<boolean> {
  const { turnId, actor, at, config } = input;
  const turn = await trx.selectFrom('turn').selectAll().where('id', '=', turnId).executeTakeFirst();
  if (turn === undefined || turn.closed_at !== null || turn.role === 'operator') return false;
  if (turn.acked_at === null) {
    if (!(await acknowledgeNotification(trx, { turnId, actor, at, config }))) return false;
  } else {
    if (parseAddressee(turn.role).kind !== 'orchestrator') return false;
    const notice = await turnNotification(trx, turnId);
    if (notice === undefined || !(await notificationAddressedTo(trx, notice, actor, config))) {
      throw new CommandError('forbidden', 'Only the addressed task role can take this turn.');
    }
  }
  await trx
    .updateTable('turn')
    .set({ acked_by: actor, acked_at: at.toISOString() })
    .where('id', '=', turnId)
    .execute();
  await trx
    .updateTable('notification')
    .set({ acked_at: at.toISOString() })
    .where('turn_id', '=', turnId)
    .where('kind', '=', 'turn_reminder')
    .where('acked_at', 'is', null)
    .where('exhausted_at', 'is', null)
    .execute();
  return true;
}

/**
 * Closes every unclosed turn of a task: its rings stop and its items end as "condition ended".
 * A ring already queued is dropped by the sender (`ringStillCurrent`).
 */
export async function closeTurns(
  trx: Trx,
  input: { taskId: number; reason: NonNullable<Turn['closed_reason']>; at: Date },
): Promise<void> {
  const { taskId, reason, at } = input;
  const closed = await trx
    .updateTable('turn')
    .set({ closed_at: at.toISOString(), closed_reason: reason })
    .where('task_id', '=', taskId)
    .where('closed_at', 'is', null)
    .returning('id')
    .execute();
  for (const { id } of closed) {
    await closeTurnNotification(trx, id, at);
    const item = await trx
      .selectFrom('operator_item')
      .select('id')
      .where('item_key', '=', turnItemKey(id))
      .where('cleared_at', 'is', null)
      .executeTakeFirst();
    if (item !== undefined) await clearItem(trx, item.id, at);
  }
}

/** How long the holder of a taken turn may sit quiet before it is reminded, then flagged. */
export function stuckTurnAfterMs(config: Config): number {
  return config.health.idleInDevAfterMs;
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
 * spell, or the close of its last question on the task. Null while the holder works, has an open
 * question on the task, or has no readable snapshot. A worker turn whose holder's session link
 * the operator removed is left out: the holder no longer works the task. An orchestrator turn is
 * addressed through the column config, so a link removal does not end its hold.
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
  const removed = await trx
    .selectFrom('link')
    .select(['task_id', 'session_id'])
    .where('entity', '=', 'session')
    .where('banned', '=', 1)
    .execute();
  const unlinked = new Set(
    removed.map((link) => `${String(link.task_id)}:${link.session_id ?? ''}`),
  );
  const quiet = [];
  for (const turn of turns) {
    if (turn.acked_by === null || turn.acked_at === null) continue;
    const holder = parseActorId(turn.acked_by);
    if (holder?.actor !== 'agent') continue;
    const sessionId = holder.actorRef.session;
    if (turn.role === 'worker' && unlinked.has(`${String(turn.task_id)}:${sessionId}`)) continue;
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
      quietSince: idle === null || asking ? null : latest([turn.acked_at, idle, ...unblocked]),
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
    if (at.getTime() < Date.parse(quietSince) + stuckTurnAfterMs(config)) continue;
    await registerTurnReminder(trx, turn, sessionId, at);
  }
}

/**
 * Whether a queued ring may go out at `at`. A turn reminder goes out only under the rule
 * `remindStuckTurns` registers it by: its holder's current take is quiet for `stuckTurnAfterMs`.
 * Otherwise the sender defers it, so a question opened after it was queued holds it until the
 * question closes and a fresh quiet period passes, and blind Spur holds it until Spur reports again.
 * Every other ring is due.
 */
export async function ringDue(
  trx: Trx,
  notificationId: number,
  config: Config,
  at: Date,
): Promise<boolean> {
  const n = await trx
    .selectFrom('notification')
    .select('kind')
    .where('id', '=', notificationId)
    .executeTakeFirst();
  if (n?.kind !== 'turn_reminder') return true;
  if (await spurBlind(trx)) return false;
  const quiet = (await quietTurns(trx)).find((entry) => entry.reminder?.id === notificationId);
  return (
    quiet !== undefined &&
    !quiet.ended &&
    quiet.quietSince !== null &&
    at.getTime() >= Date.parse(quiet.quietSince) + stuckTurnAfterMs(config)
  );
}

/** Close reasons of a turn whose untaken feedback goes back to a later turn. */
const recalled = new Set<Turn['closed_reason']>(['corrected', 'rerouted']);

/** Whether `left` is newer than `right` by `postedAt` instant, then by id. Compared, not subtracted. */
export function isNewer(
  left: Pick<Handed, 'postedAt' | 'id'>,
  right: Pick<Handed, 'postedAt' | 'id'>,
): boolean {
  const a = Date.parse(left.postedAt);
  const b = Date.parse(right.postedAt);
  return a !== b ? a > b : left.id > right.id;
}

/**
 * Per requested PR, the newest feedback a turn of its linked tasks handed over, acked or not,
 * closed or not. A PR with none gets no entry. `handled` leaves out a turn a correction or a
 * reroute closed before anyone took it: no executor received its feedback, so after a correction
 * it counts as unhandled again and the next Dev turn hands it over, and a reroute's replacement
 * turn handed it over too. `polled` counts every turn, so the poll cursor never moves back.
 */
export async function turnFeedbackCursors(
  db: Trx,
  prs: readonly PrEntityRef[],
  count: 'handled' | 'polled',
): Promise<{ ref: PrEntityRef; id: string; postedAt: string }[]> {
  if (prs.length === 0) return [];
  const rows = await db
    .selectFrom('turn')
    .innerJoin('link', 'link.task_id', 'turn.task_id')
    .select(['link.repo', 'link.number', 'turn.handed', 'turn.acked_at', 'turn.closed_reason'])
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .where(
      sql<string>`lower(link.repo)`,
      'in',
      prs.map((pr) => pr.repo.toLowerCase()),
    )
    .execute();
  const cursors = [];
  for (const ref of prs) {
    const repo = ref.repo.toLowerCase();
    let best: Handed | undefined;
    for (const row of rows) {
      if (row.repo?.toLowerCase() !== repo || row.number !== ref.number) continue;
      if (count === 'handled' && row.acked_at === null && recalled.has(row.closed_reason)) continue;
      for (const entry of turnHanded(row)) {
        if (entry.repo.toLowerCase() !== repo || entry.number !== ref.number) continue;
        if (best === undefined || isNewer(entry, best)) best = entry;
      }
    }
    if (best !== undefined) cursors.push({ ref, id: best.id, postedAt: best.postedAt });
  }
  return cursors;
}
