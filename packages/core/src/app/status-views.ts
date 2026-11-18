import { sql } from 'kysely';
import {
  COLUMN_GROUPS,
  COLUMNS,
  eventPayloadSchemas,
  type ActorId,
  type AddresseeRole,
  type ColumnId,
  type Config,
  type PrFacts,
  type SessionFacts,
} from '@spur-board/contracts';
import type { Store } from '../store/store.ts';
import { eventActor } from './board-utils.ts';

/** The column groups with their built-in columns in canonical order, the same for every project. */
export function columnGroupViews() {
  return COLUMN_GROUPS.map((id) => ({
    id,
    columns: COLUMNS.filter((c) => c.group === id).map((c) => c.id),
  }));
}

/** A session fact with its links as a list. */
export function sessionView(fact: SessionFacts) {
  return { ...fact, links: Object.entries(fact.links).map(([label, url]) => ({ label, url })) };
}

/** Factual PR rollup; the caller owns snapshot freshness and all reads. */
export function summarizePr(fact: PrFacts, factAt: string, unconfirmed: boolean) {
  const checks = fact.requiredChecks.length > 0 ? fact.requiredChecks : fact.checks;
  return {
    repo: fact.repo,
    number: fact.number,
    checks: {
      pass: checks.filter((check) => check.state === 'success' || check.state === 'neutral').length,
      pending: checks.filter((check) => check.state === 'expected' || check.state === 'pending')
        .length,
      fail: checks.filter(
        (check) => !['success', 'neutral', 'expected', 'pending'].includes(check.state),
      ).length,
    },
    mergeable: fact.mergeable,
    threads: {
      unresolved: fact.reviewThreads.filter((thread) => !thread.resolved).length,
      total: fact.reviewThreads.length,
    },
    reviewsOnHead: {
      approved: fact.reviews
        .filter((review) => review.commitSha === fact.headSha && review.state === 'approved')
        .map((review) => review.reviewer),
      changesRequested: fact.reviews
        .filter(
          (review) => review.commitSha === fact.headSha && review.state === 'changes_requested',
        )
        .map((review) => review.reviewer),
    },
    draft: fact.draft,
    factAt,
    unconfirmed,
  };
}

/** Load compact unclosed turn scalars once for the visible page. */
export async function readStatusTurns(db: Store['db'], projectIds: ReadonlySet<string>) {
  const turnRows = await db
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .leftJoin('notification', (join) =>
      join
        .onRef('notification.turn_id', '=', 'turn.id')
        .on('notification.kind', '=', 'turn')
        .on('notification.id', '=', (eb) =>
          eb
            .selectFrom('notification as newest')
            .select((eb) => eb.fn.max('newest.id').as('id'))
            .whereRef('newest.turn_id', '=', 'turn.id')
            .where('newest.kind', '=', 'turn'),
        ),
    )
    .select([
      'turn.id',
      'turn.task_id',
      'turn.column',
      'turn.role',
      'turn.reason',
      'turn.head_sha',
      'turn.created_at',
      'turn.acked_by',
      'turn.acked_at',
    ])
    .select(['task.key as task_key', 'notification.recipient_session'])
    // The open stall items of this turn (`turn-stall:<turnId>:...`, fromYou.ts): a key range the
    // operator_item_active index serves, ';' being the byte after ':'.
    .select((eb) =>
      eb
        .selectFrom('operator_item')
        .select((eb) => eb.fn.min('operator_item.fact_at').as('fact_at'))
        .where('operator_item.cleared_at', 'is', null)
        .where(
          'operator_item.item_key',
          '>=',
          sql<string>`'turn-stall:' || ${sql.ref('turn.id')} || ':'`,
        )
        .where(
          'operator_item.item_key',
          '<',
          sql<string>`'turn-stall:' || ${sql.ref('turn.id')} || ';'`,
        )
        .as('stalled_since'),
    )
    .where('turn.closed_at', 'is', null)
    .where('task.membership', '!=', 'archived')
    .where('task.project', 'in', [...projectIds])
    .execute();
  return new Map(
    turnRows.map((turn) => [
      turn.task_id,
      {
        id: `T${String(turn.id)}`,
        task: turn.task_key,
        column: turn.column,
        addressee: turn.role,
        reason: turn.reason,
        head: turn.head_sha,
        at: turn.created_at,
        taken:
          turn.acked_by === null || turn.acked_at === null
            ? null
            : { by: turn.acked_by, at: turn.acked_at },
        addressedTo: turn.acked_at === null ? turn.recipient_session : null,
        stalledSince: turn.stalled_since,
      },
    ]),
  );
}

/**
 * Load the return marker of each visible Dev task once for the page: set while the newest column
 * change of the task (a move, a non-shadow correction, a submit or an add) is the `task.return`
 * move into Dev, which journals its turn and block.
 */
export async function readStatusReturns(db: Store['db'], projectIds: ReadonlySet<string>) {
  const rows = await db
    .selectFrom('task')
    .innerJoin('event', (join) =>
      join.onRef('event.task_id', '=', 'task.id').on('event.id', '=', (eb) =>
        eb
          .selectFrom('event as newest')
          .select('newest.id')
          .whereRef('newest.task_id', '=', 'task.id')
          .where((eb) =>
            eb.or([
              eb('newest.kind', 'in', ['task_moved', 'task_submitted', 'task_added']),
              eb.and([
                eb('newest.kind', '=', 'task_corrected'),
                eb(sql<number>`coalesce(json_extract(newest.payload, '$.shadow'), 0)`, '=', 0),
              ]),
            ]),
          )
          .orderBy('newest.id', 'desc')
          .limit(1),
      ),
    )
    .select(['task.id as task_id', 'event.at', 'event.actor', 'event.actor_ref', 'event.payload'])
    .where('task.column', '=', 'dev')
    .where('task.membership', '!=', 'archived')
    .where('task.project', 'in', [...projectIds])
    .where('event.kind', '=', 'task_moved')
    .execute();
  const returns = new Map<
    number,
    { from: ColumnId; at: string; by: ActorId; block: string; findings: number | null }
  >();
  for (const row of rows) {
    const parsed = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
    if (!parsed.success) continue;
    const { from, to, turn, block, findings } = parsed.data;
    if (turn === undefined || block === undefined || to !== 'dev') continue;
    returns.set(row.task_id, {
      from,
      at: row.at,
      by: eventActor(row),
      block,
      findings: findings ?? null,
    });
  }
  return returns;
}

/**
 * Load the open blocks of visible tasks once for the page, oldest first, each with the session
 * the newest block notification for its current addressee role went to.
 */
export async function readStatusBlocks(db: Store['db'], projectIds: ReadonlySet<string>) {
  const rows = await db
    .selectFrom('block')
    .innerJoin('task', 'task.id', 'block.task_id')
    .leftJoin('notification', (join) =>
      join
        .onRef('notification.block_id', '=', 'block.id')
        .on('notification.kind', '=', 'block')
        .onRef('notification.role', '=', 'block.addressee_role')
        .on('notification.id', '=', (eb) =>
          eb
            .selectFrom('notification as newest')
            .select((eb) => eb.fn.max('newest.id').as('id'))
            .whereRef('newest.block_id', '=', 'block.id')
            .where('newest.kind', '=', 'block')
            .whereRef('newest.role', '=', 'block.addressee_role'),
        ),
    )
    .select(['block.id', 'task.id as task_id', 'block.addressee_role'])
    .select('notification.recipient_session')
    .where('block.state', '=', 'open')
    .where('task.membership', '!=', 'archived')
    .where('task.project', 'in', [...projectIds])
    .orderBy('block.id')
    .execute();
  const blocks = new Map<
    number,
    { id: string; addressee: AddresseeRole; session: string | null }[]
  >();
  for (const row of rows) {
    const list = blocks.get(row.task_id) ?? [];
    list.push({
      id: `B${String(row.id)}`,
      addressee: row.addressee_role,
      session: row.addressee_role === 'operator' ? null : row.recipient_session,
    });
    blocks.set(row.task_id, list);
  }
  return blocks;
}

/** Latest real entry into each visible task's current column, ordered by journal position. */
export async function readStatusColumnEntries(db: Store['db'], projectIds: ReadonlySet<string>) {
  return await db
    .selectFrom('event')
    .innerJoin(
      (eb) =>
        eb
          .selectFrom('event as entry')
          .innerJoin('task', 'task.id', 'entry.task_id')
          .select((eb) => eb.fn.max<number>('entry.id').as('id'))
          .where('task.membership', '!=', 'archived')
          .where('task.project', 'in', [...projectIds])
          .where(sql<boolean>`json_extract(entry.payload, '$.to') = task.column`)
          .where(
            sql<boolean>`(entry.kind = 'task_moved' or (entry.kind = 'task_corrected' and json_extract(entry.payload, '$.shadow') = 0))`,
          )
          .groupBy('entry.task_id')
          .as('latest'),
      (join) => join.onRef('latest.id', '=', 'event.id'),
    )
    .select(['event.task_id', 'event.at'])
    .execute();
}

export function sourceInterval(config: Config, source: string): number {
  if (source === 'spur') return config.adapters.spur.intervalMs;
  if (source.startsWith('jira:')) return config.adapters.jira.intervalMs;
  if (source.startsWith('github-issues:')) return config.adapters.githubIssues.intervalMs;
  return config.adapters.github.intervalMs;
}
