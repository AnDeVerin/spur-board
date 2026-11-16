import {
  assertNever,
  parseActorId,
  ringMarker,
  sessionFactsSchema,
  type ActorId,
  type AddresseeRole,
  type Config,
  type EventPayload,
  type SessionFacts,
} from '@spur-board/contracts';
import { sql, type ExpressionBuilder } from 'kysely';
import { parseAddressee } from '../domain/blocks/blocks.ts';
import type { Row, Tables } from '../store/schema.ts';
import { curatorProject } from './authorize.ts';
import { queueBlockOpen } from './block-thread.ts';
import { emit, taskUrl, type Trx } from './board-utils.ts';
import { CommandError, type CommandContext } from './commands.ts';
import { clearItem, raiseItem } from './feed.ts';
import { TASKLESS_ITEM_URL } from './item-raise.ts';
import { enqueueDoorbell, promoteWorkerDoorbells } from './outbox.ts';
import { scanTransaction } from './secrets.ts';
import { rowSubject, taskSubject, type BlockSubject } from './subject.ts';
import type { Store } from '../store/store.ts';

type Notification = Row<'notification'>;
type Block = Row<'block'>;
type Task = Row<'task'>;
type Session = Row<'session_snapshot'>;

/** What happened to a block or comment, as far as doorbells care. */
type DoorbellEvent =
  | { kind: 'block_opened'; block: Block; authorRole: AddresseeRole }
  | { kind: 'block_escalated'; block: Block }
  | {
      kind: 'answer';
      block: Block;
      commentId: number;
      revision: number;
      authorRole: AddresseeRole;
      actor: ActorId;
    }
  | { kind: 'block_removed'; block: Block }
  | { kind: 'course_note'; block: Block; comment: Pick<Row<'comment'>, 'id' | 'revision'> }
  | { kind: 'block_closed_by_addressee' }
  | { kind: 'task_comment' };

const UNANSWERED = 'unanswered';

async function journal<K extends 'doorbell_rung' | 'doorbell_read' | 'doorbell_undelivered'>(
  trx: Trx,
  notification: Notification,
  kind: K,
  payload: EventPayload<K>,
  at: Date,
): Promise<void> {
  const project = await noticeProject(trx, notification);
  await emit(trx, kind, project, notification.task_id, at.toISOString(), payload);
}

/**
 * The one rule for who a board event rings. A doorbell means someone is waiting for your action,
 * so a party that caused the event, or that the Slack thread already reaches, gets no row.
 */
export async function applyDoorbellPolicy(trx: Trx, event: DoorbellEvent, at: Date): Promise<void> {
  switch (event.kind) {
    case 'block_opened': {
      // A block addressed to its own author's role waits on an outside party.
      const ownRole =
        parseActorId(event.block.author)?.actor === 'agent' &&
        event.block.addressee_role === event.authorRole;
      if (!ownRole) await registerBlockNotification(trx, event.block, at);
      return;
    }
    case 'block_escalated':
      await closeBlockNotification(trx, event.block.id, at, 'system');
      await registerBlockNotification(trx, event.block, at);
      return;
    case 'answer':
      await registerAnswerNotification(trx, event, at);
      return;
    case 'block_removed':
      await registerRemovedNotification(trx, event.block, at);
      return;
    case 'course_note':
      await registerCourseNoteNotification(trx, event, at);
      return;
    case 'block_closed_by_addressee':
    case 'task_comment':
      return;
    default:
      assertNever(event);
  }
}

/** Register a block for its agent addressee; the Slack thread carries an operator's. */
export async function registerBlockNotification(trx: Trx, block: Block, at: Date): Promise<void> {
  if (block.addressee_role === 'operator') return;
  await trx
    .insertInto('notification')
    .values({
      source_key: `block:${String(block.id)}:${block.addressee_role}`,
      kind: 'block',
      task_id: block.task_id,
      block_id: block.id,
      comment_id: null,
      revision: null,
      role: block.addressee_role,
      author_session: null,
      recipient_session: null,
      next_at: at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/**
 * Register an agent executor's turn. Core opens a turn, so no session authored it: the worker
 * or column orchestrator the board selects is rung. A turn opened by the operation of the
 * session it would ring first rings only after `doorbells.firstRetryMs`, so an ack in that time
 * sends nothing.
 */
export async function registerTurnNotification(
  trx: Trx,
  turn: Pick<Row<'turn'>, 'id' | 'task_id' | 'role'>,
  at: Date,
  opts: { config: Config; opener?: ActorId | undefined },
): Promise<void> {
  const nextAt = (await heldForOpener(trx, turn, opts))
    ? new Date(at.getTime() + opts.config.doorbells.firstRetryMs)
    : at;
  await trx
    .insertInto('notification')
    .values({
      source_key: `turn:${String(turn.id)}:${turn.role}`,
      kind: 'turn',
      task_id: turn.task_id,
      block_id: null,
      turn_id: turn.id,
      comment_id: null,
      revision: null,
      role: turn.role,
      author_session: null,
      recipient_session: null,
      next_at: nextAt.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/** Whether the opener is the agent session the turn would ring now. */
async function heldForOpener(
  trx: Trx,
  turn: Pick<Row<'turn'>, 'task_id' | 'role'>,
  opts: { config: Config; opener?: ActorId | undefined },
): Promise<boolean> {
  const opener = opts.opener === undefined ? undefined : parseActorId(opts.opener);
  if (opener?.actor !== 'agent') return false;
  const recipient = await selectNotificationRecipient(
    trx,
    { task_id: turn.task_id, role: turn.role, author_session: null, kind: 'turn', block_id: null },
    opts.config,
  );
  return recipient?.id === opener.actorRef.session;
}

/**
 * The key of the reminder to `session` about a turn it took at `takenAt`. The take time names the
 * ownership episode, so a session that loses the turn and takes it again gets a new reminder.
 */
export const turnReminderKey = (turnId: number, session: string, takenAt: string) =>
  `turn:${String(turnId)}:reminder:${session}:${takenAt}`;

const isTurnKind = (kind: Notification['kind']) => kind === 'turn' || kind === 'turn_reminder';

/**
 * Whether a reminder was cancelled before it was ever sent, as a link removal does: it counts as
 * no reminder for its take, so a restored link reminds the holder again. A ring of it still
 * queued or in flight, or one that may have reached Spur (`uncertain`), keeps it: the outcome is
 * not known yet or the reminder may be out, and one reminder per take wins over a missed one.
 * Only rings the sender killed unsent leave it re-armable.
 */
async function reminderCancelledUnsent(
  trx: Trx,
  n: Pick<Notification, 'id' | 'acked_at' | 'rings' | 'exhausted_at'>,
): Promise<boolean> {
  return (await cancelledRingState(trx, n)) === 'unsent';
}

/**
 * The rings of a reminder acked before any delivery was counted: `unsent` when the sender killed
 * them all unsent, `maybe_out` when all are dead and one may have reached Spur, and null while one
 * is queued or in flight, or for a reminder that was delivered, exhausted or never acked. A
 * `maybe_out` reminder counts as delivered for the stuck-turn rule, so the one-ring limit does not
 * hide a stuck turn.
 */
export async function cancelledRingState(
  trx: Trx,
  n: Pick<Notification, 'id' | 'acked_at' | 'rings' | 'exhausted_at'>,
): Promise<'unsent' | 'maybe_out' | null> {
  if (n.acked_at === null || n.rings !== 0 || n.exhausted_at !== null) return null;
  const rows = await trx
    .selectFrom('outbox')
    .select(['state', 'uncertain'])
    .where('kind', '=', 'doorbell')
    .where(sql<number>`json_extract(payload, '$.notificationId')`, '=', n.id)
    .execute();
  if (rows.some((row) => row.state !== 'dead')) return null;
  return rows.some((row) => row.uncertain === 1) ? 'maybe_out' : 'unsent';
}

/**
 * Register the single reminder to the session holding a quiet turn. The key names the holder and
 * its take, so each ownership episode gets its own reminder and no episode gets a second. A
 * reminder of the take cancelled unsent is replaced by a fresh one: its row gets a new id, so the
 * new ring does not reuse the outbox key of a ring the sender already killed.
 */
export async function registerTurnReminder(
  trx: Trx,
  turn: Pick<Row<'turn'>, 'id' | 'task_id' | 'role' | 'acked_at'>,
  session: string,
  at: Date,
): Promise<void> {
  if (turn.acked_at === null) throw new Error(`turn ${String(turn.id)} is not taken`);
  const key = turnReminderKey(turn.id, session, turn.acked_at);
  const earlier = await trx
    .selectFrom('notification')
    .selectAll()
    .where('source_key', '=', key)
    .executeTakeFirst();
  if (earlier !== undefined && (await reminderCancelledUnsent(trx, earlier))) {
    await trx.deleteFrom('notification').where('id', '=', earlier.id).execute();
  }
  await trx
    .insertInto('notification')
    .values({
      source_key: key,
      kind: 'turn_reminder',
      task_id: turn.task_id,
      block_id: null,
      turn_id: turn.id,
      comment_id: null,
      revision: null,
      role: turn.role,
      author_session: session,
      recipient_session: null,
      next_at: at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/** The block of a block-owned notification; the store CHECK gives every non-turn kind one. */
function noticeBlockId(n: Pick<Notification, 'kind' | 'block_id'>): number {
  if (n.block_id === null) throw new Error(`notification of kind ${n.kind} has no block`);
  return n.block_id;
}

/** What a notification is about, as the operator item names it. */
function noticeRef(n: Notification, subject: BlockSubject): string {
  return isTurnKind(n.kind)
    ? `turn T${String(n.turn_id)} on ${subject.key}`
    : `block B${String(noticeBlockId(n))} on ${subject.key}`;
}

/** Register a one-ring notice that a block its addressee held was closed by someone else. */
async function registerRemovedNotification(trx: Trx, block: Block, at: Date): Promise<void> {
  if (block.addressee_role === 'operator') return;
  await trx
    .insertInto('notification')
    .values({
      source_key: `removed:${String(block.id)}`,
      kind: 'removed',
      task_id: block.task_id,
      block_id: block.id,
      comment_id: null,
      revision: null,
      role: block.addressee_role,
      author_session: null,
      recipient_session: null,
      next_at: at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/** Register an answer or clarification for the question's author, unless the author wrote it. */
async function registerAnswerNotification(
  trx: Trx,
  input: Extract<DoorbellEvent, { kind: 'answer' }>,
  at: Date,
): Promise<void> {
  if (input.block.addressee_spur_project !== null) {
    await registerConversationFollowUp(trx, input, at);
    return;
  }
  const parsed = parseActorId(input.block.author);
  if (parsed?.actor !== 'agent' || input.actor === input.block.author) return;
  const actor = parseActorId(input.actor);
  // A later session of the same curator or orchestrator is not someone else answering.
  if (
    resolvedByProject(input.authorRole) &&
    actor?.actor === 'agent' &&
    actor.actorRef.project === parsed.actorRef.project
  )
    return;
  await trx
    .insertInto('notification')
    .values({
      source_key: `comment:${String(input.commentId)}:${String(input.revision)}`,
      kind: 'answer',
      task_id: input.block.task_id,
      block_id: input.block.id,
      comment_id: input.commentId,
      revision: input.revision,
      role: input.authorRole,
      author_session: parsed.actorRef.session,
      recipient_session: null,
      next_at: at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/**
 * Register the addressee's ring for an operator's follow-up in an open operator conversation. An
 * agent's answer rings nobody: the operator reads it in the thread.
 */
async function registerConversationFollowUp(
  trx: Trx,
  input: Extract<DoorbellEvent, { kind: 'answer' }>,
  at: Date,
): Promise<void> {
  if (input.actor !== 'operator' || input.block.state !== 'open') return;
  await trx
    .insertInto('notification')
    .values({
      source_key: `comment:${String(input.commentId)}:${String(input.revision)}`,
      kind: 'answer',
      task_id: input.block.task_id,
      block_id: input.block.id,
      comment_id: input.commentId,
      revision: input.revision,
      role: input.block.addressee_role,
      author_session: null,
      recipient_session: null,
      next_at: at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/**
 * The Spur project an operator conversation's notification is addressed to, or null for every
 * other notification. It routes the ring before the role does.
 */
async function conversationTarget(
  trx: Trx,
  n: Partial<Pick<Notification, 'block_id'>>,
): Promise<string | null> {
  if (n.block_id === undefined || n.block_id === null) return null;
  const block = await trx
    .selectFrom('block')
    .select('addressee_spur_project')
    .where('id', '=', n.block_id)
    .executeTakeFirst();
  return block?.addressee_spur_project ?? null;
}

/**
 * Register the worker's ring for a course note: the curator's answer to a course check, copied to
 * the task. It names the course block, and until its first ring is delivered the worker's other
 * rings on the task stay held (`courseHold`), so the worker reads the decision first.
 */
async function registerCourseNoteNotification(
  trx: Trx,
  input: Extract<DoorbellEvent, { kind: 'course_note' }>,
  at: Date,
): Promise<void> {
  await trx
    .insertInto('notification')
    .values({
      source_key: `course-note:${String(input.comment.id)}`,
      kind: 'answer',
      task_id: input.block.task_id,
      block_id: input.block.id,
      comment_id: input.comment.id,
      revision: input.comment.revision,
      role: 'worker',
      author_session: null,
      recipient_session: null,
      next_at: at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

/** Course-check items of any state, as subquery rows of their block ids. */
const courseBlocks = (eb: ExpressionBuilder<Tables, 'notification'>) =>
  eb
    .selectFrom('operator_item')
    .select('operator_item.block_id')
    .where('operator_item.kind', '=', 'course_check')
    .where('operator_item.block_id', 'is not', null);

/**
 * Whether a worker notification is held by a course check on its task. Two holds apply: while a
 * `course_check` item is active, and, once it clears with a note, until the note's first ring is
 * delivered to any session, so the note rings first. A course note is a worker `answer`
 * notification on a course check's block. Other roles, operator conversations and `cycle_limit`
 * items hold no ring.
 */
function courseHold(eb: ExpressionBuilder<Tables, 'notification'>) {
  return eb.and([
    eb('notification.role', '=', 'worker'),
    // An operator conversation rings its Spur project, never the task's worker: no hold.
    eb.not(
      eb.exists(
        eb
          .selectFrom('block')
          .select('block.id')
          .whereRef('block.id', '=', 'notification.block_id')
          .where('block.addressee_spur_project', 'is not', null),
      ),
    ),
    eb.or([
      eb.exists(
        eb
          .selectFrom('operator_item')
          .select('operator_item.id')
          .where('operator_item.kind', '=', 'course_check')
          .whereRef('operator_item.task_id', '=', 'notification.task_id')
          .where('operator_item.cleared_at', 'is', null),
      ),
      eb.and([
        eb.not(
          eb.and([
            eb('notification.kind', '=', 'answer'),
            eb('notification.block_id', 'in', courseBlocks(eb)),
          ]),
        ),
        eb.exists(
          eb
            .selectFrom('notification as note')
            .select('note.id')
            .whereRef('note.task_id', '=', 'notification.task_id')
            .where('note.role', '=', 'worker')
            .where('note.kind', '=', 'answer')
            .where('note.block_id', 'in', courseBlocks(eb))
            .where('note.rings', '=', 0)
            .where('note.acked_at', 'is', null)
            .where('note.exhausted_at', 'is', null)
            // A handover resets `rings`; a ring once delivered to any session keeps the gate open.
            // The key range `doorbell:<id>:` reads the unique `dedupe_key` index; `+` keeps the
            // planner off the `state` index, whose `done` rows only grow.
            .where((inner) =>
              inner.not(
                inner.exists(
                  inner
                    .selectFrom('outbox')
                    .select('outbox.id')
                    .where(sql<string>`+outbox.state`, '=', 'done')
                    .where(
                      'outbox.dedupe_key',
                      '>',
                      sql<string>`'doorbell:' || ${sql.ref('note.id')} || ':'`,
                    )
                    .where(
                      'outbox.dedupe_key',
                      '<',
                      sql<string>`'doorbell:' || ${sql.ref('note.id')} || ';'`,
                    ),
                ),
              ),
            ),
        ),
      ]),
    ]),
  ]);
}

/**
 * Moves a block to a new addressee, for `block.escalate` and for a ring series that ended: the
 * journal row, the old notification's end, the new one and the Slack thread, in the caller's
 * transaction.
 */
export async function moveBlockToAddressee(
  trx: Trx,
  input: {
    task: Task;
    block: Block;
    to: AddresseeRole;
    reason?: string;
    ctx: CommandContext;
    config: Config;
  },
): Promise<Block> {
  const { task, block, to, reason, ctx, config } = input;
  const updated = await trx
    .updateTable('block')
    .set({ addressee_role: to })
    .where('id', '=', block.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await emit(
    trx,
    'block_escalated',
    task.project,
    task.id,
    ctx.at,
    {
      block: `B${String(block.id)}`,
      from: block.addressee_role,
      to,
      ...(reason === undefined ? {} : { reason }),
    },
    ctx.actor,
  );
  await applyDoorbellPolicy(trx, { kind: 'block_escalated', block: updated }, new Date(ctx.at));
  await queueBlockOpen(trx, taskSubject(task), updated, ctx, config);
  return updated;
}

async function sessionById(trx: Trx, id: string): Promise<Session | undefined> {
  return trx.selectFrom('session_snapshot').selectAll().where('id', '=', id).executeTakeFirst();
}

async function liveSession(trx: Trx, id: string): Promise<Session | undefined> {
  const row = await sessionById(trx, id);
  return row?.ended_at === null && row.state !== 'killed' && row.state !== 'stopped'
    ? row
    : undefined;
}

/** Spur lifecycle states of a session that can no longer read a ring. */
export const FINISHED_STATES = ['killed', 'stopped', 'errored', 'completed'];

/** Stricter than `liveSession`: a role resolved by Spur project must also be in Spur's list. */
function liveInProject(session: Session): boolean {
  return (
    session.ended_at === null &&
    session.absent_since === null &&
    !FINISHED_STATES.includes(session.state)
  );
}

/** Roles whose recipient is any session of a configured Spur project, not one linked session. */
function resolvedByProject(role: AddresseeRole): boolean {
  const { kind } = parseAddressee(role);
  return kind === 'curator' || kind === 'orchestrator';
}

/**
 * Milliseconds of a stored time, or null for a missing or unreadable one. `Date.parse`, not text
 * order: ISO values with different fractions do not sort as text.
 */
function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Orders later times first and missing times last. Compared, never subtracted. */
function laterFirst(left: number | null, right: number | null): number {
  const a = left ?? -Infinity;
  const b = right ?? -Infinity;
  return a > b ? -1 : a < b ? 1 : 0;
}

/**
 * The newest live session of a Spur project, then the most recently active, then by id. A row
 * with an unreadable time or detail stays eligible and sorts last on that time.
 */
export async function bestProjectSession(
  trx: Trx,
  project: string | null,
): Promise<Session | undefined> {
  if (project === null) return undefined;
  const rows = await trx
    .selectFrom('session_snapshot')
    .selectAll()
    // json_extract raises on malformed JSON; one bad row must not stop rings or the doctor.
    .select(
      sql`CASE WHEN json_valid(detail) THEN json_extract(detail, '$.lastActivityAt') END`.as(
        'last_activity',
      ),
    )
    .where('spur_project', '=', project)
    .where('ended_at', 'is', null)
    .where('absent_since', 'is', null)
    .where('state', 'not in', FINISHED_STATES)
    .execute();
  return rows.sort(
    (left, right) =>
      laterFirst(instant(left.first_seen), instant(right.first_seen)) ||
      laterFirst(instant(left.last_activity), instant(right.last_activity)) ||
      (left.id < right.id ? -1 : 1),
  )[0];
}

/**
 * The live session that a curator block on a board project rings, or undefined when the project
 * has no curator or the curator has no live session. `board doctor` reports the same choice.
 */
export async function curatorSession(
  trx: Trx,
  config: Config,
  projectId: string,
): Promise<Session | undefined> {
  return bestProjectSession(trx, curatorProject(config, projectId));
}

/** The newest live session linked to a task in a role; a project-level notice has no links. */
export async function linkedSession(
  trx: Trx,
  taskId: number | null,
  role: 'worker' | 'orchestrator',
): Promise<Session | undefined> {
  if (taskId === null) return undefined;
  const links = await trx
    .selectFrom('link')
    .select('session_id')
    .where('task_id', '=', taskId)
    .where('entity', '=', 'session')
    .where('role', '=', role)
    .where('banned', '=', 0)
    .orderBy('created_at', 'desc')
    .execute();
  for (const link of links) {
    if (link.session_id === null) continue;
    const session = await liveSession(trx, link.session_id);
    if (session !== undefined) return session;
  }
  return undefined;
}

/** The board project of a notification: its task's, else its project-level block's. */
async function noticeProject(
  trx: Trx,
  n: Pick<Notification, 'task_id'> & Partial<Pick<Notification, 'block_id'>>,
): Promise<string> {
  return (await rowSubject(trx, { task_id: n.task_id, block_id: n.block_id ?? null })).project;
}

/** The Spur project orchestrating a column; null when no agent project does. */
function columnOrchestratorProject(
  config: Config,
  projectId: string,
  column: string,
): string | null {
  const name = config.projects
    .find((project) => project.id === projectId)
    ?.columns.find((entry) => entry.id === column)?.orchestrator;
  return name === undefined || name === 'none' || name === 'operator' ? null : name;
}

/**
 * Select the current live recipient for a semantic notification. A turn reminder reaches only
 * the session it names, while that session lives.
 */
export async function selectNotificationRecipient(
  trx: Trx,
  n: Pick<Notification, 'task_id' | 'role' | 'author_session'> &
    Partial<Pick<Notification, 'kind' | 'block_id'>>,
  config: Config,
): Promise<Session | undefined> {
  if (n.kind === 'turn_reminder')
    return n.author_session === null ? undefined : liveSession(trx, n.author_session);
  const target = await conversationTarget(trx, n);
  if (target !== null) return bestProjectSession(trx, target);
  const addressee = parseAddressee(n.role);
  switch (addressee.kind) {
    case 'curator':
      // Any current curator speaks for the role, so the session that asked has no claim.
      return curatorSession(trx, config, await noticeProject(trx, n));
    case 'orchestrator': {
      const author =
        n.author_session === null ? undefined : await sessionById(trx, n.author_session);
      if (author !== undefined && liveInProject(author)) return author;
      return (
        (await linkedSession(trx, n.task_id, 'orchestrator')) ??
        bestProjectSession(
          trx,
          columnOrchestratorProject(config, await noticeProject(trx, n), addressee.column),
        )
      );
    }
    case 'worker':
    case 'operator': {
      const author =
        n.author_session === null ? undefined : await liveSession(trx, n.author_session);
      if (author !== undefined || addressee.kind === 'operator') return author;
      return linkedSession(trx, n.task_id, 'worker');
    }
    default:
      return assertNever(addressee);
  }
}

/** The operator item kind raised when a notification's rings are exhausted. */
function exhaustedItemKind(
  n: Pick<Notification, 'kind'>,
): 'answer_undelivered' | 'worker_not_reading' {
  return n.kind === 'answer' ? 'answer_undelivered' : 'worker_not_reading';
}

/** The operator item key raised when a notification's rings are exhausted. */
function exhaustedItemKey(n: Pick<Notification, 'kind' | 'source_key'>): string {
  return `${exhaustedItemKind(n)}:${n.source_key}`;
}

/**
 * Restart an exhausted, unacknowledged ring series at `at`. The recipient and last row stay, so
 * the next reconcile rings the same session under the next series key.
 */
export async function restartNotification(trx: Trx, sourceKey: string, at: Date): Promise<void> {
  const restarted = await trx
    .updateTable('notification')
    .set({ rings: 0, exhausted_at: null, next_at: at.toISOString() })
    .where('source_key', '=', sourceKey)
    .where('acked_at', 'is', null)
    .where('exhausted_at', 'is not', null)
    .returning('id')
    .executeTakeFirst();
  if (restarted === undefined) {
    throw new CommandError(
      'retry_not_applicable',
      'The doorbell was read or is still ringing; close the item instead.',
    );
  }
}

/**
 * Ends a notification's ring series. A curator block, and a block that ended with no session
 * (`noRecipientEnd`), move to the operator; a removal, a turn reminder or another ring with no
 * session to name ends alone; anything else raises the operator item, whose Retry restarts the
 * series (`restartNotification`). Every end journals `doorbell_undelivered`.
 */
async function endNotification(
  trx: Trx,
  n: Notification,
  subject: BlockSubject,
  end: { session: string | null; reason: string; at: Date; config: Config },
): Promise<void> {
  const { session, reason, at, config } = end;
  await trx
    .updateTable('notification')
    .set({ exhausted_at: at.toISOString() })
    .where('id', '=', n.id)
    .execute();
  if (n.rings === 0) await releaseAfterCourseNote(trx, n, at);
  const addressee = parseAddressee(n.role);
  const { task } = subject;
  // A block that ends with no recipient (`noRecipientEnd`) moves to the operator, as does a
  // curator block whose rings ran out. A project block already addresses the operator.
  // An operator conversation stays with the Spur project the operator addressed.
  if (
    n.kind === 'block' &&
    task !== null &&
    (addressee.kind === 'curator' || session === null) &&
    (await conversationTarget(trx, n)) === null
  ) {
    const block = await trx
      .selectFrom('block')
      .selectAll()
      .where('id', '=', noticeBlockId(n))
      .executeTakeFirstOrThrow();
    await moveBlockToAddressee(trx, {
      task,
      block,
      to: 'operator',
      reason,
      ctx: { actor: 'system', at: at.toISOString() },
      config,
    });
  } else if (n.kind !== 'removed' && n.kind !== 'turn_reminder' && session !== null) {
    const blockRef = noticeRef(n, subject);
    const answer = `Answer to ${blockRef} was not`;
    const holder = `${addressee.kind} ${session}`;
    await raiseItem(trx, {
      itemKey: exhaustedItemKey(n),
      kind: exhaustedItemKind(n),
      text:
        reason === UNANSWERED
          ? n.kind === 'answer'
            ? `${answer} read`
            : `${holder} is not reading ${blockRef}`
          : n.kind === 'answer'
            ? `${answer} delivered: ${reason}`
            : `${holder} did not get ${blockRef}: ${reason}`,
      url: task === null ? TASKLESS_ITEM_URL : taskUrl(task, config),
      taskId: task?.id ?? null,
      blockId: n.block_id,
      at,
    });
  }
  await journal(trx, n, 'doorbell_undelivered', { doorbell: `N${String(n.id)}`, reason }, at);
}

/**
 * Ends a ring Spur will not take (a permanent rejection, or no answer for the retry window). A
 * ring that is no longer its notification's last row (the recipient changed while it was in
 * flight) ends alone. An inbound author ring has no notification: it ends like an author found
 * unavailable at enqueue.
 */
export async function ringUndelivered(
  trx: Trx,
  input: {
    notificationId?: number | undefined;
    outboxId: number;
    dedupeKey: string;
    session: string;
    reason: string;
    at: Date;
    config: Config;
  },
): Promise<void> {
  const { at, reason } = input;
  if (input.notificationId === undefined) {
    const task = await ringTask(trx, undefined, input.dedupeKey);
    if (task === undefined) return;
    await emit(trx, 'doorbell_undelivered', task.project, task.id, at.toISOString(), {
      doorbell: input.dedupeKey,
      reason,
    });
    await raiseItem(trx, {
      itemKey: `doorbell:unavailable:${input.dedupeKey}`,
      kind: 'answer_author_unavailable',
      text: `Answer author unavailable: ${reason}`,
      url: taskUrl(task, input.config),
      taskId: task.id,
      blockId: null,
      at,
    });
    return;
  }
  const n = await trx
    .selectFrom('notification')
    .selectAll()
    .where('id', '=', input.notificationId)
    .executeTakeFirst();
  if (
    n === undefined ||
    n.acked_at !== null ||
    n.exhausted_at !== null ||
    n.last_outbox_id !== input.outboxId
  )
    return;
  await endNotification(trx, n, await rowSubject(trx, n), {
    session: input.session,
    reason,
    at,
    config: input.config,
  });
}

/**
 * Why a notification with no recipient ends now, or null when it stays due for a next session. A
 * curator block, and an orchestrator block of a course check, end with `session: null`, which
 * `endNotification` turns into a move to the operator. A worker's answer on a project-level block
 * goes only to the session that asked. An operator conversation's notification never ends here.
 */
async function noRecipientEnd(trx: Trx, n: Notification): Promise<string | null> {
  // An operator conversation waits for a live session of its Spur project.
  if ((await conversationTarget(trx, n)) !== null) return null;
  if (
    n.kind === 'removed' ||
    n.kind === 'turn_reminder' ||
    (n.kind === 'answer' && n.role === 'operator') ||
    (n.kind === 'answer' && n.role === 'worker' && n.task_id === null)
  )
    return 'no live addressee';
  if (n.kind !== 'block') return null;
  if (n.role === 'curator') return 'no live curator session';
  if (parseAddressee(n.role).kind !== 'orchestrator') return null;
  const course = await trx
    .selectFrom('operator_item')
    .select('id')
    .where('kind', '=', 'course_check')
    .where('block_id', '=', noticeBlockId(n))
    .executeTakeFirst();
  return course === undefined ? null : 'no live orchestrator session';
}

/** A ring never carries comment or reason text: only where to look. */
async function ringText(
  trx: Trx,
  n: Notification,
  { key }: BlockSubject,
  ring: number,
): Promise<string> {
  const suffix = ringMarker(n.id, ring);
  if (n.kind === 'turn') return `${key} turn T${String(n.turn_id)}: check board inbox ${suffix}`;
  if (n.kind === 'turn_reminder')
    return `${key} turn T${String(n.turn_id)} is still open: check board inbox ${suffix}`;
  const blockId = noticeBlockId(n);
  if (n.kind !== 'removed') {
    return `${key} block B${String(blockId)}: check board inbox ${suffix}`;
  }
  const block = await trx
    .selectFrom('block')
    .select('unblocked_by')
    .where('id', '=', blockId)
    .executeTakeFirstOrThrow();
  return `${key} block B${String(blockId)} was removed by ${block.unblocked_by ?? 'system'}; see board task ${key} ${suffix}`;
}

/**
 * Notifications reconcile looks at: unacked, not exhausted, due, on a task not archived or on a
 * project-level block, and not held by a course check (`courseHold`).
 */
function dueNotifications(db: Trx, at: Date) {
  // Archive cancels unsent rings (`archiveTask`); ringing again before `task.add` would undo that.
  return db
    .selectFrom('notification')
    .leftJoin('task', 'task.id', 'notification.task_id')
    .where((eb) => eb.or([eb('task.id', 'is', null), eb('task.membership', '!=', 'archived')]))
    .where('notification.acked_at', 'is', null)
    .where('notification.exhausted_at', 'is', null)
    .where('notification.next_at', '<=', at.toISOString())
    .where((eb) => eb.not(courseHold(eb)));
}

/**
 * Reconciles due notifications in their own transaction. With none due it opens no transaction;
 * a due notification waiting on a working recipient, an unsent ring or a ring still in the
 * recipient's Spur queue still opens one.
 */
export async function reconcileDueDoorbells(store: Store, config: Config, at: Date): Promise<void> {
  const due = await dueNotifications(store.db, at).select('notification.id').executeTakeFirst();
  if (due === undefined) return;
  await scanTransaction(store, config, (trx) => reconcileDoorbells(trx, at, config));
}

/** Reconcile due semantic notifications in the caller's transaction. */
export async function reconcileDoorbells(trx: Trx, at: Date, config: Config): Promise<void> {
  const due = await dueNotifications(trx, at)
    .selectAll('notification')
    .orderBy('notification.id')
    .execute();
  for (const n of due) {
    const session = await selectNotificationRecipient(trx, n, config);
    const keepsRings = resolvedByProject(n.role) || (await conversationTarget(trx, n)) !== null;
    if (session === undefined) {
      const reason = await noRecipientEnd(trx, n);
      if (reason !== null) {
        await endNotification(trx, n, await rowSubject(trx, n), {
          session: null,
          reason,
          at,
          config,
        });
      } else if (n.recipient_session !== null) {
        await trx
          .updateTable('notification')
          .set({ recipient_session: null, rings: keepsRings ? n.rings : 0, last_outbox_id: null })
          .where('id', '=', n.id)
          .execute();
      }
      continue;
    }
    // A recipient observed mid-turn is not rung until it stops. A blind Spur leaves its last
    // health in the snapshot, so a stored `working` holds nothing then.
    if (recipientBusy(session) && !(await spurBlind(trx))) continue;
    let rings = n.rings;
    let lastOutbox = n.last_outbox_id;
    if (session.id !== n.recipient_session) {
      if (lastOutbox !== null) {
        await trx
          .updateTable('outbox')
          .set({ state: 'dead', last_error: 'recipient changed' })
          .where('id', '=', lastOutbox)
          .where('state', '=', 'pending')
          .execute();
      }
      // A series for a role resolved by project spans its sessions, so handovers cannot extend it.
      if (!keepsRings) rings = 0;
      lastOutbox = null;
      await trx
        .updateTable('notification')
        .set({ recipient_session: session.id, rings, last_outbox_id: null })
        .where('id', '=', n.id)
        .execute();
    }
    if (lastOutbox !== null) {
      const row = await trx
        .selectFrom('outbox')
        .select('state')
        .where('id', '=', lastOutbox)
        .executeTakeFirst();
      if (row?.state === 'pending' || row?.state === 'in_flight') continue;
    }
    const subject = await rowSubject(trx, n);
    if (rings >= 3) {
      await endNotification(trx, n, subject, {
        session: session.id,
        reason: UNANSWERED,
        at,
        config,
      });
      continue;
    }
    // A ring still in the recipient's Spur queue was never read: hold the next one until the
    // queue lets it go, and end the series when the window it would have rung in closes. A blind
    // Spur leaves the last queue in the snapshot, so it holds nothing and rings as before.
    if (rings > 0 && earlierRingQueued(session, n.id, rings) && !(await spurBlind(trx))) {
      const pauses = ringPauses(config);
      const deadline =
        Date.parse(n.next_at) + pauses.slice(rings).reduce((sum, pause) => sum + pause, 0);
      if (at.getTime() >= deadline) {
        await endNotification(trx, n, subject, {
          session: session.id,
          reason: UNANSWERED,
          at,
          config,
        });
      }
      continue;
    }
    // Each exhausted series raised one item generation; a restarted series rings under it.
    const raised = await trx
      .selectFrom('operator_item')
      .select((eb) => eb.fn.max('raise_no').as('series'))
      .where('item_key', '=', exhaustedItemKey(n))
      .executeTakeFirst();
    // Archive killed any unsent ring of this task; a resumed ring needs a key the dead row lacks.
    const archived =
      n.task_id === null
        ? undefined
        : await trx
            .selectFrom('event')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('task_id', '=', n.task_id)
            .where('kind', '=', 'task_archived')
            .executeTakeFirst();
    const ring = rings + 1;
    const text = await ringText(trx, n, subject, ring);
    const outboxId = await enqueueDoorbell(trx, {
      notificationId: n.id,
      ring,
      session: session.id,
      text,
      at,
      series: raised?.series ?? 0,
      archives: archived?.count ?? 0,
    });
    await trx
      .updateTable('notification')
      .set({ last_outbox_id: outboxId })
      .where('id', '=', n.id)
      .execute();
  }
}

/** The pause after each delivered ring of a series: before ring 2, before ring 3, then the end. */
function ringPauses(config: Config): readonly number[] {
  return [
    config.doorbells.firstRetryMs,
    config.doorbells.secondRetryMs,
    config.doorbells.unansweredAfterMs,
  ];
}

/** The session's last observed Spur facts, or null when its detail does not parse. */
function observedFacts(session: Session): SessionFacts | null {
  let detail: unknown;
  try {
    detail = JSON.parse(session.detail);
  } catch {
    return null;
  }
  const fact = sessionFactsSchema.safeParse(detail);
  return fact.success ? fact.data : null;
}

/**
 * Whether the session was last observed mid-turn. Only an observed `working` health counts: any
 * other health, or a detail that does not parse, is rung.
 */
function recipientBusy(session: Session): boolean {
  return observedFacts(session)?.health === 'working';
}

/**
 * Whether the session's facts list a ring of this series, up to `rings`, still in its Spur queue.
 * A detail that does not parse, or one without a queue, holds nothing.
 */
function earlierRingQueued(session: Session, notificationId: number, rings: number): boolean {
  return (observedFacts(session)?.queuedRings ?? []).some(
    (queued) => queued.notification === notificationId && queued.ring <= rings,
  );
}

/** Count one confirmed Spur send, regardless of transport attempts for its outbox row. */
export async function recordRingDelivery(
  trx: Trx,
  notificationId: number,
  ring: number,
  session: string,
  at: Date,
  config: Config,
): Promise<void> {
  const n = await trx
    .selectFrom('notification')
    .selectAll()
    .where('id', '=', notificationId)
    .executeTakeFirst();
  // A turn reminder acked while its send was in flight still reached its holder: it is counted,
  // so `reminderCancelledUnsent` never takes it for unsent and a restored link sends no second.
  if (
    n === undefined ||
    (n.acked_at !== null && n.kind !== 'turn_reminder') ||
    n.recipient_session !== session ||
    n.rings >= ring
  )
    return;
  const pauses = ringPauses(config);
  await trx
    .updateTable('notification')
    .set({
      rings: ring,
      next_at: new Date(at.getTime() + (pauses[ring - 1] ?? 0)).toISOString(),
      // A removal or a turn reminder asks for nothing: it is done once delivered.
      ...(n.kind === 'removed' || n.kind === 'turn_reminder' ? { acked_at: at.toISOString() } : {}),
    })
    .where('id', '=', notificationId)
    .execute();
  if (ring === 1) await releaseAfterCourseNote(trx, n, at);
  await journal(
    trx,
    n,
    'doorbell_rung',
    {
      doorbell: `N${String(n.id)}`,
      addressee: n.role,
      attempt: ring,
    },
    at,
  );
}

/**
 * Once a course note no longer holds (`courseHold`): its first ring delivered, or read or ended
 * before it rang. Moves the worker's other rings on the task that waited in the outbox to the
 * front (`promoteWorkerDoorbells`); `clearItem` does the same for a course check that clears
 * without a note.
 */
async function releaseAfterCourseNote(trx: Trx, n: Notification, at: Date): Promise<void> {
  const note = await trx
    .selectFrom('notification')
    .select('id')
    .where('id', '=', n.id)
    .where('role', '=', 'worker')
    .where('kind', '=', 'answer')
    .where((eb) => eb('block_id', 'in', courseBlocks(eb)))
    .executeTakeFirst();
  // A project-level block is never a course check, so its notice holds no ring.
  if (note === undefined || n.task_id === null) return;
  await promoteWorkerDoorbells(trx, n.task_id, at, n.id);
}

/** True while the Spur source is blind: its stored session facts may no longer hold. */
async function spurBlind(trx: Trx): Promise<boolean> {
  const state = await trx
    .selectFrom('source_state')
    .select('blind_reason')
    .where('source', '=', 'spur')
    .executeTakeFirst();
  return state !== undefined && state.blind_reason !== null;
}

/** Confirm that a queued ring still belongs to a live, idle, unread recipient. */
export async function ringStillCurrent(
  trx: Trx,
  notificationId: number,
  sessionId: string,
  config: Config,
): Promise<'send' | 'defer' | 'dead'> {
  const n = await trx
    .selectFrom('notification')
    .selectAll()
    .where('id', '=', notificationId)
    .executeTakeFirst();
  if (
    n === undefined ||
    n.acked_at !== null ||
    n.exhausted_at !== null ||
    n.recipient_session !== sessionId
  )
    return 'dead';
  const session = await selectNotificationRecipient(trx, n, config);
  if (session?.id !== sessionId) return 'dead';
  // A held ring waits in the outbox, keeping its key and its place for the release.
  const held = await trx
    .selectFrom('notification')
    .select('id')
    .where('id', '=', n.id)
    .where(courseHold)
    .executeTakeFirst();
  if (held !== undefined) return 'defer';
  return recipientBusy(session) && !(await spurBlind(trx)) ? 'defer' : 'send';
}

/** The comment of an inbound author ring, named in its `doorbell:comment:<id>:` key. */
export function ringCommentId(dedupeKey: string): number | undefined {
  const id = /^doorbell:comment:(\d+):/.exec(dedupeKey)?.[1];
  return id === undefined ? undefined : Number(id);
}

/**
 * The task of a ring: through its notification, or for an inbound author ring (no notification)
 * through the comment in its `doorbell:comment:<id>:` key. Archive kills only unclaimed rings;
 * the sender drops a claimed one of an archived task before its send starts.
 */
export async function ringTask(
  trx: Trx,
  notificationId: number | undefined,
  dedupeKey: string,
): Promise<Row<'task'> | undefined> {
  const commentId = ringCommentId(dedupeKey);
  if (notificationId === undefined && commentId === undefined) return undefined;
  const owner =
    notificationId !== undefined
      ? trx.selectFrom('notification').select('task_id').where('id', '=', notificationId)
      : trx.selectFrom('comment').select('task_id').where('id', '=', Number(commentId));
  return trx.selectFrom('task').selectAll().where('id', 'in', owner).executeTakeFirst();
}

/** Stop notifications acknowledged by the addressed session. */
export async function acknowledgeNotification(
  trx: Trx,
  input: {
    blockId?: number;
    commentId?: number;
    turnId?: number;
    revision?: number;
    actor: ActorId;
    at: Date;
    config: Config;
  },
): Promise<boolean> {
  let query = trx.selectFrom('notification').selectAll().where('acked_at', 'is', null);
  if (input.blockId !== undefined)
    query = query.where('block_id', '=', input.blockId).where('kind', '=', 'block');
  else if (input.commentId !== undefined)
    query = query.where('comment_id', '=', input.commentId).where('kind', '=', 'answer');
  else if (input.turnId !== undefined)
    query = query.where('turn_id', '=', input.turnId).where('kind', '=', 'turn');
  else return false;
  const notices = await query.orderBy('id', 'desc').execute();
  const n = notices[0];
  if (n === undefined) return false;
  if (!(await notificationAddressedTo(trx, n, input.actor, input.config))) {
    throw new CommandError('forbidden', 'Only the addressed task role can acknowledge.');
  }
  for (const notice of notices) {
    await trx
      .updateTable('notification')
      .set({ acked_at: input.at.toISOString() })
      .where('id', '=', notice.id)
      .execute();
    if (notice.rings === 0) await releaseAfterCourseNote(trx, notice, input.at);
    await journal(trx, notice, 'doorbell_read', { doorbell: `N${String(notice.id)}` }, input.at);
    const item = await trx
      .selectFrom('operator_item')
      .select('id')
      .where('item_key', '=', exhaustedItemKey(notice))
      .where('cleared_at', 'is', null)
      .executeTakeFirst();
    if (item !== undefined) await clearItem(trx, item.id, input.at);
  }
  return true;
}

/** Decides who may list and acknowledge an inbox notice, by the role it is addressed to. */
export async function notificationAddressedTo(
  trx: Trx,
  n: Notification,
  actor: ActorId,
  config: Config,
): Promise<boolean> {
  const parsed = parseActorId(actor);
  if (parsed?.actor !== 'agent') return false;
  const { project, session } = parsed.actorRef;
  const target = await conversationTarget(trx, n);
  if (target !== null) return project === target;
  const addressee = parseAddressee(n.role);
  switch (addressee.kind) {
    case 'curator':
      return project === curatorProject(config, await noticeProject(trx, n));
    case 'orchestrator':
      return (
        project ===
          columnOrchestratorProject(config, await noticeProject(trx, n), addressee.column) ||
        (await hasLiveLink(trx, n.task_id, 'orchestrator', session))
      );
    case 'operator':
      return session === n.author_session;
    case 'worker':
      return workerNotificationAddressedTo(trx, n, session, config);
    default:
      return assertNever(addressee);
  }
}

async function sessionLink(
  trx: Trx,
  taskId: number | null,
  role: 'worker' | 'orchestrator',
  session: string,
): Promise<{ id: number } | undefined> {
  if (taskId === null) return undefined;
  return trx
    .selectFrom('link')
    .select('id')
    .where('task_id', '=', taskId)
    .where('entity', '=', 'session')
    .where('role', '=', role)
    .where('banned', '=', 0)
    .where('session_id', '=', session)
    .executeTakeFirst();
}

async function hasLiveLink(
  trx: Trx,
  taskId: number | null,
  role: 'orchestrator',
  session: string,
): Promise<boolean> {
  return (
    (await sessionLink(trx, taskId, role, session)) !== undefined &&
    (await liveSession(trx, session)) !== undefined
  );
}

/** The selected worker while it lives; before the first ring, the author or a linked worker. */
async function workerNotificationAddressedTo(
  trx: Trx,
  n: Notification,
  session: string,
  config: Config,
): Promise<boolean> {
  // A turn grants work ownership, so a stale recipient cannot keep authority after demotion.
  // Answers still follow their original author, including authors linked as other.
  if (n.kind === 'turn' && (await sessionLink(trx, n.task_id, 'worker', session)) === undefined)
    return false;
  if (n.recipient_session === null) {
    return (
      session === n.author_session ||
      (await sessionLink(trx, n.task_id, 'worker', session)) !== undefined
    );
  }
  const recipientStillWorker =
    n.kind !== 'turn' ||
    (await sessionLink(trx, n.task_id, 'worker', n.recipient_session)) !== undefined;
  return recipientStillWorker && (await liveSession(trx, n.recipient_session)) !== undefined
    ? session === n.recipient_session
    : (await selectNotificationRecipient(trx, n, config))?.id === session;
}

/** Ends a block's ring series; its exhaustion item is cleared by `actor`, who closed the block. */
export async function closeBlockNotification(
  trx: Trx,
  blockId: number,
  at: Date,
  actor: ActorId,
): Promise<void> {
  await closeOwnedNotifications(trx, 'block', blockId, at, actor);
}

/**
 * Ends a turn's ring series and reminders for good: acked, and its exhaustion item cleared by the
 * system.
 */
export async function closeTurnNotification(trx: Trx, turnId: number, at: Date): Promise<void> {
  await closeOwnedNotifications(trx, 'turn', turnId, at, 'system');
}

/**
 * Ends an operator conversation's block and follow-up rings, whoever answered or closed it: the
 * operation's grant already chose the actor. Exhaustion items are cleared by `actor`, and each
 * follow-up comment is marked read at its current revision.
 */
export async function ackConversationNotifications(
  trx: Trx,
  blockId: number,
  at: Date,
  actor: ActorId,
): Promise<void> {
  // The answer or close covers each follow-up as read, so a later edit is a clarification.
  const answers = await trx
    .selectFrom('notification')
    .select('comment_id')
    .where('block_id', '=', blockId)
    .where('kind', '=', 'answer')
    .where('acked_at', 'is', null)
    .execute();
  await closeOwnedNotifications(trx, 'conversation', blockId, at, actor);
  for (const { comment_id: id } of answers) {
    if (id === null) continue;
    await trx
      .updateTable('comment')
      .set((eb) => ({ acked_revision: eb.ref('revision') }))
      .where('id', '=', id)
      .execute();
  }
}

const OWNED_KINDS = {
  block: ['block'],
  conversation: ['block', 'answer'],
  turn: ['turn', 'turn_reminder'],
} as const satisfies Record<string, readonly Notification['kind'][]>;

async function closeOwnedNotifications(
  trx: Trx,
  kind: keyof typeof OWNED_KINDS,
  ownerId: number,
  at: Date,
  actor: ActorId,
): Promise<void> {
  const closed = await trx
    .updateTable('notification')
    .set({ acked_at: at.toISOString() })
    .where(kind === 'turn' ? 'turn_id' : 'block_id', '=', ownerId)
    .where('kind', 'in', OWNED_KINDS[kind])
    .where('acked_at', 'is', null)
    .returning(['kind', 'source_key'])
    .execute();
  for (const row of closed) {
    const item = await trx
      .selectFrom('operator_item')
      .select('id')
      .where('item_key', '=', exhaustedItemKey(row))
      .where('cleared_at', 'is', null)
      .executeTakeFirst();
    if (item !== undefined) await clearItem(trx, item.id, at, actor);
  }
}
