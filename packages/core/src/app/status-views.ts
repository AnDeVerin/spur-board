import type { Store } from '../store/store.ts';
import type { PrFacts } from '@spur-board/contracts';

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
      },
    ]),
  );
}
