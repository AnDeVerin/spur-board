import {
  eventPayloadSchemas,
  parseActorId,
  ticketFactsSchema,
  VIAS,
  type ActorId,
  type AddresseeRole,
  type Config,
  type EventKind,
  type EventPayload,
  type Via,
} from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import type { BlockTable, CommentTable, NotificationTable, TaskTable } from '../store/schema.ts';
import { BLOCK_ITEM_KINDS, isItemKind, ITEM_POLICY, type ItemKind } from '../domain/fromYou.ts';
import {
  acknowledgeComment,
  answerBlock,
  blockAddressee,
  BlockRuleError,
  closeBlock,
  editComment,
  escalateBlock,
  followUpBlock,
  parseAddressee,
  priorAddressees,
  type CurrentBlock,
} from '../domain/blocks/blocks.ts';
import { authorize, curatorProject, projectTarget, type ResolvedTarget } from './authorize.ts';
import { authorRole, orchestrator, personaFor, queueBlockOpen } from './block-thread.ts';
import { emit, openReturnBlock, taskUrl, type Trx } from './board-utils.ts';
import { CommandError, type CommandContext, type Mutation } from './commands.ts';
import {
  acknowledgeNotification,
  ackConversationNotifications,
  applyDoorbellPolicy,
  closeBlockNotification,
  moveBlockToAddressee,
  notificationAddressedTo,
} from './doorbells.ts';
import { clearItem, dismissItem } from './feed.ts';
import {
  blockSubject,
  projectSubject,
  rowSubject,
  taskSubject,
  type BlockSubject,
} from './subject.ts';
import { takeTurn } from './turns.ts';
import {
  enqueueConversationClose,
  enqueueConversationReply,
  enqueueCuratorAnswerLine,
} from './outbox.ts';

type Task = Selectable<TaskTable>;
type Block = Selectable<BlockTable>;
type Comment = Selectable<CommentTable>;
type Notification = Selectable<NotificationTable>;
/** `handled`: nothing new to acknowledge, so the entry is reported under `alreadyHandled`. */
type AckResult = 'acked' | 'handled';

const idNumber = (id: string) => Number(id.slice(1));
const blockId = (id: number) => `B${String(id)}`;
const commentId = (id: number) => `C${String(id)}`;

function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof BlockRuleError) throw new CommandError(error.code, error.message);
    throw error;
  }
}

async function taskByKey(trx: Trx, key: string): Promise<Task | undefined> {
  return trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
}

async function taskById(trx: Trx, id: number): Promise<Task> {
  return trx.selectFrom('task').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function blockById(trx: Trx, id: string): Promise<Block | undefined> {
  return trx.selectFrom('block').selectAll().where('id', '=', idNumber(id)).executeTakeFirst();
}

async function commentById(trx: Trx, id: string): Promise<Comment | undefined> {
  return trx.selectFrom('comment').selectAll().where('id', '=', idNumber(id)).executeTakeFirst();
}

/** The notification a ring ID `N<notification>[-<ring>]` names; the ring part is ignored. */
async function notificationByRingId(trx: Trx, id: string): Promise<Notification | undefined> {
  return trx
    .selectFrom('notification')
    .selectAll()
    .where('id', '=', Number.parseInt(id.slice(1), 10))
    .executeTakeFirst();
}

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new CommandError('not_found', 'Check the target ID.');
  return value;
}

function active(task: Task): void {
  if (task.membership === 'archived') {
    throw new CommandError('task_archived', 'Add the task again before changing it.');
  }
}

/** The authorization target of a subject; a project-level block has no task and no links. */
export async function subjectTarget(
  trx: Trx,
  subject: BlockSubject | undefined,
  block?: Block,
): Promise<ResolvedTarget> {
  if (subject === undefined) return { kind: 'missing' };
  const { task } = subject;
  const workers =
    task === null
      ? []
      : await trx
          .selectFrom('link')
          .select(['session_id', 'role', 'banned'])
          .where('task_id', '=', task.id)
          .where('entity', '=', 'session')
          .execute();
  return {
    kind: 'found',
    value: {
      project: subject.project,
      task: task === null ? null : { id: task.id, column: task.column },
      block:
        block === undefined
          ? null
          : {
              type: block.type,
              author: block.author,
              addressee_role: block.addressee_role,
              addressee_spur_project: block.addressee_spur_project,
            },
      workers,
    },
  };
}

export async function authorizationTarget(
  trx: Trx,
  task: Task | undefined,
  block?: Block,
): Promise<ResolvedTarget> {
  return subjectTarget(trx, task === undefined ? undefined : taskSubject(task), block);
}

export async function taskTarget(trx: Trx, key: string): Promise<readonly ResolvedTarget[]> {
  return [await authorizationTarget(trx, await taskByKey(trx, key))];
}

async function blockTarget(trx: Trx, id: string): Promise<readonly ResolvedTarget[]> {
  const block = await blockById(trx, id);
  return [
    await subjectTarget(
      trx,
      block === undefined ? undefined : await blockSubject(trx, block),
      block,
    ),
  ];
}

async function turnTarget(trx: Trx, id: string): Promise<ResolvedTarget> {
  const turn = await trx
    .selectFrom('turn')
    .select('task_id')
    .where('id', '=', idNumber(id))
    .executeTakeFirst();
  if (turn === undefined) return { kind: 'missing', id };
  return { ...(await authorizationTarget(trx, await taskById(trx, turn.task_id))), id };
}

async function commentTarget(trx: Trx, id: string): Promise<ResolvedTarget> {
  const comment = await commentById(trx, id);
  const target = await subjectTarget(
    trx,
    comment === undefined ? undefined : await rowSubject(trx, comment),
  );
  return { ...target, id };
}

function current(block: Block): CurrentBlock {
  return {
    type: block.type,
    state: block.state,
    outcome: block.outcome,
    unblockedBy: block.unblocked_by,
    author: block.author,
    addressee: block.addressee_role,
  };
}

export function blockView(block: Block, subject: BlockSubject) {
  return {
    id: blockId(block.id),
    task: subject.task?.key ?? null,
    // Only a project-level block names its project: a task block's view keeps its old shape.
    ...(subject.task === null ? { project: subject.project } : {}),
    type: block.type,
    state: block.state,
    author: block.author,
    addressee: block.addressee_role,
    reason: block.reason,
    at: block.created_at,
    outcome: block.outcome,
    outcomeReason: block.outcome_reason,
    unblockedBy: block.unblocked_by,
    unblockedAt: block.unblocked_at,
  };
}

/** A task's blocks, oldest first, each with the `via` of its closing write. */
export async function taskBlockViews(trx: Trx, task: Task) {
  const subject = taskSubject(task);
  const rows = await trx
    .selectFrom('block')
    .selectAll()
    .select(answeredViaColumn)
    .where('task_id', '=', task.id)
    .orderBy('id')
    .execute();
  return rows.map(({ answered_via, ...block }) => ({
    ...blockView(block, subject),
    answeredVia: answeredVia(answered_via),
  }));
}

/**
 * The `via` of the `block_unblocked` event that closed the `block` row in scope: `closeOpenBlock`
 * journals it at the block's `unblocked_at`, so the `event_at` index finds it. Select it from a
 * query over `block` and read the value with `answeredVia`.
 */
export const answeredViaColumn = sql<string | null>`(
  select event.via from event
  where event.kind = 'block_unblocked'
    and event.at = block.unblocked_at
    and json_extract(event.payload, '$.block') = 'B' || block.id
  order by event.id desc limit 1
)`.as('answered_via');

/** The `via` of a block's closing write; null while open or when it came another way. */
export function answeredVia(value: string | null): Via | null {
  return VIAS.find((via) => via === value) ?? null;
}

export function commentView(comment: Comment, subject: BlockSubject) {
  return {
    id: commentId(comment.id),
    task: subject.task?.key ?? null,
    block: comment.block_id === null ? null : blockId(comment.block_id),
    author: comment.author,
    at: comment.created_at,
    text: comment.text,
    revision: comment.revision,
    ackedRevision: comment.acked_revision,
    untrusted: true as const,
  };
}

async function journal<K extends EventKind>(
  trx: Trx,
  subject: BlockSubject,
  ctx: CommandContext,
  kind: K,
  payload: EventPayload<K>,
): Promise<void> {
  await emit(trx, kind, subject.project, subject.task?.id ?? null, ctx.at, payload, ctx.actor);
}

async function hasWorker(trx: Trx, task: Task): Promise<boolean> {
  const link = await trx
    .selectFrom('link')
    .select('id')
    .where('task_id', '=', task.id)
    .where('entity', '=', 'session')
    .where('role', '=', 'worker')
    .where('banned', '=', 0)
    .executeTakeFirst();
  return link !== undefined;
}

/** The addressee a block gets from current config and links. */
async function routeBlock(
  trx: Trx,
  task: Task,
  block: Pick<Block, 'type' | 'author'>,
  config: Config,
): Promise<AddresseeRole> {
  return blockAddressee({
    type: block.type,
    author: block.author,
    authorRole: authorRole(config, taskSubject(task), block.author),
    column: task.column,
    orchestrator: orchestrator(config, task),
    curator: curatorProject(config, task.project),
    hasWorker: await hasWorker(trx, task),
  });
}

function holdsBlock(config: Config, actor: ActorId, target: ResolvedTarget): boolean {
  return authorize([{ grant: 'block-addressee' }], actor, { config, target }).status === 'allowed';
}

/** `target` with its block moved to `role`, to ask who would hold it there. */
function atAddressee(target: ResolvedTarget, role: AddresseeRole): ResolvedTarget {
  if (target.kind !== 'found' || target.value.block === null) return target;
  return {
    kind: 'found',
    value: { ...target.value, block: { ...target.value.block, addressee_role: role } },
  };
}

/** Advances open questions whose persisted author now holds their stored addressee role. */
export async function reconcileQuestionAddressees(
  trx: Trx,
  config: Config,
  at: string,
): Promise<void> {
  const blocks = await trx
    .selectFrom('block')
    .selectAll()
    .where('type', '=', 'needs_input')
    .where('state', '=', 'open')
    .where('task_id', 'is not', null)
    .where('addressee_spur_project', 'is', null)
    .execute();
  for (const block of blocks) {
    if (
      parseActorId(block.author)?.actor !== 'agent' ||
      (block.addressee_role !== 'curator' && !block.addressee_role.startsWith('orchestrator:'))
    )
      continue;
    const subject = await blockSubject(trx, block);
    const { task } = subject;
    if (task === null || task.membership === 'archived') continue;
    const target = await subjectTarget(trx, subject, block);
    if (!holdsBlock(config, block.author, target)) continue;
    const next = escalateBlock(
      current(block),
      curatorProject(config, subject.project) !== null,
      (role) => holdsBlock(config, block.author, atAddressee(target, role)),
    );
    if (!next.changed) continue;
    await moveBlockToAddressee(trx, {
      task,
      block,
      to: next.addressee,
      reason: 'asker_is_addressee',
      ctx: { actor: 'system', at },
      config,
    });
  }
}

function wroteBlock(config: Config, actor: ActorId, target: ResolvedTarget): boolean {
  return authorize([{ grant: 'block-author' }], actor, { config, target }).status === 'allowed';
}

/** Inserts a comment row and journals `comment_added`; it rings and posts nothing. */
export async function insertComment(
  trx: Trx,
  subject: BlockSubject,
  blockId: number | null,
  text: string,
  ctx: CommandContext,
  addressee: AddresseeRole,
  source?: { conversationRef: string; messageRef: string },
  forwardedFrom?: number,
): Promise<Comment> {
  const row = await trx
    .insertInto('comment')
    .values({
      task_id: subject.task?.id ?? null,
      block_id: blockId,
      author: ctx.actor,
      text,
      revision: 1,
      conversation_ref: source?.conversationRef ?? null,
      message_ref: source?.messageRef ?? null,
      acked_revision: null,
      created_at: ctx.at,
      delivery_state: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, subject, ctx, 'comment_added', {
    comment: commentId(row.id),
    addressee,
    ...(forwardedFrom === undefined ? {} : { forwardedFrom: commentId(forwardedFrom) }),
  });
  return row;
}

async function addComment(
  trx: Trx,
  subject: BlockSubject,
  block: Block | undefined,
  text: string,
  ctx: CommandContext,
  addressee: AddresseeRole,
  config: Config,
  options: {
    source?: { conversationRef: string; messageRef: string };
    /** False for a comment that is not an answer to the block's author. */
    ringsAuthor?: boolean;
  } = {},
): Promise<Comment> {
  const { source, ringsAuthor = true } = options;
  const row = await insertComment(trx, subject, block?.id ?? null, text, ctx, addressee, source);
  // A note or a withdrawal comment is not an answer, so it rings nobody.
  if (ringsAuthor) {
    await applyDoorbellPolicy(
      trx,
      block === undefined
        ? { kind: 'task_comment' }
        : {
            kind: 'answer',
            block,
            commentId: row.id,
            revision: row.revision,
            authorRole: authorRole(config, subject, block.author),
            actor: ctx.actor,
          },
      new Date(ctx.at),
    );
  }
  if (block !== undefined && source === undefined) {
    await enqueueConversationReply(trx, {
      commentId: row.id,
      persona: personaFor(config, subject, ctx.actor),
      at: new Date(ctx.at),
    });
  }
  return row;
}

/**
 * Opens a block; a project-level block, which has no task to route by, goes to the operator. An
 * operator conversation names the Spur project it is addressed to, which routes its rings.
 */
export async function openBlock(
  trx: Trx,
  subject: BlockSubject,
  type: Block['type'],
  reason: string,
  ctx: CommandContext,
  config: Config,
  addressee?: AddresseeRole,
  addresseeSpurProject?: string,
): Promise<Block> {
  const { task } = subject;
  addressee ??=
    task === null ? 'operator' : await routeBlock(trx, task, { type, author: ctx.actor }, config);
  const row = await trx
    .insertInto('block')
    .values({
      task_id: task?.id ?? null,
      project: task === null ? subject.project : null,
      type,
      reason,
      author: ctx.actor,
      addressee_role: addressee,
      target_column: null,
      state: 'open',
      outcome: null,
      outcome_reason: null,
      repeat_of: null,
      unblocked_by: null,
      unblocked_at: null,
      created_at: ctx.at,
      addressee_spur_project: addresseeSpurProject ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, subject, ctx, 'block_opened', { block: blockId(row.id), type, addressee });
  await applyDoorbellPolicy(
    trx,
    {
      kind: 'block_opened',
      block: row,
      authorRole: authorRole(config, subject, ctx.actor),
      config,
    },
    new Date(ctx.at),
  );
  return row;
}

/**
 * Opens a `system` question to `addressee` (the operator by default) on a condition the board
 * cannot settle, with its thread once the operator holds it. The caller raises the ledger item
 * that names the block.
 */
export async function openSystemBlock(
  trx: Trx,
  input: { task: Task; reason: string; at: string; config: Config; addressee?: AddresseeRole },
): Promise<Block> {
  const { task, reason, at, config, addressee = 'operator' } = input;
  const ctx: CommandContext = { actor: 'system', at };
  const subject = taskSubject(task);
  const block = await openBlock(trx, subject, 'needs_input', reason, ctx, config, addressee);
  await queueBlockOpen(trx, subject, block, ctx, config);
  return block;
}

/**
 * Copies the answer to a course check to the task as a comment without a block, so the worker
 * reads it in its inbox: the close reason, else `answer`, else the closing actor's newest comment
 * on the block. A copied comment is named in the copy's `comment_added`, so its edits reach the
 * copy. The copy rings the worker, ahead of its other rings on the task (`course_note`). Returns
 * the copy, or undefined when there is no answer to copy.
 */
async function forwardCourseNote(
  trx: Trx,
  task: Task,
  block: Block,
  ctx: CommandContext,
  reason: string | null,
  given: Comment | undefined,
): Promise<Comment | undefined> {
  const answer =
    reason !== null
      ? undefined
      : (given ??
        (await trx
          .selectFrom('comment')
          .select(['id', 'text'])
          .where('block_id', '=', block.id)
          .where('author', '=', ctx.actor)
          .orderBy('id', 'desc')
          .executeTakeFirst()));
  const text = reason ?? answer?.text;
  if (text === undefined) return undefined;
  const copy = await insertComment(
    trx,
    taskSubject(task),
    null,
    text,
    ctx,
    'worker',
    undefined,
    answer?.id,
  );
  await applyDoorbellPolicy(trx, { kind: 'course_note', block, comment: copy }, new Date(ctx.at));
  return copy;
}

/** The comments `forwardCourseNote` copied from comment `id`. */
async function forwardedCopies(trx: Trx, id: number): Promise<Comment[]> {
  const added = await trx
    .selectFrom('event')
    .select('payload')
    .where('kind', '=', 'comment_added')
    .where(sql<boolean>`json_extract(payload, '$.forwardedFrom') = ${commentId(id)}`)
    .execute();
  const ids = added.flatMap(({ payload }) => {
    const parsed = eventPayloadSchemas.comment_added.safeParse(JSON.parse(payload));
    return parsed.success ? [idNumber(parsed.data.comment)] : [];
  });
  if (ids.length === 0) return [];
  return trx.selectFrom('comment').selectAll().where('id', 'in', ids).execute();
}

/** Writes an edit to one comment by the acknowledgment rule, with its `comment_edited`. */
async function reviseComment(
  trx: Trx,
  subject: BlockSubject,
  comment: Comment,
  text: string,
  ctx: CommandContext,
): Promise<{ updated: Comment; clarification: boolean }> {
  const next = editComment(comment.revision, comment.acked_revision);
  const updated = await trx
    .updateTable('comment')
    .set({ text, revision: next.revision })
    .where('id', '=', comment.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, subject, ctx, 'comment_edited', {
    comment: commentId(comment.id),
    revision: next.revision,
    clarification: next.clarification,
  });
  return { updated, clarification: next.clarification };
}

/**
 * Unblocks one block with its journal entry, thread close, doorbell close and item clears. An
 * operator or agent close of a reconciled ledger block dismisses its item, so the condition
 * raises again only once it changes; a `system` or archive close only clears it. An answer or a
 * close with a reason to a course check also goes to the worker as a task comment that rings it
 * first, before the rings the check held; `answer` names the answer when the closing actor also
 * left a note after it.
 */
export async function closeOpenBlock(
  trx: Trx,
  subject: BlockSubject,
  block: Block,
  ctx: CommandContext,
  outcome: 'done' | 'reason' | 'withdrawn' | 'archived',
  outcomeReason: string | null,
  answer?: Comment,
): Promise<Block> {
  const updated = await trx
    .updateTable('block')
    .set({
      state: 'unblocked',
      outcome,
      outcome_reason: outcomeReason,
      unblocked_by: ctx.actor,
      unblocked_at: ctx.at,
    })
    .where('id', '=', block.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, subject, ctx, 'block_unblocked', {
    block: blockId(block.id),
    outcome,
    ...(outcomeReason === null ? {} : { reason: outcomeReason }),
  });
  await enqueueConversationClose(trx, {
    blockId: block.id,
    outcome,
    actor: ctx.actor,
    at: new Date(ctx.at),
  });
  // A conversation's follow-up rings end with it; elsewhere an answer's ring to the asker stays.
  if (block.addressee_spur_project === null)
    await closeBlockNotification(trx, block.id, new Date(ctx.at), ctx.actor);
  else await ackConversationNotifications(trx, block.id, new Date(ctx.at), ctx.actor);
  const items = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('kind', 'in', ['post_blocked', ...BLOCK_ITEM_KINDS] satisfies ItemKind[])
    .where('block_id', '=', block.id)
    .where('cleared_at', 'is', null)
    .execute();
  if (
    subject.task !== null &&
    ctx.actor !== 'system' &&
    (outcome === 'done' || outcome === 'reason') &&
    items.some((item) => item.kind === ('course_check' satisfies ItemKind))
  )
    await forwardCourseNote(
      trx,
      subject.task,
      block,
      ctx,
      outcome === 'reason' ? outcomeReason : null,
      answer,
    );
  for (const item of items) {
    if (item.kind === 'post_blocked') await clearItem(trx, item.id, new Date(ctx.at), ctx.actor);
    else if (
      ctx.actor !== 'system' &&
      outcome !== 'archived' &&
      isItemKind(item.kind) &&
      ITEM_POLICY[item.kind].reconciled
    )
      await dismissItem(trx, item, ctx.actor, new Date(ctx.at));
    else await clearItem(trx, item.id, new Date(ctx.at), ctx.actor);
  }
  return updated;
}

/** Closes block `blockId` through `closeOpenBlock` when it is still open. */
export async function closeBlockIfOpen(
  trx: Trx,
  blockId: number,
  ctx: CommandContext,
  outcome: 'reason' | 'withdrawn',
  outcomeReason: string,
): Promise<void> {
  const block = await trx
    .selectFrom('block')
    .selectAll()
    .where('id', '=', blockId)
    .where('state', '=', 'open')
    .executeTakeFirst();
  if (block === undefined) return;
  await closeOpenBlock(trx, await blockSubject(trx, block), block, ctx, outcome, outcomeReason);
}

/**
 * Closes the open `code` block of the return that opened `turn`'s visit (`openReturnBlock`) as
 * done at `sha`: the turn's submit, once confirmed, answered it. The block stays on the worker
 * when the operator holds the Dev turn, so the operator's submit closes it on the worker's role
 * too; a named orchestrator's does not. A pending submit waits, so a voided one leaves the block
 * to the next submit.
 */
export async function answerReturn(
  trx: Trx,
  task: Task,
  turn: Parameters<typeof openReturnBlock>[1],
  ctx: CommandContext,
  sha: string,
): Promise<void> {
  const roles = turn.role === 'operator' ? (['operator', 'worker'] as const) : [turn.role];
  const block = await openReturnBlock(trx, turn, roles);
  if (block !== undefined) await closeOpenBlock(trx, taskSubject(task), block, ctx, 'done', sha);
}

/** The thread messages that close an operator conversation, compared after trimming. */
const CLOSE_COMMANDS: ReadonlySet<string> = new Set(['close', '✅', ':white_check_mark:']);

/**
 * Applies an operator message to the block selected by its conversation, without echoing it. The
 * first message answers and closes a block; on an operator conversation it is a follow-up that
 * rings the addressee, and only the close command closes it.
 */
export async function recordInboundBlockMessage(
  trx: Trx,
  input: {
    blockId: number;
    text: string;
    conversationRef: string;
    messageRef: string;
    at: string;
    config: Config;
  },
): Promise<{
  comment: Comment;
  block: Block;
  subject: BlockSubject;
  answered: boolean;
  authorRole: AddresseeRole;
}> {
  const block = await trx
    .selectFrom('block')
    .selectAll()
    .where('id', '=', input.blockId)
    .executeTakeFirstOrThrow();
  const subject = await blockSubject(trx, block);
  const ctx: CommandContext = { actor: 'operator', at: input.at };
  const conversation = block.addressee_spur_project !== null;
  const closes = conversation && block.state === 'open' && CLOSE_COMMANDS.has(input.text.trim());
  const answered = block.state === 'open' && !conversation;
  if (answered) {
    if (subject.task !== null) active(subject.task);
    rule(() => {
      answerBlock(current(block));
    });
  }
  const comment = await addComment(
    trx,
    subject,
    block,
    input.text,
    ctx,
    authorRole(input.config, subject, block.author),
    input.config,
    {
      source: { conversationRef: input.conversationRef, messageRef: input.messageRef },
      ringsAuthor: !closes,
    },
  );
  const updated =
    answered || closes ? await closeOpenBlock(trx, subject, block, ctx, 'done', null) : block;
  return {
    comment,
    block: updated,
    subject,
    answered,
    authorRole: authorRole(input.config, subject, block.author),
  };
}

/**
 * `text` without a leading `@<shortName>` token and the space after it; a text that is only the
 * token stays whole. An operator conversation's reason is its opening text stripped this way.
 */
export function stripShortName(text: string, shortName: string): string {
  const prefix = /^@(\S+)\s*/.exec(text);
  if (prefix?.[1] !== shortName) return text;
  const rest = text.slice(prefix[0].length);
  return rest.length === 0 ? text : rest;
}

/**
 * An edit of an open operator conversation's opening message: the block reason follows the new
 * text, and an addressee that already read the conversation is rung once more. Target and scope
 * stay as opened.
 */
async function reviseConversationOpening(
  trx: Trx,
  updated: Comment,
  input: { at: string; actor: ActorId; config: Config },
  subject: BlockSubject,
): Promise<void> {
  if (updated.block_id === null) return;
  const block = await trx
    .selectFrom('block')
    .selectAll()
    .where('id', '=', updated.block_id)
    .executeTakeFirstOrThrow();
  const spur = block.addressee_spur_project;
  if (spur === null || block.state !== 'open') return;
  const opening = await trx
    .selectFrom('comment')
    .select('id')
    .where('block_id', '=', block.id)
    .orderBy('id')
    .executeTakeFirstOrThrow();
  if (opening.id !== updated.id) return;
  const shortName = input.config.projects
    .flatMap((project) => project.spurProjects)
    .find((entry) => entry.name === spur)?.shortName;
  const reason = shortName === undefined ? updated.text : stripShortName(updated.text, shortName);
  const revised = await trx
    .updateTable('block')
    .set({ reason })
    .where('id', '=', block.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const waiting = await trx
    .selectFrom('notification')
    .select('id')
    .where('block_id', '=', block.id)
    .where('kind', 'in', ['block', 'answer'])
    .where('acked_at', 'is', null)
    .executeTakeFirst();
  if (waiting !== undefined) return;
  await applyDoorbellPolicy(
    trx,
    {
      kind: 'answer',
      block: revised,
      commentId: updated.id,
      revision: updated.revision,
      authorRole: authorRole(input.config, subject, block.author),
      actor: input.actor,
    },
    new Date(input.at),
  );
}

/** Uses the same revision and acknowledgment rule as the catalog comment.edit mutation. */
export async function editInboundComment(
  trx: Trx,
  input: { comment: Comment; text: string; at: string; actor: ActorId; config: Config },
): Promise<Comment> {
  const subject = await rowSubject(trx, input.comment);
  if (subject.task !== null) active(subject.task);
  if (input.comment.author !== input.actor) {
    throw new CommandError('forbidden', 'Only the comment author can edit it.');
  }
  const ctx: CommandContext = { actor: input.actor, at: input.at };
  const { updated, clarification } = await reviseComment(
    trx,
    subject,
    input.comment,
    input.text,
    ctx,
  );
  for (const copy of await forwardedCopies(trx, input.comment.id))
    await reviseComment(trx, subject, copy, input.text, ctx);
  // Only a comment that rang as an answer rings again; a note or a withdrawal never did.
  const answered = await trx
    .selectFrom('notification')
    .select('id')
    .where('kind', '=', 'answer')
    .where('comment_id', '=', updated.id)
    .executeTakeFirst();
  if (clarification && updated.block_id !== null && answered !== undefined) {
    const block = await trx
      .selectFrom('block')
      .selectAll()
      .where('id', '=', updated.block_id)
      .executeTakeFirstOrThrow();
    await applyDoorbellPolicy(
      trx,
      {
        kind: 'answer',
        block,
        commentId: updated.id,
        revision: updated.revision,
        authorRole: authorRole(input.config, subject, block.author),
        actor: input.actor,
      },
      new Date(input.at),
    );
  }
  await reviseConversationOpening(trx, updated, input, subject);
  return updated;
}

/** The task's tracker title, or undefined when no readable snapshot has one; never throws. */
async function ticketTitle(trx: Trx, task: Task): Promise<string | undefined> {
  const row = await trx
    .selectFrom('ticket_snapshot')
    .select('detail')
    .where('task_id', '=', task.id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail);
  } catch {
    return undefined;
  }
  const facts = ticketFactsSchema.safeParse(detail);
  return facts.success ? facts.data.title : undefined;
}

/** Posts a curator's answer to the feed; an operator answer is already on the board. */
async function queueCuratorAnswerLine(
  trx: Trx,
  task: Task,
  block: Block,
  answer: Comment,
  note: string | undefined,
  ctx: CommandContext,
  config: Config,
): Promise<void> {
  if (parseAddressee(block.addressee_role).kind !== 'curator') return;
  // An operator conversation is answered in its own thread.
  if (block.addressee_spur_project !== null) return;
  if (authorRole(config, taskSubject(task), ctx.actor) === 'operator') return;
  const curator = parseActorId(ctx.actor);
  if (curator?.actor !== 'agent') return;
  const asker = parseActorId(block.author);
  const question = await trx
    .selectFrom('comment')
    .select('text')
    .where('block_id', '=', block.id)
    .where('id', '<', answer.id)
    .orderBy('id')
    .executeTakeFirst();
  const { project, session } = curator.actorRef;
  const entry = config.projects
    .find((p) => p.id === task.project)
    ?.spurProjects.find((s) => s.role === 'curator' && s.name === project);
  await enqueueCuratorAnswerLine(trx, {
    taskId: task.id,
    key: task.key,
    url: taskUrl(task, config),
    blockId: block.id,
    commentId: answer.id,
    asker:
      asker?.actor === 'agent'
        ? `${asker.actorRef.project}/${asker.actorRef.session}`
        : block.author,
    question: question?.text ?? block.reason,
    answer: answer.text,
    note,
    taskTitle: await ticketTitle(trx, task),
    persona: {
      name: entry?.displayName ?? project,
      role: 'curator',
      ...(entry?.icon === undefined ? {} : { icon: entry.icon }),
    },
    answeredBy: `${project}/${session}`,
    at: new Date(ctx.at),
  });
}

/** Concrete block and comment mutations for the generic apply boundary. */
export function createBlockMutations(config: Config) {
  /** Opens a question block on a subject with the text as its first comment. */
  async function askOn(trx: Trx, subject: BlockSubject, text: string, ctx: CommandContext) {
    const block = await openBlock(trx, subject, 'needs_input', text, ctx, config);
    await addComment(trx, subject, block, text, ctx, block.addressee_role, config);
    await queueBlockOpen(trx, subject, block, ctx, config);
    return { block: blockView(block, subject) };
  }
  const ask: Mutation<'block.ask'> = {
    id: 'block.ask',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      return askOn(trx, taskSubject(task), input.text, ctx);
    },
  };
  const create: Mutation<'block.create'> = {
    id: 'block.create',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      const subject = taskSubject(task);
      const block = await openBlock(trx, subject, input.type, input.reason, ctx, config);
      await queueBlockOpen(trx, subject, block, ctx, config);
      return { block: blockView(block, subject) };
    },
  };
  const escalate: Mutation<'block.escalate'> = {
    id: 'block.escalate',
    async resolveTargets(trx, input, actor) {
      const block = await blockById(trx, input.block);
      if (block === undefined) return blockTarget(trx, input.block);
      const subject = await blockSubject(trx, block);
      const target = await subjectTarget(trx, subject, block);
      if (target.kind !== 'found' || target.value.block === null) return [target];
      if (holdsBlock(config, actor, target)) return [target];
      const { task } = subject;
      // A project-level block has no task to route by, so it has no earlier addressee.
      if (task === null) return [target];
      const priors = priorAddressees(
        await routeBlock(trx, task, block, config),
        block.addressee_role,
        block.type,
        curatorProject(config, task.project) !== null,
      );
      for (const role of priors) {
        const prior = atAddressee(target, role);
        if (holdsBlock(config, actor, prior)) return [prior];
      }
      return [target];
    },
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const subject = await blockSubject(trx, block);
      const { task } = subject;
      if (task !== null) active(task);
      const hasCurator = curatorProject(config, subject.project) !== null;
      const target = await subjectTarget(trx, subject, block);
      const next = rule(() =>
        escalateBlock(current(block), hasCurator, (role) =>
          holdsBlock(config, ctx.actor, atAddressee(target, role)),
        ),
      );
      // A no-op leaves the block as it is but still posts the note to its current thread.
      const unchanged = async () => {
        if (input.note !== undefined) {
          await addComment(trx, subject, block, input.note, ctx, block.addressee_role, config, {
            ringsAuthor: false,
          });
        }
        return { block: blockView(block, subject) };
      };
      // A project-level block is the operator's, which escalates to no one; an operator
      // conversation stays with the Spur project the operator addressed.
      if (!next.changed || task === null || block.addressee_spur_project !== null)
        return unchanged();
      // An earlier addressee passes authorization to retry; only the current one moves the block.
      if (!holdsBlock(config, ctx.actor, target)) return unchanged();
      const updated = await moveBlockToAddressee(trx, {
        task,
        block,
        to: next.addressee,
        ctx,
        config,
      });
      // After the open, so the note is a reply and never replaces the original text at the head.
      if (input.note !== undefined) {
        await addComment(trx, subject, updated, input.note, ctx, next.addressee, config, {
          ringsAuthor: false,
        });
      }
      return { block: blockView(updated, subject) };
    },
  };
  const answer: Mutation<'block.answer'> = {
    id: 'block.answer',
    resolveTargets: (trx, input) => blockTarget(trx, input.block),
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const subject = await blockSubject(trx, block);
      const { task } = subject;
      if (task !== null) active(task);
      rule(() => {
        answerBlock(current(block));
      });
      const role = authorRole(config, subject, block.author);
      // An operator conversation stays open for follow-ups: the answer ends the rings so far,
      // before its comment, so the operator's own answer still rings the addressee.
      const conversation = block.addressee_spur_project !== null;
      if (conversation)
        await ackConversationNotifications(trx, block.id, new Date(ctx.at), ctx.actor);
      const comment = await addComment(trx, subject, block, input.text, ctx, role, config);
      // Before the close, so a note on a threaded block is a reply that rings nobody.
      if (input.note !== undefined) {
        await addComment(trx, subject, block, input.note, ctx, role, config, {
          ringsAuthor: false,
        });
      }
      const updated = conversation
        ? block
        : await closeOpenBlock(trx, subject, block, ctx, 'done', null, comment);
      if (task !== null)
        await queueCuratorAnswerLine(trx, task, block, comment, input.note, ctx, config);
      return { block: blockView(updated, subject), comment: commentView(comment, subject) };
    },
  };
  // Stores what a reply in the block's Slack thread stores: a comment that rings the block's
  // author like an answer, echoed into the thread. The block, its task and turn stay as they are.
  const followup: Mutation<'block.followup'> = {
    id: 'block.followup',
    resolveTargets: (trx, input) => blockTarget(trx, input.block),
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const subject = await blockSubject(trx, block);
      if (subject.task !== null) active(subject.task);
      rule(() => {
        followUpBlock(current(block));
      });
      const role = authorRole(config, subject, block.author);
      const comment = await addComment(trx, subject, block, input.text, ctx, role, config);
      return { comment: commentView(comment, subject) };
    },
  };
  const unblock: Mutation<'block.unblock'> = {
    id: 'block.unblock',
    async resolveTargets(trx, input) {
      const [target] = await blockTarget(trx, input.block);
      if (target?.kind !== 'found' || target.value.block?.addressee_spur_project == null)
        return [target ?? { kind: 'missing' }];
      // Only the operator closes an operator conversation: for unblocking, the operator holds it.
      const block = { ...target.value.block, addressee_role: 'operator' as const };
      return [
        {
          ...target,
          value: { ...target.value, block: { ...block, addressee_spur_project: null } },
        },
      ];
    },
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const subject = await blockSubject(trx, block);
      if (subject.task !== null) active(subject.task);
      const target = await subjectTarget(trx, subject, block);
      const decision = rule(() =>
        input.mode === 'done'
          ? closeBlock(current(block), {
              mode: 'done',
              ...(input.ref === undefined ? {} : { ref: input.ref }),
            })
          : input.mode === 'reason'
            ? closeBlock(current(block), { mode: 'reason', reason: input.reason })
            : closeBlock(current(block), {
                mode: 'withdraw',
                isAuthor: wroteBlock(config, ctx.actor, target),
                reason: input.answer,
              }),
      );
      if (input.mode === 'withdraw') {
        await addComment(trx, subject, block, input.answer, ctx, block.addressee_role, config, {
          ringsAuthor: false,
        });
      }
      const updated = await closeOpenBlock(
        trx,
        subject,
        block,
        ctx,
        decision.outcome,
        decision.outcomeReason,
      );
      const closedByAddressee = input.mode === 'done' || holdsBlock(config, ctx.actor, target);
      await applyDoorbellPolicy(
        trx,
        closedByAddressee
          ? { kind: 'block_closed_by_addressee' }
          : { kind: 'block_removed', block: updated },
        new Date(ctx.at),
      );
      return { block: blockView(updated, subject) };
    },
  };
  const add: Mutation<'comment.add'> = {
    id: 'comment.add',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      const block =
        input.block === undefined ? undefined : found(await blockById(trx, input.block));
      if (block !== undefined && block.task_id !== task.id) {
        throw new CommandError('not_found', 'Block does not belong to this task.');
      }
      const subject = taskSubject(task);
      let addressee: AddresseeRole = 'worker';
      if (block !== undefined) {
        if (ctx.actor !== block.author) {
          addressee = authorRole(config, subject, block.author);
        } else if (
          block.outcome === 'done' &&
          block.unblocked_by !== null &&
          block.unblocked_by !== block.author
        ) {
          addressee = authorRole(config, subject, block.unblocked_by);
        } else {
          addressee = block.addressee_role;
        }
      }
      const comment = await addComment(trx, subject, block, input.text, ctx, addressee, config);
      return { comment: commentView(comment, subject) };
    },
  };
  const edit: Mutation<'comment.edit'> = {
    id: 'comment.edit',
    async resolveTargets(trx, input) {
      return [await commentTarget(trx, input.comment)];
    },
    async run(trx, input, ctx) {
      const comment = found(await commentById(trx, input.comment));
      if (comment.author !== ctx.actor)
        throw new CommandError('forbidden', 'Only the comment author can edit it.');
      const updated = await editInboundComment(trx, {
        comment,
        text: input.text,
        at: ctx.at,
        actor: ctx.actor,
        config,
      });
      return { comment: commentView(updated, await rowSubject(trx, comment)) };
    },
  };
  /** Marks a comment read at `revision` and acks its unread answer notifications. */
  async function ackComment(
    trx: Trx,
    comment: Comment,
    revision: number,
    ctx: CommandContext,
  ): Promise<void> {
    const subject = await rowSubject(trx, comment);
    await acknowledgeNotification(trx, {
      commentId: comment.id,
      revision,
      actor: ctx.actor,
      at: new Date(ctx.at),
      config,
    });
    await trx
      .updateTable('comment')
      .set({ acked_revision: revision })
      .where('id', '=', comment.id)
      .execute();
    await journal(trx, subject, ctx, 'comment_acked', {
      comment: commentId(comment.id),
      revision,
    });
  }

  /** Acks the caller's unread answers of an asked block, then its unread block notification. */
  async function ackBlock(trx: Trx, id: number, ctx: CommandContext): Promise<AckResult> {
    const rows = await trx
      .selectFrom('notification')
      .selectAll()
      .where('block_id', '=', id)
      .where('kind', 'in', ['block', 'answer'])
      .orderBy('id', 'desc')
      .execute();
    const addressed = new Set<number>();
    for (const row of rows) {
      if (await notificationAddressedTo(trx, row, ctx.actor, config)) addressed.add(row.id);
    }
    const answered = new Set<number>();
    for (const row of rows) {
      const unreadAnswer = row.kind === 'answer' && row.acked_at === null;
      if (unreadAnswer && row.comment_id !== null && addressed.has(row.id))
        answered.add(row.comment_id);
    }
    for (const answer of answered) {
      const comment = found(await commentById(trx, commentId(answer)));
      await ackComment(trx, comment, comment.revision, ctx);
    }
    const unread = rows.find((row) => row.kind === 'block' && row.acked_at === null);
    const readsBlock = unread !== undefined && addressed.has(unread.id);
    if (readsBlock)
      await acknowledgeNotification(trx, {
        blockId: id,
        actor: ctx.actor,
        at: new Date(ctx.at),
        config,
      });
    if (answered.size > 0 || readsBlock) return 'acked';
    if (addressed.size > 0) return 'handled';
    if (unread !== undefined)
      throw new CommandError('forbidden', 'Only the addressed task role can acknowledge.');
    throw new CommandError('not_found', 'No unread block notification.');
  }

  /**
   * Takes a turn; a turn the caller took or was rung for before it closed is already handled.
   * Taking the Dev turn of a return also reads the return's open `code` block
   * (`openReturnBlock`), so its rings stop and it never raises `worker_not_reading`.
   */
  async function ackTurn(trx: Trx, id: number, ctx: CommandContext): Promise<AckResult> {
    const at = new Date(ctx.at);
    const taken = await takeTurn(trx, { turnId: id, actor: ctx.actor, at, config });
    if (taken) {
      const turn = await trx
        .selectFrom('turn')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const block = await openReturnBlock(trx, turn);
      // The take already authorized the actor for this visit, so the block is read as a
      // takeover even when its ring went to another linked session of the role.
      if (block !== undefined)
        await acknowledgeNotification(trx, {
          blockId: block.id,
          actor: ctx.actor,
          at,
          config,
          takeover: true,
        });
      return 'acked';
    }
    const turn = await trx.selectFrom('turn').selectAll().where('id', '=', id).executeTakeFirst();
    if (turn?.acked_by === ctx.actor) return 'handled';
    if (turn !== undefined && turn.closed_at !== null) {
      const notice = await trx
        .selectFrom('notification')
        .selectAll()
        .where('turn_id', '=', id)
        .where('kind', '=', 'turn')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (notice !== undefined && (await notificationAddressedTo(trx, notice, ctx.actor, config)))
        return 'handled';
    }
    throw new CommandError('not_found', 'No open turn to take for this ID.');
  }

  /** Acks the item a ring `N<notification>[-<ring>]` was sent for. */
  async function ackRing(trx: Trx, id: string, ctx: CommandContext): Promise<AckResult> {
    const notice = found(await notificationByRingId(trx, id));
    if (notice.kind === 'block' && notice.block_id !== null)
      return ackBlock(trx, notice.block_id, ctx);
    if (notice.kind === 'turn' && notice.turn_id !== null) return ackTurn(trx, notice.turn_id, ctx);
    if (!(await notificationAddressedTo(trx, notice, ctx.actor, config)))
      throw new CommandError('forbidden', 'Only the addressed task role can acknowledge.');
    if (notice.kind === 'answer' && notice.acked_at === null && notice.comment_id !== null) {
      const comment = found(await commentById(trx, commentId(notice.comment_id)));
      await ackComment(trx, comment, comment.revision, ctx);
      return 'acked';
    }
    return 'handled';
  }

  const ack: Mutation<'inbox.ack'> = {
    id: 'inbox.ack',
    async resolveTargets(trx, input) {
      return Promise.all(
        input.entries.map(async ({ id }) => {
          if (id.startsWith('C')) return commentTarget(trx, id);
          if (id.startsWith('T')) return turnTarget(trx, id);
          if (id.startsWith('N')) {
            const notice = await notificationByRingId(trx, id);
            if (notice === undefined) return { kind: 'missing' as const, id };
            return { ...(await subjectTarget(trx, await rowSubject(trx, notice))), id };
          }
          const targets = await blockTarget(trx, id);
          const target = targets[0];
          return target === undefined ? { kind: 'missing' as const, id } : { ...target, id };
        }),
      );
    },
    async run(trx, input, ctx) {
      const alreadyHandled: string[] = [];
      for (const entry of input.entries) {
        let result: AckResult;
        if ('revision' in entry) {
          const comment = found(await commentById(trx, entry.id));
          const revision = rule(() => acknowledgeComment(comment.revision, entry.revision));
          await ackComment(trx, comment, revision, ctx);
          result = 'acked';
        } else if (entry.id.startsWith('T')) result = await ackTurn(trx, idNumber(entry.id), ctx);
        else if (entry.id.startsWith('N')) result = await ackRing(trx, entry.id, ctx);
        else result = await ackBlock(trx, found(await blockById(trx, entry.id)).id, ctx);
        if (result === 'handled') alreadyHandled.push(entry.id);
      }
      const acked = input.entries.map(({ id }) => id);
      return alreadyHandled.length > 0 ? { acked, alreadyHandled } : { acked };
    },
  };
  const projectAsk: Mutation<'project.ask'> = {
    id: 'project.ask',
    resolveTargets: (_trx, input) =>
      Promise.resolve([
        config.projects.some((project) => project.id === input.project)
          ? projectTarget(input.project)
          : { kind: 'missing' as const },
      ]),
    run: (trx, input, ctx) => askOn(trx, projectSubject(input.project), input.text, ctx),
  };
  return { ask, create, escalate, answer, followup, unblock, add, edit, ack, projectAsk };
}
