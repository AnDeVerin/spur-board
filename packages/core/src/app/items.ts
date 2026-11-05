import type { Kysely } from 'kysely';
import { fingerprint } from '../domain/fromYou.ts';
import type { Row, Tables } from '../store/schema.ts';
import { CommandError, type Mutation } from './commands.ts';
import { restartNotification } from './doorbells.ts';
import { clearItem } from './feed.ts';
import { requeuePostFailed } from './sender.ts';

type Trx = Kysely<Tables>;
type Item = Row<'operator_item'>;

/** Re-applies an `inbound_failure` item's stored event in `trx`; the caller clears the item. */
export type ReapplyInbound = (trx: Trx, itemId: number, at: string) => Promise<void>;

const DOORBELL_ITEM = /^(?:answer_undelivered|worker_not_reading):(.+)$/;

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

/** Item actions: retry runs the action behind the item's kind; close dismisses it. Both clear it. */
export function createItemMutations(deps: { reapplyInbound?: () => ReapplyInbound | undefined }): {
  retry: Mutation<'item.retry'>;
  close: Mutation<'item.close'>;
} {
  async function retryAction(trx: Trx, item: Item, at: string): Promise<void> {
    const closeHint = `close it with \`board item close I${String(item.id)}\`.`;
    if (item.item_key.startsWith('delivery:')) {
      const outboxId = Number(item.item_key.slice('delivery:'.length));
      if ((await requeuePostFailed(trx, [outboxId], at)) === 0) {
        throw notApplicable('The delivery is no longer failed.');
      }
      return;
    }
    const doorbell = DOORBELL_ITEM.exec(item.item_key);
    if (doorbell?.[1] !== undefined) {
      await restartNotification(trx, doorbell[1], new Date(at));
      return;
    }
    if (item.kind === 'inbound_failure') {
      const reapply = deps.reapplyInbound?.();
      if (reapply === undefined) {
        throw notApplicable('Slack inbound is not running; close the item instead.');
      }
      await reapply(trx, item.id, at);
      return;
    }
    if (item.kind === 'post_blocked') {
      throw notApplicable(`The blocked text is never sent; ${closeHint}`);
    }
    throw notApplicable(`This item has no retry action; ${closeHint}`);
  }

  return {
    retry: {
      id: 'item.retry',
      resolveTargets: () => Promise.resolve([]),
      async run(trx, input, ctx) {
        const { item, task } = await loadItem(trx, input.item);
        if (task?.membership === 'archived') {
          throw new CommandError('task_archived', 'Add the task again before retrying its item.');
        }
        if (item.cleared_at !== null) throw notApplicable('The item is already cleared.');
        await retryAction(trx, item, ctx.at);
        await clearItem(trx, item.id, new Date(ctx.at), ctx.actor);
        return view(item, task);
      },
    },
    close: {
      id: 'item.close',
      resolveTargets: () => Promise.resolve([]),
      async run(trx, input, ctx) {
        const { item, task } = await loadItem(trx, input.item);
        if (item.cleared_at === null) {
          const hash =
            item.fingerprint ??
            fingerprint({
              key: item.item_key,
              taskId: item.task_id,
              summary: item.text,
              factAt: item.fact_at,
              source: item.source,
              priority: item.priority ?? 0,
              revision: null,
            });
          await trx
            .insertInto('dismissal')
            .values({
              item_key: item.item_key,
              fingerprint: hash,
              dismissed_by: ctx.actor,
              dismissed_at: ctx.at,
            })
            .onConflict((oc) =>
              oc.column('item_key').doUpdateSet({
                fingerprint: hash,
                dismissed_by: ctx.actor,
                dismissed_at: ctx.at,
              }),
            )
            .execute();
          await clearItem(trx, item.id, new Date(ctx.at), ctx.actor);
        }
        return view(item, task);
      },
    },
  };
}
