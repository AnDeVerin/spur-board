import { scanTransaction } from './secrets.ts';
import { createHash } from 'node:crypto';
import {
  EVENT_VERSION,
  ERRORS,
  OPERATIONS,
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
  type OperationId,
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
import { registerAnswerNotification, selectNotificationRecipient } from './doorbells.ts';
import { replayOperation } from './commands.ts';
import { CommandError } from './commands.ts';
import { commandReply } from './command-replies.ts';
import { raiseItem as raiseOperatorItem, clearItem as clearOperatorItem } from './feed.ts';
import { dispatchOperation, type OperationRegistry } from './operations.ts';
import { enqueueConversationClose, enqueueInboundDoorbell } from './outbox.ts';
import { redactPrivateReply, redactSecretMatches } from './secrets.ts';
import { decideTokenInTransaction } from './tokens.ts';

type Trx = Kysely<Tables>;
type Item = Row<'operator_item'>;
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
  retryStored(itemId: number): Promise<void>;
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

async function raiseInboundItem(
  trx: Trx,
  input: {
    sourceKey: string;
    title: string;
    sourceUrl: string | null;
    event: InboundEvent;
    taskId: number | null;
    at: string;
    retry: boolean;
  },
): Promise<Item> {
  const item = await raiseOperatorItem(trx, {
    itemKey: input.sourceKey,
    kind: input.retry
      ? 'inbound_failure'
      : input.event.kind === 'gap'
        ? 'inbound_gap'
        : 'answer_author_unavailable',
    text: input.title,
    url: input.sourceUrl ?? '',
    taskId: input.taskId,
    blockId: null,
    at: new Date(input.at),
  });
  if (input.retry && item.inbound_event_json === null) {
    await trx
      .updateTable('operator_item')
      .set({ inbound_event_json: toJson(inboundEventSchema, input.event) })
      .where('id', '=', item.id)
      .execute();
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
    workerAuthor: boolean;
    at: string;
  },
): Promise<void> {
  const key = `doorbell:comment:${String(input.comment.id)}:revision:${String(input.comment.revision)}`;
  const parsed = parseActorId(input.block.author);
  if (parsed?.actor === 'agent') {
    if (input.workerAuthor) {
      const recipient = await selectNotificationRecipient(trx, {
        task_id: input.task.id,
        role: 'worker',
        author_session: parsed.actorRef.session,
      });
      await registerAnswerNotification(trx, {
        block: input.block,
        commentId: input.comment.id,
        revision: input.comment.revision,
        authorRole: 'worker',
        at: new Date(input.at),
      });
      if (recipient !== undefined) return;
    } else {
      const session = await trx
        .selectFrom('session_snapshot')
        .select(['id', 'ended_at'])
        .where('id', '=', parsed.actorRef.session)
        .executeTakeFirst();
      if (session !== undefined && session.ended_at === null) {
        await enqueueInboundDoorbell(trx, {
          key,
          session: session.id,
          text: `Answer for ${input.task.key} block B${String(input.block.id)}; read board task ${input.task.key}`,
          at: new Date(input.at),
        });
        return;
      }
    }
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
  await raiseInboundItem(trx, {
    sourceKey: `doorbell:unavailable:${key}`,
    title: 'Answer author unavailable',
    sourceUrl: input.event.sourceUrl,
    event: input.event,
    taskId: input.task.id,
    at: input.at,
    retry: false,
  });
}

export function createInbound(input: {
  store: Store;
  gateway: Gateway;
  config: Config;
  clock?: { now(): number };
  registry?: OperationRegistry;
}): Inbound {
  const { store, gateway, config } = input;
  const clock = input.clock ?? { now: () => Date.now() };
  const registry = input.registry ?? {};
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
        workerAuthor: recorded.workerAuthor,
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
      await editInboundComment(trx, {
        comment,
        text: event.text,
        at: event.at,
        actor: 'operator',
        config,
      });
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

  async function retryStoredInbound(trx: Trx, itemId: number, at: string): Promise<void> {
    const item = await trx
      .selectFrom('operator_item')
      .selectAll()
      .where('id', '=', itemId)
      .executeTakeFirst();
    if (item === undefined || item.cleared_at !== null || item.inbound_event_json === null) {
      throw new CommandError('retry_not_applicable', 'This item has no stored event to retry.');
    }
    const stored = inboundEventSchema.parse(JSON.parse(item.inbound_event_json) as unknown);
    if (stored.kind === 'gap' || stored.kind === 'connection') {
      throw new CommandError('retry_not_applicable', 'This event cannot be retried.');
    }
    const actor: ActorId =
      stored.kind === 'message_deleted' || stored.author === config.operator.slack
        ? 'operator'
        : 'system';
    await replayOperation(trx, {
      actor,
      key: stored.dedupeKey,
      operation: operationId(stored),
      fingerprintInput: stored,
      output: resultSchema,
      at,
      run: () => runUser(trx, stored, at),
    });
    await clearOperatorItem(trx, item.id, new Date(at));
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
    if (event.kind === 'action' || event.kind === 'command') {
      const allowed = event.kind === 'action' ? event.sourceSpace !== null : true;
      if (!allowed)
        return deny(trx, {
          event,
          reason: 'Interaction came from outside a board space.',
          actor: 'operator',
          gateway: gateway.kind,
          at,
          privateResponse: true,
        });
    }
    if (event.kind === 'command') {
      return { status: 'applied', response: 'not available yet' };
    }
    if (event.kind === 'action') return { status: 'applied', response: 'not available yet' };
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
      return interactionOperation(event).id ?? 'inbound.command';
    }
    return `inbound.${event.kind}`;
  }

  /** Decode command text only for events stored before parsed selections were added. */
  function legacyCommand(
    text: string,
  ): NonNullable<Extract<UserEvent, { kind: 'command' }>['command']> | null {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'status')) {
      return { kind: 'query', id: 'status.get', input: {} };
    }
    if (parts[0] === 'task' && parts[1] !== undefined) {
      if (parts.length === 2) {
        return { kind: 'query', id: 'task.get', input: { task: parts[1] } };
      }
      if (parts.length === 3 && parts[2] === 'history') {
        return { kind: 'query', id: 'task.history', input: { task: parts[1] } };
      }
    }
    return null;
  }

  function interactionOperation(event: Extract<UserEvent, { kind: 'command' | 'action' }>): {
    id: OperationId | undefined;
    operationInput: unknown;
  } {
    let id: OperationId | undefined;
    let operationInput: unknown;
    if (event.kind === 'command') {
      const command = event.command;
      if (command?.kind === 'query') {
        const operation = OPERATIONS.find((entry) => entry.id === command.id);
        if (operation?.kind === 'query' && operation.slack?.kind === 'slash-command') {
          const parsed = operation.input.safeParse(command.input);
          if (parsed.success) {
            id = operation.id;
            operationInput = parsed.data;
          }
        }
      }
    } else {
      const parts = event.actionId.split(':');
      if (parts.length === 2 && /^I[1-9]\d*$/.test(parts[1] ?? '')) {
        id = parts[0] === 'item.close' || parts[0] === 'item.retry' ? parts[0] : undefined;
        operationInput = { item: parts[1] };
      } else if (parts.length === 3 && parts[0] === 'item' && /^[1-9]\d*$/.test(parts[1] ?? '')) {
        id = parts[2] === 'close' ? 'item.close' : parts[2] === 'retry' ? 'item.retry' : undefined;
        operationInput = { item: `I${parts[1] ?? ''}` };
      }
    }
    return { id, operationInput };
  }

  function tokenAction(event: Extract<UserEvent, { kind: 'action' }>): {
    itemId: number;
    decision: 'approve' | 'deny';
  } | null {
    const match = /^token:([1-9]\d*):(approve|deny)$/.exec(event.actionId);
    if (match === null) return null;
    const itemId = Number(match[1]);
    if (!Number.isSafeInteger(itemId)) return null;
    return {
      itemId,
      decision: match[2] === 'approve' ? 'approve' : 'deny',
    };
  }

  async function recordFailure(event: UserEvent, error: unknown, at: string): Promise<void> {
    await scanTransaction(store, async (trx) => {
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
      await raiseInboundItem(trx, {
        sourceKey: `inbound:failure:${event.dedupeKey}`,
        title: 'Slack message not processed',
        sourceUrl: event.sourceUrl,
        event,
        taskId: context.taskId,
        at,
        retry: true,
      });
    });
  }

  async function dispatchInteraction(event: Extract<UserEvent, { kind: 'command' | 'action' }>) {
    const token = event.kind === 'action' ? tokenAction(event) : null;
    if (token !== null) {
      let response = 'not allowed';
      if (event.sourceSpace === 'feed') {
        try {
          const at = new Date(clock.now()).toISOString();
          const result = await scanTransaction(store, (trx) =>
            replayOperation(trx, {
              actor: 'operator',
              key: event.dedupeKey,
              operation: `token.${token.decision}`,
              fingerprintInput: token,
              output: resultSchema,
              at,
              run: async () => {
                const decided = await decideTokenInTransaction(
                  trx,
                  token.itemId,
                  token.decision,
                  new Date(at),
                );
                return {
                  status: 'applied' as const,
                  response: `${decided.name}: ${decided.status}`,
                };
              },
            }),
          );
          response = result?.response ?? 'not available yet';
        } catch (error) {
          if (!(error instanceof CommandError)) {
            await recordFailure(event, error, new Date(clock.now()).toISOString());
          }
          response = error instanceof CommandError ? error.hint : 'not available yet';
        }
      }
      try {
        await gateway.respond(event.interaction, plain(response), { private: true });
      } catch {
        // The decision is already committed; a failed ephemeral reply cannot undo it.
      }
      return;
    }
    const { id, operationInput } = interactionOperation(event);
    let response: RichText;
    let cliHint: string | undefined;
    if (event.kind === 'command' && event.command?.kind === 'usage')
      response = plain(event.command.text);
    else if (id === undefined) response = plain('not allowed');
    else {
      try {
        const value = await dispatchOperation(
          { store, clock, config, registry },
          id,
          operationInput,
          'operator',
          event.dedupeKey,
        );
        if (event.kind === 'command') {
          const reply = commandReply(
            id as 'status.get' | 'task.get' | 'task.history',
            value,
            operationInput,
          );
          response = reply.body;
          cliHint = reply.cliHint;
        } else response = plain(JSON.stringify(value));
      } catch (error) {
        if (!(error instanceof CommandError)) {
          await recordFailure(event, error, new Date(clock.now()).toISOString());
        }
        response = plain(
          error instanceof CommandError && error.code !== 'not_implemented'
            ? event.kind === 'command'
              ? `${ERRORS[error.code].message} ${ERRORS[error.code].hint}`
              : error.hint
            : 'not available yet',
        );
      }
    }
    try {
      const safeResponse = event.kind === 'command' ? await redactPrivateReply(response) : response;
      const safeHint =
        event.kind === 'command' && cliHint !== undefined
          ? await redactSecretMatches(cliHint)
          : cliHint;
      await gateway.respond(event.interaction, safeResponse, {
        private: true,
        ...(safeHint === undefined ? {} : { cliHint: safeHint }),
      });
    } catch {
      // The operation has completed; failed scanning or delivery must not replay it.
    }
  }

  async function applyUser(event: UserEvent): Promise<void> {
    if (
      (event.kind === 'command' || event.kind === 'action') &&
      event.author === config.operator.slack &&
      (event.kind === 'command' || event.sourceSpace !== null)
    ) {
      await dispatchInteraction(event);
      return;
    }
    const at = new Date(clock.now()).toISOString();
    const actor: ActorId =
      event.kind === 'message_deleted' || event.author === config.operator.slack
        ? 'operator'
        : 'system';
    try {
      const result = await scanTransaction(store, (trx) =>
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
      await recordFailure(event, error, at);
    }
  }

  async function applyGap(event: Extract<InboundEvent, { kind: 'gap' }>): Promise<void> {
    const at = new Date(clock.now()).toISOString();
    await scanTransaction(store, async (trx) => {
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
      const scope = createHash('sha256')
        .update(JSON.stringify([gateway.kind, event.conversation ?? null]))
        .digest('hex');
      const baseKey = `inbound:gap:${scope}`;

      await raiseInboundItem(trx, {
        sourceKey: baseKey,
        title: 'repeat your answer',
        sourceUrl: ref?.permalink ?? null,
        event,
        taskId: context.taskId,
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
    retryStored(itemId) {
      return serial(async () => {
        const item = await store.db
          .selectFrom('operator_item')
          .select(['cleared_at', 'inbound_event_json'])
          .where('id', '=', itemId)
          .executeTakeFirst();
        if (item === undefined || item.cleared_at !== null || item.inbound_event_json === null) {
          throw new CommandError('retry_not_applicable', 'This item has no stored event to retry.');
        }
        let event = inboundEventSchema.parse(JSON.parse(item.inbound_event_json) as unknown);
        if (event.kind === 'command' && event.command === undefined) {
          const command = legacyCommand(event.text);
          if (command === null) {
            throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
          }
          event = { ...event, command };
        }
        if (event.kind === 'action' || event.kind === 'command') {
          const { id, operationInput } = interactionOperation(event);
          if (id === undefined) {
            throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
          }
          await dispatchOperation(
            { store, clock, config, registry },
            id,
            operationInput,
            'operator',
            event.dedupeKey,
          );
          await scanTransaction(store, (trx) =>
            clearOperatorItem(trx, itemId, new Date(clock.now())),
          );
          return;
        }
        await scanTransaction(store, (trx) =>
          retryStoredInbound(trx, itemId, new Date(clock.now()).toISOString()),
        );
      });
    },
  };
}

export async function getOperatorItem(store: Store, id: number): Promise<Item | undefined> {
  return store.db.selectFrom('operator_item').selectAll().where('id', '=', id).executeTakeFirst();
}
