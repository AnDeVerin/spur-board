import { COLUMN_IDS, prSourceId, type Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import type { Row } from '../store/schema.ts';
import { emit, type Trx } from './board-utils.ts';
import {
  courseCounter,
  type CourseReplay,
  EXTERNAL_CAUSES,
  EXTERNAL_COUNTER,
  externalColumn,
  externalRound,
  externalReviewer,
  prFacts,
  raiseCourseDue,
} from './course-check.ts';
import { readStatusColumnEntries } from './status-views.ts';

// The Dev half of External Review's course count: the external change requests on new PR heads
// while the task is in Dev (`external_round`), recorded on each dispatcher pass.

type Task = Row<'task'>;
type Project = Config['projects'][number];

/**
 * While the task is in Dev with the dispatcher on and External Review's course check on, records
 * one `external_round` for each external change request on the open PR that came after the task
 * entered Dev, on a head not yet counted under External Review: by an earlier round or by a
 * return counted there, resets ignored, and not while the PR's GitHub source is `blind` (no
 * complete poll since the start, or blind).
 */
export async function recordExternalRounds(
  trx: Trx,
  input: {
    task: Task;
    project: Project;
    at: Date;
    blind: (source: string) => boolean;
    replay: () => Promise<CourseReplay>;
  },
): Promise<void> {
  const { task, project, at, blind } = input;
  if (!counting(task, project)) return;
  const pr = await prFacts(trx, task.id);
  const requests =
    pr?.state === 'open'
      ? pr.reviews.filter(
          (review) =>
            review.state === 'changes_requested' &&
            externalReviewer(pr, project.operatorGithubLogin, review.reviewer),
        )
      : [];
  if (pr !== null && requests.length > 0 && !blind(prSourceId(project.id, pr.repo))) {
    const replay = await input.replay();
    const counted = replay.externalHeads;
    const fresh = requests.filter((review) => !counted.has(review.commitSha.toLowerCase()));
    if (fresh.length > 0) {
      const [entry] = await readStatusColumnEntries(trx, new Set([task.project]), task.id);
      const entered = Date.parse(entry?.at ?? task.created_at);
      const after = fresh
        .filter((review) => Date.parse(review.submittedAt) > entered)
        .sort(
          (left, right) =>
            Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
            left.reviewer.localeCompare(right.reviewer),
        );
      for (const review of after) {
        const head = review.commitSha.toLowerCase();
        if (counted.has(head)) continue;
        counted.add(head);
        await emit(trx, 'external_round', task.project, task.id, at.toISOString(), {
          repo: pr.repo,
          pr: pr.number,
          head,
          reviewer: review.reviewer,
        });
        // The newest journal entry: the replay this pass reuses ends with it.
        replay.course.push(externalRound({ reviewer: review.reviewer, head }, project));
      }
    }
  }
}

/** The columns a return from External Review can go to: every column left of it. */
const LEFT_OF_EXTERNAL = COLUMN_IDS.slice(0, COLUMN_IDS.indexOf(EXTERNAL_COUNTER));

/**
 * Whether the task's journal may hold a round External Review's counter takes (`courseCounter`):
 * an `external_round`, a move whose gate holds an external cause (`EXTERNAL_CAUSES`) from any
 * column, or any left move from External Review, whatever its cause. A superset of the counted
 * entries: a move it lets through only costs a replay, and none it drops can count. Without one
 * the deferred raise reads no PR history. One row at most, through the event task index.
 */
export async function mayCount(trx: Trx, taskId: number): Promise<boolean> {
  const row = await trx
    .selectFrom('event')
    .select('id')
    .where('task_id', '=', taskId)
    .where(
      sql<boolean>`(kind = 'external_round' or (kind = 'task_moved' and (exists (select 1 from json_each(event.payload, '$.gate') where value in (select value from json_each(${JSON.stringify(EXTERNAL_CAUSES)}))) or (json_extract(payload, '$.from') = ${EXTERNAL_COUNTER} and json_extract(payload, '$.to') in (select value from json_each(${JSON.stringify(LEFT_OF_EXTERNAL)}))))))`,
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether External Review counts the task's Dev rounds: dispatcher on, in Dev, its check on. */
function counting(task: Task, project: Project): boolean {
  const external = externalColumn(project);
  return (
    project.dispatcher.mode === 'on' &&
    task.column === 'dev' &&
    external !== undefined &&
    external.courseCheck > 0
  );
}

/**
 * Raises External Review's course check of a task in Dev once its rounds since the last check
 * reach its `courseCheck`, returns alone included: a check a return reached while another item
 * held the task. The dispatcher calls it only in a pass that leaves the task unheld in Dev, after
 * its decision, so completion and every other move go first. Returns whether it raised.
 */
export async function raiseDeferredCourseCheck(
  trx: Trx,
  input: {
    task: Task;
    project: Project;
    config: Config;
    at: Date;
    replay: () => Promise<CourseReplay>;
  },
): Promise<boolean> {
  const { task, project, config, at } = input;
  if (!counting(task, project) || !(await mayCount(trx, task.id))) return false;
  const counter = courseCounter({ kind: 'external_round' }, project);
  const replay = await input.replay();
  return (await raiseCourseDue(trx, { task, project, config, at, counter, replay })) !== null;
}
