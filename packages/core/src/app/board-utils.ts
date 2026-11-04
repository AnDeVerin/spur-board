import {
  EVENT_VERSION,
  eventPayloadSchemas,
  type Config,
  type EventKind,
  type EventPayload,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { toJson } from '../store/json.ts';
import type { Tables, TaskTable } from '../store/schema.ts';
import type { Selectable } from 'kysely';

export type Trx = Kysely<Tables>;
export type Task = Selectable<TaskTable>;

export function trackerSource(project: Config['projects'][number]): string {
  return project.tracker.type === 'jira'
    ? `jira:${project.id}`
    : `github-issues:${project.id}:${project.tracker.repo.toLowerCase()}`;
}

export function projectForKey(config: Config, key: string): Config['projects'][number] | null {
  const matched = config.projects.filter((project) => {
    const tracker = project.tracker;
    if (tracker.type === 'github-issues') {
      const prefix = `${tracker.repo.toLowerCase()}#`;
      const short = tracker.repo.split('/')[1];
      return (
        key.toLowerCase().startsWith(prefix) ||
        (short !== undefined && key.toLowerCase().startsWith(`${short.toLowerCase()}#`))
      );
    }
    const prefix = /^([A-Za-z][A-Za-z0-9_]*)-/.exec(key)?.[1]?.toUpperCase();
    return (
      prefix !== undefined &&
      (tracker.projectKeys.length === 0 || tracker.projectKeys.includes(prefix))
    );
  });
  return matched.length === 1 ? (matched[0] ?? null) : null;
}

export async function emit<K extends EventKind>(
  trx: Trx,
  kind: K,
  project: string,
  taskId: number | null,
  at: string,
  payload: EventPayload<K>,
  actor: 'operator' | 'system' = 'system',
): Promise<void> {
  await trx
    .insertInto('event')
    .values({
      at,
      project,
      task_id: taskId,
      kind,
      actor,
      actor_ref: null,
      payload: toJson(eventPayloadSchemas[kind], payload),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}

export function taskView(task: Task) {
  return {
    key: task.key,
    project: task.project,
    column: task.column,
    membership: task.membership,
  };
}
