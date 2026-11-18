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
import { sql } from 'kysely';
import { z } from 'zod';
import { parseAddressee } from '../domain/blocks/blocks.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import { isOperator } from './authorize.ts';
import { emit, parsePr, taskPr, taskUrl, type Trx } from './board-utils.ts';
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
import { adoptDevRepair, importLegacyDevRepair } from './dev-repair.ts';

// A turn hands a task's column visit `(column, column_epoch)` to the column's executor. Every
// function takes `at` from the caller, so it is safe inside a scan transaction.

type Turn = Row<'turn'>;
type Handed = z.output<typeof turnHandedSchema>;
type CloseReason = NonNullable<Turn['closed_reason']>;

const handedSchema = z.array(turnHandedSchema);

const turnItemKey = (turnId: number) => `turn:${String(turnId)}`;
const turnRef = (turnId: number) => `T${String(turnId)}`;
const taskProject = async (trx: Trx, id: number) =>
  (await trx.selectFrom('task').select('project').where('id', '=', id).executeTakeFirstOrThrow())
    .project;

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
  input: {
    task: Row<'task'>;
    reason: string;
    handed: readonly Handed[];
    at: Date;
    config: Config;
    /** The actor whose operation opens the turn; absent for tick and observation. */
    opener?: ActorId | undefined;
  },
): Promise<Turn> {
  const { task, reason, handed, at, config, opener } = input;
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
  await emit(trx, 'turn_opened', task.project, task.id, turn.created_at, {
    turn: turnRef(turn.id),
    column: turn.column,
    addressee: turn.role,
    reason: turn.reason,
  });
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
    await registerTurnNotification(trx, turn, at, { config, opener });
  }
  return turn;
}

/**
 * Takes a turn for `actor`. False for a missing, closed, operator or taken worker turn. An
 * untaken turn needs its unread notification addressed to the actor; a taken orchestrator turn
 * may be taken over by whoever its notification is now addressed to. An operator on the task's
 * project may take any open orchestrator turn, taken or not. Others get `forbidden`.
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
  const project = await taskProject(trx, turn.task_id);
  const orchestrated = parseAddressee(turn.role).kind === 'orchestrator';
  const takeover = orchestrated && isOperator(actor, config, project);
  if (turn.acked_at === null) {
    if (!(await acknowledgeNotification(trx, { ...input, takeover }))) return false;
  } else if (!orchestrated) {
    return false;
  } else if (!takeover) {
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
  await emit(
    trx,
    'turn_taken',
    project,
    turn.task_id,
    at.toISOString(),
    { turn: turnRef(turnId), taker: actor },
    actor,
  );
  return true;
}

/**
 * Closes every unclosed turn of a task: its rings stop and its items end as "condition ended".
 * A ring already queued is dropped by the sender (`ringStillCurrent`). `turn_closed` names
 * `actor` when given, else `system`.
 */
export async function closeTurns(
  trx: Trx,
  input: { taskId: number; reason: CloseReason; at: Date; actor?: ActorId | undefined },
): Promise<void> {
  const { taskId, reason, at, actor } = input;
  const closed = await trx
    .updateTable('turn')
    .set({ closed_at: at.toISOString(), closed_reason: reason })
    .where('task_id', '=', taskId)
    .where('closed_at', 'is', null)
    .returning('id')
    .execute();
  if (closed.length === 0) return;
  const project = await taskProject(trx, taskId);
  for (const { id } of closed) {
    const closedPayload = { turn: turnRef(id), outcome: reason };
    await emit(trx, 'turn_closed', project, taskId, at.toISOString(), closedPayload, actor);
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

/** Reroutes a worker turn whose holder or unread recipient was demoted from worker. */
export async function rerouteDemotedWorkerTurn(
  trx: Trx,
  input: { taskId: number; sessionId: string; at: Date; config: Config },
): Promise<boolean> {
  const { taskId, sessionId, at, config } = input;
  const turn = await trx
    .selectFrom('turn')
    .selectAll()
    .where('task_id', '=', taskId)
    .where('role', '=', 'worker')
    .where('closed_at', 'is', null)
    .executeTakeFirst();
  if (turn === undefined) return false;
  if (turn.acked_by !== null) {
    const holder = parseActorId(turn.acked_by);
    if (holder?.actor !== 'agent' || holder.actorRef.session !== sessionId) return false;
  } else {
    const notice = await turnNotification(trx, turn.id);
    if (notice !== undefined && notice.recipient_session !== null) {
      if (notice.recipient_session !== sessionId) return false;
    } else if ((await linkedSession(trx, taskId, 'worker')) !== undefined) {
      // An unrung turn can already be taken by the remaining worker.
      return false;
    }
  }
  const task = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  await closeTurns(trx, { taskId, reason: 'rerouted', at });
  const handed = await carriedFeedback(trx, turn);
  const repair = { task, at: at.toISOString() };
  await importLegacyDevRepair(trx, repair, turn);
  const opened = await openTurn(trx, { task, reason: turn.reason, handed, at, config });
  if (task.column === 'dev') await adoptDevRepair(trx, repair, opened.id, turn.id);
  return true;
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
  const rows = await prTurns(db, prs);
  const cursors = [];
  for (const ref of prs) {
    let best: Handed | undefined;
    for (const row of rows) {
      if (count === 'handled' && isRecalled(row)) continue;
      for (const entry of handedOn(row, ref)) {
        if (best === undefined || isNewer(entry, best)) best = entry;
      }
    }
    if (best !== undefined) cursors.push({ ref, id: best.id, postedAt: best.postedAt });
  }
  return cursors;
}

/**
 * The feedback on `ref` that the turns `turnFeedbackCursors` leaves out of `handled` handed over,
 * oldest first and once each, as the copy with the newest edit. A later poll may have dropped
 * these entries from the PR snapshot, and the poll cursor, which still counts those turns, never
 * pages back to them.
 */
export async function recalledFeedback(db: Trx, ref: PrEntityRef): Promise<Handed[]> {
  const entries: Handed[] = [];
  for (const row of await prTurns(db, [ref])) {
    if (!isRecalled(row)) continue;
    for (const entry of handedOn(row, ref)) {
      const index = entries.findIndex((old) => sameHanded(old, entry));
      if (index === -1) entries.push(entry);
      else if (isNewerEdit(entry, entries[index] as Handed)) entries[index] = entry;
    }
  }
  return (await withoutStatusComments(db, entries)).sort((left, right) =>
    isNewer(left, right) ? 1 : -1,
  );
}

/** The feedback `turn` handed over, for the turn a reroute opens in its place. */
export async function carriedFeedback(db: Trx, turn: Pick<Turn, 'handed'>): Promise<Handed[]> {
  return withoutStatusComments(db, turnHanded(turn));
}

/**
 * `entries` without those their PR's snapshot flags as a reviewer service's status comment
 * (`statusComment`): a turn may have handed one over before the flag existed. Every path that
 * hands earlier handed feedback over again reads it through here (`recalledFeedback`,
 * `carriedFeedback`). An entry whose snapshot is missing or unreadable stays.
 */
export async function withoutStatusComments(db: Trx, entries: readonly Handed[]) {
  const flagged: Handed[] = [];
  const read = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.repo.toLowerCase()}#${String(entry.number)}`;
    if (read.has(key)) continue;
    read.add(key);
    const snapshot = await db
      .selectFrom('pr_snapshot')
      .select('detail')
      .where(sql<boolean>`lower(repo) = ${entry.repo.toLowerCase()}`)
      .where('number', '=', entry.number)
      .executeTakeFirst();
    for (const fact of parsePr(snapshot?.detail)?.feedback ?? []) {
      if (fact.statusComment === true)
        flagged.push({ ...entry, kind: fact.kind, id: fact.id, postedAt: fact.postedAt });
    }
  }
  return entries.filter((entry) => !flagged.some((old) => sameHanded(old, entry)));
}

/** Whether `left` carries a newer edit than `right`. */
export function isNewerEdit(left: Pick<Handed, 'editedAt'>, right: Pick<Handed, 'editedAt'>) {
  if (left.editedAt === undefined) return false;
  return right.editedAt === undefined || Date.parse(left.editedAt) > Date.parse(right.editedAt);
}

/**
 * The edit baseline of feedback on `ref`: an entry edited after it counts as unhandled again.
 * Over the turns `turnFeedbackCursors` counts as `handled`, each copy of the entry gives its
 * `editedAt`; else, with a `url`, no bound (this version handed it unedited, so any edit counts);
 * else its turn's `created_at` (handed before entries had either). The newest copy wins. An entry
 * no turn handed gets the earliest `created_at` of the turns that handed a newer entry, or none.
 */
export async function editBaselines(db: Trx, ref: PrEntityRef): Promise<(entry: Handed) => number> {
  const turns = (await prTurns(db, [ref]))
    .filter((row) => !isRecalled(row))
    .map((row) => ({ at: Date.parse(row.created_at), entries: handedOn(row, ref) }));
  return (entry) => {
    let base: number | undefined;
    for (const { at, entries } of turns) {
      for (const copy of entries) {
        if (!sameHanded(copy, entry)) continue;
        const own =
          copy.editedAt !== undefined
            ? Date.parse(copy.editedAt)
            : copy.url !== undefined
              ? -Infinity
              : at;
        base = base === undefined ? own : Math.max(base, own);
      }
    }
    if (base !== undefined) return base;
    const newer = turns.filter(({ entries }) => entries.some((copy) => isNewer(copy, entry)));
    return Math.min(Infinity, ...newer.map(({ at }) => at));
  };
}

/** Whether two handed entries are the same feedback on the same PR. */
export function sameHanded(left: Handed, right: Handed): boolean {
  return (
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number &&
    left.kind === right.kind &&
    left.id === right.id
  );
}

type PrTurn = Awaited<ReturnType<typeof prTurns>>[number];

/** The turns of the tasks linked to `prs`, with the link they were found by. */
function prTurns(db: Trx, prs: readonly PrEntityRef[]) {
  return db
    .selectFrom('turn')
    .innerJoin('link', 'link.task_id', 'turn.task_id')
    .select([
      'link.repo',
      'link.number',
      'turn.handed',
      'turn.acked_at',
      'turn.closed_reason',
      'turn.created_at',
    ])
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .where(
      sql<string>`lower(link.repo)`,
      'in',
      prs.map((pr) => pr.repo.toLowerCase()),
    )
    .execute();
}

/** Whether a correction or a reroute closed the turn before anyone took it. */
function isRecalled(row: PrTurn): boolean {
  return row.acked_at === null && recalled.has(row.closed_reason);
}

/** The entries on `ref` that the turn handed over, when it was found through `ref`'s link. */
function handedOn(row: PrTurn, ref: PrEntityRef): Handed[] {
  const repo = ref.repo.toLowerCase();
  if (row.repo?.toLowerCase() !== repo || row.number !== ref.number) return [];
  return turnHanded(row).filter(
    (entry) => entry.repo.toLowerCase() === repo && entry.number === ref.number,
  );
}
