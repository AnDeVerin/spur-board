import { assertNever, type Config } from '@spur-board/contracts';
import { z } from 'zod';
import { isItemKind, itemBlockRef, ITEM_POLICY } from '../domain/fromYou.ts';
import { parseJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import type { ResolvedTarget } from './authorize.ts';
import { closeBlockIfOpen, subjectTarget } from './blocks.ts';
import { blockSubject, taskSubject, type BlockSubject } from './subject.ts';
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
  notificationId: z.unknown().optional(),
});

/** The outbox row of a `delivery:<outbox id>` item; the item itself has no task. */
function deliveryId(item: Item): number | undefined {
  return item.kind === 'post_failed' && item.task_id === null
    ? Number(item.item_key.slice('delivery:'.length))
    : undefined;
}

/**
 * The task each failed delivery item's outbox row belongs to: the payload's task, else for a
 * doorbell its ring's (`ringTask`). Reads at most four statements, whatever the item count.
 */
export async function deliveryOwners(
  trx: Trx,
  items: readonly Item[],
): Promise<Map<number, Row<'task'>>> {
  const owners = new Map<number, Row<'task'>>();
  const outboxIds = items.flatMap((item) => deliveryId(item) ?? []);
  if (outboxIds.length === 0) return owners;
  const rows = await trx
    .selectFrom('outbox')
    .select(['id', 'kind', 'dedupe_key', 'payload'])
    .where('id', 'in', outboxIds)
    .execute();
  // How each row finds its task: directly, through its notification or through its comment.
  const refs = new Map<number, { task?: number; notification?: number; comment?: number }>();
  for (const row of rows) {
    const payload = parseJson(deliveryPayloadSchema, row.payload);
    if (typeof payload.taskId === 'number') refs.set(row.id, { task: payload.taskId });
    else if (row.kind !== 'doorbell') continue;
    else if (typeof payload.notificationId === 'number')
      refs.set(row.id, { notification: payload.notificationId });
    else {
      const comment = ringCommentId(row.dedupe_key);
      if (comment !== undefined) refs.set(row.id, { comment });
    }
  }
  const ids = (pick: 'notification' | 'comment') =>
    [...refs.values()].flatMap((ref) => ref[pick] ?? []);
  const [notifications, comments] = await Promise.all(
    (['notification', 'comment'] as const).map((table) => {
      const wanted = ids(table);
      return wanted.length === 0
        ? Promise.resolve([])
        : trx.selectFrom(table).select(['id', 'task_id']).where('id', 'in', wanted).execute();
    }),
  );
  const taskOf = {
    notification: new Map(notifications?.map((row) => [row.id, row.task_id])),
    comment: new Map(comments?.map((row) => [row.id, row.task_id])),
  };
  const taskIds = new Map<number, number>();
  for (const [outboxId, ref] of refs) {
    const taskId =
      ref.task ??
      (ref.notification === undefined ? undefined : taskOf.notification.get(ref.notification)) ??
      (ref.comment === undefined ? undefined : taskOf.comment.get(ref.comment));
    if (typeof taskId === 'number') taskIds.set(outboxId, taskId);
  }
  if (taskIds.size === 0) return owners;
  const tasks = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', 'in', [...new Set(taskIds.values())])
    .execute();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const item of items) {
    const outboxId = deliveryId(item);
    const taskId = outboxId === undefined ? undefined : taskIds.get(outboxId);
    const task = taskId === undefined ? undefined : taskById.get(taskId);
    if (task !== undefined) owners.set(item.id, task);
  }
  return owners;
}

/** The task a `delivery:<outbox id>` item's row belongs to; the item itself has no task. */
async function deliveryTask(trx: Trx, item: Item): Promise<Row<'task'> | undefined> {
  return (await deliveryOwners(trx, [item])).get(item.id);
}

/** The task an item belongs to: its own, else its delivery's; undefined for a board item. */
async function itemOwner(trx: Trx, item: Item): Promise<Row<'task'> | undefined> {
  return item.task_id === null
    ? deliveryTask(trx, item)
    : trx.selectFrom('task').selectAll().where('id', '=', item.task_id).executeTakeFirst();
}

/**
 * What an item is about, as `inbox.operator` files it: its owning task (`itemOwner`), else the
 * block it refers to - that block's task, or a project-level block's project while the project
 * is in config. Undefined for a board item, including one whose project has left the config.
 */
export async function itemSubject(
  trx: Trx,
  item: Item,
  config: Config,
): Promise<BlockSubject | undefined> {
  const owner = await itemOwner(trx, item);
  if (owner !== undefined) return taskSubject(owner);
  const ref = itemBlockRef(item);
  const block =
    ref === undefined
      ? undefined
      : await trx
          .selectFrom('block')
          .select(['task_id', 'project'])
          .where('id', '=', ref)
          .executeTakeFirst();
  if (block === undefined) return undefined;
  if (block.task_id === null && !config.projects.some((entry) => entry.id === block.project)) {
    return undefined;
  }
  return blockSubject(trx, block);
}

/**
 * An item is its subject's project's (`itemSubject`); a board item or an unknown ID has no
 * target, so only the token, the board-wide operator or a one-project board's operator may act
 * on it, and `run` raises the unknown ID.
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
        const owner = task ?? (await deliveryTask(trx, item));
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
