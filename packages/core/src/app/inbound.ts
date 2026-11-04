import {
  EVENT_VERSION,
  OPERATIONS,
  encodeActorId,
  conversationRefSchema,
  eventPayloadSchemas,
  inboundEventSchema,
  parseActorId,
  messageRefSchema,
  type ActorId,
  type Config,
  type EventKind,
  type Gateway,
  type InboundEvent,
  type RichText,
} from '@spur-board/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  advanceConversationCursor,
  conversationsForRecovery,
  resolveBlockConversation,
} from '../domain/conversations.ts';
import { toJson } from '../store/json.ts';
import type { Row, Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { editInboundComment, recordInboundBlockMessage } from './blocks.ts';
import { replayOperation } from './commands.ts';
import { enqueueConversationClose, enqueueDoorbell, enqueueFeedItem } from './outbox.ts';

type Trx = Kysely<Tables>;
type Item = Row<'from_you_item'>;
type UserEvent = Exclude<InboundEvent, { kind: 'gap' | 'connection' }>;
type MessageEvent = Extract<
  InboundEvent,
  { kind: 'message' | 'mention' | 'message_edited' | 'message_deleted' }
>;
const resultSchema = z.strictObject({
  status: z.enum(['applied', 'ignored', 'denied']),
  response: z.string().optional(),
});
type Result = z.output<typeof resultSchema>;

export interface Inbound {
  sink(event: InboundEvent): Promise<void>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}

function plain(text: string): RichText {
  return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }];
}

async function journal(
  trx: Trx,
  input: {
    kind: EventKind;
    payload: unknown;
    actor: ActorId;
    taskId: number | null;
    project: string;
    at: string;
  },
): Promise<void> {
  const actor = parseActorId(input.actor);
  if (actor === null) throw new Error('Invalid journal actor');
  const schema = eventPayloadSchemas[input.kind];
  await trx
    .insertInto('event')
    .values({
      at: input.at,
      project: input.project,
      task_id: input.taskId,
      kind: input.kind,
      actor: actor.actor,
      actor_ref: actor.actor === 'agent' ? JSON.stringify(actor.actorRef) : null,
      payload: toJson(z.unknown(), schema.parse(input.payload)),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}

async function taskContext(
  trx: Trx,
  event: InboundEvent,
  gateway: string,
): Promise<{ taskId: number | null; project: string; taskKey: string | null }> {
  if (!('conversation' in event) || event.conversation === undefined) {
    return { taskId: null, project: 'board', taskKey: null };
  }
  const row = await trx
    .selectFrom('conversation')
    .leftJoin('task', 'task.id', 'conversation.task_id')
    .select(['conversation.task_id as taskId', 'task.project', 'task.key'])
    .where('conversation.gateway', '=', gateway)
    .where('conversation.ref', '=', event.conversation)
    .executeTakeFirst();
  return {
    taskId: row?.taskId ?? null,
    project: row?.project ?? 'board',
    taskKey: row?.key ?? null,
  };
}

async function raiseItem(
  trx: Trx,
  input: {
    sourceKey: string;
    title: string;
    sourceUrl: string | null;
    event: InboundEvent;
    taskId: number | null;
    project: string;
    taskKey: string | null;
    at: string;
    retry: boolean;
  },
): Promise<Item> {
  const inserted = await trx
    .insertInto('from_you_item')
    .values({
      source_key: input.sourceKey,
      title: input.title,
      source_url: input.sourceUrl,
      event_json: toJson(inboundEventSchema, input.event),
      task_id: input.taskId,
      state: 'open',
      created_at: input.at,
      closed_at: null,
    })
    .onConflict((oc) => oc.column('source_key').doNothing())
    .returningAll()
    .executeTakeFirst();
  const item =
    inserted ??
    (await trx
      .selectFrom('from_you_item')
      .selectAll()
      .where('source_key', '=', input.sourceKey)
      .executeTakeFirstOrThrow());
  if (inserted !== undefined) {
    await journal(trx, {
      kind: 'from_you_raised',
      payload: { item: `I${String(item.id)}` },
      actor: 'system',
      taskId: input.taskId,
      project: input.project,
      at: input.at,
    });
    await enqueueFeedItem(trx, {
      itemId: item.id,
      title: item.title,
      sourceUrl: item.source_url,
      taskId: input.taskId,
      taskKey: input.taskKey,
      at: new Date(input.at),
      retry: input.retry,
    });
  }
  return item;
}

async function deny(
  trx: Trx,
  input: {
    event: UserEvent;
    reason: string;
    actor: ActorId;
    gateway: string;
    at: string;
    privateResponse?: boolean;
  },
): Promise<Result> {
  const context = await taskContext(trx, input.event, input.gateway);
  await journal(trx, {
    kind: 'operation_denied',
    payload: {
      operation: `inbound.${input.event.kind}`,
      reason: input.reason,
      normalizedEvent: input.event,
      ...('author' in input.event ? { platformUser: input.event.author } : {}),
    },
    actor: input.actor,
    taskId: context.taskId,
    project: context.project,
    at: input.at,
  });
  return input.privateResponse
    ? { status: 'denied', response: 'not allowed' }
    : { status: 'ignored' };
}

async function linkedComment(trx: Trx, event: MessageEvent): Promise<Row<'comment'> | undefined> {
  return trx
    .selectFrom('comment')
    .selectAll()
    .where('conversation_ref', '=', event.conversation)
    .where('message_ref', '=', event.message)
    .executeTakeFirst();
}

async function ringAuthor(
  trx: Trx,
  input: {
    event: UserEvent;
    block: Row<'block'>;
    task: Row<'task'>;
    comment: Row<'comment'>;
    at: string;
  },
): Promise<void> {
  const key = `doorbell:comment:${String(input.comment.id)}:revision:${String(input.comment.revision)}`;
  const parsed = parseActorId(input.block.author);
  const session =
    parsed?.actor === 'agent'
      ? await trx
          .selectFrom('session_snapshot')
          .select(['id', 'ended_at'])
          .where('id', '=', parsed.actorRef.session)
          .executeTakeFirst()
      : undefined;
  if (session !== undefined && session.ended_at === null) {
    await enqueueDoorbell(trx, {
      key,
      session: session.id,
      text: `Answer for ${input.task.key} block B${String(input.block.id)}:\n> ${input.comment.text}`,
      at: new Date(input.at),
    });
    return;
  }
  const reason =
    parsed?.actor !== 'agent' ? 'author is not an agent' : 'author session is unavailable';
  await journal(trx, {
    kind: 'doorbell_undelivered',
    payload: { doorbell: key, reason },
    actor: 'system',
    taskId: input.task.id,
    project: input.task.project,
    at: input.at,
  });
  await raiseItem(trx, {
    sourceKey: `doorbell:unavailable:${key}`,
    title: 'Answer author unavailable',
    sourceUrl: input.event.sourceUrl,
    event: input.event,
    taskId: input.task.id,
    project: input.task.project,
    taskKey: input.task.key,
    at: input.at,
    retry: false,
  });
}

export function createInbound(input: {
  store: Store;
  gateway: Gateway;
  config: Config;
  clock?: { now(): number };
}): Inbound {
  const { store, gateway, config } = input;
  const clock = input.clock ?? { now: () => Date.now() };
  let running: Promise<void> = Promise.resolve();

  async function sourceContext(trx: Trx, event: UserEvent, at: string) {
    if (!('conversation' in event)) return undefined;
    const resolved = await resolveBlockConversation(trx, {
      gateway: gateway.kind,
      ref: event.conversation,
      ...(event.originKey === undefined ? {} : { originKey: event.originKey }),
      rootMessage: event.rootMessage,
      at,
    });
    if (resolved?.registered && resolved.conversation.state === 'closed') {
      const block = await trx
        .selectFrom('block')
        .select(['outcome', 'unblocked_by'])
        .where('id', '=', resolved.conversation.block_id ?? -1)
        .executeTakeFirst();
      if (block?.outcome !== null && block?.outcome !== undefined) {
        await enqueueConversationClose(trx, {
          blockId: resolved.conversation.block_id ?? -1,
          outcome: block.outcome,
          actor: block.unblocked_by ?? 'system',
          at: new Date(at),
        });
      }
    }
    return resolved?.conversation;
  }

  async function processMessage(trx: Trx, event: MessageEvent, at: string): Promise<Result> {
    const conversation = await sourceContext(trx, event, at);
    if (conversation?.block_id === null || conversation === undefined) {
      return deny(trx, {
        event,
        reason: 'Unknown board conversation.',
        actor: 'operator',
        gateway: gateway.kind,
        at,
      });
    }
    if (event.kind === 'message' || event.kind === 'mention') {
      const recorded = await recordInboundBlockMessage(trx, {
        blockId: conversation.block_id,
        text: event.text,
        conversationRef: event.conversation,
        messageRef: event.message,
        at: event.at,
        config,
      });
      await advanceConversationCursor(trx, conversation, event.message, event.at);
      await ringAuthor(trx, {
        event,
        block: recorded.block,
        task: recorded.task,
        comment: recorded.comment,
        at,
      });
      return { status: 'applied' };
    }
    const comment = await linkedComment(trx, event);
    if (comment === undefined || comment.author !== 'operator') {
      return deny(trx, {
        event,
        reason: 'Original operator comment not found.',
        actor: 'system',
        gateway: gateway.kind,
        at,
      });
    }
    if (event.kind === 'message_edited') {
      await editInboundComment(trx, { comment, text: event.text, at: event.at, actor: 'operator' });
      return { status: 'applied' };
    }
    const task = await trx
      .selectFrom('task')
      .selectAll()
      .where('id', '=', comment.task_id)
      .executeTakeFirstOrThrow();
    await journal(trx, {
      kind: 'comment_deleted',
      payload: { comment: `C${String(comment.id)}`, normalizedEvent: event },
      actor: 'operator',
      taskId: task.id,
      project: task.project,
      at,
    });
    return { status: 'applied' };
  }

  async function closeItem(trx: Trx, item: Item, at: string): Promise<void> {
    if (item.state === 'closed') return;
    await trx
      .updateTable('from_you_item')
      .set({ state: 'closed', closed_at: at })
      .where('id', '=', item.id)
      .execute();
    const task =
      item.task_id === null
        ? undefined
        : await trx
            .selectFrom('task')
            .select(['project'])
            .where('id', '=', item.task_id)
            .executeTakeFirst();
    await journal(trx, {
      kind: 'from_you_cleared',
      payload: { item: `I${String(item.id)}` },
      actor: 'operator',
      taskId: item.task_id,
      project: task?.project ?? 'board',
      at,
    });
  }

  async function query(trx: Trx, command: string): Promise<string> {
    const parts = command.trim().split(/\s+/);
    const id =
      parts.length === 1 && parts[0] === 'status'
        ? 'status.get'
        : parts.length === 2 && parts[0] === 'task'
          ? 'task.get'
          : parts.length === 3 && parts[0] === 'task' && parts[2] === 'history'
            ? 'task.history'
            : undefined;
    const entry = OPERATIONS.find((candidate) => candidate.id === id);
    if (entry?.kind !== 'query' || entry.slack?.kind !== 'slash-command') {
      return 'Usage: /board status | /board task <KEY> | /board task <KEY> history';
    }
    if (id === 'status.get') {
      const tasks = await trx
        .selectFrom('task')
        .select(['key', 'project', 'column', 'membership'])
        .where('membership', '!=', 'archived')
        .orderBy('id')
        .execute();
      return JSON.stringify(entry.output.parse({ tasks }));
    }
    const key = parts[1];
    if (key === undefined) return 'Usage: /board task <KEY>';
    const task = await trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
    if (task === undefined) return `Task ${key} not found.`;
    const taskView = {
      key: task.key,
      project: task.project,
      column: task.column,
      membership: task.membership,
    };
    if (id === 'task.history') {
      const rows = await trx
        .selectFrom('event')
        .selectAll()
        .where('task_id', '=', task.id)
        .orderBy('id')
        .execute();
      const events = rows.flatMap((row) => {
        const actorRef =
          row.actor_ref === null
            ? undefined
            : (JSON.parse(row.actor_ref) as { project: string; session: string });
        return [
          {
            at: row.at,
            kind: row.kind,
            actor: encodeActorId({ actor: row.actor, actorRef }),
            summary: row.kind,
          },
        ];
      });
      return JSON.stringify(entry.output.parse({ task: taskView, events }));
    }
    const [blocks, comments] = await Promise.all([
      trx.selectFrom('block').selectAll().where('task_id', '=', task.id).orderBy('id').execute(),
      trx.selectFrom('comment').selectAll().where('task_id', '=', task.id).orderBy('id').execute(),
    ]);
    return JSON.stringify(
      entry.output.parse({
        task: taskView,
        blocks: blocks.map((block) => ({
          id: `B${String(block.id)}`,
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
        })),
        comments: comments.map((comment) => ({
          id: `C${String(comment.id)}`,
          task: task.key,
          block: comment.block_id === null ? null : `B${String(comment.block_id)}`,
          author: comment.author,
          at: comment.created_at,
          text: comment.text,
          revision: comment.revision,
          ackedRevision: comment.acked_revision,
          untrusted: true,
        })),
      }),
    );
  }

  async function processAction(
    trx: Trx,
    event: Extract<InboundEvent, { kind: 'action' }>,
    at: string,
  ): Promise<Result> {
    const [id, itemId] = event.actionId.split(':');
    const entry = OPERATIONS.find((candidate) => candidate.id === id);
    if (
      entry?.kind !== 'mutation' ||
      entry.slack?.kind !== 'button' ||
      itemId === undefined ||
      !/^I[1-9]\d*$/.test(itemId)
    ) {
      return deny(trx, {
        event,
        reason: 'Unknown item action.',
        actor: 'operator',
        gateway: gateway.kind,
        at,
        privateResponse: true,
      });
    }
    const item = await trx
      .selectFrom('from_you_item')
      .selectAll()
      .where('id', '=', Number(itemId.slice(1)))
      .executeTakeFirst();
    if (item === undefined) return { status: 'ignored', response: 'Item not found.' };
    if (id === 'item.close') {
      await closeItem(trx, item, at);
      return { status: 'applied', response: 'Item closed.' };
    }
    if (id === 'item.retry') {
      if (item.state === 'closed') return { status: 'ignored', response: 'Item is closed.' };
      const stored = inboundEventSchema.parse(JSON.parse(item.event_json) as unknown);
      if (stored.kind === 'gap' || stored.kind === 'connection') {
        return { status: 'ignored', response: 'Retry is unavailable for this item.' };
      }
      const actor =
        stored.kind === 'message_deleted'
          ? 'operator'
          : stored.author === config.operator.slack
            ? 'operator'
            : 'system';
      await replayOperation(trx, {
        actor,
        key: stored.dedupeKey,
        operation: `inbound.${stored.kind}`,
        fingerprintInput: stored,
        output: resultSchema,
        at,
        run: () => runUser(trx, stored, at),
      });
      await closeItem(trx, item, at);
      return { status: 'applied', response: 'Item retried.' };
    }
    return { status: 'ignored', response: 'Unknown item action.' };
  }

  async function runUser(trx: Trx, event: UserEvent, at: string): Promise<Result> {
    if (event.kind !== 'message_deleted' && event.author !== config.operator.slack) {
      return deny(trx, {
        event,
        reason: 'Only the configured operator may act.',
        actor: 'system',
        gateway: gateway.kind,
        at,
        privateResponse: event.kind === 'action' || event.kind === 'command',
      });
    }
    if (event.kind === 'command') {
      return { status: 'applied', response: await query(trx, event.text) };
    }
    if (event.kind === 'action') return processAction(trx, event, at);
    return processMessage(trx, event, at);
  }

  function operationId(event: UserEvent): string {
    if (event.kind === 'action') {
      const id = event.actionId.split(':', 1)[0];
      return OPERATIONS.some((entry) => entry.id === id && entry.slack?.kind === 'button')
        ? (id ?? 'inbound.action')
        : 'inbound.action';
    }
    if (event.kind === 'command') {
      const parts = event.text.trim().split(/\s+/);
      if (parts.length === 1 && parts[0] === 'status') return 'status.get';
      if (parts.length === 2 && parts[0] === 'task') return 'task.get';
      if (parts.length === 3 && parts[0] === 'task' && parts[2] === 'history')
        return 'task.history';
    }
    return `inbound.${event.kind}`;
  }

  async function applyUser(event: UserEvent): Promise<void> {
    const at = new Date(clock.now()).toISOString();
    const actor: ActorId =
      event.kind === 'message_deleted' || event.author === config.operator.slack
        ? 'operator'
        : 'system';
    try {
      const result = await store.transaction((trx) =>
        replayOperation(trx, {
          actor,
          key: event.dedupeKey,
          operation: operationId(event),
          fingerprintInput: event,
          output: resultSchema,
          at,
          run: () => runUser(trx, event, at),
        }),
      );
      if (result?.response !== undefined && 'interaction' in event) {
        try {
          await gateway.respond(event.interaction, plain(result.response), { private: true });
        } catch {
          // The input already committed; an ephemeral response failure must not replay it.
        }
      }
    } catch (error) {
      await store.transaction(async (trx) => {
        const context = await taskContext(trx, event, gateway.kind);
        await journal(trx, {
          kind: 'inbound_failed',
          payload: {
            gateway: gateway.kind,
            reason: error instanceof Error ? error.message : String(error),
            normalizedEvent: event,
          },
          actor: 'system',
          taskId: context.taskId,
          project: context.project,
          at,
        });
        await raiseItem(trx, {
          sourceKey: `inbound:failure:${event.dedupeKey}`,
          title: 'Slack message not processed',
          sourceUrl: event.sourceUrl,
          event,
          taskId: context.taskId,
          project: context.project,
          taskKey: context.taskKey,
          at,
          retry: true,
        });
      });
    }
  }

  async function applyGap(event: Extract<InboundEvent, { kind: 'gap' }>): Promise<void> {
    const at = new Date(clock.now()).toISOString();
    await store.transaction(async (trx) => {
      const context = await taskContext(trx, event, gateway.kind);
      const conversation =
        event.conversation === undefined
          ? undefined
          : await trx
              .selectFrom('conversation')
              .select(['root_message_ref'])
              .where('gateway', '=', gateway.kind)
              .where('ref', '=', event.conversation)
              .executeTakeFirst();
      const opened =
        conversation === undefined
          ? undefined
          : await trx
              .selectFrom('outbox')
              .select('external_ref')
              .where('kind', '=', 'conversation.open')
              .where('state', '=', 'done')
              .where(
                sql<string>`json_extract(external_ref, '$.message')`,
                '=',
                conversation.root_message_ref,
              )
              .orderBy('id', 'desc')
              .executeTakeFirst();
      const ref =
        opened?.external_ref === null || opened?.external_ref === undefined
          ? undefined
          : (JSON.parse(opened.external_ref) as { permalink?: string });
      await raiseItem(trx, {
        sourceKey: `inbound:gap:${event.dedupeKey}`,
        title: 'repeat your answer',
        sourceUrl: ref?.permalink ?? null,
        event,
        taskId: context.taskId,
        project: context.project,
        taskKey: context.taskKey,
        at,
        retry: false,
      });
    });
  }

  async function applyEvent(event: InboundEvent): Promise<void> {
    if (event.kind === 'connection') {
      if (event.state === 'up') await scan();
      return;
    }
    if (event.kind === 'gap') return applyGap(event);
    return applyUser(event);
  }

  async function scan(): Promise<void> {
    const selected = await conversationsForRecovery(store.db, gateway.kind, new Date(clock.now()));
    const conversations = selected.rows.map((row) => ({
      ref: conversationRefSchema.parse(row.ref),
      ...(row.after_message_ref === null
        ? {}
        : { after: messageRefSchema.parse(row.after_message_ref) }),
    }));
    for await (const event of gateway.recover({ conversations, since: selected.since })) {
      await applyEvent(event);
    }
  }

  function serial(work: () => Promise<void>): Promise<void> {
    const next = running.then(work);
    running = next.catch(() => undefined);
    return next;
  }

  return {
    sink(event) {
      return serial(() => applyEvent(event));
    },
    recover() {
      return serial(scan);
    },
    stop() {
      return running;
    },
  };
}

export async function getFromYouItem(store: Store, id: number): Promise<Item | undefined> {
  return store.db.selectFrom('from_you_item').selectAll().where('id', '=', id).executeTakeFirst();
}
