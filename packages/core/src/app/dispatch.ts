import {
  COLUMN_IDS,
  DISPATCHER_MODES,
  isExternalAuthor,
  parseActorId,
  prSourceId,
  trackerSourceId,
  type ActorId,
  type ColumnId,
  type Config,
  type DispatcherMode,
  type GateReason,
  type MoveReason,
  type PrFacts,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { dispatch, turnReason } from '../domain/dispatch.ts';
import type { GateMark } from '../domain/gates.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import {
  emit,
  mergedTicket,
  parsePr,
  projectForSource,
  taskMergedPr,
  taskPr,
  ticketDone,
  type Trx,
} from './board-utils.ts';
import {
  courseKeyPrefix,
  cycleKeyPrefix,
  raiseCourseCheck,
  returnCounts,
  shadowCourseCheck,
  uncounted,
} from './course-check.ts';
import { linkedSession } from './doorbells.ts';
import { raiseCycleLimit } from './fromYou.ts';
import {
  closeTurns,
  isNewer,
  openTurn,
  recalledFeedback,
  sameHanded,
  turnFeedbackCursors,
  turnHanded,
} from './turns.ts';

// The dispatcher applies the pure cascade of `domain/dispatch.ts` inside its caller's
// transaction. It reads no clock and does no IO: `at` and the complete-poll map come from the
// caller, so a scan replay makes the same writes.

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
}

const CURSOR_KEY = 'dispatcher_cursor';
const modeKey = (project: string) => `dispatcher_mode:${project}`;
const cursorSchema = z.int().min(0);
const modeSchema = z.enum(DISPATCHER_MODES);

/** Columns whose submissions are marks: they last for their head across visits. */
const MARK_COLUMNS: readonly ColumnId[] = ['review', 'product-review'];

const indexOf = (column: ColumnId) => COLUMN_IDS.indexOf(column);

/**
 * Sets `voided_at` on the unvoided submits of `columns`. Review and product-review marks are
 * not voided by a move; a new PR head voids them (`voidMarksOffHead`).
 */
async function voidColumns(
  trx: Trx,
  taskId: number,
  columns: readonly ColumnId[],
  at: Date,
): Promise<void> {
  const voided = columns.filter((column) => !MARK_COLUMNS.includes(column));
  if (voided.length === 0) return;
  await trx
    .updateTable('submission')
    .set({ voided_at: at.toISOString() })
    .where('task_id', '=', taskId)
    .where('voided_at', 'is', null)
    .where('column', 'in', voided)
    .execute();
}

/**
 * Sets `voided_at` on the unvoided Review and Product Review marks of PR `repo#number` that are
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
    .where('column', 'in', MARK_COLUMNS)
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
 * else `moved`) and journals `task_moved`. In `on` mode a counted return that reaches the
 * column's cycle limit raises its cycle-limit block; otherwise one that reaches its course check
 * raises the course check. Either holds the task, and
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
  },
): Promise<{ task: Task; limitReached: boolean }> {
  const { task, to, at, actor, config, turn, block, reason, gate } = input;
  const moved = await trx
    .updateTable('task')
    .set({
      column: to,
      column_epoch: task.column_epoch + 1,
      left_moves: task.left_moves + 1,
      last_change_at: at.toISOString(),
    })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await voidSubmits(trx, task.id, to, at);
  await closeTurns(trx, { taskId: task.id, reason: turn === undefined ? 'moved' : 'returned', at });
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
    },
    actor,
  );
  const project = config.projects.find((entry) => entry.id === task.project);
  const column = project?.columns.find((entry) => entry.id === task.column);
  if (project?.dispatcher.mode !== 'on' || column === undefined || uncounted(reason))
    return { task: moved, limitReached: false };
  const counts = await returnCounts(trx, task.id, task.column);
  if (counts.cycle >= column.cycleLimit) {
    await raiseCycleLimit(trx, { task: moved, column: task.column, at, config });
    return { task: moved, limitReached: true };
  }
  if (column.courseCheck > 0 && counts.course >= column.courseCheck) {
    await raiseCourseCheck(trx, {
      task: moved,
      column: task.column,
      count: counts.course,
      at,
      config,
    });
    return { task: moved, limitReached: true };
  }
  return { task: moved, limitReached: false };
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
            last_change_at: at.toISOString(),
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

/**
 * The operator's correction of a task's column to `to`, as a new visit of `to`. It first applies
 * a pending dispatcher mode switch, so the switch cannot overwrite the correction. In `on` mode it
 * sets the column and bumps `column_epoch`, voids the submits of `to` and right of it, closes the
 * task's turns as `corrected` and journals `task_corrected`; in shadow mode it sets only the shadow
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
        ? { shadow_column: to, last_change_at: at.toISOString() }
        : { column: to, column_epoch: task.column_epoch + 1, last_change_at: at.toISOString() },
    )
    .where('id', '=', task.id)
    .execute();
  await voidSubmits(trx, task.id, to, at);
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
  const external = (login: string) =>
    login.toLowerCase() !== agentLogin.toLowerCase() &&
    !(pr.feedback ?? []).some(
      (entry) =>
        entry.author?.type === 'bot' && entry.author.login.toLowerCase() === login.toLowerCase(),
    );
  const reviews = pr.reviews.filter((review) => external(review.reviewer));
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
 * (`handlingSubmits`) on this PR was made at or after it. The entries such an untaken turn handed
 * over come from the turn when a later poll dropped them from the snapshot (`recalledFeedback`).
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
  return [...recalled, ...fromSnapshot].filter(
    (entry) =>
      !(Date.parse(entry.postedAt) <= newest) && (cursor === undefined || isNewer(entry, cursor)),
  );
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
  };
}

/**
 * A turn submit accepted before the board could confirm its head, and what it turned into:
 * `pending` while nothing settles it, `confirmed` once a poll observed the PR at `sha` after the
 * submit, `failed` when the head moved, the PR closed, or no PR appeared within the bound.
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
);

/**
 * The newest unvoided pending submit of the task's current visit in `on` mode, settled from
 * stored facts: the linked PR's snapshot observed at or after the submit decides it; with no PR
 * linked, it fails only once the bound passed and a complete poll of every project repo started
 * at or after the bound. Nothing settles while GitHub is blind.
 */
async function readPendingSubmit(
  trx: Trx,
  task: Task,
  project: Project,
  input: {
    link: { repo: string; number: number } | null;
    githubBlind: boolean;
    at: Date;
    complete: ReadonlyMap<string, string>;
  },
): Promise<PendingSubmit | undefined> {
  const row = await trx
    .selectFrom('submission')
    .select(['id', 'commit_sha', 'author', 'submitted_at', 'pending_until'])
    .where('task_id', '=', task.id)
    .where('column', '=', task.column)
    .where('epoch', '=', task.column_epoch)
    .where('voided_at', 'is', null)
    .where('pending_until', 'is not', null)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (row?.pending_until == null) return undefined;
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
    if (snap === undefined || Date.parse(snap.observed_at) < Date.parse(row.submitted_at)) {
      return pending;
    }
    if (snap.state === 'closed') {
      return {
        ...pending,
        state: 'failed',
        failure: `PR ${link.repo}#${String(link.number)} closed`,
      };
    }
    if (snap.head_sha.toLowerCase() === sha) return { ...pending, state: 'confirmed', pr: link };
    return {
      ...pending,
      state: 'failed',
      failure: `head moved to ${snap.head_sha.toLowerCase().slice(0, 7)}`,
    };
  }
  const until = Date.parse(row.pending_until);
  const polledAfter = project.repos.every((repo) => {
    const since = input.complete.get(prSourceId(project.id, repo));
    return since !== undefined && Date.parse(since) >= until;
  });
  if (input.at.getTime() < until || !polledAfter) return pending;
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

/**
 * The dispatcher input of one task, or null when a stored snapshot is missing or unreadable. It
 * only reads.
 */
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
  /** The merged PR whose ticket was seen open past the grace: the task has no PR for the gates. */
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
  // A merged PR finishes the task only with its ticket done. A ticket seen open one tracker
  // interval after the merge sends it back to work without a PR; before that, it waits.
  let mergedOpen: { repo: string; number: number } | undefined;
  let ticketUnconfirmed = false;
  if (pr?.state === 'merged') {
    const ticket = await readTicket();
    const judged = mergedTicket(
      project,
      config,
      ticket,
      task.manual_include === 1,
      pr.mergedAt ?? pr.updatedAt,
    );
    if (judged === 'open') mergedOpen = { repo: pr.repo, number: pr.number };
    ticketUnconfirmed = judged === 'unconfirmed';
  }
  // A merged PR that counts as no PR leaves the follow-up PR in any repo: every repo must see.
  if (mergedOpen !== undefined) pr = null;
  const repos = pr === null ? project.repos : [pr.repo];
  const githubBlind = repos.some((repo) => blind(prSourceId(project.id, repo)));
  const pending =
    mode === 'on'
      ? await readPendingSubmit(trx, task, project, { link, githubBlind, ...clock })
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
    return row.column === 'review' || row.column === 'product-review'
      ? { kind: 'mark', column: row.column, headSha }
      : { kind: 'submit', column: row.column, headSha };
  });
  const unhandled = pr === null ? [] : await unhandledFeedback(trx, task, project, pr);
  // A turn hands over no feedback from an incomplete history: its entries would move the cursor
  // past the unread older ones, and the next poll would stop before them.
  const handed = pr?.feedbackComplete === true ? unhandled : [];
  const column = mode === 'shadow' ? (task.shadow_column ?? task.column) : task.column;
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
  const unclosed = last?.closed_at === null ? last : undefined;
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
      project: { columns: project.columns, reposWithoutCi: project.reposWithoutCi },
      facts: {
        pr,
        externalReviewApproved: pr !== null && externalApproval(pr, project.operatorGithubLogin),
        commentHistory: pr?.feedbackComplete === true ? 'complete' : 'incomplete',
        unhandledExternalComments: unhandled.length,
        marks,
      },
      reopened:
        mergedOpen === undefined &&
        (await trx
          .selectFrom('link')
          .select('id')
          .where('task_id', '=', task.id)
          .where('reopen_hidden_at', 'is not', null)
          .executeTakeFirst()) !== undefined,
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
  // By id: `voidSubmits` and a turn's `voids` skip the Review and Product Review marks.
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
      // The left move ends the visit of the failed submit.
      await voidFailed();
      if (left.limitReached) return;
      continue;
    }
    current = await trx
      .updateTable('task')
      .set({ column: move.to, last_change_at: at.toISOString() })
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
  if (turn.kind === 'after_submit') await voidFailed();
  // An entry turn hands a failed submit back after a left move: the target column's executor.
  const handedBack = turn.kind === 'after_submit' || turn.kind === 'entry' ? failed : undefined;
  const replaced = turn.kind === 'reroute' ? read.unclosed : undefined;
  if (replaced !== undefined) await closeTurns(trx, { taskId: current.id, reason: 'rerouted', at });
  // A reroute carries the feedback the replaced turn handed over; the cursor already counts it.
  const carried = replaced === undefined ? [] : turnHanded(replaced);
  const handed = [
    ...carried,
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
  });
}

/** Counts a pending submit a poll confirmed: from its receipt time, on the linked PR. */
async function confirmSubmit(
  trx: Trx,
  pending: Extract<PendingSubmit, { state: 'confirmed' }>,
): Promise<void> {
  await trx
    .updateTable('submission')
    .set((eb) => ({
      pending_until: null,
      pr_repo: eb.fn.coalesce('pr_repo', eb.val(pending.pr.repo)),
      pr_number: eb.fn.coalesce('pr_number', eb.val(pending.pr.number)),
    }))
    .where('id', '=', pending.id)
    .execute();
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
    const read = await readInput(trx, task, project, mode, blind, ctx.config, ctx);
    if (read === null || read.ticketUnconfirmed) continue;
    if (read.pending?.state === 'confirmed') await confirmSubmit(trx, read.pending);
    const result = dispatch(read.input);
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
