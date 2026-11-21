import { externalQuietAfterMs, prSourceId, type Config } from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import { EXTERNAL_QUIET_KEY, type ItemCandidate } from '../domain/fromYou.ts';
import { externalReviews } from '../domain/review-rule.ts';
import type { Row, TaskTable } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import { prFacts } from './course-check.ts';
import { readStatusColumnEntries, sourceInterval } from './status-views.ts';

/**
 * The items of tasks waiting in External Review with an open PR and no new external review round
 * for the project's `quietAfterMs`. The wait runs from the latest of the task entering the column,
 * the last Dev submit on the current head, the head's arrival and the last external review on the
 * PR. While the PR's source is blind or stale nothing is raised and the item of the current visit
 * is held, so a review that lands in the gap shows on the next complete read.
 */
export async function externalQuietItems(
  trx: Trx,
  config: Config,
  now: number,
  tasks: readonly Selectable<TaskTable>[],
  sourceById: ReadonlyMap<string, Row<'source_state'>>,
): Promise<{ candidates: ItemCandidate[]; held: string[] }> {
  const candidates: ItemCandidate[] = [];
  const held: string[] = [];
  for (const task of tasks) {
    if (task.column !== 'external-review') continue;
    const project = config.projects.find((entry) => entry.id === task.project);
    const threshold = project === undefined ? 0 : externalQuietAfterMs(project);
    if (project === undefined || threshold === 0) continue;
    const pr = await prFacts(trx, task.id);
    if (pr?.state !== 'open') continue;
    const key = `${EXTERNAL_QUIET_KEY}${String(task.id)}:${String(task.column_epoch)}`;
    const source = prSourceId(project.id, pr.repo);
    const state = sourceById.get(source);
    const lastComplete = state?.last_complete_at ?? null;
    if (
      state === undefined ||
      state.blind_reason !== null ||
      lastComplete === null ||
      now - Date.parse(lastComplete) >
        config.thresholds.staleMultiplier * sourceInterval(config, source)
    ) {
      held.push(key);
      continue;
    }
    const head = pr.headSha.toLowerCase();
    const reviews = externalReviews(pr, project.operatorGithubLogin);
    const [entry] = await readStatusColumnEntries(trx, new Set([task.project]), task.id);
    const submit = await trx
      .selectFrom('submission')
      .select((eb) => eb.fn.max('submitted_at').as('at'))
      .where('task_id', '=', task.id)
      .where('column', '=', 'dev')
      .where(sql<boolean>`lower(commit_sha) = ${head}`)
      .executeTakeFirst();
    const arrival = await trx
      .selectFrom('event')
      .select((eb) => eb.fn.max('at').as('at'))
      .where('task_id', '=', task.id)
      .where('kind', '=', 'head_moved')
      .where(sql<boolean>`lower(json_extract(payload, '$.to')) = ${head}`)
      .executeTakeFirst();
    const since = Math.max(
      Date.parse(entry?.at ?? task.created_at),
      ...[submit?.at, arrival?.at, ...reviews.map((review) => review.submittedAt)]
        .filter((at): at is string => typeof at === 'string')
        .map((at) => Date.parse(at)),
    );
    if (now - since < threshold) continue;
    const [latest] = reviews
      .filter((review) => review.commitSha.toLowerCase() === head)
      .sort(
        (left, right) =>
          Date.parse(right.submittedAt) - Date.parse(left.submittedAt) ||
          left.reviewer.localeCompare(right.reviewer),
      );
    const sha = head.slice(0, 7);
    const last =
      latest === undefined
        ? `no external review on ${sha}`
        : `latest external review on ${sha}: ${latest.state.replaceAll('_', ' ')} by ${latest.reviewer} at ${latest.submittedAt}`;
    const what = (waited: string) =>
      `${task.key}: ${pr.repo}#${String(pr.number)} has had no new external review round${waited}, since ${new Date(since).toISOString()}; ${last}`;
    candidates.push({
      key,
      kind: 'board_observation',
      taskId: task.id,
      summary: what(` for ${String(Math.floor((now - since) / 60_000))} min`),
      // The shown wait grows each reconcile; the item and its dismissal hold for one quiet stretch.
      hashedSummary: what(''),
      factAt: lastComplete,
      source,
      priority: 4,
    });
  }
  return { candidates, held };
}
