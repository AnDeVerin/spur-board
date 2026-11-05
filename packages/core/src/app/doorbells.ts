import {
  EVENT_VERSION,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
  type Config,
  type EventPayload,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { toJson } from '../store/json.ts';
import type { Row, Tables } from '../store/schema.ts';
import { CommandError } from './commands.ts';
import { clearItem, raiseItem } from './feed.ts';
import { enqueueDoorbell } from './outbox.ts';

type Trx = Kysely<Tables>;
type Notification = Row<'notification'>;
type Block = Row<'block'>;

const DEFAULT_PAUSES = [120_000, 300_000, 900_000] as const;

async function journal<K extends 'doorbell_rung' | 'doorbell_read' | 'doorbell_undelivered'>(
  trx: Trx,
  notification: Notification,
  kind: K,
  payload: EventPayload<K>,
  at: Date,
): Promise<void> {
  const task = await trx
    .selectFrom('task')
    .select('project')
    .where('id', '=', notification.task_id)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('event')
    .values({
      at: at.toISOString(),
      project: task.project,
      task_id: notification.task_id,
      kind,
      actor: 'system',
      actor_ref: null,
      payload: toJson(eventPayloadSchemas[kind], payload),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}

/** Register a worker-addressed block without manufacturing a comment. */
export async function registerBlockNotification(trx: Trx, block: Block, at: Date): Promise<void> {
  if (block.addressee_role !== 'worker') return;
  await trx
    .insertInto('notification')
    .values({
      source_key: `block:${String(block.id)}:worker`,
      kind: 'block',
      task_id: block.task_id,
      block_id: block.id,
      comment_id: null,
      revision: null,
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

/** Register an answer or clarification for the original author and its task role. */
export async function registerAnswerNotification(
  trx: Trx,
  input: { block: Block; commentId: number; revision: number; authorRole: string; at: Date },
): Promise<void> {
  if (input.authorRole !== 'worker') return;
  const parsed = parseActorId(input.block.author);
  if (parsed?.actor !== 'agent') return;
  await trx
    .insertInto('notification')
    .values({
      source_key: `comment:${String(input.commentId)}:${String(input.revision)}`,
      kind: 'answer',
      task_id: input.block.task_id,
      block_id: input.block.id,
      comment_id: input.commentId,
      revision: input.revision,
      role: 'worker',
      author_session: parsed.actorRef.session,
      recipient_session: null,
      next_at: input.at.toISOString(),
      last_outbox_id: null,
      acked_at: null,
      exhausted_at: null,
      created_at: input.at.toISOString(),
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .execute();
}

async function liveSession(trx: Trx, id: string): Promise<Row<'session_snapshot'> | undefined> {
  const row = await trx
    .selectFrom('session_snapshot')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row?.ended_at === null && row.state !== 'killed' && row.state !== 'stopped'
    ? row
    : undefined;
}

/** Select the current live recipient for a semantic notification. */
export async function selectNotificationRecipient(
  trx: Trx,
  n: Pick<Notification, 'task_id' | 'role' | 'author_session'>,
): Promise<Row<'session_snapshot'> | undefined> {
  if (n.author_session !== null) {
    const author = await liveSession(trx, n.author_session);
    if (author !== undefined) return author;
  }
  const links = await trx
    .selectFrom('link')
    .select('session_id')
    .where('task_id', '=', n.task_id)
    .where('entity', '=', 'session')
    .where('role', '=', n.role === 'worker' ? 'worker' : 'orchestrator')
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

export function taskUrl(task: Row<'task'>, config?: Config): string {
  if (task.tracker_kind === 'github-issues') {
    const match = /^(.+)#(\d+)$/.exec(task.key);
    if (match?.[1] !== undefined && match[2] !== undefined)
      return `https://github.com/${match[1]}/issues/${match[2]}`;
  }
  const project = config?.projects.find((p) => p.id === task.project);
  if (project?.tracker.type === 'jira') {
    return `${project.tracker.baseUrl.replace(/\/$/, '')}/browse/${task.key}`;
  }
  return `https://github.com/${task.key.replace('#', '/issues/')}`;
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

/** Reconcile due semantic notifications in the sender's claim transaction. */
export async function reconcileDoorbells(trx: Trx, at: Date, config?: Config): Promise<void> {
  // Archive cancels unsent rings (`archiveTask`); ringing again before `task.add` would undo that.
  const due = await trx
    .selectFrom('notification')
    .innerJoin('task', 'task.id', 'notification.task_id')
    .selectAll('notification')
    .where('task.membership', '!=', 'archived')
    .where('notification.acked_at', 'is', null)
    .where('notification.exhausted_at', 'is', null)
    .where('notification.next_at', '<=', at.toISOString())
    .orderBy('notification.id')
    .execute();
  for (const n of due) {
    const session = await selectNotificationRecipient(trx, n);
    if (session === undefined) {
      if (n.recipient_session !== null) {
        await trx
          .updateTable('notification')
          .set({ recipient_session: null, rings: 0, last_outbox_id: null })
          .where('id', '=', n.id)
          .execute();
      }
      continue;
    }
    if (session.state === 'working') continue;
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
      rings = 0;
      lastOutbox = null;
      await trx
        .updateTable('notification')
        .set({ recipient_session: session.id, rings: 0, last_outbox_id: null })
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
    const task = await trx
      .selectFrom('task')
      .selectAll()
      .where('id', '=', n.task_id)
      .executeTakeFirstOrThrow();
    const itemKey = exhaustedItemKey(n);
    if (rings >= 3) {
      await raiseItem(trx, {
        itemKey,
        kind: exhaustedItemKind(n),
        text:
          n.kind === 'answer'
            ? `Answer to block B${String(n.block_id)} on ${task.key} was not read`
            : `worker ${session.id} is not reading block B${String(n.block_id)} on ${task.key}`,
        url: taskUrl(task, config),
        taskId: task.id,
        blockId: n.block_id,
        at,
      });
      await trx
        .updateTable('notification')
        .set({ exhausted_at: at.toISOString() })
        .where('id', '=', n.id)
        .execute();
      await journal(
        trx,
        n,
        'doorbell_undelivered',
        {
          doorbell: `N${String(n.id)}`,
          reason: 'unanswered',
        },
        at,
      );
      continue;
    }
    // Each exhausted series raised one item generation; a restarted series rings under it.
    const raised = await trx
      .selectFrom('operator_item')
      .select((eb) => eb.fn.max('raise_no').as('series'))
      .where('item_key', '=', itemKey)
      .executeTakeFirst();
    // Archive killed any unsent ring of this task; a resumed ring needs a key the dead row lacks.
    const archived = await trx
      .selectFrom('event')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('task_id', '=', n.task_id)
      .where('kind', '=', 'task_archived')
      .executeTakeFirst();
    const ring = rings + 1;
    const text = `${task.key} block B${String(n.block_id)}: check board inbox (N${String(n.id)}-${String(ring)})`;
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

/** Count one confirmed Spur send, regardless of transport attempts for its outbox row. */
export async function recordRingDelivery(
  trx: Trx,
  notificationId: number,
  ring: number,
  session: string,
  at: Date,
  config?: Config,
): Promise<void> {
  const n = await trx
    .selectFrom('notification')
    .selectAll()
    .where('id', '=', notificationId)
    .executeTakeFirst();
  if (n === undefined || n.acked_at !== null || n.recipient_session !== session || n.rings >= ring)
    return;
  const pauses = config
    ? [
        config.doorbells.firstRetryMs,
        config.doorbells.secondRetryMs,
        config.doorbells.unansweredAfterMs,
      ]
    : DEFAULT_PAUSES;
  await trx
    .updateTable('notification')
    .set({ rings: ring, next_at: new Date(at.getTime() + (pauses[ring - 1] ?? 0)).toISOString() })
    .where('id', '=', notificationId)
    .execute();
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
 * Confirm that a queued ring still belongs to a live, idle, unread recipient on a board task.
 * Archive kills only unclaimed rings; a ring claimed before the archive is dropped here.
 */
export async function ringStillCurrent(
  trx: Trx,
  notificationId: number,
  sessionId: string,
): Promise<'send' | 'defer' | 'dead'> {
  const n = await trx
    .selectFrom('notification')
    .innerJoin('task', 'task.id', 'notification.task_id')
    .selectAll('notification')
    .select('task.membership')
    .where('notification.id', '=', notificationId)
    .executeTakeFirst();
  if (
    n === undefined ||
    n.membership === 'archived' ||
    n.acked_at !== null ||
    n.exhausted_at !== null ||
    n.recipient_session !== sessionId
  )
    return 'dead';
  const session = await selectNotificationRecipient(trx, n);
  if (session?.id !== sessionId) return 'dead';
  return session.state === 'working' ? 'defer' : 'send';
}

/** Whether an inbound author ring (`doorbell:comment:<id>:...`) belongs to an archived task. */
export async function inboundRingTaskArchived(trx: Trx, dedupeKey: string): Promise<boolean> {
  const commentId = /^doorbell:comment:(\d+):/.exec(dedupeKey)?.[1];
  if (commentId === undefined) return false;
  const row = await trx
    .selectFrom('comment')
    .innerJoin('task', 'task.id', 'comment.task_id')
    .select('task.membership')
    .where('comment.id', '=', Number(commentId))
    .executeTakeFirst();
  return row?.membership === 'archived';
}

/** Stop notifications acknowledged by the addressed session. */
export async function acknowledgeNotification(
  trx: Trx,
  input: { blockId?: number; commentId?: number; revision?: number; actor: ActorId; at: Date },
): Promise<boolean> {
  let query = trx.selectFrom('notification').selectAll().where('acked_at', 'is', null);
  if (input.blockId !== undefined)
    query = query.where('block_id', '=', input.blockId).where('kind', '=', 'block');
  else if (input.commentId !== undefined)
    query = query.where('comment_id', '=', input.commentId).where('kind', '=', 'answer');
  else return false;
  const notices = await query.orderBy('id', 'desc').execute();
  const n = notices[0];
  if (n === undefined) return false;
  if (!(await notificationAddressedTo(trx, n, input.actor))) {
    throw new CommandError('forbidden', 'Only the addressed task role can acknowledge.');
  }
  for (const notice of notices) {
    await trx
      .updateTable('notification')
      .set({ acked_at: input.at.toISOString() })
      .where('id', '=', notice.id)
      .execute();
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

/** Use the same current recipient rule when listing and acknowledging an inbox notice. */
export async function notificationAddressedTo(
  trx: Trx,
  n: Notification,
  actor: ActorId,
): Promise<boolean> {
  const parsed = parseActorId(actor);
  if (parsed?.actor !== 'agent') return false;
  const linked = await trx
    .selectFrom('link')
    .select('id')
    .where('task_id', '=', n.task_id)
    .where('entity', '=', 'session')
    .where('role', '=', 'worker')
    .where('banned', '=', 0)
    .where('session_id', '=', parsed.actorRef.session)
    .executeTakeFirst();
  const selectedIsLive =
    n.recipient_session !== null && (await liveSession(trx, n.recipient_session)) !== undefined;
  return n.recipient_session === null
    ? parsed.actorRef.session === n.author_session || linked !== undefined
    : selectedIsLive
      ? parsed.actorRef.session === n.recipient_session
      : (await selectNotificationRecipient(trx, n))?.id === parsed.actorRef.session;
}

export async function closeBlockNotification(trx: Trx, blockId: number, at: Date): Promise<void> {
  const closed = await trx
    .updateTable('notification')
    .set({ acked_at: at.toISOString() })
    .where('block_id', '=', blockId)
    .where('kind', '=', 'block')
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
    if (item !== undefined) await clearItem(trx, item.id, at);
  }
}
