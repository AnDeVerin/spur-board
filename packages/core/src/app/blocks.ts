import {
  EVENT_VERSION,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
  type AddresseeRole,
  type Config,
  type EventKind,
  type EventPayload,
  type Persona,
} from '@spur-board/contracts';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import { toJson } from '../store/json.ts';
import type { BlockTable, CommentTable, Tables, TaskTable } from '../store/schema.ts';
import {
  acknowledgeComment,
  answerBlock,
  blockAddressee,
  BlockRuleError,
  closeBlock,
  editComment,
  escalateBlock,
  type CurrentBlock,
} from '../domain/blocks/blocks.ts';
import { authorize, type ResolvedTarget } from './authorize.ts';
import { CommandError, type CommandContext, type Mutation } from './commands.ts';
import {
  acknowledgeNotification,
  closeBlockNotification,
  registerAnswerNotification,
  registerBlockNotification,
} from './doorbells.ts';
import { clearItem } from './feed.ts';
import { enqueueConversationOpen, enqueueConversationReply } from './outbox.ts';
import { enqueueConversationClose } from './outbox.ts';

type Task = Selectable<TaskTable>;
type Block = Selectable<BlockTable>;
type Comment = Selectable<CommentTable>;
type Trx = Kysely<Tables>;

const actorRefSchema = z.strictObject({ project: z.string().min(1), session: z.string().min(1) });
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
  const actor = parseActorId(ctx.actor);
  if (actor === null) throw new Error('Invalid actor');
  await trx
    .insertInto('event')
    .values({
      at: ctx.at,
      project: task.project,
      task_id: task.id,
      kind,
      actor: actor.actor,
      actor_ref: actor.actor === 'agent' ? toJson(actorRefSchema, actor.actorRef) : null,
      payload: toJson(eventPayloadSchemas[kind], payload),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}

function orchestrator(config: Config, task: Task): string | null {
  const name = config.projects
    .find((project) => project.id === task.project)
    ?.columns.find((column) => column.id === task.column)?.orchestrator;
  return name === undefined || name === 'none' ? null : name;
}

function authorRole(config: Config, task: Task, actor: ActorId): AddresseeRole {
  if (actor === 'operator') return 'operator';
  const parsed = parseActorId(actor);
  if (
    parsed?.actor === 'agent' &&
    config.projects.some((project) =>
      project.spurProjects.some(
        (spur) => spur.name === parsed.actorRef.project && spur.role === 'operator',
      ),
    )
  ) {
    return 'operator';
  }
  const configured = orchestrator(config, task);
  return parsed?.actor === 'agent' && parsed.actorRef.project === configured
    ? `orchestrator:${task.column}`
    : 'worker';
}

function personaFor(config: Config, task: Task, actor: ActorId): Persona {
  if (actor === 'system') return { name: 'board', role: 'board' };
  if (actor === 'operator') return { name: 'operator', role: 'board' };
  const parsed = parseActorId(actor);
  if (parsed?.actor !== 'agent') throw new Error('Invalid actor');
  const role = authorRole(config, task, actor);
  return {
    name: parsed.actorRef.project,
    role: role === 'operator' ? 'board' : role === 'worker' ? 'worker' : 'orchestrator',
  };
}

async function queueBlockOpen(
  trx: Trx,
  task: Task,
  block: Block,
  ctx: CommandContext,
  config: Config,
): Promise<void> {
  if (authorRole(config, task, block.author) === 'operator') return;
  const comments = await trx
    .selectFrom('comment')
    .select(['id', 'author'])
    .where('block_id', '=', block.id)
    .orderBy('id')
    .execute();
  const opened = await enqueueConversationOpen(trx, {
    blockId: block.id,
    commentId: comments[0]?.id ?? null,
    persona: personaFor(config, task, comments[0]?.author ?? block.author),
    at: new Date(ctx.at),
  });
  if (opened === null) return;
  for (const comment of comments.slice(1)) {
    await enqueueConversationReply(trx, {
      commentId: comment.id,
      persona: personaFor(config, task, comment.author),
      at: new Date(ctx.at),
    });
  }
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

async function addComment(
  trx: Trx,
  task: Task,
  block: Block | undefined,
  text: string,
  ctx: CommandContext,
  addressee: AddresseeRole,
  config: Config,
  source?: { conversationRef: string; messageRef: string },
): Promise<Comment> {
  const row = await trx
    .insertInto('comment')
    .values({
      task_id: task.id,
      block_id: block?.id ?? null,
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
  await journal(trx, task, ctx, 'comment_added', { comment: commentId(row.id), addressee });
  if (block !== undefined && source === undefined && ctx.actor !== block.author) {
    await registerAnswerNotification(trx, {
      block,
      commentId: row.id,
      revision: row.revision,
      authorRole: authorRole(config, task, block.author),
      at: new Date(ctx.at),
    });
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

async function openBlock(
  trx: Trx,
  task: Task,
  type: Block['type'],
  reason: string,
  ctx: CommandContext,
  config: Config,
): Promise<Block> {
  const addressee = blockAddressee({
    type,
    author: ctx.actor,
    authorRole: authorRole(config, task, ctx.actor),
    column: task.column,
    orchestrator: orchestrator(config, task),
    hasWorker: await hasWorker(trx, task),
  });
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
  await registerBlockNotification(trx, row, new Date(ctx.at));
  return row;
}

async function close(
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
  await closeBlockNotification(trx, block.id, new Date(ctx.at));
  const blockedItems = await trx
    .selectFrom('operator_item')
    .select('id')
    .where('kind', '=', 'post_blocked')
    .where('block_id', '=', block.id)
    .where('cleared_at', 'is', null)
    .execute();
  for (const item of blockedItems) await clearItem(trx, item.id, new Date(ctx.at));
  return updated;
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
  workerAuthor: boolean;
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
    { conversationRef: input.conversationRef, messageRef: input.messageRef },
  );
  const updated = answered ? await close(trx, task, block, ctx, 'done', null) : block;
  return {
    comment,
    block: updated,
    task,
    answered,
    workerAuthor: authorRole(input.config, task, block.author) === 'worker',
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
  const next = editComment(input.comment.revision, input.comment.acked_revision);
  const updated = await trx
    .updateTable('comment')
    .set({ text: input.text, revision: next.revision })
    .where('id', '=', input.comment.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, task, { actor: input.actor, at: input.at }, 'comment_edited', {
    comment: commentId(input.comment.id),
    revision: next.revision,
    clarification: next.clarification,
  });
  if (next.clarification && updated.block_id !== null) {
    const block = await trx
      .selectFrom('block')
      .selectAll()
      .where('id', '=', updated.block_id)
      .executeTakeFirstOrThrow();
    if (input.actor !== block.author) {
      await registerAnswerNotification(trx, {
        block,
        commentId: updated.id,
        revision: updated.revision,
        authorRole: authorRole(input.config, task, block.author),
        at: new Date(input.at),
      });
    }
  }
  return updated;
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
      if (block === undefined || block.addressee_role !== 'operator') {
        return blockTarget(trx, input.block);
      }
      const task = await taskById(trx, block.task_id);
      const target = await authorizationTarget(trx, task, block);
      if (target.kind !== 'found' || target.value.block === null) return [target];
      const original = blockAddressee({
        type: block.type,
        author: block.author,
        authorRole: authorRole(config, task, block.author),
        column: task.column,
        orchestrator: orchestrator(config, task),
        hasWorker: block.author === 'system' && (await hasWorker(trx, task)),
      });
      if (original === 'operator') return [target];
      const originalTarget: ResolvedTarget = {
        kind: 'found',
        value: {
          ...target.value,
          block: { ...target.value.block, addressee_role: original },
        },
      };
      const originalAllowed = authorize([{ grant: 'block-addressee' }], actor, {
        config,
        target: originalTarget,
      });
      return [originalAllowed.status === 'allowed' ? originalTarget : target];
    },
    async run(trx, input, ctx) {
      const block = found(await blockById(trx, input.block));
      const task = await taskById(trx, block.task_id);
      active(task);
      const next = rule(() => escalateBlock(current(block)));
      if (!next.changed) return { block: blockView(block, task) };
      const updated = await trx
        .updateTable('block')
        .set({ addressee_role: next.addressee })
        .where('id', '=', block.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await journal(trx, task, ctx, 'block_escalated', {
        block: input.block,
        from: block.addressee_role,
        to: next.addressee,
      });
      await closeBlockNotification(trx, block.id, new Date(ctx.at));
      await queueBlockOpen(trx, task, updated, ctx, config);
      await registerBlockNotification(trx, updated, new Date(ctx.at));
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
      const comment = await addComment(
        trx,
        task,
        block,
        input.text,
        ctx,
        authorRole(config, task, block.author),
        config,
      );
      const updated = await close(trx, task, block, ctx, 'done', null);
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
      const decision = rule(() =>
        input.mode === 'done'
          ? closeBlock(current(block), {
              mode: 'done',
              ...(input.ref === undefined ? {} : { ref: input.ref }),
            })
          : input.mode === 'reason'
            ? closeBlock(current(block), { mode: 'reason', reason: input.reason })
            : closeBlock(current(block), { mode: 'withdraw', actor: ctx.actor }),
      );
      if (input.mode === 'withdraw') {
        await addComment(trx, task, block, input.answer, ctx, block.addressee_role, config);
      }
      const updated = await close(trx, task, block, ctx, decision.outcome, decision.outcomeReason);
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
  const archive: Mutation<'task.archive'> = {
    id: 'task.archive',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      const blocks = await trx
        .selectFrom('block')
        .selectAll()
        .where('task_id', '=', task.id)
        .where('state', '=', 'open')
        .execute();
      for (const block of blocks) {
        await close(trx, task, block, ctx, 'archived', null);
      }
      const updated = await trx
        .updateTable('task')
        .set({ membership: 'archived', archive_reason: 'manual' })
        .where('id', '=', task.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await journal(trx, task, ctx, 'task_archived', { reason: 'manual' });
      return {
        task: {
          key: updated.key,
          project: updated.project,
          column: updated.column,
          membership: updated.membership,
        },
      };
    },
  };
  const ack: Mutation<'inbox.ack'> = {
    id: 'inbox.ack',
    async resolveTargets(trx, input) {
      return Promise.all(
        input.entries.map(async ({ id }) => {
          if (id.startsWith('C')) return commentTarget(trx, id);
          const targets = await blockTarget(trx, id);
          const target = targets[0];
          return target === undefined ? { kind: 'missing' as const, id } : { ...target, id };
        }),
      );
    },
    async run(trx, input, ctx) {
      for (const entry of input.entries) {
        if (!('revision' in entry)) {
          const block = found(await blockById(trx, entry.id));
          const read = await acknowledgeNotification(trx, {
            blockId: block.id,
            actor: ctx.actor,
            at: new Date(ctx.at),
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
  return { ask, create, escalate, answer, unblock, add, edit, ack, archive };
}
