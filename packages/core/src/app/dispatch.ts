import {
  COLUMN_IDS,
  DISPATCHER_MODES,
  eventPayloadSchemas,
  isExternalAuthor,
  prFactsSchema,
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
import { dispatch, returnCauses, turnReason } from '../domain/dispatch.ts';
import { countCycles, type CycleEvent, type GateMark } from '../domain/gates.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import { emit, projectForSource, taskPr, type Trx } from './board-utils.ts';
import { linkedSession } from './doorbells.ts';
import { raiseCycleLimit } from './fromYou.ts';
import { closeTurns, isNewer, openTurn, turnFeedbackCursors, turnHanded } from './turns.ts';

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
const cycleKeyPrefix = (taskId: number) => `cycle-limit:${String(taskId)}:`;
/** A reopened ticket or a mode switch moves a task left without counting a return. */
const uncounted = (reason: MoveReason | undefined) =>
  reason === 'ticket_reopened' || reason === 'mode_changed';

/**
 * Sets `voided_at` on the unvoided submits of `columns`. Review and product-review marks are
 * never voided.
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

/** Voids the submits of `to` and every column right of it, as a left move does. */
async function voidSubmits(trx: Trx, taskId: number, to: ColumnId, at: Date): Promise<void> {
  await voidColumns(
    trx,
    taskId,
    COLUMN_IDS.filter((column) => indexOf(column) >= indexOf(to)),
    at,
  );
}

/** Whether the returns from `column` since its last limit reset reach the column's limit. */
async function cycleLimitReached(
  trx: Trx,
  taskId: number,
  column: ColumnId,
  limit: number,
): Promise<boolean> {
  const prefix = cycleKeyPrefix(taskId);
  const items = await trx
    .selectFrom('operator_item')
    .select(['id', 'item_key'])
    .where('item_key', 'like', `${prefix}%`)
    .execute();
  const itemColumn = new Map(
    items.map((item) => [`I${String(item.id)}`, item.item_key.slice(prefix.length)]),
  );
  // One `at` is shared by a whole transaction, so the journal order is the event id.
  const rows = await trx
    .selectFrom('event')
    .select(['kind', 'payload'])
    .where('task_id', '=', taskId)
    .where('kind', 'in', ['task_moved', 'from_you_cleared'])
    .orderBy('id')
    .execute();
  const events: CycleEvent[] = [];
  for (const row of rows) {
    if (row.kind === 'from_you_cleared') {
      const cleared = eventPayloadSchemas.from_you_cleared.safeParse(JSON.parse(row.payload));
      const of = cleared.success ? itemColumn.get(cleared.data.item) : undefined;
      if (of !== undefined && (COLUMN_IDS as readonly string[]).includes(of))
        events.push({ kind: 'limit_reset', column: of as ColumnId });
      continue;
    }
    const moved = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
    if (!moved.success) continue;
    const { from, to, reason, gate, block } = moved.data;
    if (indexOf(to) >= indexOf(from) || uncounted(reason)) continue;
    const [first, ...rest] = returnCauses(gate ?? [], block !== undefined);
    if (first !== undefined)
      events.push({ kind: 'return', column: from, causes: [first, ...rest] });
  }
  return countCycles(events, column, limit).limitReached;
}

/**
 * Moves a task left to `to` as a new visit: bumps `column_epoch` and `left_moves`, voids the
 * submits of `to` and right of it, closes its turns and journals `task_moved`. In `on` mode a
 * counted return that reaches the column's cycle limit raises its cycle-limit block, and
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
  await closeTurns(trx, { taskId: task.id, reason: 'moved', at });
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
  const limit = project?.columns.find((column) => column.id === task.column)?.cycleLimit;
  if (
    project?.dispatcher.mode !== 'on' ||
    limit === undefined ||
    uncounted(reason) ||
    !(await cycleLimitReached(trx, task.id, task.column, limit))
  )
    return { task: moved, limitReached: false };
  await raiseCycleLimit(trx, { task: moved, column: task.column, at, config });
  return { task: moved, limitReached: true };
}

/**
 * Applies a changed dispatcher mode of each project, as stored in `meta`. A first run only stores
 * the mode. A switch to `on` copies each task's shadow column into its column as a new visit; a
 * switch to `shadow` closes the project's unclosed turns. Either switch then clears the shadow
 * column and journals `dispatcher_mode_changed`.
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
        await closeTurns(trx, { taskId: task.id, reason: 'moved', at });
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
        await closeTurns(trx, { taskId: task_id, reason: 'moved', at });
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

/** A source has no fresh view while it reports blind or has had no complete poll since start. */
async function blindSources(trx: Trx, complete: ReadonlyMap<string, string>) {
  const states = await trx.selectFrom('source_state').select(['source', 'blind_reason']).execute();
  const blind = new Set(
    states.filter((state) => state.blind_reason !== null).map((state) => state.source),
  );
  return (source: string) => blind.has(source) || !complete.has(source);
}

function parsePr(detail: string | undefined): PrFacts | null {
  if (detail === undefined) return null;
  try {
    const parsed = prFactsSchema.safeParse(JSON.parse(detail));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
 * reviewer's latest approval. An entry is handled once a turn handed it over, or an older one, or
 * once a handling submission (`handlingSubmits`) on this PR was made at or after it.
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
  const [cursor] = await turnFeedbackCursors(trx, [
    { kind: 'pr', repo: pr.repo, number: pr.number },
  ]);
  return entries
    .filter(
      (entry) =>
        !(Date.parse(entry.postedAt) <= newest) && (cursor === undefined || isNewer(entry, cursor)),
    )
    .map((entry) => handedOf(pr, entry));
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
  const cursors = await turnFeedbackCursors(db, prs);
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

/** The dispatcher input of one task, or null when a stored snapshot is missing or unreadable. */
async function readInput(
  trx: Trx,
  task: Task,
  project: Project,
  mode: DispatcherMode,
  blind: (source: string) => boolean,
): Promise<{ input: DispatchInput; handed: Handed[]; unclosed: Row<'turn'> | undefined } | null> {
  const link = await taskPr(trx, task.id);
  let pr: PrFacts | null = null;
  if (link !== null) {
    const snapshot = await trx
      .selectFrom('pr_snapshot')
      .select('detail')
      .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
      .where('number', '=', link.number)
      .executeTakeFirst();
    pr = parsePr(snapshot?.detail);
    if (pr === null) return null;
  }
  const repos = pr === null ? project.repos : [pr.repo];
  const githubBlind = repos.some((repo) => blind(`github:${project.id}:${repo.toLowerCase()}`));
  const submissions = await trx
    .selectFrom('submission')
    .select(['column', 'commit_sha'])
    .where('task_id', '=', task.id)
    .where('voided_at', 'is', null)
    .orderBy('id')
    .execute();
  const marks = submissions.map((row): GateMark => {
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
      .where('item_key', 'like', `${cycleKeyPrefix(task.id)}%`)
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
      },
    },
    handed,
    unclosed,
  };
}

async function applyShadow(trx: Trx, task: Task, result: DispatchResult, at: Date): Promise<void> {
  const last = result.moves.at(-1);
  if (last === undefined) return;
  for (const move of result.moves) {
    if (indexOf(move.to) < indexOf(move.from)) await voidSubmits(trx, task.id, move.to, at);
    await emit(trx, 'task_shadow_moved', task.project, task.id, at.toISOString(), {
      from: move.from,
      to: move.to,
      reason: move.reason,
      ...(move.gate === undefined ? {} : { gate: [...move.gate] }),
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
  const replaced = turn.kind === 'reroute' ? read.unclosed : undefined;
  if (replaced !== undefined) await closeTurns(trx, { taskId: current.id, reason: 'rerouted', at });
  // A reroute carries the feedback the replaced turn handed over; the cursor already counts it.
  const carried = replaced === undefined ? [] : turnHanded(replaced);
  const handed = [
    ...carried,
    ...read.handed.filter(
      (entry) =>
        !carried.some(
          (old) =>
            old.repo.toLowerCase() === entry.repo.toLowerCase() &&
            old.number === entry.number &&
            old.kind === entry.kind &&
            old.id === entry.id,
        ),
    ),
  ];
  await openTurn(trx, {
    task: current,
    reason: turnReason(turn, replaced?.reason),
    handed: current.column === 'dev' ? handed : [],
    at,
    config,
  });
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
    const read = await readInput(trx, task, project, mode, blind);
    if (read === null) continue;
    const result = dispatch(read.input);
    if (mode === 'shadow') await applyShadow(trx, task, result, ctx.at);
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
