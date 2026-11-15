import type { Selectable } from 'kysely';
import type { BlockTable, TaskTable } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';

type Task = Selectable<TaskTable>;

/**
 * What a block is about: a task, or a board project when the block has no task. `key` names it
 * in rings and threads: the task key, else `<project> (project)`.
 */
export interface BlockSubject {
  readonly project: string;
  readonly task: Task | null;
  readonly key: string;
}

export function taskSubject(task: Task): BlockSubject {
  return { project: task.project, task, key: task.key };
}

export function projectSubject(project: string): BlockSubject {
  return { project, task: null, key: `${project} (project)` };
}

/** The subject of a row with a task or a block; a block without a task has a project. */
export async function rowSubject(
  trx: Trx,
  row: { readonly task_id: number | null; readonly block_id: number | null },
): Promise<BlockSubject> {
  if (row.task_id !== null) {
    const task = await trx
      .selectFrom('task')
      .selectAll()
      .where('id', '=', row.task_id)
      .executeTakeFirstOrThrow();
    return taskSubject(task);
  }
  if (row.block_id === null) throw new Error('Row has neither a task nor a block');
  const block = await trx
    .selectFrom('block')
    .select(['task_id', 'project'])
    .where('id', '=', row.block_id)
    .executeTakeFirstOrThrow();
  return blockSubject(trx, block);
}

export async function blockSubject(
  trx: Trx,
  block: Pick<Selectable<BlockTable>, 'task_id' | 'project'>,
): Promise<BlockSubject> {
  if (block.task_id !== null) return rowSubject(trx, { task_id: block.task_id, block_id: null });
  if (block.project === null) throw new Error('Block has neither a task nor a project');
  return projectSubject(block.project);
}
