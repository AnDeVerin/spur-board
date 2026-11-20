import type { Config } from '@spur-board/contracts';
import { taskTarget } from './blocks.ts';
import { emit, taskView, type Trx } from './board-utils.ts';
import { CommandError, type Mutation } from './commands.ts';
import { storedKey } from './membership.ts';

const PICK_ANOTHER = 'name another task of its column, or use --top or --bottom.';

async function taskByKey(trx: Trx, key: string) {
  return trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
}

/** The anchor task of a before or after placement; anything but another live task of the column is refused. */
async function anchorTask(
  trx: Trx,
  config: Config,
  key: string,
  task: { id: number; project: string; column: string },
) {
  let stored: string;
  try {
    stored = storedKey(config, key);
  } catch (error) {
    if (error instanceof CommandError && error.code === 'not_found')
      throw new CommandError('order_anchor_invalid', `No task has the key ${key}; ${PICK_ANOTHER}`);
    throw error;
  }
  const anchor = await taskByKey(trx, stored);
  if (anchor === undefined)
    throw new CommandError('order_anchor_invalid', `No task has the key ${key}; ${PICK_ANOTHER}`);
  if (anchor.id === task.id)
    throw new CommandError(
      'order_anchor_invalid',
      `The anchor is the task itself; ${PICK_ANOTHER}`,
    );
  if (anchor.membership === 'archived')
    throw new CommandError(
      'order_anchor_invalid',
      `Task ${anchor.key} is archived; ${PICK_ANOTHER}`,
    );
  if (anchor.project !== task.project || anchor.column !== task.column)
    throw new CommandError(
      'order_anchor_invalid',
      `Task ${anchor.key} is in ${anchor.project} ${anchor.column}, not ${task.project} ${task.column}; ${PICK_ANOTHER}`,
    );
  return anchor;
}

/** The operator's manual order of a column: one board-wide order per (project, column). */
export function createOrderMutations(config: Config) {
  /**
   * Renumbers the live tasks of the task's column 1..n with the task at its new place, writing only
   * the rows whose place changed, and journals `task_reordered`. A placement that keeps the task's
   * place writes nothing.
   */
  const order: Mutation<'task.order'> = {
    id: 'task.order',
    resolveTargets: (trx, input) => taskTarget(trx, storedKey(config, input.task)),
    async run(trx, input, ctx) {
      const task = await taskByKey(trx, storedKey(config, input.task));
      if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
      if (task.membership === 'archived')
        throw new CommandError('task_archived', 'Add the task again before ordering it.');
      const rows = await trx
        .selectFrom('task')
        .select(['id', 'key', 'position'])
        .where('project', '=', task.project)
        .where('column', '=', task.column)
        .where('membership', '!=', 'archived')
        .orderBy('position')
        .orderBy('id')
        .execute();
      const self = rows.find((row) => row.id === task.id);
      if (self === undefined) throw new Error('Live task missing from its column');
      const others = rows.filter((row) => row.id !== task.id);
      let index = input.mode === 'top' ? 0 : others.length;
      if (input.mode === 'before' || input.mode === 'after') {
        const anchor = await anchorTask(trx, config, input.anchor, task);
        index = others.findIndex((row) => row.id === anchor.id) + (input.mode === 'after' ? 1 : 0);
      }
      const placed = [...others.slice(0, index), self, ...others.slice(index)];
      const from = rows.indexOf(self) + 1;
      const to = index + 1;
      if (from !== to) {
        for (const [i, row] of placed.entries()) {
          if (row.position === i + 1) continue;
          await trx
            .updateTable('task')
            .set({ position: i + 1 })
            .where('id', '=', row.id)
            .execute();
        }
        await emit(
          trx,
          'task_reordered',
          task.project,
          task.id,
          ctx.at,
          { column: task.column, from, to },
          ctx.actor,
        );
      }
      return {
        task: taskView(task),
        position: to,
        previous: placed[index - 1]?.key ?? null,
        next: placed[index + 1]?.key ?? null,
      };
    },
  };
  return { order };
}
