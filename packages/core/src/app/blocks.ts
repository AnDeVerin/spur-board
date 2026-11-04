import {
  EVENT_VERSION,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
  type AddresseeRole,
  type Config,
  type EventKind,
  type EventPayload,
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
import type { ResolvedTarget } from './authorize.ts';
import { CommandError, type CommandContext, type Mutation } from './commands.ts';

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

async function authorizationTarget(
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

async function taskTarget(trx: Trx, key: string): Promise<readonly ResolvedTarget[]> {
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

function blockView(block: Block, task: Task) {
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

function commentView(comment: Comment, task: Task) {
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
  const project = config.projects.find((entry) => entry.id === task.project);
  if (
    parsed?.actor === 'agent' &&
    project?.spurProjects.some(
      (spur) => spur.name === parsed.actorRef.project && spur.role === 'operator',
    )
  ) {
    return 'operator';
  }
  const configured = orchestrator(config, task);
  return parsed?.actor === 'agent' && parsed.actorRef.project === configured
    ? `orchestrator:${task.column}`
    : 'worker';
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
): Promise<Comment> {
  const row = await trx
    .insertInto('comment')
    .values({
      task_id: task.id,
      block_id: block?.id ?? null,
      author: ctx.actor,
      text,
      revision: 1,
      conversation_ref: null,
      message_ref: null,
      acked_revision: null,
      created_at: ctx.at,
      delivery_state: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, task, ctx, 'comment_added', { comment: commentId(row.id), addressee });
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
  return row;
}

async function close(
  trx: Trx,
  task: Task,
  block: Block,
  ctx: CommandContext,
  outcome: 'done' | 'reason' | 'withdrawn',
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
      await addComment(trx, task, block, input.text, ctx, block.addressee_role);
      return { block: blockView(block, task) };
    },
  };
  const create: Mutation<'block.create'> = {
    id: 'block.create',
    resolveTargets: (trx, input) => taskTarget(trx, input.task),
    async run(trx, input, ctx) {
      const task = found(await taskByKey(trx, input.task));
      active(task);
      return {
        block: blockView(await openBlock(trx, task, input.type, input.reason, ctx, config), task),
      };
    },
  };
  const escalate: Mutation<'block.escalate'> = {
    id: 'block.escalate',
    resolveTargets: (trx, input) => blockTarget(trx, input.block),
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
        await addComment(trx, task, block, input.answer, ctx, block.addressee_role);
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
      const addressee = block?.addressee_role ?? 'worker';
      const comment = await addComment(trx, task, block, input.text, ctx, addressee);
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
      const task = await taskById(trx, comment.task_id);
      active(task);
      if (comment.author !== ctx.actor)
        throw new CommandError('forbidden', 'Only the comment author can edit it.');
      const next = editComment(comment.revision, comment.acked_revision);
      const updated = await trx
        .updateTable('comment')
        .set({ text: input.text, revision: next.revision })
        .where('id', '=', comment.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await journal(trx, task, ctx, 'comment_edited', {
        comment: input.comment,
        revision: next.revision,
        clarification: next.clarification,
      });
      return { comment: commentView(updated, task) };
    },
  };
  const ack: Mutation<'inbox.ack'> = {
    id: 'inbox.ack',
    async resolveTargets(trx, input) {
      return Promise.all(input.entries.map(({ id }) => commentTarget(trx, id)));
    },
    async run(trx, input, ctx) {
      for (const entry of input.entries) {
        const comment = found(await commentById(trx, entry.id));
        const task = await taskById(trx, comment.task_id);
        const revision = rule(() => acknowledgeComment(comment.revision, entry.revision));
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
