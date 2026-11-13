import { parseRef, type Config } from '@spur-board/contracts';
import type { Mutation } from './commands.ts';
import { CommandError } from './commands.ts';
import { archiveTask } from './archive.ts';
import { emit, projectForKey, taskView, type Trx } from './board-utils.ts';

export function canonicalKey(
  config: Config,
  key: string,
): { project: Config['projects'][number]; key: string } {
  const parsed = parseRef(key, 'task');
  if (!parsed.ok || parsed.value.kind !== 'task')
    throw new CommandError('not_found', 'Check the tracker task key.');
  const project = projectForKey(config, key);
  if (project === null)
    throw new CommandError('not_found', 'Key matches no unique project tracker.');
  if (project.tracker.type === 'github-issues' && parsed.value.form === 'github-short')
    return { project, key: `${project.tracker.repo}#${key.split('#')[1] ?? ''}` };
  return { project, key };
}

async function target(trx: Trx, key: string) {
  const task = await trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
  return task === undefined
    ? [{ kind: 'missing' as const }]
    : [
        {
          kind: 'found' as const,
          value: {
            project: task.project,
            task: { id: task.id, column: task.column },
            block: null,
            workers: [],
          },
        },
      ];
}

/** Operator membership commands. `task.add` creates a pending key without tracker IO. */
export function createMembershipMutations(config: Config): {
  add: Mutation<'task.add'>;
  archive: Mutation<'task.archive'>;
} {
  return {
    add: {
      id: 'task.add',
      resolveTargets() {
        return Promise.resolve([]);
      },
      async run(trx, input, ctx) {
        const { project, key } = canonicalKey(config, input.task);
        let task = await trx
          .selectFrom('task')
          .selectAll()
          .where('project', '=', project.id)
          .where('key', '=', key)
          .executeTakeFirst();
        if (task === undefined) {
          const inserted = await trx
            .insertInto('task')
            .values({
              project: project.id,
              tracker_kind: project.tracker.type,
              tracker_id: null,
              key,
              membership: 'active',
              archive_reason: null,
              column: 'todo',
              shadow_column: null,
              created_at: ctx.at,
              manual_include: 1,
              manual_exclude: 0,
              last_change_at: ctx.at,
              terminal_at: null,
              archive_slot_at: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          task = inserted;
          await emit(
            trx,
            'task_added',
            project.id,
            task.id,
            ctx.at,
            { column: task.column },
            'operator',
          );
        } else {
          if (task.archive_reason === 'done')
            throw new CommandError('task_archived', 'A Done archive is final.');
          await trx
            .updateTable('task')
            .set({
              manual_include: 1,
              manual_exclude: 0,
              membership: 'active',
              archive_reason: null,
              last_change_at: ctx.at,
            })
            .where('id', '=', task.id)
            .execute();
          // The journal is the dispatcher's trigger: a reactivation evaluates on the next tick.
          if (task.membership === 'archived')
            await emit(
              trx,
              'task_added',
              project.id,
              task.id,
              ctx.at,
              { column: task.column },
              'operator',
            );
          task = await trx
            .selectFrom('task')
            .selectAll()
            .where('id', '=', task.id)
            .executeTakeFirstOrThrow();
        }
        return { task: taskView(task) };
      },
    },
    archive: {
      id: 'task.archive',
      resolveTargets(trx, input) {
        return target(trx, input.task);
      },
      async run(trx, input, ctx) {
        const task = await trx
          .selectFrom('task')
          .selectAll()
          .where('key', '=', input.task)
          .executeTakeFirst();
        if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
        if (task.membership === 'archived')
          throw new CommandError('task_archived', 'Task is archived.');
        await trx
          .updateTable('task')
          .set({ manual_include: 0, manual_exclude: 1 })
          .where('id', '=', task.id)
          .execute();
        await archiveTask(trx, { task, reason: 'manual', actor: ctx.actor, at: ctx.at });
        return { task: { ...taskView(task), membership: 'archived' as const } };
      },
    },
  };
}
