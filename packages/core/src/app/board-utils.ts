import {
  EVENT_VERSION,
  defaultBranchViewSchema,
  encodeActorId,
  eventPayloadSchemas,
  parseActorId,
  parseRef,
  prFactsSchema,
  prSourceId,
  ticketFactsSchema,
  trackerSourceId,
  type ActorId,
  type ColumnId,
  type Config,
  type DefaultBranchView,
  type EventKind,
  type EventPayload,
  type GateReason,
  type MoveReason,
  type PrFacts,
  type Via,
} from '@spur-board/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import { parseJson, toJson } from '../store/json.ts';
import type { EventTable, LinkTable, Tables, TaskTable, TurnTable } from '../store/schema.ts';
import { taskChangeContext } from './secrets.ts';

export type Trx = Kysely<Tables>;
type Task = Selectable<TaskTable>;
type Link = Selectable<LinkTable>;

/** A changed task never trusts absence evidence older than any change already accepted. */
export function taskChangeAt(at: string) {
  const { config, clock } = taskChangeContext();
  const acceptedAt = new Date(clock.now()).toISOString();
  const scopes = config.projects.flatMap((project) =>
    project.repos.length === 0
      ? []
      : [
          sql`(task.project = ${project.id} AND source IN (${sql.join(project.repos.map((repo) => prSourceId(project.id, repo)))}))`,
        ],
  );
  const sources = sql.join([sql`source = 'spur'`, ...scopes], sql` OR `);
  return sql<string>`max(coalesce(last_change_at, created_at), ${at}, ${acceptedAt},
    coalesce((SELECT max(last_complete_at) FROM source_state WHERE ${sources}), ${at}))`;
}

export async function markTaskChanged(trx: Trx, taskId: number, at: string): Promise<void> {
  await trx
    .updateTable('task')
    .set({ last_change_at: taskChangeAt(at) })
    .where('id', '=', taskId)
    .execute();
}

/** Whether a ticket status is done: a Jira done status, or a closed GitHub Issue. */
export function ticketDone(project: Config['projects'][number], status: string): boolean {
  return project.tracker.type === 'jira'
    ? project.tracker.doneStatuses.includes(status)
    : status === 'closed';
}

/**
 * How the ticket of a task stands after its PR merged at `mergedAt`: `done`; `open` once the
 * tracker saw it open at least one tracker interval after the merge, in the filter or fetched by
 * key for a hand-added task; else `unconfirmed`, since the close a merge triggers may not be
 * polled yet and a ticket dropped from the filter keeps a stale status.
 */
export function mergedTicket(
  project: Config['projects'][number],
  config: Config,
  ticket: { status: string; detail: string; observed_at: string } | undefined,
  manualInclude: boolean,
  mergedAt: string,
): 'done' | 'open' | 'unconfirmed' {
  if (ticket === undefined) return 'unconfirmed';
  if (ticketDone(project, ticket.status)) return 'done';
  let inFilter: boolean;
  try {
    const parsed = ticketFactsSchema.safeParse(JSON.parse(ticket.detail));
    if (!parsed.success) return 'unconfirmed';
    inFilter = parsed.data.inFilter;
  } catch {
    return 'unconfirmed';
  }
  const { intervalMs } =
    project.tracker.type === 'jira' ? config.adapters.jira : config.adapters.githubIssues;
  return (inFilter || manualInclude) &&
    Date.parse(ticket.observed_at) >= Date.parse(mergedAt) + intervalMs
    ? 'open'
    : 'unconfirmed';
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

/**
 * The task's newest merged PR: the newest active unbanned link past the reopen floor whose PR is
 * seen merged. Completes a task whose follow-up PR closed unmerged after an earlier merge.
 */
export async function taskMergedPr(
  db: Trx,
  taskId: number,
): Promise<{ repo: string; number: number } | null> {
  const link = await db
    .selectFrom('link')
    .innerJoin('pr_snapshot', (join) =>
      join
        .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
        .onRef('pr_snapshot.number', '=', 'link.number'),
    )
    .select(['link.repo', 'link.number'])
    .where('link.task_id', '=', taskId)
    .where('link.entity', '=', 'pr')
    .where('link.pr_state', '=', 'active')
    .where('link.banned', '=', 0)
    .where('pr_snapshot.state', '=', 'merged')
    .where(pastReopenFloor)
    .orderBy('link.id', 'desc')
    .executeTakeFirst();
  return link?.repo == null || link.number === null
    ? null
    : { repo: link.repo, number: link.number };
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

/** A source's stored default-branch colour, or null when none is stored or it is unreadable. */
export function parseDefaultBranch(text: string | null | undefined): DefaultBranchView | null {
  if (text == null) return null;
  try {
    return defaultBranchViewSchema.safeParse(JSON.parse(text)).data ?? null;
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

const vias = new AsyncLocalStorage<Via>();

/**
 * Runs fn in the scope of one write path (`web`, `slack`, `cli` or `mcp`): every event `emit`
 * writes inside it carries it in `via`. The innermost scope wins, and it nests independently of
 * `withCommandKey`. The same rule applies: run only request work inside it, never trigger a job or
 * start detached work (timers, unawaited promises), or later scheduled runs would carry this `via`.
 */
export function withVia<T>(via: Via, fn: () => Promise<T>): Promise<T> {
  return vias.run(via, fn);
}

/**
 * The only writer of the journal; `request_id` is the key of the enclosing command and `via` the
 * write path of the enclosing `withVia` scope, each null outside one.
 */
export async function emit<K extends EventKind>(
  trx: Trx,
  kind: K,
  project: string,
  taskId: number | null,
  at: string,
  payload: EventPayload<K>,
  actor: ActorId = 'system',
): Promise<number> {
  const parsed = parseActorId(actor);
  if (parsed === null) throw new Error('Invalid journal actor');
  // Linking or unlinking work changes which absence the next complete source polls must prove.
  if (
    taskId !== null &&
    (kind === 'task_added' || kind === 'link_added' || kind === 'link_removed')
  )
    await markTaskChanged(trx, taskId, at);
  const event = await trx
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
      via: vias.getStore() ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return event.id;
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

/**
 * The return that opened the visit `turn` belongs to, or undefined. A `task.return` closes the
 * returned turn of the current visit and bumps the column epoch, so the visit it opens is the one
 * at the next epoch in the column it moved to. Read from ids and epochs, never from `at`: a later
 * move cannot add or remove it. The reason is the code block's current reason.
 */
export async function turnReturn(
  db: Trx,
  turn: Pick<Selectable<TurnTable>, 'task_id' | 'column' | 'epoch'>,
) {
  const previous = await db
    .selectFrom('turn')
    .select('id')
    .where('task_id', '=', turn.task_id)
    .where('epoch', '=', turn.epoch - 1)
    .execute();
  if (previous.length === 0) return undefined;
  const labels = new Set(previous.map((row) => `T${String(row.id)}`));
  const moves = await db
    .selectFrom('event')
    .select(['actor', 'actor_ref', 'payload'])
    .where('task_id', '=', turn.task_id)
    .where('kind', '=', 'task_moved')
    .orderBy('id', 'desc')
    .execute();
  for (const row of moves) {
    const parsed = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
    if (!parsed.success) continue;
    const { from, to, turn: returned, block } = parsed.data;
    if (returned === undefined || block === undefined || to !== turn.column) continue;
    if (!labels.has(returned) || !/^B\d+$/.test(block)) continue;
    const opened = await db
      .selectFrom('block')
      .select('reason')
      .where('id', '=', Number(block.slice(1)))
      .where('task_id', '=', turn.task_id)
      .executeTakeFirst();
    if (opened === undefined) return undefined;
    return { by: eventActor(row), from, turn: returned, block, reason: opened.reason };
  }
  return undefined;
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
