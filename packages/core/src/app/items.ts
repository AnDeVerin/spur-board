import { assertNever, type Config } from '@spur-board/contracts';
import { z } from 'zod';
import { isItemKind, itemBlockRef, ITEM_POLICY } from '../domain/fromYou.ts';
import { parseJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
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
});

/** The outbox row of a `delivery:<outbox id>` item; the item itself has no task. */
function deliveryId(item: Item): number | undefined {
  return item.kind === 'post_failed' && item.task_id === null
    ? Number(item.item_key.slice('delivery:'.length))
    : undefined;
}

/** How an item finds its subject: a task directly, through a notification, comment or block. */
interface SubjectRef {
  task?: number;
  notification?: number;
  comment?: number;
  block?: number;
}

/** How a failed delivery's outbox row finds its subject, from its payload or ring, if at all. */
function deliveryRef(row: {
  kind: string;
  dedupe_key: string;
  payload: string;
}): SubjectRef | undefined {
  const payload = parseJson(deliveryPayloadSchema, row.payload);
  if (typeof payload.taskId === 'number') return { task: payload.taskId };
  if (typeof payload.blockId === 'number') return { block: payload.blockId };
  if (row.kind !== 'doorbell') return undefined;
  if (typeof payload.notificationId === 'number') return { notification: payload.notificationId };
  const comment = ringCommentId(row.dedupe_key);
  return comment === undefined ? undefined : { comment };
}

/**
 * What each item is about; `inbox.operator`, `status.get` and item actions all file an item by
 * it. An item is its own task's; else a failed delivery's: its payload's task, the block it
 * posts, or for a doorbell its ring's task; else the block it refers to (`itemBlockRef`). A block
 * is its task's, or a project-level block its project's while the project is in config. An item
 * missing from the map is a board item. Reads at most five statements, whatever the item count.
 */
export async function itemSubjects(
  trx: Trx,
  items: readonly Item[],
  config: Config,
): Promise<Map<number, BlockSubject>> {
  const outboxIds = items.flatMap((item) => deliveryId(item) ?? []);
  const deliveries =
    outboxIds.length === 0
      ? []
      : await trx
          .selectFrom('outbox')
          .select(['id', 'kind', 'dedupe_key', 'payload'])
          .where('id', 'in', outboxIds)
          .execute();
  const deliveryRefs = new Map(deliveries.map((row) => [row.id, deliveryRef(row)]));
  const refs = new Map<number, SubjectRef>();
  for (const item of items) {
    const outboxId = deliveryId(item);
    const blockRef = itemBlockRef(item);
    const ref =
      item.task_id !== null
        ? { task: item.task_id }
        : ((outboxId === undefined ? undefined : deliveryRefs.get(outboxId)) ??
          (blockRef === undefined ? {} : { block: blockRef }));
    refs.set(item.id, ref);
  }
  const ids = (pick: 'notification' | 'comment' | 'block') => [
    ...new Set([...refs.values()].flatMap((ref) => ref[pick] ?? [])),
  ];
  const [notifications, comments] = await Promise.all(
    (['notification', 'comment'] as const).map((table) => {
      const wanted = ids(table);
      return wanted.length === 0
        ? Promise.resolve([])
        : trx.selectFrom(table).select(['id', 'task_id']).where('id', 'in', wanted).execute();
    }),
  );
  const blockIds = ids('block');
  const blocks =
    blockIds.length === 0
      ? []
      : await trx
          .selectFrom('block')
          .select(['id', 'task_id', 'project'])
          .where('id', 'in', blockIds)
          .execute();
  const taskOf = {
    notification: new Map(notifications?.map((row) => [row.id, row.task_id])),
    comment: new Map(comments?.map((row) => [row.id, row.task_id])),
  };
  const blockById = new Map(blocks.map((row) => [row.id, row]));
  const configured = new Set(config.projects.map((project) => project.id));
  // Each item's task id, or the project of its project-level block.
  const resolved = new Map<number, { task: number } | { project: string }>();
  for (const [itemId, ref] of refs) {
    const block = ref.block === undefined ? undefined : blockById.get(ref.block);
    const taskId =
      ref.task ??
      (ref.notification === undefined ? undefined : taskOf.notification.get(ref.notification)) ??
      (ref.comment === undefined ? undefined : taskOf.comment.get(ref.comment)) ??
      block?.task_id;
    if (typeof taskId === 'number') resolved.set(itemId, { task: taskId });
    else if (block?.project != null && configured.has(block.project))
      resolved.set(itemId, { project: block.project });
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
    if (!('task' in entry)) subjects.set(itemId, projectSubject(entry.project));
    else {
      const task = taskById.get(entry.task);
      if (task !== undefined) subjects.set(itemId, taskSubject(task));
    }
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
