import { prSourceId, type Config } from '@spur-board/contracts';
import type { Row } from '../store/schema.ts';
import { emit, type Trx } from './board-utils.ts';
import {
  courseCounter,
  courseKeyPrefix,
  courseRounds,
  cycleKeyPrefix,
  externalColumn,
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
 * complete poll since the start, or blind). Then, with the PR still open and no cycle-limit or
 * course-check item open, raises External Review's course check once its rounds since the last
 * check reach its `courseCheck`, returns alone included: a return that reached it while another
 * item was open.
 */
export async function recordExternalRounds(
  trx: Trx,
  input: {
    task: Task;
    project: Project;
    config: Config;
    at: Date;
    blind: (source: string) => boolean;
  },
): Promise<void> {
  const { task, project, config, at, blind } = input;
  const external = externalColumn(project);
  if (
    project.dispatcher.mode !== 'on' ||
    task.column !== 'dev' ||
    external === undefined ||
    external.courseCheck <= 0
  )
    return;
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
    const { externalHeads: counted } = await courseRounds(trx, task.id, project);
    const fresh = requests.filter((review) => !counted.has(review.commitSha.toLowerCase()));
    if (fresh.length > 0) {
      const entries = await readStatusColumnEntries(trx, new Set([task.project]));
      const entered = Date.parse(
        entries.find((entry) => entry.task_id === task.id)?.at ?? task.created_at,
      );
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
      }
    }
  }
  // A merged or closed PR completes or leaves the task in this pass: completion goes first.
  if (pr?.state !== 'open') return;
  const open = await trx
    .selectFrom('operator_item')
    .select('id')
    .where((eb) =>
      eb.or([
        eb('item_key', 'like', `${cycleKeyPrefix(task.id)}%`),
        eb('item_key', 'like', `${courseKeyPrefix(task.id)}%`),
      ]),
    )
    .where('cleared_at', 'is', null)
    .executeTakeFirst();
  if (open !== undefined) return;
  await raiseCourseDue(trx, {
    task,
    project,
    config,
    at,
    counter: courseCounter({ kind: 'external_round' }, project),
  });
}
