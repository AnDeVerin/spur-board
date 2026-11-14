import { assertNever } from '@spur-board/contracts';
import { isItemKind, ITEM_POLICY } from '../domain/fromYou.ts';
import type { Row } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import { closeBlockIfOpen } from './blocks.ts';
import { CommandError, type Mutation } from './commands.ts';
import { restartNotification, ringTask } from './doorbells.ts';
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

/** The task a `delivery:<outbox id>` item's row belongs to; the item itself has no task. */
async function deliveryTask(trx: Trx, item: Item): Promise<Row<'task'> | undefined> {
  if (item.kind !== 'post_failed') return undefined;
  const row = await trx
    .selectFrom('outbox')
    .select(['kind', 'dedupe_key', 'payload'])
    .where('id', '=', Number(item.item_key.slice('delivery:'.length)))
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const payload = JSON.parse(row.payload) as { taskId?: unknown; notificationId?: unknown };
  if (typeof payload.taskId === 'number')
    return trx.selectFrom('task').selectAll().where('id', '=', payload.taskId).executeTakeFirst();
  if (row.kind !== 'doorbell') return undefined;
  const notificationId =
    typeof payload.notificationId === 'number' ? payload.notificationId : undefined;
  return ringTask(trx, notificationId, row.dedupe_key);
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
export function createItemMutations(deps: { reapplyInbound?: () => ReapplyInbound | undefined }): {
  retry: Mutation<'item.retry'>;
  close: Mutation<'item.close'>;
} {
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
      resolveTargets: () => Promise.resolve([]),
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
      resolveTargets: () => Promise.resolve([]),
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
