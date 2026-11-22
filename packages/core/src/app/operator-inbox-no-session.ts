import { columnTurnTimings, inboxNoSessionSchema, type Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import type { z } from 'zod';
import { NO_SESSION_KEY } from '../domain/fromYou.ts';
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
}

/**
 * Untaken orchestrator turns of non-archived tasks with a ringing turn notification, as the
 * reconcile counts them: one batched read, run only when an open `no-session:` item is listed.
 */
export async function waitingTurns(trx: Trx, items: readonly Item[]): Promise<Waiting> {
  const waiting: Waiting = { count: new Map(), turnOf: new Map() };
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
    waiting.turnOf.set(`${String(row.task_id)}:${row.column}`, {
      turn: row.id,
      rangAt: row.rang_at,
    });
  }
  return waiting;
}

/**
 * The orchestrator turn each cleared `no-session:` item was raised for, by item id: its task's
 * turn in the item's column opened by `raised_at` and still unclosed then, the highest id on a tie.
 * One batched read, run only when such an item is listed.
 */
export async function handledOldestTurns(
  trx: Trx,
  items: readonly Item[],
): Promise<Map<number, number>> {
  const cleared = items.filter(
    (item) =>
      item.cleared_at !== null && item.task_id !== null && item.item_key.startsWith(NO_SESSION_KEY),
  );
  if (cleared.length === 0) return new Map();
  const rows = await trx
    .selectFrom('operator_item')
    .innerJoin('turn', 'turn.task_id', 'operator_item.task_id')
    .select(['operator_item.id as item_id', 'operator_item.item_key', 'turn.column', 'turn.id'])
    .where(
      'operator_item.id',
      'in',
      cleared.map((item) => item.id),
    )
    .where(sql<boolean>`turn.role = 'orchestrator:' || turn."column"`)
    .whereRef('turn.created_at', '<=', 'operator_item.raised_at')
    .where((eb) =>
      eb.or([
        eb('turn.closed_at', 'is', null),
        eb('turn.closed_at', '>', eb.ref('operator_item.raised_at')),
      ]),
    )
    .execute();
  const found = new Map<number, number>();
  for (const row of rows) {
    if (noSessionColumn(row.item_key).column !== row.column) continue;
    found.set(row.item_id, Math.max(found.get(row.item_id) ?? 0, row.id));
  }
  return found;
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
 * The fields of a `no-session:` item, read like `noSessionText`: the waiting count and the
 * oldest turn's ring time while open, the turn it was raised for once cleared. Undefined when
 * the key, column binding, task or `fact_at` cannot be read.
 */
export function noSessionFields(
  item: Item,
  task: string | undefined,
  config: Config,
  waiting: Waiting,
  handledTurn: number | undefined,
): NoSession | undefined {
  const { project, column } = noSessionColumn(item.item_key);
  const spurProject = columnTurnTimings(config, project, column)?.orchestrator;
  const since = item.fact_at === null ? NaN : Date.parse(item.fact_at);
  if (spurProject === undefined || task === undefined || Number.isNaN(since)) return undefined;
  const open = item.cleared_at === null;
  const ringing =
    open && item.task_id !== null
      ? waiting.turnOf.get(`${String(item.task_id)}:${column}`)
      : undefined;
  const turn = open ? ringing?.turn : handledTurn;
  const rangAt = ringing === undefined ? NaN : Date.parse(ringing.rangAt);
  const parsed = inboxNoSessionSchema.safeParse({
    project,
    column,
    spurProject,
    oldestTask: task,
    since: new Date(since).toISOString(),
    ...(open ? { waiting: waiting.count.get(`${project}:${column}`) ?? 0 } : {}),
    ...(turn === undefined ? {} : { oldestTurn: `T${String(turn)}` }),
    ...(Number.isNaN(rangAt) ? {} : { oldestAt: new Date(rangAt).toISOString() }),
  });
  return parsed.success ? parsed.data : undefined;
}
