import {
  EVENT_VERSION,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
  type Config,
  type EventKind,
  type EventPayload,
} from '@spur-board/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely, Selectable } from 'kysely';
import { toJson } from '../store/json.ts';
import type { LinkTable, Tables, TaskTable } from '../store/schema.ts';

export type Trx = Kysely<Tables>;
type Task = Selectable<TaskTable>;
type Link = Selectable<LinkTable>;

export function trackerSource(project: Config['projects'][number]): string {
  return project.tracker.type === 'jira'
    ? `jira:${project.id}`
    : `github-issues:${project.id}:${project.tracker.repo.toLowerCase()}`;
}

/** The project whose tracker or repo source wrote an observation. */
export function projectForSource(config: Config, source: string) {
  return config.projects.find(
    (project) =>
      source === trackerSource(project) ||
      project.repos.some((repo) => source === `github:${project.id}:${repo.toLowerCase()}`),
  );
}

export function projectForKey(config: Config, key: string): Config['projects'][number] | null {
  const lowerKey = key.toLowerCase();
  const matched = config.projects.filter((project) => {
    const tracker = project.tracker;
    if (tracker.type === 'github-issues') {
      const prefix = `${tracker.repo.toLowerCase()}#`;
      const short = tracker.repo.split('/')[1];
      return (
        lowerKey.startsWith(prefix) ||
        (short !== undefined && lowerKey.startsWith(`${short.toLowerCase()}#`))
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

/** The tracker page of a task: GitHub issue, Jira issue, or a GitHub fallback by key. */
export function taskUrl(task: Task, config: Config): string {
  if (task.tracker_kind === 'github-issues') {
    const match = /^(.+)#(\d+)$/.exec(task.key);
    if (match?.[1] !== undefined && match[2] !== undefined)
      return `https://github.com/${match[1]}/issues/${match[2]}`;
  }
  const project = config.projects.find((p) => p.id === task.project);
  if (project?.tracker.type === 'jira') {
    return `${project.tracker.baseUrl.replace(/\/$/, '')}/browse/${task.key}`;
  }
  return `https://github.com/${task.key.replace('#', '/issues/')}`;
}

const commandKeys = new AsyncLocalStorage<string>();

/**
 * Runs fn in the scope of one command: every event `emit` writes inside it carries `key` in
 * `request_id`. The innermost scope wins. Run only `trx` work inside it. Never trigger a job or
 * start detached work (timers, unawaited promises) in the scope: async context propagates into
 * it, and a scheduler job chains its next runs from that context, so a leaked `trigger()` would
 * stamp this key on every later scheduled run, not just one.
 */
export function withCommandKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return commandKeys.run(key, fn);
}

/** The only writer of the journal; `request_id` is the key of the enclosing command, or null. */
export async function emit<K extends EventKind>(
  trx: Trx,
  kind: K,
  project: string,
  taskId: number | null,
  at: string,
  payload: EventPayload<K>,
  actor: ActorId = 'system',
): Promise<void> {
  const parsed = parseActorId(actor);
  if (parsed === null) throw new Error('Invalid journal actor');
  await trx
    .insertInto('event')
    .values({
      at,
      project,
      task_id: taskId,
      kind,
      actor: parsed.actor,
      actor_ref: parsed.actor === 'agent' ? JSON.stringify(parsed.actorRef) : null,
      payload: toJson(eventPayloadSchemas[kind], payload),
      v: EVENT_VERSION,
      request_id: commandKeys.getStore() ?? null,
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

export function linkView(link: Link) {
  return {
    kind: link.entity,
    ref:
      link.entity === 'pr'
        ? `${link.repo ?? ''}#${String(link.number ?? '')}`
        : link.entity === 'session'
          ? (link.session_id ?? '')
          : (link.ticket_key ?? ''),
    role: link.role,
  };
}
