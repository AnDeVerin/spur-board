import { columnTurnTimings, inboxNoSessionSchema, type Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import type { z } from 'zod';
import { NO_SESSION_KEY, parseNoSessionSummary } from '../domain/fromYou.ts';
import type { Row } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';

// The `no-session:` board observation of the operator inbox: its text and its `noSession` fields.

type Item = Row<'operator_item'>;
export type NoSession = z.infer<typeof inboxNoSessionSchema>;

/** The board project and column a `no-session:<project>:<column>` key names. */
function noSessionColumn(key: string): { project: string; column: string } {
  const rest = key.slice(NO_SESSION_KEY.length);
  const last = rest.lastIndexOf(':');
  return { project: rest.slice(0, last), column: rest.slice(last + 1) };
}

/** The untaken orchestrator turns of an open `no-session:` item's columns, as `waitingTurns` reads them. */
export interface Waiting {
  /** Waiting turns by `<project>:<column>`. */
  count: Map<string, number>;
  /** Each waiting turn and when it first rang, by `<task id>:<column>`. */
  turnOf: Map<string, { turn: number; rangAt: string }>;
  /** Ids of the waiting turns. */
  ids: Set<number>;
}

/**
 * Untaken orchestrator turns of non-archived tasks with a ringing turn notification, as the
 * reconcile counts them: one batched read, run only when an open `no-session:` item is listed.
 */
export async function waitingTurns(trx: Trx, items: readonly Item[]): Promise<Waiting> {
  const waiting: Waiting = { count: new Map(), turnOf: new Map(), ids: new Set() };
  if (!items.some((item) => item.item_key.startsWith(NO_SESSION_KEY))) return waiting;
  const rows = await trx
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .innerJoin('notification', 'notification.turn_id', 'turn.id')
    .select([
      'task.project',
      'turn.column',
      'turn.task_id',
      'turn.id',
      (eb) => eb.fn.min<string>('notification.created_at').as('rang_at'),
    ])
    .where('task.membership', '!=', 'archived')
    .where('turn.closed_at', 'is', null)
    .where('turn.acked_at', 'is', null)
    .where(sql<boolean>`turn.role = 'orchestrator:' || turn."column"`)
    .where('notification.kind', '=', 'turn')
    .where('notification.acked_at', 'is', null)
    .where('notification.exhausted_at', 'is', null)
    .groupBy('turn.id')
    .execute();
  for (const row of rows) {
    const key = `${row.project}:${row.column}`;
    waiting.count.set(key, (waiting.count.get(key) ?? 0) + 1);
    waiting.ids.add(row.id);
    waiting.turnOf.set(`${String(row.task_id)}:${row.column}`, {
      turn: row.id,
      rangAt: row.rang_at,
    });
  }
  return waiting;
}

/**
 * The text of a `no-session:` item: while open, its stored text with the waiting turns and the
 * whole minutes since `fact_at` read now; a cleared one keeps its stored text. The action names
 * the column's Spur project.
 */
export function noSessionText(
  item: Item,
  config: Config,
  waiting: Waiting,
  now: number,
): { condition: string; action: string } {
  const { project, column } = noSessionColumn(item.item_key);
  const spur = columnTurnTimings(config, project, column)?.orchestrator;
  const action = `start a session in ${spur === undefined ? 'its Spur project' : `Spur project ${spur}`}, or take over its turns with board inbox ack`;
  const since = item.fact_at === null ? NaN : Date.parse(item.fact_at);
  if (item.cleared_at !== null || Number.isNaN(since)) return { condition: item.text, action };
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  const count = waiting.count.get(`${project}:${column}`) ?? 0;
  return {
    condition: `${item.text}; ${String(count)} waiting, no live session for ${String(minutes)} min`,
    action,
  };
}

/**
 * The fields of a `no-session:` item: the Spur project and oldest turn its summary recorded, else
 * the column's binding and, while open, the task's waiting turn; while open also the waiting count
 * and the turn's ring time while that turn still waits. Undefined when the key, task or `fact_at`
 * cannot be read.
 */
export function noSessionFields(
  item: Item,
  task: string | undefined,
  config: Config,
  waiting: Waiting,
): NoSession | undefined {
  const { project, column } = noSessionColumn(item.item_key);
  const since = item.fact_at === null ? NaN : Date.parse(item.fact_at);
  if (task === undefined || Number.isNaN(since)) return undefined;
  const parsed = parseNoSessionSummary(item.text);
  const recorded = parsed?.project === project && parsed.column === column ? parsed : undefined;
  const spurProject = recorded?.spur ?? columnTurnTimings(config, project, column)?.orchestrator;
  const open = item.cleared_at === null;
  const ringing =
    open && recorded === undefined && item.task_id !== null
      ? waiting.turnOf.get(`${String(item.task_id)}:${column}`)
      : undefined;
  const turn = recorded?.turn ?? ringing?.turn;
  const rangAt = !open
    ? NaN
    : recorded === undefined
      ? Date.parse(ringing?.rangAt ?? '')
      : waiting.ids.has(recorded.turn)
        ? Date.parse(recorded.ringAt)
        : NaN;
  const fields = inboxNoSessionSchema.safeParse({
    project,
    column,
    ...(spurProject === undefined ? {} : { spurProject }),
    oldestTask: task,
    since: new Date(since).toISOString(),
    ...(open ? { waiting: waiting.count.get(`${project}:${column}`) ?? 0 } : {}),
    ...(turn === undefined ? {} : { oldestTurn: `T${String(turn)}` }),
    ...(Number.isNaN(rangAt) ? {} : { oldestAt: new Date(rangAt).toISOString() }),
  });
  return fields.success ? fields.data : undefined;
}
