import {
  eventPayloadSchemas,
  parseActorId,
  ticketFactsSchema,
  type ActorId,
  type AddresseeRole,
  type Config,
  type EventKind,
  type EventPayload,
} from '@spur-board/contracts';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { BlockTable, CommentTable, Tables, TaskTable } from '../store/schema.ts';
import { BLOCK_ITEM_KINDS, isItemKind, ITEM_POLICY, type ItemKind } from '../domain/fromYou.ts';
import {
  acknowledgeComment,
  answerBlock,
  blockAddressee,
  BlockRuleError,
  closeBlock,
  editComment,
  escalateBlock,
  parseAddressee,
  priorAddressees,
  type CurrentBlock,
} from '../domain/blocks/blocks.ts';
import { authorize, curatorProject, type ResolvedTarget } from './authorize.ts';
import { authorRole, orchestrator, personaFor, queueBlockOpen } from './block-thread.ts';
import { emit, taskUrl } from './board-utils.ts';
import { CommandError, type CommandContext, type Mutation } from './commands.ts';
import {
  acknowledgeNotification,
  applyDoorbellPolicy,
  closeBlockNotification,
  moveBlockToAddressee,
} from './doorbells.ts';
import { clearItem, dismissItem } from './feed.ts';
import { takeTurn } from './turns.ts';
import {
  enqueueConversationClose,
  enqueueConversationReply,
  enqueueCuratorAnswerLine,
} from './outbox.ts';

type Task = Selectable<TaskTable>;
type Block = Selectable<BlockTable>;
type Comment = Selectable<CommentTable>;
type Trx = Kysely<Tables>;

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

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new CommandError('not_found', 'Check the target ID.');
  return value;
}

function active(task: Task): void {
  if (task.membership === 'archived') {
    throw new CommandError('task_archived', 'Add the task again before changing it.');
  }
}

export async function authorizationTarget(
  trx: Trx,
  task: Task | undefined,
  block?: Block,
): Promise<ResolvedTarget> {
  if (task === undefined) return { kind: 'missing' };
  const workers = await trx
    .selectFrom('link')
    .select(['session_id', 'role', 'banned'])
    .where('task_id', '=', task.id)
    .where('entity', '=', 'session')
    .execute();
  return {
    kind: 'found',
    value: {
      project: task.project,
      task: { id: task.id, column: task.column },
      block:
        block === undefined
          ? null
          : { type: block.type, author: block.author, addressee_role: block.addressee_role },
      workers,
    },
  };
}

export async function taskTarget(trx: Trx, key: string): Promise<readonly ResolvedTarget[]> {
  return [await authorizationTarget(trx, await taskByKey(trx, key))];
}

async function blockTarget(trx: Trx, id: string): Promise<readonly ResolvedTarget[]> {
  const block = await blockById(trx, id);
  return [
    await authorizationTarget(
      trx,
      block === undefined ? undefined : await taskById(trx, block.task_id),
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
  const target = await authorizationTarget(
    trx,
    comment === undefined ? undefined : await taskById(trx, comment.task_id),
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

export function blockView(block: Block, task: Task) {
  return {
    id: blockId(block.id),
    task: task.key,
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

export function commentView(comment: Comment, task: Task) {
  return {
    id: commentId(comment.id),
    task: task.key,
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
  task: Task,
  ctx: CommandContext,
  kind: K,
  payload: EventPayload<K>,
): Promise<void> {
  await emit(trx, kind, task.project, task.id, ctx.at, payload, ctx.actor);
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
    authorRole: authorRole(config, task, block.author),
    column: task.column,
    orchestrator: orchestrator(config, task),
    curator: curatorProject(config, task.project),
    hasWorker: await hasWorker(trx, task),
  });
}

function holdsBlock(config: Config, actor: ActorId, target: ResolvedTarget): boolean {
  return authorize([{ grant: 'block-addressee' }], actor, { config, target }).status === 'allowed';
}

function wroteBlock(config: Config, actor: ActorId, target: ResolvedTarget): boolean {
  return authorize([{ grant: 'block-author' }], actor, { config, target }).status === 'allowed';
}

/** Inserts a comment row and journals `comment_added`; it rings and posts nothing. */
async function insertComment(
  trx: Trx,
  task: Task,
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
      task_id: task.id,
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
  await journal(trx, task, ctx, 'comment_added', {
    comment: commentId(row.id),
    addressee,
    ...(forwardedFrom === undefined ? {} : { forwardedFrom: commentId(forwardedFrom) }),
  });
  return row;
}

async function addComment(
  trx: Trx,
  task: Task,
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
  const row = await insertComment(trx, task, block?.id ?? null, text, ctx, addressee, source);
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
            authorRole: authorRole(config, task, block.author),
            actor: ctx.actor,
          },
      new Date(ctx.at),
    );
  }
  if (block !== undefined && source === undefined) {
    await enqueueConversationReply(trx, {
      commentId: row.id,
      persona: personaFor(config, task, ctx.actor),
      at: new Date(ctx.at),
    });
  }
  return row;
}

export async function openBlock(
  trx: Trx,
  task: Task,
  type: Block['type'],
  reason: string,
  ctx: CommandContext,
  config: Config,
  addressee?: AddresseeRole,
): Promise<Block> {
  addressee ??= await routeBlock(trx, task, { type, author: ctx.actor }, config);
  const row = await trx
    .insertInto('block')
    .values({
      task_id: task.id,
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
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, task, ctx, 'block_opened', { block: blockId(row.id), type, addressee });
  await applyDoorbellPolicy(
    trx,
    { kind: 'block_opened', block: row, authorRole: authorRole(config, task, ctx.actor) },
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
  const block = await openBlock(trx, task, 'needs_input', reason, ctx, config, addressee);
  await queueBlockOpen(trx, task, block, ctx, config);
  return block;
}

/**
 * Copies the answer to a course check to the task as a comment without a block, so the worker
 * reads it in its inbox: the close reason, else the closing actor's newest comment on the block.
 * A copied comment is named in the copy's `comment_added`, so its edits reach the copy.
 */
async function forwardCourseNote(
  trx: Trx,
  task: Task,
  block: Block,
  ctx: CommandContext,
  reason: string | null,
): Promise<void> {
  if (reason !== null) {
    await insertComment(trx, task, null, reason, ctx, 'worker');
    return;
  }
  const answer = await trx
    .selectFrom('comment')
    .select(['id', 'text'])
    .where('block_id', '=', block.id)
    .where('author', '=', ctx.actor)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (answer === undefined) return;
  await insertComment(trx, task, null, answer.text, ctx, 'worker', undefined, answer.id);
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
  task: Task,
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
  await journal(trx, task, ctx, 'comment_edited', {
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
 * close with a reason to a course check also goes to the worker as a task comment.
 */
export async function closeOpenBlock(
  trx: Trx,
  task: Task,
  block: Block,
  ctx: CommandContext,
  outcome: 'done' | 'reason' | 'withdrawn' | 'archived',
  outcomeReason: string | null,
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
  await journal(trx, task, ctx, 'block_unblocked', {
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
  await closeBlockNotification(trx, block.id, new Date(ctx.at), ctx.actor);
  const items = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('kind', 'in', ['post_blocked', ...BLOCK_ITEM_KINDS] satisfies ItemKind[])
    .where('block_id', '=', block.id)
    .where('cleared_at', 'is', null)
    .execute();
  if (
    ctx.actor !== 'system' &&
    (outcome === 'done' || outcome === 'reason') &&
    items.some((item) => item.kind === ('course_check' satisfies ItemKind))
  )
    await forwardCourseNote(trx, task, block, ctx, outcome === 'reason' ? outcomeReason : null);
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
  const task = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', '=', block.task_id)
    .executeTakeFirstOrThrow();
  await closeOpenBlock(trx, task, block, ctx, outcome, outcomeReason);
}

/** Applies an operator message to the block selected by its conversation, without echoing it. */
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
  task: Task;
  answered: boolean;
  authorRole: AddresseeRole;
}> {
  const block = await trx
    .selectFrom('block')
    .selectAll()
    .where('id', '=', input.blockId)
    .executeTakeFirstOrThrow();
  const task = await taskById(trx, block.task_id);
  const ctx: CommandContext = { actor: 'operator', at: input.at };
  const answered = block.state === 'open';
  if (answered) {
    active(task);
    rule(() => {
      answerBlock(current(block));
    });
  }
  const comment = await addComment(
    trx,
    task,
    block,
    input.text,
    ctx,
    authorRole(input.config, task, block.author),
    input.config,
    { source: { conversationRef: input.conversationRef, messageRef: input.messageRef } },
  );
  const updated = answered ? await closeOpenBlock(trx, task, block, ctx, 'done', null) : block;
  return {
    comment,
    block: updated,
    task,
    answered,
    authorRole: authorRole(input.config, task, block.author),
  };
}

/** Uses the same revision and acknowledgment rule as the catalog comment.edit mutation. */
export async function editInboundComment(
  trx: Trx,
  input: { comment: Comment; text: string; at: string; actor: ActorId; config: Config },
): Promise<Comment> {
  const task = await taskById(trx, input.comment.task_id);
  active(task);
  if (input.comment.author !== input.actor) {
    throw new CommandError('forbidden', 'Only the comment author can edit it.');
  }
  const ctx: CommandContext = { actor: input.actor, at: input.at };
  const { updated, clarification } = await reviseComment(trx, task, input.comment, input.text, ctx);
  for (const copy of await forwardedCopies(trx, input.comment.id))
    await reviseComment(trx, task, copy, input.text, ctx);
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
        authorRole: authorRole(input.config, task, block.author),
        actor: input.actor,
      },
      new Date(input.at),
    );
  }
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
  if (authorRole(config, task, ctx.actor) === 'operator') return;
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
  const ask: Mutation<'block.ask'> = {
    id: 'block.ask',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      const block = await openBlock(trx, task, 'needs_input', input.text, ctx, config);
      await addComment(trx, task, block, input.text, ctx, block.addressee_role, config);
      await queueBlockOpen(trx, task, block, ctx, config);
      return { block: blockView(block, task) };
    },
  };
  const create: Mutation<'block.create'> = {
    id: 'block.create',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      const block = await openBlock(trx, task, input.type, input.reason, ctx, config);
      await queueBlockOpen(trx, task, block, ctx, config);
      return { block: blockView(block, task) };
    },
  };
  const escalate: Mutation<'block.escalate'> = {
    id: 'block.escalate',
    async resolveTargets(trx, input, actor) {
      const block = await blockById(trx, input.block);
      if (block === undefined) return blockTarget(trx, input.block);
      const task = await taskById(trx, block.task_id);
      const target = await authorizationTarget(trx, task, block);
      if (target.kind !== 'found' || target.value.block === null) return [target];
      if (holdsBlock(config, actor, target)) return [target];
      const priors = priorAddressees(
        await routeBlock(trx, task, block, config),
        block.addressee_role,
        block.type,
        curatorProject(config, task.project) !== null,
      );
      for (const addressee_role of priors) {
        const prior: ResolvedTarget = {
          kind: 'found',
          value: { ...target.value, block: { ...target.value.block, addressee_role } },
        };
        if (holdsBlock(config, actor, prior)) return [prior];
      }
      return [target];
    },
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const task = await taskById(trx, block.task_id);
      active(task);
      const hasCurator = curatorProject(config, task.project) !== null;
      const next = rule(() => escalateBlock(current(block), hasCurator));
      // A no-op leaves the block as it is but still posts the note to its current thread.
      const unchanged = async () => {
        if (input.note !== undefined) {
          await addComment(trx, task, block, input.note, ctx, block.addressee_role, config, {
            ringsAuthor: false,
          });
        }
        return { block: blockView(block, task) };
      };
      if (!next.changed) return unchanged();
      // An earlier addressee passes authorization to retry; only the current one moves the block.
      const target = await authorizationTarget(trx, task, block);
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
        await addComment(trx, task, updated, input.note, ctx, next.addressee, config, {
          ringsAuthor: false,
        });
      }
      return { block: blockView(updated, task) };
    },
  };
  const answer: Mutation<'block.answer'> = {
    id: 'block.answer',
    resolveTargets: (trx, input) => blockTarget(trx, input.block),
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const task = await taskById(trx, block.task_id);
      active(task);
      rule(() => {
        answerBlock(current(block));
      });
      const role = authorRole(config, task, block.author);
      const comment = await addComment(trx, task, block, input.text, ctx, role, config);
      // Before the close, so a note on a threaded block is a reply that rings nobody.
      if (input.note !== undefined) {
        await addComment(trx, task, block, input.note, ctx, role, config, { ringsAuthor: false });
      }
      const updated = await closeOpenBlock(trx, task, block, ctx, 'done', null);
      await queueCuratorAnswerLine(trx, task, block, comment, input.note, ctx, config);
      return { block: blockView(updated, task), comment: commentView(comment, task) };
    },
  };
  const unblock: Mutation<'block.unblock'> = {
    id: 'block.unblock',
    resolveTargets: (trx, input) => blockTarget(trx, input.block),
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const task = await taskById(trx, block.task_id);
      active(task);
      const target = await authorizationTarget(trx, task, block);
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
        await addComment(trx, task, block, input.answer, ctx, block.addressee_role, config, {
          ringsAuthor: false,
        });
      }
      const updated = await closeOpenBlock(
        trx,
        task,
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
      return { block: blockView(updated, task) };
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
      let addressee: AddresseeRole = 'worker';
      if (block !== undefined) {
        if (ctx.actor !== block.author) {
          addressee = authorRole(config, task, block.author);
        } else if (
          block.outcome === 'done' &&
          block.unblocked_by !== null &&
          block.unblocked_by !== block.author
        ) {
          addressee = authorRole(config, task, block.unblocked_by);
        } else {
          addressee = block.addressee_role;
        }
      }
      const comment = await addComment(trx, task, block, input.text, ctx, addressee, config);
      return { comment: commentView(comment, task) };
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
      const task = await taskById(trx, comment.task_id);
      return { comment: commentView(updated, task) };
    },
  };
  const ack: Mutation<'inbox.ack'> = {
    id: 'inbox.ack',
    async resolveTargets(trx, input) {
      return Promise.all(
        input.entries.map(async ({ id }) => {
          if (id.startsWith('C')) return commentTarget(trx, id);
          if (id.startsWith('T')) return turnTarget(trx, id);
          const targets = await blockTarget(trx, id);
          const target = targets[0];
          return target === undefined ? { kind: 'missing' as const, id } : { ...target, id };
        }),
      );
    },
    async run(trx, input, ctx) {
      for (const entry of input.entries) {
        if (entry.id.startsWith('T')) {
          const taken = await takeTurn(trx, {
            turnId: idNumber(entry.id),
            actor: ctx.actor,
            at: new Date(ctx.at),
            config,
          });
          if (!taken) throw new CommandError('not_found', 'No open turn to take for this ID.');
          continue;
        }
        if (!('revision' in entry)) {
          const block = found(await blockById(trx, entry.id));
          const read = await acknowledgeNotification(trx, {
            blockId: block.id,
            actor: ctx.actor,
            at: new Date(ctx.at),
            config,
          });
          if (!read) throw new CommandError('not_found', 'No unread block notification.');
          continue;
        }
        const comment = found(await commentById(trx, entry.id));
        const task = await taskById(trx, comment.task_id);
        const revision = rule(() => acknowledgeComment(comment.revision, entry.revision));
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
        await journal(trx, task, ctx, 'comment_acked', { comment: entry.id, revision });
      }
      return { acked: input.entries.map(({ id }) => id) };
    },
  };
  return { ask, create, escalate, answer, unblock, add, edit, ack };
}
