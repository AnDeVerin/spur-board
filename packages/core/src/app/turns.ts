import {
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
import { taskUrl } from './board-utils.ts';
import { CommandError } from './commands.ts';
import {
  acknowledgeNotification,
  closeTurnNotification,
  linkedSession,
  notificationAddressedTo,
  registerTurnNotification,
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
  return true;
}

/**
 * Closes every unclosed turn of a task: its rings stop and its items end as "condition ended".
 * A ring already queued is dropped by the sender (`ringStillCurrent`).
 */
export async function closeTurns(
  trx: Trx,
  input: { taskId: number; reason: 'moved' | 'archived'; at: Date },
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

/** Whether `left` is newer than `right` by `postedAt` instant, then by id. Compared, not subtracted. */
function isNewer(left: Handed, right: Handed): boolean {
  const a = Date.parse(left.postedAt);
  const b = Date.parse(right.postedAt);
  return a !== b ? a > b : left.id > right.id;
}

/**
 * Per requested PR, the newest feedback any turn of its linked tasks handed over, acked or not,
 * closed or not, so the cursor never moves back. A PR with none gets no entry.
 */
export async function turnFeedbackCursors(
  db: Trx,
  prs: readonly PrEntityRef[],
): Promise<{ ref: PrEntityRef; id: string; postedAt: string }[]> {
  if (prs.length === 0) return [];
  const rows = await db
    .selectFrom('turn')
    .innerJoin('link', 'link.task_id', 'turn.task_id')
    .select(['link.repo', 'link.number', 'turn.handed'])
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
      for (const entry of turnHanded(row)) {
        if (entry.repo.toLowerCase() !== repo || entry.number !== ref.number) continue;
        if (best === undefined || isNewer(entry, best)) best = entry;
      }
    }
    if (best !== undefined) cursors.push({ ref, id: best.id, postedAt: best.postedAt });
  }
  return cursors;
}
