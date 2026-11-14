import {
  EVENT_VERSION,
  encodeActorId,
  eventPayloadSchemas,
  parseActorId,
  parseRef,
  prFactsSchema,
  prSourceId,
  trackerSourceId,
  type ActorId,
  type ColumnId,
  type Config,
  type EventKind,
  type EventPayload,
  type GateReason,
  type MoveReason,
  type PrFacts,
} from '@spur-board/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import { parseJson, toJson } from '../store/json.ts';
import type { EventTable, LinkTable, Tables, TaskTable } from '../store/schema.ts';

export type Trx = Kysely<Tables>;
type Task = Selectable<TaskTable>;
type Link = Selectable<LinkTable>;

/** Whether a ticket status is done: a Jira done status, or a closed GitHub Issue. */
export function ticketDone(project: Config['projects'][number], status: string): boolean {
  return project.tracker.type === 'jira'
    ? project.tracker.doneStatuses.includes(status)
    : status === 'closed';
}

/**
 * Whether a PR link counts past the task's reopen floor: an open link, or a link not hidden by a
 * reopen. For a query over `link`. Written so a link without a marker counts: the negated form
 * is NULL there and would drop it.
 */
export const pastReopenFloor = sql<boolean>`(link.pr_open = 1 OR link.reopen_hidden_at IS NULL)`;

/**
 * The task's PR: the open active unbanned link past the reopen floor, else the newest active
 * unbanned one past it.
 */
export async function taskPr(
  db: Trx,
  taskId: number,
): Promise<{ repo: string; number: number; open: boolean } | null> {
  const link = await db
    .selectFrom('link')
    .select(['link.repo', 'link.number', 'link.pr_open'])
    .where('link.task_id', '=', taskId)
    .where('link.entity', '=', 'pr')
    .where('link.pr_state', '=', 'active')
    .where('link.banned', '=', 0)
    .where('link.repo', 'is not', null)
    .where('link.number', 'is not', null)
    .where(pastReopenFloor)
    .orderBy('link.pr_open', 'desc')
    .orderBy('link.id', 'desc')
    .executeTakeFirst();
  return link?.repo == null || link.number === null
    ? null
    : { repo: link.repo, number: link.number, open: link.pr_open === 1 };
}

/** A PR snapshot's facts, or null when the detail is missing or unreadable. */
export function parsePr(detail: string | undefined): PrFacts | null {
  if (detail === undefined) return null;
  try {
    const parsed = prFactsSchema.safeParse(JSON.parse(detail));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The project whose tracker or repo source wrote an observation. */
export function projectForSource(config: Config, source: string) {
  return config.projects.find(
    (project) =>
      source === trackerSourceId(project) ||
      project.repos.some((repo) => source === prSourceId(project.id, repo)),
  );
}

/** The one project whose tracker takes `key` by its form: Jira for `ABC-1`, GitHub for `#`. */
export function projectForKey(config: Config, key: string): Config['projects'][number] | null {
  const parsed = parseRef(key, 'task');
  if (!parsed.ok || parsed.value.kind !== 'task') return null;
  const { form } = parsed.value;
  const lowerKey = key.toLowerCase();
  const matched = config.projects.filter((project) => {
    const tracker = project.tracker;
    if (tracker.type === 'github-issues') {
      const repo = lowerKey.split('#')[0];
      const full = tracker.repo.toLowerCase();
      if (form === 'github') return repo === full;
      return form === 'github-short' && repo === full.split('/')[1];
    }
    if (form !== 'jira') return false;
    const prefix = key.split('-')[0]?.toUpperCase();
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

const actorRefSchema = z.strictObject({ project: z.string().min(1), session: z.string().min(1) });

/** The actor ID of a journal row. */
export function eventActor(row: Pick<Selectable<EventTable>, 'actor' | 'actor_ref'>): ActorId {
  const actorRef = row.actor_ref === null ? undefined : parseJson(actorRefSchema, row.actor_ref);
  return encodeActorId({ actor: row.actor, actorRef });
}

const MOVE_KINDS = ['task_moved', 'task_shadow_moved', 'task_corrected'] as const;

/** One column move as `task.get --why` and `task.move` show it. */
interface MoveView {
  at: string;
  kind: (typeof MOVE_KINDS)[number];
  actor: ActorId;
  from: ColumnId;
  to: ColumnId;
  reason: MoveReason | 'returned' | 'corrected';
  gate: GateReason[];
  text: string | null;
}

function moveView(row: Selectable<EventTable>): MoveView | null {
  const base = { at: row.at, actor: eventActor(row) };
  const payload: unknown = JSON.parse(row.payload);
  if (row.kind === 'task_corrected') {
    const parsed = eventPayloadSchemas.task_corrected.safeParse(payload);
    if (!parsed.success) return null;
    const { from, to, reason } = parsed.data;
    return { ...base, kind: row.kind, from, to, reason: 'corrected', gate: [], text: reason };
  }
  if (row.kind === 'task_shadow_moved') {
    const parsed = eventPayloadSchemas.task_shadow_moved.safeParse(payload);
    if (!parsed.success) return null;
    const { from, to, reason, gate } = parsed.data;
    return { ...base, kind: row.kind, from, to, reason, gate: gate ?? [], text: null };
  }
  const parsed = eventPayloadSchemas.task_moved.safeParse(payload);
  if (!parsed.success) return null;
  const { from, to, reason, gate, block } = parsed.data;
  // `task.return` journals its move with the block it opened and no dispatcher reason.
  if (reason === undefined) {
    return block === undefined
      ? null
      : { ...base, kind: 'task_moved', from, to, reason: 'returned', gate: [], text: block };
  }
  return { ...base, kind: 'task_moved', from, to, reason, gate: gate ?? [], text: null };
}

/**
 * The task's column moves, oldest first: those journaled after event `after`, or the newest
 * `limit`.
 */
export async function moveViews(
  db: Trx,
  taskId: number,
  options: { after: number } | { limit: number },
): Promise<MoveView[]> {
  const query = db
    .selectFrom('event')
    .selectAll()
    .where('task_id', '=', taskId)
    .where('kind', 'in', MOVE_KINDS);
  const rows =
    'after' in options
      ? await query.where('id', '>', options.after).orderBy('id').execute()
      : (await query.orderBy('id', 'desc').limit(options.limit).execute()).reverse();
  return rows.flatMap((row) => moveView(row) ?? []);
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
