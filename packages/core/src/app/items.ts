import { assertNever, type Config } from '@spur-board/contracts';
import { z } from 'zod';
import { isItemKind, itemBlockRef, ITEM_POLICY } from '../domain/fromYou.ts';
import { parseJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import { projectForSource, type Trx } from './board-utils.ts';
import type { ResolvedTarget } from './authorize.ts';
import { closeBlockIfOpen, subjectTarget } from './blocks.ts';
import { projectSubject, taskSubject, type BlockSubject } from './subject.ts';
import { CommandError, type Mutation } from './commands.ts';
import { restartNotification, ringCommentId } from './doorbells.ts';
import { clearItem, dismissItem } from './feed.ts';
import { requeuePostFailed, retryTransport } from './sender.ts';

type Item = Row<'operator_item'>;

/** Re-applies an `inbound_failure` item's stored event in `trx`; the caller clears the item. */
export type ReapplyInbound = (trx: Trx, itemId: number, at: string) => Promise<void>;

async function loadItem(
  trx: Trx,
  id: string,
): Promise<{ item: Item; task: Row<'task'> | undefined }> {
  const item = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('id', '=', Number(id.slice(1)))
    .executeTakeFirst();
  if (item === undefined) throw new CommandError('not_found', 'Check the item ID.');
  const task =
    item.task_id === null
      ? undefined
      : await trx
          .selectFrom('task')
          .selectAll()
          .where('id', '=', item.task_id)
          .executeTakeFirstOrThrow();
  return { item, task };
}

/** The ids a delivery payload may carry; each payload kind has its own full schema. */
const deliveryPayloadSchema = z.object({
  taskId: z.unknown().optional(),
  blockId: z.unknown().optional(),
  notificationId: z.unknown().optional(),
  itemId: z.unknown().optional(),
});

/** The outbox row of a `delivery:<outbox id>` item; the item itself has no task. */
function deliveryId(item: Item): number | undefined {
  return item.kind === 'post_failed' && item.task_id === null
    ? Number(item.item_key.slice('delivery:'.length))
    : undefined;
}

/**
 * How an item finds its subject: a task, or a notification, comment, thread or block, or the
 * operator item a feed line is about, or the outbox row a feed edit changes.
 */
interface SubjectRef {
  task?: number;
  notification?: number;
  comment?: number;
  conversation?: string;
  block?: number;
  item?: number;
  delivery?: number;
}

/** The conversation of an `inbound_failure` item's stored event. */
const storedEventSchema = z.object({ conversation: z.unknown().optional() });
const UNAVAILABLE_KEY = 'doorbell:unavailable:';

/**
 * How an item with neither a task nor a block finds its subject from what it stores: an
 * unavailable answer author's ring key names the comment, a stored inbound event its thread.
 * Rows raised before the block was stored on these items have only these.
 */
function storedRef(item: Item): SubjectRef {
  if (item.item_key.startsWith(UNAVAILABLE_KEY)) {
    const comment = ringCommentId(item.item_key.slice(UNAVAILABLE_KEY.length));
    if (comment !== undefined) return { comment };
  }
  if (item.inbound_event_json === null) return {};
  const { conversation } = parseJson(storedEventSchema, item.inbound_event_json);
  return typeof conversation === 'string' ? { conversation } : {};
}

type DeliveryRow = Pick<
  Row<'outbox'>,
  'id' | 'kind' | 'dedupe_key' | 'payload' | 'parent_outbox_id'
>;

/**
 * How a failed delivery's outbox row finds its subject, from its payload or ring, if at all: a
 * feed line by the item it is about, a feed edit by the line it edits.
 */
function deliveryRef(row: DeliveryRow): SubjectRef | undefined {
  const payload = parseJson(deliveryPayloadSchema, row.payload);
  if (typeof payload.taskId === 'number') return { task: payload.taskId };
  if (typeof payload.blockId === 'number') return { block: payload.blockId };
  if (row.kind === 'feed.line') {
    return typeof payload.itemId === 'number' ? { item: payload.itemId } : undefined;
  }
  if (row.kind === 'feed.line.edit') {
    return row.parent_outbox_id === null ? undefined : { delivery: row.parent_outbox_id };
  }
  if (row.kind !== 'doorbell') return undefined;
  if (typeof payload.notificationId === 'number') return { notification: payload.notificationId };
  const comment = ringCommentId(row.dedupe_key);
  return comment === undefined ? undefined : { comment };
}

/** Outbox rows read per edit chain: a token card's revoked edit follows its card edit. */
const DELIVERY_HOPS = 3;
/** Operator items followed from a feed line: the line's item, never an item's line again. */
const ITEM_HOPS = 1;

/**
 * Each failed delivery's ref, following a feed edit to the line it edits for at most
 * `DELIVERY_HOPS` rows; a longer chain has no ref. One statement per hop.
 */
async function deliveryRefs(
  trx: Trx,
  outboxIds: readonly number[],
): Promise<Map<number, SubjectRef | undefined>> {
  const refs = new Map<number, SubjectRef | undefined>();
  // Each failed delivery's outbox id -> the row still to read for it.
  let pending = new Map(outboxIds.map((id) => [id, id]));
  for (let hop = 0; hop < DELIVERY_HOPS && pending.size > 0; hop += 1) {
    const rows = await trx
      .selectFrom('outbox')
      .select(['id', 'kind', 'dedupe_key', 'payload', 'parent_outbox_id'])
      .where('id', 'in', [...new Set(pending.values())])
      .execute();
    const refOf = new Map(rows.map((row) => [row.id, deliveryRef(row)]));
    const next = new Map<number, number>();
    for (const [origin, current] of pending) {
      const ref = refOf.get(current);
      if (ref?.delivery === undefined) refs.set(origin, ref);
      else next.set(origin, ref.delivery);
    }
    pending = next;
  }
  return refs;
}

/**
 * What each item is about; `inbox.operator`, `status.get` and item actions all file an item by
 * it. An item is its own task's; else a failed delivery's: its payload's task, the block it
 * posts, for a doorbell its ring's notification or comment, for a feed line the subject of the
 * item it is about, for a feed edit that of the line it edits; else the block it refers to
 * (`itemBlockRef`); else the comment or thread it stores (`storedRef`). A notification, comment
 * or thread is its task's, else its block's; a block is its task's, else a project-level block
 * its project's. An item that reaches neither is the project's whose repository or tracker
 * source it names (`projectForSource`), such as a blind source or a red default branch; the
 * `spur` source and other board-wide ones name none. A subject whose project has left the config
 * is the board's, except an archived task's, which stays hidden. An item missing from the map is
 * a board item. The number of statements it reads is bounded (`DELIVERY_HOPS`, `ITEM_HOPS`),
 * whatever the item count.
 */
export async function itemSubjects(
  trx: Trx,
  items: readonly Item[],
  config: Config,
): Promise<Map<number, BlockSubject>> {
  return subjectsOf(trx, items, config, ITEM_HOPS);
}

/** `itemSubjects`, following a feed line to its item for at most `itemHops` items. */
async function subjectsOf(
  trx: Trx,
  items: readonly Item[],
  config: Config,
  itemHops: number,
): Promise<Map<number, BlockSubject>> {
  const outboxIds = items.flatMap((item) => deliveryId(item) ?? []);
  const refOfDelivery =
    outboxIds.length === 0
      ? new Map<number, SubjectRef | undefined>()
      : await deliveryRefs(trx, outboxIds);
  const refs = new Map<number, SubjectRef>();
  for (const item of items) {
    const outboxId = deliveryId(item);
    const blockRef = itemBlockRef(item);
    const ref =
      item.task_id !== null
        ? { task: item.task_id }
        : ((outboxId === undefined ? undefined : refOfDelivery.get(outboxId)) ??
          (blockRef === undefined ? storedRef(item) : { block: blockRef }));
    refs.set(item.id, ref);
  }
  const ids = <K extends 'notification' | 'comment' | 'conversation' | 'block' | 'item'>(
    pick: K,
  ) => [...new Set([...refs.values()].flatMap((ref) => ref[pick] ?? []))];
  // A failed feed line or edit is the subject's of the item the line is about.
  const lineItemIds = itemHops === 0 ? [] : ids('item');
  const lineItems =
    lineItemIds.length === 0
      ? []
      : await trx.selectFrom('operator_item').selectAll().where('id', 'in', lineItemIds).execute();
  const lineSubjects =
    lineItems.length === 0
      ? new Map<number, BlockSubject>()
      : await subjectsOf(trx, lineItems, config, itemHops - 1);
  type Linked = { task_id: number | null; block_id: number | null };
  const notificationIds = ids('notification');
  const commentIds = ids('comment');
  const conversationRefs = ids('conversation');
  const [notifications, comments, conversations] = await Promise.all([
    notificationIds.length === 0
      ? []
      : trx
          .selectFrom('notification')
          .select(['id', 'task_id', 'block_id'])
          .where('id', 'in', notificationIds)
          .execute(),
    commentIds.length === 0
      ? []
      : trx
          .selectFrom('comment')
          .select(['id', 'task_id', 'block_id'])
          .where('id', 'in', commentIds)
          .execute(),
    conversationRefs.length === 0
      ? []
      : trx
          .selectFrom('conversation')
          .select(['ref', 'task_id', 'block_id'])
          .where('ref', 'in', conversationRefs)
          .execute(),
  ]);
  const linkedOf = {
    notification: new Map<number, Linked>(notifications.map((row) => [row.id, row])),
    comment: new Map<number, Linked>(comments.map((row) => [row.id, row])),
    conversation: new Map<string, Linked>(conversations.map((row) => [row.ref, row])),
  };
  // The notification, comment or thread an item reaches, if any.
  const linked = (ref: SubjectRef): Linked | undefined =>
    (ref.notification === undefined ? undefined : linkedOf.notification.get(ref.notification)) ??
    (ref.comment === undefined ? undefined : linkedOf.comment.get(ref.comment)) ??
    (ref.conversation === undefined ? undefined : linkedOf.conversation.get(ref.conversation));
  const blockOf = (ref: SubjectRef) => ref.block ?? linked(ref)?.block_id ?? undefined;
  const blockIds = [...new Set([...refs.values()].flatMap((ref) => blockOf(ref) ?? []))];
  const blocks =
    blockIds.length === 0
      ? []
      : await trx
          .selectFrom('block')
          .select(['id', 'task_id', 'project'])
          .where('id', 'in', blockIds)
          .execute();
  const blockById = new Map(blocks.map((row) => [row.id, row]));
  const configured = new Set(config.projects.map((project) => project.id));
  const sourceOf = new Map(items.map((item) => [item.id, item.source]));
  // Each item's task id, or the project of its project-level block, else of its source.
  const resolved = new Map<number, { task: number } | { project: string }>();
  for (const [itemId, ref] of refs) {
    const blockId = blockOf(ref);
    const block = blockId === undefined ? undefined : blockById.get(blockId);
    const taskId = ref.task ?? linked(ref)?.task_id ?? block?.task_id;
    const source = sourceOf.get(itemId) ?? null;
    const sourceProject = source === null ? undefined : projectForSource(config, source)?.id;
    if (typeof taskId === 'number') resolved.set(itemId, { task: taskId });
    else if (block?.project != null) resolved.set(itemId, { project: block.project });
    else if (sourceProject !== undefined) resolved.set(itemId, { project: sourceProject });
  }
  const taskIds = [
    ...new Set([...resolved.values()].flatMap((entry) => ('task' in entry ? [entry.task] : []))),
  ];
  const tasks =
    taskIds.length === 0
      ? []
      : await trx.selectFrom('task').selectAll().where('id', 'in', taskIds).execute();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const subjects = new Map<number, BlockSubject>();
  for (const [itemId, entry] of resolved) {
    const task = 'task' in entry ? taskById.get(entry.task) : undefined;
    const subject =
      'task' in entry
        ? task === undefined
          ? undefined
          : taskSubject(task)
        : projectSubject(entry.project);
    if (subject === undefined) continue;
    // A project that left the config files its items under the board; an archived task's stay
    // its task's, so they stay hidden.
    if (configured.has(subject.project) || task?.membership === 'archived') {
      subjects.set(itemId, subject);
    }
  }
  for (const [itemId, ref] of refs) {
    const subject = ref.item === undefined ? undefined : lineSubjects.get(ref.item);
    if (subject !== undefined) subjects.set(itemId, subject);
  }
  return subjects;
}

/** One item's subject (`itemSubjects`); undefined for a board item. */
async function itemSubject(
  trx: Trx,
  item: Item,
  config: Config,
): Promise<BlockSubject | undefined> {
  return (await itemSubjects(trx, [item], config)).get(item.id);
}

/**
 * An item is its subject's project's (`itemSubjects`); a board item or an unknown ID has no
 * target, so only the token, the board-wide operator or, without one, a one-project board's
 * operator may act on it, and `run` raises the unknown ID.
 */
async function itemTarget(
  trx: Trx,
  config: Config,
  input: { item: string },
): Promise<readonly ResolvedTarget[]> {
  const item = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('id', '=', Number(input.item.slice(1)))
    .executeTakeFirst();
  if (item === undefined) return [];
  const subject = await itemSubject(trx, item, config);
  return subject === undefined ? [] : [await subjectTarget(trx, subject)];
}

function view(item: Item, task: Row<'task'> | undefined) {
  return {
    item: {
      id: `I${String(item.id)}`,
      task: task?.key ?? null,
      at: item.raised_at,
      summary: item.text,
    },
  };
}

function notApplicable(hint: string): CommandError {
  return new CommandError('retry_not_applicable', hint);
}

/**
 * Item actions: retry runs the action behind the item's kind; close dismisses it. Both clear it,
 * except a retry on a transport item, which the sender clears when the transport is back.
 */
export function createItemMutations(deps: {
  config: Config;
  reapplyInbound?: () => ReapplyInbound | undefined;
}): {
  retry: Mutation<'item.retry'>;
  close: Mutation<'item.close'>;
} {
  const resolveTargets = (trx: Trx, input: { item: string }) => itemTarget(trx, deps.config, input);
  /** Runs the retry behind the item's kind; false when the item must stay raised. */
  async function retryAction(trx: Trx, item: Item, at: string): Promise<boolean> {
    const closeHint = `close it with \`board item close I${String(item.id)}\`.`;
    const noAction = notApplicable(`This item has no retry action; ${closeHint}`);
    const action = isItemKind(item.kind) ? ITEM_POLICY[item.kind].retry : 'none';
    switch (action) {
      case 'requeue_post': {
        const outboxId = Number(item.item_key.slice('delivery:'.length));
        if ((await requeuePostFailed(trx, [outboxId], at)) === 0) {
          throw notApplicable('The delivery is no longer failed.');
        }
        return true;
      }
      case 'restart_ring': {
        const prefix = `${item.kind}:`;
        if (!item.item_key.startsWith(prefix) || item.item_key.length === prefix.length) {
          throw noAction;
        }
        await restartNotification(trx, item.item_key.slice(prefix.length), new Date(at));
        return true;
      }
      case 'reapply_inbound': {
        const reapply = deps.reapplyInbound?.();
        if (reapply === undefined) {
          throw notApplicable('Slack inbound is not running; close the item instead.');
        }
        await reapply(trx, item.id, at);
        return true;
      }
      case 'probe_transport': {
        // Probe now; only the sender clears this item, once the transport is back. A probe
        // that fails again adds no row, so nothing would raise the item again if retry cleared it.
        const gateway = item.item_key.slice('transport:'.length);
        if ((await retryTransport(trx, gateway, at)) === 0) {
          throw notApplicable('No transport outage is recorded; the item clears on its own.');
        }
        return false;
      }
      case 'never_sent':
        throw notApplicable(`The blocked text is never sent; ${closeHint}`);
      case 'none':
        throw noAction;
      default:
        return assertNever(action);
    }
  }

  return {
    retry: {
      id: 'item.retry',
      resolveTargets,
      async run(trx, input, ctx) {
        const { item, task } = await loadItem(trx, input.item);
        const owner = (await itemSubject(trx, item, deps.config))?.task;
        if (owner?.membership === 'archived') {
          throw new CommandError('task_archived', 'Add the task again before retrying its item.');
        }
        if (item.cleared_at !== null) throw notApplicable('The item is already cleared.');
        if (await retryAction(trx, item, ctx.at)) {
          await clearItem(trx, item.id, new Date(ctx.at), ctx.actor);
        }
        return view(item, task);
      },
    },
    close: {
      id: 'item.close',
      resolveTargets,
      async run(trx, input, ctx) {
        const { item, task } = await loadItem(trx, input.item);
        if (item.cleared_at === null) {
          if (item.kind === 'post_failed') {
            // A closed failed post stays unsent: neither `recover()` nor a retry may resend it.
            await trx
              .updateTable('outbox')
              .set({ state: 'dead', last_error: `closed by ${ctx.actor} (I${String(item.id)})` })
              .where('id', '=', Number(item.item_key.slice('delivery:'.length)))
              .where('state', '=', 'post_failed')
              .execute();
          }
          await dismissItem(trx, item, ctx.actor, new Date(ctx.at));
          // A ledger item's block closes with it, as the actor that closed the item.
          if (item.block_id !== null && isItemKind(item.kind) && ITEM_POLICY[item.kind].block) {
            const reason = `closed as item I${String(item.id)}`;
            await closeBlockIfOpen(trx, item.block_id, ctx, 'reason', reason);
          }
        }
        return view(item, task);
      },
    },
  };
}
