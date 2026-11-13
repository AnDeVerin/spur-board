import { scanTransaction } from './secrets.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  ERRORS,
  OPERATIONS,
  RESERVED_PROJECT,
  conversationRefSchema,
  inboundEventSchema,
  messageRefSchema,
  parseActorId,
  type ActorId,
  type AddresseeRole,
  type Config,
  type EventKind,
  type EventPayload,
  type Gateway,
  type InboundEvent,
  type OperationId,
  type RecoverRequest,
  type RichText,
} from '@spur-board/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  advanceConversationCursor,
  conversationsForRecovery,
  resolveBlockConversation,
} from '../domain/conversations.ts';
import { BLOCK_ITEM_KINDS } from '../domain/fromYou.ts';
import { toJson } from '../store/json.ts';
import type { Row, Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { emit, withCommandKey } from './board-utils.ts';
import { editInboundComment, recordInboundBlockMessage } from './blocks.ts';
import { selectNotificationRecipient } from './doorbells.ts';
import { replayOperation } from './commands.ts';
import { CommandError } from './commands.ts';
import { commandReply } from './command-replies.ts';
import { deniedProject } from './denied-event.ts';
import { raiseItem as raiseOperatorItem, clearItem as clearOperatorItem } from './feed.ts';
import type { ReapplyInbound } from './items.ts';
import { dispatchOperation, type OperationRegistry } from './operations.ts';
import { enqueueConversationClose } from './outbox.ts';
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
type ItemEntry = Extract<(typeof OPERATIONS)[number], { id: 'item.close' | 'item.retry' }>;

export interface Inbound {
  sink(event: InboundEvent): Promise<void>;
  recover(): Promise<void>;
  stop(): Promise<void>;
  retryStored(itemId: number): Promise<void>;
  /**
   * Re-applies an item's stored event in the caller's transaction, without clearing the item.
   * A stored query needs nothing re-applied; an event that cannot be re-applied throws
   * `retry_not_applicable`.
   */
  reapply: ReapplyInbound;
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
  await emit(
    trx,
    input.kind,
    input.project,
    input.taskId,
    input.at,
    input.payload as EventPayload<EventKind>,
    input.actor,
  );
}

async function taskContext(
  trx: Trx,
  event: InboundEvent,
  gateway: string,
): Promise<{ taskId: number | null; project: string | null }> {
  if (!('conversation' in event) || event.conversation === undefined) {
    return { taskId: null, project: null };
  }
  const row = await trx
    .selectFrom('conversation')
    .leftJoin('task', 'task.id', 'conversation.task_id')
    .select(['conversation.task_id as taskId', 'task.project'])
    .where('conversation.gateway', '=', gateway)
    .where('conversation.ref', '=', event.conversation)
    .executeTakeFirst();
  return {
    taskId: row?.taskId ?? null,
    project: row?.project ?? null,
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

/** The operation input a parsed query command carries; legacy stored commands carry none. */
function commandInput(event: UserEvent): unknown {
  return event.kind === 'command' && event.command?.kind === 'query'
    ? event.command.input
    : undefined;
}

async function deny(
  trx: Trx,
  input: {
    config: Config;
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
    project: context.project ?? deniedProject(input.config, input.actor, commandInput(input.event)),
    at: input.at,
  });
  return input.privateResponse
    ? { status: 'denied', response: 'not allowed' }
    : { status: 'ignored' };
}

/** Journal an inbound message the board does not act on; no gateway response. */
async function skip(
  trx: Trx,
  input: { event: UserEvent; reason: string; actor: ActorId; gateway: string; at: string },
): Promise<Result> {
  const context = await taskContext(trx, input.event, input.gateway);
  await journal(trx, {
    kind: 'inbound_skipped',
    payload: {
      gateway: input.gateway,
      reason: input.reason,
      normalizedEvent: input.event,
      ...('author' in input.event ? { platformUser: input.event.author } : {}),
    },
    actor: input.actor,
    taskId: context.taskId,
    project: context.project ?? RESERVED_PROJECT,
    at: input.at,
  });
  return { status: 'ignored' };
}

/**
 * The journal is the comment's edit cursor: a deletion, or a later edit, was already applied.
 * Times compare in milliseconds, since `at` precision varies. Distinct edits can share a
 * millisecond, so an edit at the same millisecond counts as applied only when the comment
 * already holds its text.
 */
async function alreadyApplied(trx: Trx, event: MessageEvent): Promise<boolean> {
  if (event.kind !== 'message_edited' && event.kind !== 'message_deleted') return false;
  const comment = await linkedComment(trx, event);
  if (comment === undefined || comment.author !== 'operator') return false;
  const rows = await trx
    .selectFrom('event')
    .select(['kind', 'at'])
    .where('task_id', '=', comment.task_id)
    .where('kind', 'in', ['comment_deleted', 'comment_edited'])
    .where(sql<string>`json_extract(payload, '$.comment')`, '=', `C${String(comment.id)}`)
    .execute();
  if (rows.some((row) => row.kind === 'comment_deleted')) return true;
  if (event.kind === 'message_deleted') return false;
  const editedAt = Date.parse(event.at);
  return rows.some((row) => {
    const rowAt = Date.parse(row.at);
    return rowAt > editedAt || (rowAt === editedAt && comment.text === event.text);
  });
}

async function linkedComment(trx: Trx, event: MessageEvent): Promise<Row<'comment'> | undefined> {
  return trx
    .selectFrom('comment')
    .selectAll()
    .where('conversation_ref', '=', event.conversation)
    .where('message_ref', '=', event.message)
    .executeTakeFirst();
}

/** The answer's notification is already registered; this raises the item when nobody can read it. */
async function ringAuthor(
  trx: Trx,
  input: {
    event: UserEvent;
    block: Row<'block'>;
    task: Row<'task'>;
    comment: Row<'comment'>;
    authorRole: AddresseeRole;
    at: string;
    config: Config;
  },
): Promise<void> {
  // A ledger block asks for the operator's action, not an answer: its author is the board.
  const ledger = await trx
    .selectFrom('operator_item')
    .select('id')
    .where('block_id', '=', input.block.id)
    .where('kind', 'in', BLOCK_ITEM_KINDS)
    .executeTakeFirst();
  if (ledger !== undefined) return;
  const key = `doorbell:comment:${String(input.comment.id)}:revision:${String(input.comment.revision)}`;
  const parsed = parseActorId(input.block.author);
  if (parsed?.actor === 'agent') {
    const recipient = await selectNotificationRecipient(
      trx,
      {
        task_id: input.task.id,
        role: input.authorRole,
        author_session: parsed.actorRef.session,
      },
      input.config,
    );
    if (recipient !== undefined) return;
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

/** One scan: its queued selections and the promise every caller waits on. */
interface ScanState {
  /** A selection has set `since`; later ones only move it earlier. */
  selected: boolean;
  /** A selection found no conversations: read once with an empty list. */
  readEmpty: boolean;
  /** The latest queued selection. */
  selection: Promise<void>;
  promise: Promise<void>;
}

function first(set: Set<string>): string | undefined {
  for (const value of set) return value;
  return undefined;
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
  const stopping = new AbortController();
  const stopped = () => stopping.signal.aborted;
  /** Conversations the current or stopped scan selected and has not read yet. */
  const pending = new Set<string>();
  let since = new Date(clock.now());
  let scan: ScanState | undefined;

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

  async function processMessage(
    trx: Trx,
    event: MessageEvent,
    at: string,
  ): Promise<Result | undefined> {
    if (await alreadyApplied(trx, event)) return undefined;
    const conversation = await sourceContext(trx, event, at);
    if (conversation?.block_id === null || conversation === undefined) {
      return skip(trx, {
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
        authorRole: recorded.authorRole,
        at,
        config,
      });
      return { status: 'applied' };
    }
    const comment = await linkedComment(trx, event);
    if (comment === undefined || comment.author !== 'operator') {
      return skip(trx, {
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

  async function reapply(trx: Trx, itemId: number, at: string): Promise<void> {
    const item = await trx
      .selectFrom('operator_item')
      .selectAll()
      .where('id', '=', itemId)
      .executeTakeFirst();
    if (item === undefined || item.cleared_at !== null || item.inbound_event_json === null) {
      throw new CommandError('retry_not_applicable', 'This item has no stored event to retry.');
    }
    const event = inboundEventSchema.parse(JSON.parse(item.inbound_event_json) as unknown);
    if (event.kind === 'gap' || event.kind === 'connection') {
      throw new CommandError('retry_not_applicable', 'This event cannot be retried.');
    }
    if (event.kind === 'command' || event.kind === 'action') {
      await reapplyInteraction(trx, event, at);
      return;
    }
    const actor: ActorId =
      event.kind === 'message_deleted' || event.author === config.operator.slack
        ? 'operator'
        : 'system';
    await replayOperation(trx, {
      actor,
      key: event.dedupeKey,
      operation: operationId(event),
      fingerprintInput: event,
      output: resultSchema,
      at,
      run: () => runUser(trx, event, at),
    });
  }

  /**
   * A stored query needs no re-apply. A stored item or token press replays as the operator under
   * its own key, only when it passed the same gate as a live press.
   */
  async function reapplyInteraction(
    trx: Trx,
    stored: Extract<UserEvent, { kind: 'command' | 'action' }>,
    at: string,
  ): Promise<void> {
    let event = stored;
    if (
      event.kind === 'command' &&
      event.name !== undefined &&
      event.name !== config.slack.command
    ) {
      throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
    }
    if (event.kind === 'command' && event.command === undefined) {
      const command = legacyCommand(event.text);
      if (command === null) {
        throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
      }
      event = { ...event, command };
    }
    const token = event.kind === 'action' ? tokenAction(event) : null;
    if (token !== null) {
      // The live gate: the configured operator, pressed in the feed.
      if (
        event.kind !== 'action' ||
        event.author !== config.operator.slack ||
        event.sourceSpace !== 'feed'
      ) {
        throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
      }
      await decideToken(trx, event.dedupeKey, token, at);
      return;
    }
    const { id, operationInput } = interactionOperation(event);
    if (id === undefined) {
      throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
    }
    if (id !== 'item.close' && id !== 'item.retry') return;
    const handler = registry[id];
    const entry = OPERATIONS.find((candidate): candidate is ItemEntry => candidate.id === id);
    const parsed = entry?.input.safeParse(operationInput);
    if (
      event.kind !== 'action' ||
      event.author !== config.operator.slack ||
      event.sourceSpace === null ||
      handler === undefined ||
      entry === undefined ||
      parsed?.success !== true
    ) {
      throw new CommandError('retry_not_applicable', 'This interaction cannot be retried.');
    }
    const input = parsed.data;
    await replayOperation(trx, {
      actor: 'operator',
      key: event.dedupeKey,
      operation: id,
      fingerprintInput: operationInput,
      output: entry.output,
      at,
      run: () => handler.run(trx, input, { actor: 'operator', at }),
    });
  }

  async function runUser(trx: Trx, event: UserEvent, at: string): Promise<Result | undefined> {
    if (
      event.kind === 'command' &&
      event.name !== undefined &&
      event.name !== config.slack.command
    ) {
      return deny(trx, {
        config,
        event,
        reason: 'Command name does not match the configured command.',
        actor: 'system',
        gateway: gateway.kind,
        at,
      });
    }
    if (event.kind !== 'message_deleted' && event.author !== config.operator.slack) {
      return deny(trx, {
        config,
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
          config,
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
    /** The pressed item, `I<n>`, for an action. */
    item?: string;
  } {
    let id: OperationId | undefined;
    let operationInput: unknown;
    let item: string | undefined;
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
        item = parts[1];
        operationInput = { item };
      } else if (parts.length === 3 && parts[0] === 'item' && /^[1-9]\d*$/.test(parts[1] ?? '')) {
        id = parts[2] === 'close' ? 'item.close' : parts[2] === 'retry' ? 'item.retry' : undefined;
        item = `I${parts[1] ?? ''}`;
        operationInput = { item };
      }
    }
    return { id, operationInput, ...(item === undefined ? {} : { item }) };
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

  /** A token press decides once per dedupe key, live or replayed from its failure item. */
  function decideToken(
    trx: Trx,
    key: string,
    token: { itemId: number; decision: 'approve' | 'deny' },
    at: string,
  ) {
    return replayOperation(trx, {
      actor: 'operator',
      key,
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
    });
  }

  async function recordFailure(event: UserEvent, error: unknown, at: string): Promise<void> {
    await withCommandKey(event.dedupeKey, () =>
      scanTransaction(store, config, async (trx) => {
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
          project: context.project ?? RESERVED_PROJECT,
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
      }),
    );
  }

  async function dispatchInteraction(event: Extract<UserEvent, { kind: 'command' | 'action' }>) {
    const token = event.kind === 'action' ? tokenAction(event) : null;
    if (token !== null) {
      let response = 'not allowed';
      if (event.sourceSpace === 'feed') {
        try {
          const at = new Date(clock.now()).toISOString();
          const result = await scanTransaction(store, config, (trx) =>
            decideToken(trx, event.dedupeKey, token, at),
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
    const { id, operationInput, item } = interactionOperation(event);
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
        } else {
          response = plain(
            id === 'item.close' ? `Closed ${item ?? ''}.` : `Retry started for ${item ?? ''}.`,
          );
        }
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
      (event.kind !== 'command' ||
        event.name === undefined ||
        event.name === config.slack.command) &&
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
      const result = await scanTransaction(store, config, (trx) =>
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
    await scanTransaction(store, config, async (trx) => {
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

  async function applyEvent(event: Exclude<InboundEvent, { kind: 'connection' }>): Promise<void> {
    if (event.kind === 'gap') return applyGap(event);
    return applyUser(event);
  }

  /** Reads one conversation, or none to let a history-less gateway report its gap. */
  async function readSlice(ref: string | undefined): Promise<void> {
    let conversations: RecoverRequest['conversations'] = [];
    if (ref !== undefined) {
      const row = await store.db
        .selectFrom('conversation')
        .select('after_message_ref')
        .where('gateway', '=', gateway.kind)
        .where('ref', '=', ref)
        .executeTakeFirst();
      if (row === undefined) return;
      conversations = [
        {
          ref: conversationRefSchema.parse(ref),
          ...(row.after_message_ref === null
            ? {}
            : { after: messageRefSchema.parse(row.after_message_ref) }),
        },
      ];
    }
    for await (const event of gateway.recover({ conversations, since, signal: stopping.signal })) {
      // A gateway may still yield history it loaded before the abort; leave it unapplied.
      if (stopped()) return;
      // A slice never starts a scan from inside the chain.
      if (event.kind === 'connection') continue;
      await applyEvent(event);
    }
  }

  /** Reads `ref` now when the scan has not read it yet; a stopped scan leaves it unread. */
  async function sliceIfPending(ref: string): Promise<void> {
    if (!pending.has(ref) || stopped()) return;
    try {
      await readSlice(ref);
    } catch (error) {
      pending.delete(ref);
      throw error;
    }
    if (!stopped()) pending.delete(ref);
  }

  /**
   * Adds the selected conversations to `pending`. A selection merged into a running scan reads
   * from the earliest `since` of its selections, so no selection's window shrinks.
   */
  async function select(state: ScanState): Promise<void> {
    if (scan !== state) return;
    const selected = await conversationsForRecovery(store.db, gateway.kind, new Date(clock.now()));
    since = state.selected && since.getTime() < selected.since.getTime() ? since : selected.since;
    state.selected = true;
    for (const row of selected.rows) pending.add(row.ref);
    if (selected.rows.length === 0) state.readEmpty = true;
  }

  /**
   * One slot per conversation, so live events run between slices, until `pending` is empty.
   * The scan ends where this decides to stop, in the same microtask, so a later request starts
   * a fresh scan instead of joining one that will not read again.
   */
  async function drain(state: ScanState): Promise<void> {
    const end = () => {
      if (scan === state) scan = undefined;
    };
    try {
      for (;;) {
        const selection = state.selection;
        await selection;
        for (let ref = first(pending); ref !== undefined && !stopped(); ref = first(pending)) {
          const next = ref;
          await serial(() => sliceIfPending(next));
        }
        if (state.readEmpty && !stopped()) {
          state.readEmpty = false;
          await serial(() => readSlice(undefined));
        }
        if (stopped() || state.selection === selection) {
          end();
          return;
        }
      }
    } catch (error) {
      end();
      pending.clear();
      throw error;
    }
  }

  /**
   * A request during a scan queues its selection at once, so later live events wait for it;
   * every caller waits until the merged selections are read.
   */
  function requestScan(): Promise<void> {
    if (stopped()) return Promise.resolve();
    if (scan !== undefined) {
      queueSelection(scan);
      return scan.promise;
    }
    const state: ScanState = {
      selected: false,
      readEmpty: false,
      selection: Promise.resolve(),
      promise: Promise.resolve(),
    };
    scan = state;
    queueSelection(state);
    state.promise = drain(state);
    return state.promise;
  }

  function queueSelection(state: ScanState): void {
    // Chained, so the drain sees a failed earlier selection even after a later one is queued.
    const queued = serial(() => select(state));
    state.selection = state.selection.then(() => queued);
    // The drain awaits it; a rejection must not surface before then.
    state.selection.catch(() => undefined);
  }

  /** Before a live event: its conversation's unread history, or a gap once the scan stopped. */
  async function beforeLive(event: InboundEvent): Promise<void> {
    const ref = 'conversation' in event ? event.conversation : undefined;
    if (ref === undefined || !pending.has(ref)) return;
    if (!stopped()) return sliceIfPending(ref);
    pending.delete(ref);
    await applyGap({
      kind: 'gap',
      dedupeKey: `inbound:stopped-scan:${randomUUID()}`,
      conversation: ref,
    });
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = running.then(work);
    running = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    sink(event) {
      if (event.kind === 'connection') {
        return event.state === 'up' ? requestScan() : Promise.resolve();
      }
      return serial(async () => {
        await beforeLive(event);
        await applyEvent(event);
      });
    },
    recover: requestScan,
    async stop() {
      stopping.abort();
      await scan?.promise.catch(() => undefined);
      await running;
    },
    retryStored(itemId) {
      return serial(async () => {
        const at = new Date(clock.now()).toISOString();
        await scanTransaction(store, config, async (trx) => {
          await reapply(trx, itemId, at);
          await clearOperatorItem(trx, itemId, new Date(at));
        });
      });
    },
    reapply,
  };
}

export async function getOperatorItem(store: Store, id: number): Promise<Item | undefined> {
  return store.db.selectFrom('operator_item').selectAll().where('id', '=', id).executeTakeFirst();
}
