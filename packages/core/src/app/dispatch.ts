import {
  COLUMNS,
  COLUMN_IDS,
  TODO_GROUP_COLUMN_IDS,
  DISPATCHER_MODES,
  approvalRuleOf,
  isExternalAuthor,
  mirrorSourceId,
  readyMirrorOf,
  parseActorId,
  prSourceId,
  trackerSourceId,
  eventPayloadSchemas,
  type ActorId,
  type ColumnId,
  type Config,
  type DispatcherMode,
  type GateReason,
  type MarkColumnId,
  type MoveReason,
  type PrFacts,
  type ReadinessState,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  describeCompletion as describeDomainCompletion,
  dispatch,
  dispatchHolds,
  mirrorPlacement,
  returnCauses,
  turnReason,
} from '../domain/dispatch.ts';
import { countCycles, type GateMark } from '../domain/gates.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import {
  emit,
  latest,
  mergedTicket,
  newestMergeAt,
  parsePr,
  pastReopenFloor,
  projectForSource,
  taskMergedPr,
  taskPr,
  taskChangeAt,
  ticketDone,
  type Trx,
} from './board-utils.ts';
import {
  courseCounter,
  courseKeyPrefix,
  cycleEvents,
  cycleKeyPrefix,
  raiseCourseDue,
  replayOnce,
  shadowCourseCheck,
  uncounted,
} from './course-check.ts';
import { raiseDeferredCourseCheck, recordExternalRounds } from './external-rounds.ts';
import { answerReturn } from './blocks.ts';
import { withUnconfirmedCancels } from './cancelled-checks.ts';
import { externalReviews } from '../domain/review-rule.ts';
import { storedReviewRule } from './review-rule.ts';
import { linkedSession } from './doorbells.ts';
import { CommandError } from './commands.ts';
import { raiseCycleLimit } from './fromYou.ts';
import {
  carriedFeedback,
  closeTurns,
  editBaselines,
  isNewer,
  isNewerEdit,
  openTurn,
  recalledFeedback,
  sameHanded,
  turnFeedbackCursors,
} from './turns.ts';

// The dispatcher applies the pure cascade of `domain/dispatch.ts` inside its caller's
// transaction. Event times and the complete-poll map come from the caller; task-change
// watermarks also sample the scan transaction's clock when accepting a relevant change.

type Task = Row<'task'>;
type Project = Config['projects'][number];
type DispatchInput = Parameters<typeof dispatch>[0];
type DispatchResult = ReturnType<typeof dispatch>;
type Handed = Parameters<typeof openTurn>[1]['handed'][number];

interface DispatchContext {
  config: Config;
  at: Date;
  /** Since when each source has had an effectively complete poll in this process. */
  complete: ReadonlyMap<string, string>;
  /** The actor whose operation runs this pass; absent for tick and observation. */
  actor?: ActorId | undefined;
}

const CURSOR_KEY = 'dispatcher_cursor';

/** Policy counterpart of readInput's mergedTicket qualification and dispatchTasks' scope. */
export function describeCompletion(project: Project) {
  const route = describeDomainCompletion();
  const done =
    project.tracker.type === 'jira'
      ? `a Jira status in ${JSON.stringify(project.tracker.doneStatuses)}`
      : 'GitHub status "closed"';
  return {
    ...route,
    text: `${route.text} A done ticket means ${done}. After a merge, a missing ticket or unconfirmed status holds dispatch. An open ticket resumes work without the merged PR only once it changed at or after the newest merge, in the tracker filter or for a manually included task; a ticket untouched since the merge stays unconfirmed, and dropped-filter evidence alone stays unconfirmed; when no merged PR has a stored merge time (facts from before the dispatcher), work resumes once the ticket, in filter or manually included, is observed open at or past the judged PR's last update plus the tracker interval. Only non-archived tasks are evaluated; eligible links must be unbanned and past the reopen floor. Missing or unreadable facts for a chosen or fallback PR hold evaluation. Cycle holds do not stop completion shortcuts. Dispatcher on applies moves; shadow computes only a shadow position.`,
  };
}

const modeKey = (project: string) => `dispatcher_mode:${project}`;
const cursorSchema = z.int().min(0);
const modeSchema = z.enum(DISPATCHER_MODES);

/** Columns whose submissions are marks: they last for their head across visits. */
const MARK_COLUMNS: readonly ColumnId[] = COLUMNS.filter((c) => c.marks).map((c) => c.id);

const isMarkColumn = (column: ColumnId): column is MarkColumnId => MARK_COLUMNS.includes(column);

/** Evidence that lasts for its head across visits. QA remains a submit. */
const HEAD_COLUMNS: readonly ColumnId[] = [...MARK_COLUMNS, 'qa'];

const indexOf = (column: ColumnId) => COLUMN_IDS.indexOf(column);

/**
 * Sets `voided_at` on the unvoided submits of `columns`. Review marks and QA submits are
 * not voided by an ordinary move; a new PR head voids them (`voidMarksOffHead`). A pending submit is never
 * voided here: it settles only when its hand-back turn opens, as confirmed, or as superseded by
 * a merge (`readPendingSubmit`), and counts as no mark until then.
 */
async function voidColumns(
  trx: Trx,
  taskId: number,
  columns: readonly ColumnId[],
  at: Date,
): Promise<void> {
  const voided = columns.filter((column) => !HEAD_COLUMNS.includes(column));
  if (voided.length === 0) return;
  await trx
    .updateTable('submission')
    .set({ voided_at: at.toISOString() })
    .where('task_id', '=', taskId)
    .where('voided_at', 'is', null)
    .where('pending_until', 'is', null)
    .where('column', 'in', voided)
    .execute();
}

/**
 * Sets `voided_at` on the unvoided Review/Product Review marks and QA submits of PR `repo#number` that are
 * not on `head`, for the PR's new head: a mark lasts only while its head stays the PR's head, so
 * a head that comes back to an earlier commit needs fresh marks. Marks made before submissions
 * recorded their PR count for the tasks linked to the PR. A pending mark is left to the
 * dispatcher, which hands it back with the new head (`readPendingSubmit`).
 */
export async function voidMarksOffHead(
  trx: Trx,
  input: { repo: string; number: number; head: string; at: string },
): Promise<void> {
  const repo = input.repo.toLowerCase();
  await trx
    .updateTable('submission')
    .set({ voided_at: input.at })
    .where('voided_at', 'is', null)
    .where('column', 'in', HEAD_COLUMNS)
    .where('pending_until', 'is', null)
    .where(sql<boolean>`lower(commit_sha) != ${input.head.toLowerCase()}`)
    .where((eb) =>
      eb.or([
        eb.and([eb(sql`lower(pr_repo)`, '=', repo), eb('pr_number', '=', input.number)]),
        eb.and([
          eb('pr_repo', 'is', null),
          eb(
            'task_id',
            'in',
            eb
              .selectFrom('link')
              .select('task_id')
              .where('entity', '=', 'pr')
              .where(sql<boolean>`lower(repo) = ${repo}`)
              .where('number', '=', input.number),
          ),
        ]),
      ]),
    )
    .execute();
}

/** Voids the submits of `to` and every column right of it, as a left move does. */
async function voidSubmits(trx: Trx, taskId: number, to: ColumnId, at: Date): Promise<void> {
  await voidColumns(
    trx,
    taskId,
    COLUMN_IDS.filter((column) => indexOf(column) >= indexOf(to)),
    at,
  );
}

/**
 * Moves a task left to `to` as a new visit: bumps `column_epoch` and `left_moves`, voids the
 * submits of `to` and right of it, closes its turns (`returned` for a `task.return` of `turn`,
 * else `moved`, named on `turn_closed` as `closedBy` when given) and journals `task_moved`. In `on` mode a counted return that reaches the
 * column's cycle limit raises its cycle-limit block; otherwise one that reaches the course check
 * of the column it counts under (`courseCounter`) raises that course check. Either holds the task, and
 * `limitReached` tells the dispatcher to stop the cascade.
 */
export async function moveLeft(
  trx: Trx,
  input: {
    task: Task;
    to: ColumnId;
    at: Date;
    actor: ActorId;
    config: Config;
    turn?: string;
    block?: string;
    reason?: MoveReason;
    gate?: readonly GateReason[];
    /** Number of review findings a return sends; journaled only when given. */
    findings?: number | undefined;
    closedBy?: ActorId | undefined;
  },
): Promise<{ task: Task; limitReached: boolean }> {
  const { task, to, at, actor, config, turn, block, reason, gate, findings, closedBy } = input;
  const moved = await trx
    .updateTable('task')
    .set({
      column: to,
      column_epoch: task.column_epoch + 1,
      left_moves: task.left_moves + 1,
      last_change_at: taskChangeAt(at.toISOString()),
    })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await voidSubmits(trx, task.id, to, at);
  await closeTurns(trx, {
    taskId: task.id,
    reason: turn === undefined ? 'moved' : 'returned',
    at,
    actor: closedBy,
  });
  await emit(
    trx,
    'task_moved',
    task.project,
    task.id,
    at.toISOString(),
    {
      from: task.column,
      to,
      ...(turn === undefined ? {} : { turn }),
      ...(block === undefined ? {} : { block }),
      ...(reason === undefined ? {} : { reason }),
      ...(gate === undefined ? {} : { gate: [...gate] }),
      ...(findings === undefined ? {} : { findings }),
    },
    actor,
  );
  const project = config.projects.find((entry) => entry.id === task.project);
  const column = project?.columns.find((entry) => entry.id === task.column);
  if (project?.dispatcher.mode !== 'on' || column === undefined || uncounted(reason))
    return { task: moved, limitReached: false };
  // The cycle limit counts returns alone: PR history is read only for a course count that is on.
  const cycle = countCycles(await cycleEvents(trx, task.id), task.column, Infinity).count;
  if (cycle >= column.cycleLimit) {
    await raiseCycleLimit(trx, { task: moved, column: task.column, at, config });
    return { task: moved, limitReached: true };
  }
  const course = await raiseCourseDue(trx, {
    task: moved,
    project,
    config,
    at,
    counter: courseCounter(
      {
        kind: 'return',
        column: task.column,
        causes: returnCauses(gate ?? [], block !== undefined),
      },
      project,
    ),
  });
  return { task: moved, limitReached: course !== null };
}

/**
 * Applies a changed dispatcher mode of each project, as stored in `meta`. A first run only stores
 * the mode. A switch to `on` copies each task's shadow column into its column as a new visit; a
 * switch to `shadow` closes the project's unclosed turns. Turns either switch closes record
 * `mode_changed`. Either switch then clears the shadow column and journals
 * `dispatcher_mode_changed`.
 */
async function syncModes(trx: Trx, config: Config, at: Date): Promise<void> {
  for (const project of config.projects) {
    const mode = project.dispatcher.mode;
    const row = await trx
      .selectFrom('meta')
      .select('value')
      .where('key', '=', modeKey(project.id))
      .executeTakeFirst();
    const stored: DispatcherMode | undefined =
      row === undefined ? undefined : parseJson(modeSchema, row.value);
    if (stored === mode) continue;
    await trx
      .insertInto('meta')
      .values({ key: modeKey(project.id), value: toJson(modeSchema, mode) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: toJson(modeSchema, mode) }))
      .execute();
    if (stored === undefined) continue;
    if (mode === 'on') {
      const tasks = await trx
        .selectFrom('task')
        .selectAll()
        .where('project', '=', project.id)
        .where('membership', '!=', 'archived')
        .where('shadow_column', 'is not', null)
        .whereRef('shadow_column', '!=', 'column')
        .orderBy('id')
        .execute();
      for (const task of tasks) {
        if (task.shadow_column === null) continue;
        await trx
          .updateTable('task')
          .set({
            column: task.shadow_column,
            column_epoch: task.column_epoch + 1,
            last_change_at: taskChangeAt(at.toISOString()),
          })
          .where('id', '=', task.id)
          .execute();
        await closeTurns(trx, { taskId: task.id, reason: 'mode_changed', at });
        await emit(trx, 'task_moved', task.project, task.id, at.toISOString(), {
          from: task.column,
          to: task.shadow_column,
          reason: 'mode_changed',
        });
      }
    } else {
      // Shadow mode hands out no turns, so a turn left from `on` must not move the real column.
      const open = await trx
        .selectFrom('turn')
        .innerJoin('task', 'task.id', 'turn.task_id')
        .select('turn.task_id')
        .distinct()
        .where('task.project', '=', project.id)
        .where('turn.closed_at', 'is', null)
        .orderBy('turn.task_id')
        .execute();
      for (const { task_id } of open)
        await closeTurns(trx, { taskId: task_id, reason: 'mode_changed', at });
    }
    await trx
      .updateTable('task')
      .set({ shadow_column: null })
      .where('project', '=', project.id)
      .where('shadow_column', 'is not', null)
      .execute();
    await emit(trx, 'dispatcher_mode_changed', project.id, null, at.toISOString(), {
      from: stored,
      to: mode,
    });
  }
}

/** Whether work on the task started: an eligible open linked PR or a live linked worker. */
async function workStartedOn(trx: Trx, taskId: number): Promise<boolean> {
  const openPr = await trx
    .selectFrom('link')
    .select('id')
    .where('task_id', '=', taskId)
    .where('entity', '=', 'pr')
    .where('banned', '=', 0)
    .where('pr_open', '=', 1)
    .where(pastReopenFloor)
    .executeTakeFirst();
  return openPr !== undefined || (await linkedSession(trx, taskId, 'worker')) !== undefined;
}

/** Put the task in a fresh visit of a Todo-group column and close its turns. */
async function placeInTodoGroup(
  trx: Trx,
  task: Task,
  project: Project | undefined,
  to: ColumnId,
  at: Date,
): Promise<void> {
  await trx
    .updateTable('task')
    .set({
      column: to,
      shadow_column:
        task.shadow_column === null && project?.dispatcher.mode !== 'shadow' ? null : to,
      column_epoch: task.column_epoch + 1,
      last_change_at: taskChangeAt(at.toISOString()),
    })
    .where('id', '=', task.id)
    .execute();
  await closeTurns(trx, { taskId: task.id, reason: 'moved', at });
}

/** Place idle work in a fresh real-column visit after synchronizing dispatcher mode. */
export async function manuallyMoveColumn(
  trx: Trx,
  input: { taskId: number; to: ColumnId; at: Date; actor: ActorId; reason: string; config: Config },
): Promise<{ from: ColumnId; to: ColumnId; column: ColumnId }> {
  const { taskId, to, at, actor, reason, config } = input;
  await syncModes(trx, config, at);
  const task = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  const project = config.projects.find((entry) => entry.id === task.project);
  const enabledGroup = (id: ColumnId) =>
    TODO_GROUP_COLUMN_IDS.some((column) => column === id) &&
    project?.columns.some((column) => column.id === id && column.enabled);
  if (!enabledGroup(task.column) || !enabledGroup(to))
    throw new CommandError(
      'move_outside_todo_group',
      `Pick enabled Todo-group columns in project ${task.project}.`,
    );
  const mirror = project === undefined ? undefined : readyMirrorOf(project);
  if (mirror !== undefined && (task.column === 'ready-for-dev' || to === 'ready-for-dev'))
    throw new CommandError(
      'column_mirrored',
      `Change the status of ${task.key} in GitHub Project ${mirror.project} (${mirror.field}) instead.`,
    );
  if (await workStartedOn(trx, taskId))
    throw new CommandError(
      'work_started',
      'Resolve the open pull request or live worker before moving idle work.',
    );
  await placeInTodoGroup(trx, task, project, to, at);
  await emit(
    trx,
    'task_manually_moved',
    task.project,
    taskId,
    at.toISOString(),
    { from: task.column, to, reason },
    actor,
  );
  return { from: task.column, to, column: to };
}

/**
 * Apply a complete GitHub Project read of `source`, after synchronizing dispatcher mode: every
 * live task of the mirrored project goes where `mirrorPlacement` puts it, journaled as
 * `task_mirror_moved` by `system`. A real column move is a fresh visit that closes the task's
 * turns. A move of only the shadow column keeps the visit and the turns, and its event carries
 * `shadow: true` with the shadow positions. A task the read does not list stays put.
 */
export async function applyMirror(
  trx: Trx,
  input: {
    source: string;
    readiness: readonly { key: string; state: ReadinessState }[];
    at: Date;
    config: Config;
  },
): Promise<void> {
  const { source, at, config } = input;
  const project = config.projects.find((entry) => mirrorSourceId(entry) === source);
  if (project === undefined) return;
  await syncModes(trx, config, at);
  const readiness = new Map(input.readiness.map((entry) => [entry.key, entry.state]));
  const tasks = await trx
    .selectFrom('task')
    .selectAll()
    .where('project', '=', project.id)
    .where('membership', '!=', 'archived')
    .where('column', 'in', ['todo', 'ready-for-dev'])
    .orderBy('id')
    .execute();
  for (const task of tasks) {
    const state = readiness.get(task.key);
    if (state === undefined) continue;
    const placement = mirrorPlacement({
      column: task.column,
      shadowColumn: task.shadow_column,
      shadowMode: project.dispatcher.mode === 'shadow',
      workStarted: await workStartedOn(trx, task.id),
      readiness: state,
    });
    if (placement === null) continue;
    const moved = placement.column !== task.column;
    await trx
      .updateTable('task')
      .set({
        shadow_column: placement.shadowColumn,
        last_change_at: taskChangeAt(at.toISOString()),
        ...(moved ? { column: placement.column, column_epoch: task.column_epoch + 1 } : {}),
      })
      .where('id', '=', task.id)
      .execute();
    if (moved) await closeTurns(trx, { taskId: task.id, reason: 'moved', at });
    await emit(
      trx,
      'task_mirror_moved',
      project.id,
      task.id,
      at.toISOString(),
      moved
        ? { from: task.column, to: placement.column, source }
        : {
            from: task.shadow_column ?? task.column,
            to: placement.shadowColumn ?? placement.column,
            source,
            shadow: true,
          },
    );
  }
}

/**
 * The operator's correction of a task's column to `to`, as a new visit of `to`. It first applies
 * a pending dispatcher mode switch, so the switch cannot overwrite the correction. In `on` mode it
 * sets the column and bumps `column_epoch`, voids the submits of `to` and right of it, closes the
 * task's turns as `corrected` and journals `task_corrected`; correction into QA also voids
 * confirmed and pending QA evidence. In shadow mode it sets only the shadow
 * column. The feedback a closed untaken turn handed over counts as unhandled again
 * (`turnFeedbackCursors`), so the next Dev turn hands it over, whenever it opens. It is
 * not a dispatcher move: no `task_moved`, no `left_moves` and no cycle count. The caller settles
 * the task with a dispatcher pass after it. `from` is the column the dispatcher worked from, and
 * `eventId` the id of the `task_corrected` event.
 */
export async function correctColumn(
  trx: Trx,
  input: { taskId: number; to: ColumnId; at: Date; actor: ActorId; reason: string; config: Config },
): Promise<{ from: ColumnId; eventId: number }> {
  const { taskId, to, at, actor, reason, config } = input;
  await syncModes(trx, config, at);
  const task = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  const shadow =
    config.projects.find((project) => project.id === task.project)?.dispatcher.mode === 'shadow';
  const from = task.shadow_column ?? task.column;
  await trx
    .updateTable('task')
    .set(
      shadow
        ? { shadow_column: to, last_change_at: taskChangeAt(at.toISOString()) }
        : {
            column: to,
            column_epoch: task.column_epoch + 1,
            last_change_at: taskChangeAt(at.toISOString()),
          },
    )
    .where('id', '=', task.id)
    .execute();
  await voidSubmits(trx, task.id, to, at);
  if (to === 'qa') {
    // An explicit retest also cancels pending QA so it cannot confirm after the correction.
    await trx
      .updateTable('submission')
      .set({ voided_at: at.toISOString() })
      .where('task_id', '=', task.id)
      .where('column', '=', 'qa')
      .where('voided_at', 'is', null)
      .execute();
  }
  if (!shadow) await closeTurns(trx, { taskId: task.id, reason: 'corrected', at });
  await emit(
    trx,
    'task_corrected',
    task.project,
    task.id,
    at.toISOString(),
    { from, to, reason, shadow },
    actor,
  );
  const event = await trx
    .selectFrom('event')
    .select('id')
    .where('task_id', '=', task.id)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  return { from, eventId: event.id };
}

/** A source has no fresh view while it reports blind or has had no complete poll since start. */
export async function blindSources(trx: Trx, complete: ReadonlyMap<string, string>) {
  const states = await trx.selectFrom('source_state').select(['source', 'blind_reason']).execute();
  const blind = new Set(
    states.filter((state) => state.blind_reason !== null).map((state) => state.source),
  );
  return (source: string) => blind.has(source) || !complete.has(source);
}

/** Whether the external reviewers approved: one approval, and no changes requested by one. */
function externalApproval(pr: PrFacts, agentLogin: string): boolean {
  const reviews = externalReviews(pr, agentLogin);
  return (
    reviews.some((review) => review.state === 'approved') &&
    !reviews.some((review) => review.state === 'changes_requested')
  );
}

/**
 * The external feedback nobody handled yet. An approval review is not a comment: an entry is one
 * by its own state, or, in a snapshot written before entries had one, when it matches the
 * reviewer's latest approval. An entry is handled once a turn handed it over, or an older one,
 * unless a correction or a reroute closed that turn untaken, or once a handling submission
 * (`handlingSubmits`) on this PR was made at or after it and its last edit. An edit after the
 * entry's baseline (`editBaselines`) makes it unhandled again, so it is handed once per edit.
 * The entries such an untaken turn handed over come from the turn when a later poll dropped them
 * from the snapshot (`recalledFeedback`).
 * A reviewer service's status comment (`statusComment`) never counts, and neither a recall nor a
 * reroute hands one over again (`withoutStatusComments` in `turns.ts`).
 */
async function unhandledFeedback(
  trx: Trx,
  task: Task,
  project: Project,
  pr: PrFacts,
): Promise<Handed[]> {
  const approvals = pr.reviews.filter((review) => review.state === 'approved');
  const entries = (pr.feedback ?? []).filter(
    (entry) =>
      isExternalAuthor(entry, project.operatorGithubLogin) &&
      entry.statusComment !== true &&
      !(
        entry.kind === 'review' &&
        (entry.state === undefined
          ? approvals.some(
              (review) =>
                review.reviewer.toLowerCase() === entry.author?.login.toLowerCase() &&
                Date.parse(review.submittedAt) === Date.parse(entry.postedAt),
            )
          : entry.state === 'approved')
      ),
  );
  const submitted = (await handlingSubmits(trx, [task.id], [project])).filter((row) =>
    submittedOn(row, pr),
  );
  const newest = Math.max(...submitted.map((row) => Date.parse(row.submitted_at)));
  const [cursor] = await turnFeedbackCursors(
    trx,
    [{ kind: 'pr', repo: pr.repo, number: pr.number }],
    'handled',
  );
  const fromSnapshot = entries.map((entry) => handedOf(pr, entry));
  const recalled = (
    await recalledFeedback(trx, { kind: 'pr', repo: pr.repo, number: pr.number })
  ).filter((entry) => !fromSnapshot.some((old) => sameHanded(old, entry)));
  const baseline = await editBaselines(trx, { kind: 'pr', repo: pr.repo, number: pr.number });
  return [...recalled, ...fromSnapshot].filter((entry) => {
    const edited = entry.editedAt === undefined ? -Infinity : Date.parse(entry.editedAt);
    return (
      !(Math.max(Date.parse(entry.postedAt), edited) <= newest) &&
      (cursor === undefined || isNewer(entry, cursor) || edited > baseline(entry))
    );
  });
}

/**
 * The submissions of `taskIds` that handle the external feedback posted before them on the PR
 * they were made on (`submittedOn`): those in Dev, whatever its orchestrator, or in another
 * worker column. In `on` mode only a turnless
 * (shadow) submit counts, since a turn records what it handed over: a turned submit closes its
 * turn `submitted` at the same instant in the same column visit, and a shadow submit has no turn.
 */
async function handlingSubmits(db: Trx, taskIds: readonly number[], projects: readonly Project[]) {
  const columns = projects.flatMap((project) =>
    handlingColumns(project).map((column) => ({ project, column })),
  );
  if (taskIds.length === 0 || columns.length === 0) return [];
  const rows = await db
    .selectFrom('submission')
    .innerJoin('task', 'task.id', 'submission.task_id')
    .select([
      'submission.task_id',
      'task.project',
      'submission.column',
      'submission.submitted_at',
      'submission.pr_repo',
      'submission.pr_number',
      sql<number>`exists (select 1 from turn where turn.task_id = submission.task_id and turn."column" = submission."column" and turn.epoch = submission.epoch and turn.closed_reason = 'submitted' and turn.closed_at = submission.submitted_at)`.as(
        'turned',
      ),
    ])
    .where('submission.task_id', 'in', taskIds)
    .execute();
  return rows.filter((row) =>
    columns.some(
      ({ project, column }) =>
        project.id === row.project &&
        column === row.column &&
        (project.dispatcher.mode === 'shadow' || row.turned === 0),
    ),
  );
}

/** Whether a submission was checked against `pr`; one recorded without its PR is on none. */
function submittedOn(
  row: { pr_repo: string | null; pr_number: number | null },
  pr: { repo: string; number: number },
): boolean {
  return row.pr_repo?.toLowerCase() === pr.repo.toLowerCase() && row.pr_number === pr.number;
}

/** The columns whose submission handles the external feedback posted before it. */
function handlingColumns(project: Project): ColumnId[] {
  return project.columns
    .filter((column) => column.id === 'dev' || column.orchestrator === 'none')
    .map((column) => column.id);
}

type FeedbackCursor = Awaited<ReturnType<typeof turnFeedbackCursors>>[number];

/**
 * Per requested PR, the feedback cursor for the GitHub poll: the newer of the newest entry a turn
 * handed over and the time-only cursor at its task's newest handling submission on that PR
 * (`handlingSubmits`), the cutoff of `unhandledFeedback`. No real entry has the empty id, so the
 * adapter reads back to the first comment older than that time.
 */
export async function pollFeedbackCursors(
  db: Trx,
  config: Config,
  prs: readonly FeedbackCursor['ref'][],
): Promise<FeedbackCursor[]> {
  const cursors = await turnFeedbackCursors(db, prs, 'polled');
  if (prs.length === 0) return cursors;
  const links = await db
    .selectFrom('link')
    .select(['task_id', 'repo', 'number'])
    .where('entity', '=', 'pr')
    .where('banned', '=', 0)
    .where(
      sql<string>`lower(repo)`,
      'in',
      prs.map((pr) => pr.repo.toLowerCase()),
    )
    .execute();
  const submitted = await handlingSubmits(
    db,
    [...new Set(links.map((link) => link.task_id))],
    config.projects,
  );
  const merged = [];
  for (const ref of prs) {
    let best = cursors.find(
      (cursor) =>
        cursor.ref.number === ref.number &&
        cursor.ref.repo.toLowerCase() === ref.repo.toLowerCase(),
    );
    for (const link of links) {
      if (link.repo?.toLowerCase() !== ref.repo.toLowerCase() || link.number !== ref.number)
        continue;
      for (const row of submitted) {
        if (row.task_id !== link.task_id || !submittedOn(row, ref)) continue;
        const cursor = { ref, id: '', postedAt: row.submitted_at };
        if (best === undefined || isNewer(cursor, best)) best = cursor;
      }
    }
    if (best !== undefined) merged.push(best);
  }
  return merged;
}

function handedOf(pr: PrFacts, entry: NonNullable<PrFacts['feedback']>[number]): Handed {
  return {
    repo: pr.repo,
    number: pr.number,
    kind: entry.kind,
    id: entry.id,
    postedAt: entry.postedAt,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.editedAt === undefined ? {} : { editedAt: entry.editedAt }),
    ...(entry.comments === undefined ? {} : { comments: entry.comments }),
  };
}

/**
 * A turn submit accepted before the board could confirm its head, and what it turned into:
 * `pending` while nothing settles it, `confirmed` once a poll observed the PR at `sha` after the
 * submit, `failed` when the head moved, the PR closed, or no PR appeared within the bound, and
 * `superseded` when the PR merged at another head: the merge decides the task, no turn.
 */
type PendingSubmit = {
  id: number;
  sha: string;
  /** `submitted_at + submitConfirmMs`: when an absent PR counts as none. */
  until: string;
} & (
  | { state: 'pending' }
  /** `pr`: the linked PR, copied onto a confirmed row recorded without one. */
  | { state: 'confirmed'; pr: { repo: string; number: number } }
  | { state: 'failed'; failure: string }
  /** `head`: the merged PR's head, lowercased. */
  | { state: 'superseded'; head: string }
);

/** The clock passed `until` and a complete poll of each of `repos` started at or after it. */
function pastBound(
  project: Project,
  until: string,
  input: { at: Date; complete: ReadonlyMap<string, string> },
  repos: readonly string[],
): boolean {
  const bound = Date.parse(until);
  if (input.at.getTime() < bound) return false;
  return repos.every((repo) => {
    const since = input.complete.get(prSourceId(project.id, repo));
    return since !== undefined && Date.parse(since) >= bound;
  });
}

/**
 * The newest unvoided pending submit of the task's current visit in `on` mode, settled from
 * stored facts (`settlePending`). With `carry` (no turn yet in the current visit), the task's
 * newest submission from an earlier visit counts too, but only once it failed or was superseded:
 * a left move whose
 * turn was deferred or held still hands the failure back with the turn it opens later. Such a
 * row never confirms or holds the task here.
 */
async function readPendingSubmit(
  trx: Trx,
  task: Task,
  project: Project,
  input: SettleInput & { carry: boolean },
): Promise<PendingSubmit | undefined> {
  const current = await trx
    .selectFrom('submission')
    .select(['id', 'commit_sha', 'author', 'submitted_at', 'pending_until'])
    .where('task_id', '=', task.id)
    .where('column', '=', task.column)
    .where('epoch', '=', task.column_epoch)
    .where('voided_at', 'is', null)
    .where('pending_until', 'is not', null)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (current?.pending_until != null) {
    return settlePending(trx, { ...current, pending_until: current.pending_until }, project, input);
  }
  if (!input.carry) return undefined;
  const newest = await trx
    .selectFrom('submission')
    .select(['id', 'commit_sha', 'author', 'submitted_at', 'pending_until', 'voided_at'])
    .where('task_id', '=', task.id)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (newest?.pending_until == null || newest.voided_at !== null) return undefined;
  const settled = await settlePending(
    trx,
    { ...newest, pending_until: newest.pending_until },
    project,
    input,
  );
  return settled.state === 'failed' || settled.state === 'superseded' ? settled : undefined;
}

interface SettleInput {
  link: { repo: string; number: number } | null;
  githubBlind: boolean;
  at: Date;
  complete: ReadonlyMap<string, string>;
}

/**
 * Settles a pending submit from stored facts: the linked PR's snapshot observed at or after the
 * submit decides it, and so does a merged one observed before; a closed one observed before fails
 * it, and no PR linked fails it, only once the bound passed and a complete poll of the PR's repo,
 * or of every project repo, started at or after the bound. Nothing settles while GitHub is blind.
 */
async function settlePending(
  trx: Trx,
  row: {
    id: number;
    commit_sha: string;
    author: string;
    submitted_at: string;
    pending_until: string;
  },
  project: Project,
  input: SettleInput,
): Promise<PendingSubmit> {
  const sha = row.commit_sha.toLowerCase();
  const pending: PendingSubmit = { id: row.id, sha, until: row.pending_until, state: 'pending' };
  if (input.githubBlind) return pending;
  const { link } = input;
  if (link !== null) {
    const snap = await trx
      .selectFrom('pr_snapshot')
      .select(['head_sha', 'state', 'observed_at'])
      .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
      .where('number', '=', link.number)
      .executeTakeFirst();
    if (snap === undefined) return pending;
    // Complete polls skip a PR already seen merged or closed (#469). A merged head is final; a
    // closed PR seen before the submit may have reopened, so it fails only past the bound.
    const stale = Date.parse(snap.observed_at) < Date.parse(row.submitted_at);
    if (snap.state === 'open' && stale) return pending;
    if (snap.state === 'closed') {
      if (stale && !pastBound(project, row.pending_until, input, [link.repo])) return pending;
      return {
        ...pending,
        state: 'failed',
        failure: `PR ${link.repo}#${String(link.number)} closed`,
      };
    }
    if (snap.head_sha.toLowerCase() === sha) return { ...pending, state: 'confirmed', pr: link };
    if (snap.state === 'merged') {
      return { ...pending, state: 'superseded', head: snap.head_sha.toLowerCase() };
    }
    return {
      ...pending,
      state: 'failed',
      failure: `head moved to ${snap.head_sha.toLowerCase().slice(0, 7)}`,
    };
  }
  if (!pastBound(project, row.pending_until, input, project.repos)) return pending;
  const parsed = parseActorId(row.author);
  const session = parsed?.actor === 'agent' ? parsed.actorRef.session : undefined;
  const branch =
    session === undefined
      ? undefined
      : (
          await trx
            .selectFrom('session_snapshot')
            .select('branch')
            .where('id', '=', session)
            .executeTakeFirst()
        )?.branch;
  return {
    ...pending,
    state: 'failed',
    failure: branch == null ? 'no PR found' : `no PR found for ${branch}`,
  };
}

/** Whether a reopen still needs to override the latest explicit placement. */
async function reopenNeedsDispatch(trx: Trx, taskId: number, project: Project): Promise<boolean> {
  const placement = await trx
    .selectFrom('event')
    .select(['id', 'kind'])
    .where('task_id', '=', taskId)
    .where('kind', 'in', ['task_manually_moved', 'task_mirror_moved', 'task_corrected'])
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (placement === undefined || placement.kind === 'task_corrected') return true;
  // A manual or mirror visit acknowledges older reopen facts, not their permanent PR exclusion.
  // Journal order also distinguishes a new reopen when both writes share a timestamp.
  const statuses = await trx
    .selectFrom('event')
    .select('payload')
    .where('task_id', '=', taskId)
    .where('kind', '=', 'ticket_status_changed')
    .where('id', '>', placement.id)
    .execute();
  return statuses.some((row) => {
    const status = parseJson(eventPayloadSchemas.ticket_status_changed, row.payload);
    return (
      status.from !== null && ticketDone(project, status.from) && !ticketDone(project, status.to)
    );
  });
}

/** The dispatcher input, or null when a stored snapshot is missing or unreadable. Only reads. */
export async function readInput(
  trx: Trx,
  task: Task,
  project: Project,
  mode: DispatcherMode,
  blind: (source: string) => boolean,
  config: Config,
  /** The pass time and the complete-poll map, for a pending submit's bound. */
  clock: { at: Date; complete: ReadonlyMap<string, string> },
): Promise<{
  input: DispatchInput;
  handed: Handed[];
  unclosed: Row<'turn'> | undefined;
  /** The merged PR whose ticket changed at or after the merge, not done: the task has no PR for the gates. */
  mergedOpen: { repo: string; number: number } | undefined;
  /** The task's PR merged and its ticket is neither done nor confirmed open: hold the task. */
  ticketUnconfirmed: boolean;
  /** The pending turn submit of the current visit (`on` mode); absent when none waits. */
  pending: PendingSubmit | undefined;
} | null> {
  const readPr = async (ref: { repo: string; number: number }) =>
    parsePr(
      (
        await trx
          .selectFrom('pr_snapshot')
          .select('detail')
          .where(sql<boolean>`lower(repo) = ${ref.repo.toLowerCase()}`)
          .where('number', '=', ref.number)
          .executeTakeFirst()
      )?.detail,
    );
  const link = await taskPr(trx, task.id);
  let pr: PrFacts | null = null;
  if (link !== null) {
    pr = await readPr(link);
    if (pr === null) return null;
  }
  const readTicket = () =>
    trx
      .selectFrom('ticket_snapshot')
      .select(['status', 'detail', 'observed_at'])
      .where('task_id', '=', task.id)
      .executeTakeFirst();
  // An earlier merge decides when the chosen PR is not merged: a done ticket ends the task on
  // it whatever its other PRs are, and a follow-up closed unmerged with none open leaves it to judge.
  if (pr !== null && pr.state !== 'merged') {
    const merged = await taskMergedPr(trx, task.id);
    if (merged !== null) {
      const ticket = await readTicket();
      if (
        (pr.state === 'closed' && link?.open !== true) ||
        (ticket !== undefined && ticketDone(project, ticket.status))
      ) {
        pr = await readPr(merged);
        if (pr === null) return null;
      }
    }
  }
  // A merged PR finishes the task only with its ticket done. A ticket changed at or after the merge and
  // still not done sends it back to work without a PR; an untouched one waits.
  let mergedOpen: { repo: string; number: number } | undefined;
  let ticketUnconfirmed = false;
  if (pr?.state === 'merged') {
    const ticket = await readTicket();
    // A ticket edited before a later merge of another PR waits for that merge's close too; the
    // interval fallback of a PR without a stored merge time applies only when no merge has one.
    const mergedAt = latest([pr.mergedAt, await newestMergeAt(trx, task.id)]);
    const judged = mergedTicket(project, config, ticket, task.manual_include === 1, {
      ...pr,
      ...(mergedAt === null ? {} : { mergedAt }),
    });
    if (judged === 'reopened' || judged === 'open')
      mergedOpen = { repo: pr.repo, number: pr.number };
    ticketUnconfirmed = judged === 'unconfirmed';
  }
  // A merged PR that counts as no PR leaves the follow-up PR in any repo: every repo must see.
  if (mergedOpen !== undefined) pr = null;
  const repos = pr === null ? project.repos : [pr.repo];
  const githubBlind = repos.some((repo) => blind(prSourceId(project.id, repo)));
  const sourceReady = (source: string) => {
    const complete = clock.complete.get(source);
    return (
      !blind(source) &&
      complete !== undefined &&
      complete > (task.last_change_at ?? task.created_at)
    );
  };
  const allGithubReposReady = project.repos.every((repo) =>
    sourceReady(prSourceId(project.id, repo)),
  );
  const ticket = await readTicket();
  const done = ticket !== undefined && ticketDone(project, ticket.status);
  const hasOpenLinkedPr =
    (await trx
      .selectFrom('link')
      .select('id')
      .where('task_id', '=', task.id)
      .where('entity', '=', 'pr')
      .where('banned', '=', 0)
      .where('pr_open', '=', 1)
      .where(pastReopenFloor)
      .executeTakeFirst()) !== undefined;
  const last =
    mode === 'shadow'
      ? undefined
      : await trx
          .selectFrom('turn')
          .selectAll()
          .where('task_id', '=', task.id)
          .where('column', '=', task.column)
          .where('epoch', '=', task.column_epoch)
          .orderBy('seq', 'desc')
          .executeTakeFirst();
  const pending =
    mode === 'on'
      ? await readPendingSubmit(trx, task, project, {
          link,
          githubBlind,
          ...clock,
          carry: last === undefined,
        })
      : undefined;
  const submissions = await trx
    .selectFrom('submission')
    .select(['id', 'column', 'commit_sha', 'pending_until'])
    .where('task_id', '=', task.id)
    .where('voided_at', 'is', null)
    .orderBy('id')
    .execute();
  // A pending submit counts only once a poll confirmed it, in this pass or an earlier one.
  const counted = submissions.filter(
    (row) =>
      row.pending_until === null || (pending?.state === 'confirmed' && row.id === pending.id),
  );
  const marks = counted.map((row): GateMark => {
    const headSha = row.commit_sha.toLowerCase();
    return isMarkColumn(row.column)
      ? { kind: 'mark', column: row.column, headSha }
      : { kind: 'submit', column: row.column, headSha };
  });
  const unhandled = pr === null ? [] : await unhandledFeedback(trx, task, project, pr);
  // A turn hands over no feedback from an incomplete history: its entries would move the cursor
  // past the unread older ones, and the next poll would stop before them.
  const handed = pr?.feedbackComplete === true ? unhandled : [];
  const column = mode === 'shadow' ? (task.shadow_column ?? task.column) : task.column;
  const unclosed = last?.closed_at === null ? last : undefined;
  const gatePr =
    pr !== null && pr.state === 'open' && project.checksGate !== 'dev'
      ? await withUnconfirmedCancels(trx, prSourceId(project.id, pr.repo), pr)
      : pr;
  // Under github-rules the review rule comes only from the project's own source row on the head.
  const reviewRule =
    gatePr !== null && approvalRuleOf(project) === 'github-rules'
      ? await storedReviewRule(
          trx,
          prSourceId(project.id, gatePr.repo),
          gatePr,
          project.operatorGithubLogin,
        )
      : undefined;
  const held =
    mode === 'on' &&
    (await trx
      .selectFrom('operator_item')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('item_key', 'like', `${cycleKeyPrefix(task.id)}%`),
          eb('item_key', 'like', `${courseKeyPrefix(task.id)}%`),
        ]),
      )
      .where('cleared_at', 'is', null)
      .executeTakeFirst()) !== undefined;
  return {
    input: {
      column,
      project: {
        columns: project.columns,
        reposWithoutCi: project.reposWithoutCi,
        checksGate: project.checksGate,
      },
      facts: {
        pr: gatePr,
        externalReviewApproved: pr !== null && externalApproval(pr, project.operatorGithubLogin),
        ...(reviewRule === undefined ? {} : { reviewRule }),
        commentHistory: pr?.feedbackComplete === true ? 'complete' : 'incomplete',
        unhandledExternalComments: unhandled.length,
        unresolvedThreads:
          pr === null ? 0 : pr.reviewThreads.filter((thread) => !thread.resolved).length,
        marks,
      },
      reopened:
        mergedOpen === undefined &&
        ((column === 'done' && !done && task.reopened_at !== null) ||
          (await trx
            .selectFrom('link')
            .select('id')
            .where('task_id', '=', task.id)
            .where('reopen_hidden_at', 'is not', null)
            .executeTakeFirst()) !== undefined) &&
        (await reopenNeedsDispatch(trx, task.id, project)),
      ticketDone: done,
      hasOpenLinkedPr,
      allGithubReposReady,
      spurReady: sourceReady('spur'),
      openPr: link?.open === true,
      githubBlind,
      spurBlind: blind('spur'),
      liveWorker: (await linkedSession(trx, task.id, 'worker')) !== undefined,
      cycleHeld: held,
      submitPending: pending?.state === 'pending',
      submitFailed: pending?.state === 'failed',
      turn: {
        visit:
          last === undefined
            ? 'none'
            : unclosed !== undefined
              ? 'unclosed'
              : last.closed_reason === 'submitted'
                ? 'submitted'
                : 'none',
        open: unclosed?.acked_at != null,
        operatorUntaken: unclosed?.role === 'operator' && unclosed.acked_at === null,
        // turn.head_sha is stored lowercased; GitHub's head is not.
        headMoved:
          unclosed !== undefined &&
          unclosed.head_sha !== null &&
          pr !== null &&
          unclosed.head_sha !== pr.headSha.toLowerCase(),
      },
    },
    handed,
    unclosed,
    mergedOpen,
    ticketUnconfirmed,
    pending,
  };
}

async function applyShadow(
  trx: Trx,
  task: Task,
  project: Project,
  result: DispatchResult,
  at: Date,
): Promise<void> {
  const last = result.moves.at(-1);
  if (last === undefined) return;
  for (const move of result.moves) {
    if (indexOf(move.to) < indexOf(move.from)) await voidSubmits(trx, task.id, move.to, at);
    const courseCheck = await shadowCourseCheck(trx, task.id, move, project);
    await emit(trx, 'task_shadow_moved', task.project, task.id, at.toISOString(), {
      from: move.from,
      to: move.to,
      reason: move.reason,
      ...(move.gate === undefined ? {} : { gate: [...move.gate] }),
      ...(courseCheck ? { courseCheck } : {}),
    });
  }
  await trx.updateTable('task').set({ shadow_column: last.to }).where('id', '=', task.id).execute();
}

async function applyOn(
  trx: Trx,
  task: Task,
  read: NonNullable<Awaited<ReturnType<typeof readInput>>>,
  result: DispatchResult,
  ctx: DispatchContext,
): Promise<void> {
  const { at, config } = ctx;
  const failed = read.pending?.state === 'failed' ? read.pending : undefined;
  // By id: ordinary invalidation skips Review/Product Review marks and QA submissions.
  const voidFailed = async () => {
    if (failed === undefined) return;
    await trx
      .updateTable('submission')
      .set({ voided_at: at.toISOString() })
      .where('id', '=', failed.id)
      .execute();
  };
  let current = task;
  for (const move of result.moves) {
    if (indexOf(move.to) < indexOf(move.from)) {
      const left = await moveLeft(trx, {
        task: current,
        to: move.to,
        at,
        actor: 'system',
        config,
        reason: move.reason,
        ...(move.gate === undefined ? {} : { gate: move.gate }),
      });
      current = left.task;
      // The failure stays deliverable until a turn hands it back (`readPendingSubmit` carry).
      if (left.limitReached) return;
      continue;
    }
    current = await trx
      .updateTable('task')
      .set({ column: move.to, last_change_at: taskChangeAt(at.toISOString()) })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await closeTurns(trx, { taskId: current.id, reason: 'moved', at });
    await emit(trx, 'task_moved', current.project, current.id, at.toISOString(), {
      from: move.from,
      to: move.to,
      reason: move.reason,
    });
  }
  const turn = result.turn;
  if (turn === null) return;
  if (result.voids !== undefined) await voidColumns(trx, current.id, [result.voids], at);
  // An entry turn hands a failed submit back after a left move: the target column's executor.
  const handedBack = turn.kind === 'after_submit' || turn.kind === 'entry' ? failed : undefined;
  if (handedBack !== undefined) await voidFailed();
  const replaced = turn.kind === 'reroute' ? read.unclosed : undefined;
  if (replaced !== undefined) await closeTurns(trx, { taskId: current.id, reason: 'rerouted', at });
  // A reroute carries the feedback the replaced turn handed over; the cursor already counts it.
  // An entry edited since comes as the newer copy.
  const carried = replaced === undefined ? [] : await carriedFeedback(trx, replaced);
  const handed = [
    ...carried.map((old) => {
      const fresh = read.handed.find((entry) => sameHanded(old, entry));
      return fresh !== undefined && isNewerEdit(fresh, old) ? fresh : old;
    }),
    ...read.handed.filter((entry) => !carried.some((old) => sameHanded(old, entry))),
  ];
  const reason =
    read.mergedOpen === undefined || turn.kind === 'reroute'
      ? turnReason(turn, replaced?.reason)
      : `${turnReason(turn)} (PR ${read.mergedOpen.repo}#${String(read.mergedOpen.number)} merged, ticket still open)`;
  await openTurn(trx, {
    task: current,
    reason:
      handedBack === undefined
        ? reason
        : `${reason} (submit of ${handedBack.sha.slice(0, 7)}: ${handedBack.failure})`,
    handed: current.column === 'dev' ? handed : [],
    at,
    config,
    opener: ctx.actor,
  });
}

/**
 * Voids a pending submit whose PR merged at another head and journals it; it opens no turn, as
 * the merge decides the task (a ticket left open sends it back to Dev on its own).
 */
async function supersedeSubmit(
  trx: Trx,
  task: Task,
  pending: Extract<PendingSubmit, { state: 'superseded' }>,
  at: Date,
): Promise<void> {
  const row = await trx
    .updateTable('submission')
    .set({ voided_at: at.toISOString() })
    .where('id', '=', pending.id)
    .returning('column')
    .executeTakeFirstOrThrow();
  await emit(trx, 'task_submitted', task.project, task.id, at.toISOString(), {
    column: row.column,
    sha: pending.sha,
    supersededByMerge: pending.head,
  });
}

/**
 * Counts a pending submit a poll confirmed: from its receipt time, on the linked PR. The turn it
 * closed answered its visit's return, so the return's code block closes at the confirmed head.
 */
async function confirmSubmit(
  trx: Trx,
  task: Task,
  pending: Extract<PendingSubmit, { state: 'confirmed' }>,
  at: Date,
): Promise<void> {
  const row = await trx
    .updateTable('submission')
    .set((eb) => ({
      pending_until: null,
      pr_repo: eb.fn.coalesce('pr_repo', eb.val(pending.pr.repo)),
      pr_number: eb.fn.coalesce('pr_number', eb.val(pending.pr.number)),
    }))
    .where('id', '=', pending.id)
    .returning(['column', 'epoch', 'author'])
    .executeTakeFirstOrThrow();
  const turn = await trx
    .selectFrom('turn')
    .select(['task_id', 'column', 'epoch', 'role'])
    .where('task_id', '=', task.id)
    .where('column', '=', row.column)
    .where('epoch', '=', row.epoch)
    .where('acked_by', '=', row.author)
    .where('closed_reason', '=', 'submitted')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (turn !== undefined)
    await answerReturn(trx, task, turn, { actor: row.author, at: at.toISOString() }, pending.sha);
}

/**
 * Re-evaluates the gates of each task and applies the cascade: in `on` mode it moves the column
 * and opens turns, in `shadow` it moves only the shadow column. Archived tasks and tasks of
 * unconfigured projects are skipped; a task with a missing or unreadable snapshot is held.
 */
export async function dispatchTasks(
  trx: Trx,
  taskIds: readonly number[],
  ctx: DispatchContext,
): Promise<void> {
  await syncModes(trx, ctx.config, ctx.at);
  const blind = await blindSources(trx, ctx.complete);
  for (const id of [...new Set(taskIds)].sort((left, right) => left - right)) {
    const task = await trx.selectFrom('task').selectAll().where('id', '=', id).executeTakeFirst();
    if (task === undefined || task.membership === 'archived') continue;
    const project = ctx.config.projects.find((entry) => entry.id === task.project);
    if (project === undefined) continue;
    const mode = project.dispatcher.mode;
    // One replay of the task's course journal serves the recording, the dedupe and the threshold.
    const replay = replayOnce(trx, task.id, project);
    if (mode === 'on')
      await recordExternalRounds(trx, { task, project, at: ctx.at, blind, replay });
    const read = await readInput(trx, task, project, mode, blind, ctx.config, ctx);
    if (read === null) continue;
    // Before the merged-ticket hold: a merge settles the submit whatever the ticket says.
    if (read.pending?.state === 'superseded')
      await supersedeSubmit(trx, task, read.pending, ctx.at);
    if (read.ticketUnconfirmed) continue;
    if (read.pending?.state === 'confirmed') await confirmSubmit(trx, task, read.pending, ctx.at);
    let result = dispatch(read.input);
    // External Review's deferred course check waits for a final decision of this pass: completion
    // and every other move go first, and a held pass (blind GitHub, a pending submit, an open
    // item) decides nothing yet. Spur blindness holds it only as it holds the Dev turn: `dispatch`
    // defers a turn of a column without an orchestrator (the worker's) while Spur is blind. Its
    // hold then opens no turn in this pass.
    const devWaitsForSpur =
      (project.columns.find((column) => column.id === 'dev')?.orchestrator ?? 'none') === 'none';
    if (
      mode === 'on' &&
      result.moves.length === 0 &&
      dispatchHolds({ ...read.input, spurBlind: devWaitsForSpur && read.input.spurBlind })
        .length === 0 &&
      (await raiseDeferredCourseCheck(trx, {
        task,
        project,
        config: ctx.config,
        at: ctx.at,
        replay,
      }))
    )
      result = dispatch({ ...read.input, cycleHeld: true });
    if (mode === 'shadow') await applyShadow(trx, task, project, result, ctx.at);
    else await applyOn(trx, task, read, result, ctx);
  }
}

/**
 * Evaluates every task journaled since the stored cursor, then moves the cursor past the newest
 * event, the dispatcher's own included. Nothing is written without a new event.
 */
export async function dispatchJournaled(trx: Trx, ctx: DispatchContext): Promise<void> {
  await syncModes(trx, ctx.config, ctx.at);
  const row = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', CURSOR_KEY)
    .executeTakeFirst();
  const cursor = row === undefined ? 0 : parseJson(cursorSchema, row.value);
  const newest = await trx
    .selectFrom('event')
    .select((eb) => eb.fn.max('id').as('id'))
    .executeTakeFirst();
  if (newest?.id == null || newest.id <= cursor) return;
  const tasks = await trx
    .selectFrom('event')
    .select('task_id')
    .distinct()
    .where('id', '>', cursor)
    .where('task_id', 'is not', null)
    .execute();
  await dispatchTasks(
    trx,
    tasks.flatMap((task) => (task.task_id === null ? [] : [task.task_id])),
    ctx,
  );
  const after = await trx
    .selectFrom('event')
    .select((eb) => eb.fn.max('id').as('id'))
    .executeTakeFirstOrThrow();
  const value = toJson(cursorSchema, Math.max(after.id, newest.id));
  await trx
    .insertInto('meta')
    .values({ key: CURSOR_KEY, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

/**
 * Evaluates the tasks of `on`-mode projects whose current visit has an unvoided pending submit:
 * its bound passes and a poll confirms it without a journal entry. A still-pending task gets no
 * write.
 */
export async function dispatchPendingSubmits(trx: Trx, ctx: DispatchContext): Promise<void> {
  const projects = ctx.config.projects
    .filter((project) => project.dispatcher.mode === 'on')
    .map((project) => project.id);
  if (projects.length === 0) return;
  const tasks = await trx
    .selectFrom('task')
    .innerJoin('submission', (join) =>
      join
        .onRef('submission.task_id', '=', 'task.id')
        .onRef('submission.column', '=', 'task.column')
        .onRef('submission.epoch', '=', 'task.column_epoch'),
    )
    .select('task.id')
    .distinct()
    .where('task.project', 'in', projects)
    .where('task.membership', '!=', 'archived')
    .where('submission.voided_at', 'is', null)
    .where('submission.pending_until', 'is not', null)
    .execute();
  if (tasks.length === 0) return;
  await dispatchTasks(
    trx,
    tasks.map((task) => task.id),
    ctx,
  );
}

/**
 * Evaluates every non-archived task of the source's project, or of every project for `spur`: on
 * the source's first complete poll since start and when it recovers from blindness.
 */
export async function dispatchSource(
  trx: Trx,
  source: string,
  ctx: DispatchContext,
): Promise<void> {
  const projects =
    source === 'spur'
      ? ctx.config.projects.map((project) => project.id)
      : [projectForSource(ctx.config, source)?.id].flatMap((id) => (id === undefined ? [] : [id]));
  if (projects.length === 0) return;
  const tasks = await trx
    .selectFrom('task')
    .select('id')
    .where('project', 'in', projects)
    .where('membership', '!=', 'archived')
    .execute();
  await dispatchTasks(
    trx,
    tasks.map((task) => task.id),
    ctx,
  );
}

/** Unchanged complete repository and Spur polls can confirm absence after the task changed. */
export async function dispatchDoneTickets(
  trx: Trx,
  source: string,
  ctx: DispatchContext,
): Promise<void> {
  const projects = ctx.config.projects.filter(
    (entry) =>
      source === 'spur' || entry.repos.some((repo) => prSourceId(entry.id, repo) === source),
  );
  for (const project of projects) {
    const tasks = await trx
      .selectFrom('task')
      .innerJoin('ticket_snapshot', 'ticket_snapshot.task_id', 'task.id')
      .select(['task.id', 'ticket_snapshot.status'])
      .where('task.project', '=', project.id)
      .where('task.membership', '!=', 'archived')
      .where(
        project.dispatcher.mode === 'shadow'
          ? sql<string>`coalesce(task.shadow_column, task.column)`
          : sql<string>`task.column`,
        '!=',
        'done',
      )
      .execute();
    await dispatchTasks(
      trx,
      tasks.filter((task) => ticketDone(project, task.status)).map((task) => task.id),
      ctx,
    );
  }
}

/**
 * Evaluates the tasks of a tracker source's project that are out of Done and whose PR merged:
 * a poll that only refreshes an unchanged open ticket journals nothing, yet can confirm it open
 * past the merge.
 */
export async function dispatchMergedTickets(
  trx: Trx,
  source: string,
  ctx: DispatchContext,
): Promise<void> {
  const project = ctx.config.projects.find((entry) => trackerSourceId(entry) === source);
  if (project === undefined) return;
  const tasks = await trx
    .selectFrom('task')
    .innerJoin('link', 'link.task_id', 'task.id')
    .innerJoin('pr_snapshot', (join) =>
      join
        .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
        .onRef('pr_snapshot.number', '=', 'link.number'),
    )
    .select('task.id')
    .distinct()
    .where('task.project', '=', project.id)
    .where('task.membership', '!=', 'archived')
    .where((eb) => eb.or([eb('task.column', '!=', 'done'), eb('task.shadow_column', '!=', 'done')]))
    .where('link.entity', '=', 'pr')
    .where('link.pr_state', '=', 'active')
    .where('link.banned', '=', 0)
    .where('pr_snapshot.state', '=', 'merged')
    .execute();
  await dispatchTasks(
    trx,
    tasks.map((task) => task.id),
    ctx,
  );
}
