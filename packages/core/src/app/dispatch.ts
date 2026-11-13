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
import { closeTurns, isNewer, openTurn, turnFeedbackCursors } from './turns.ts';

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
 * Sets `voided_at` on the unvoided submits of `to` and every column right of it. Review and
 * product-review marks are never voided.
 */
async function voidSubmits(trx: Trx, taskId: number, to: ColumnId, at: Date): Promise<void> {
  const columns = COLUMN_IDS.filter(
    (column) => indexOf(column) >= indexOf(to) && !MARK_COLUMNS.includes(column),
  );
  await trx
    .updateTable('submission')
    .set({ voided_at: at.toISOString() })
    .where('task_id', '=', taskId)
    .where('voided_at', 'is', null)
    .where('column', 'in', columns)
    .execute();
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
 * the mode. A switch to `on` copies each task's shadow column into its column as a new visit;
 * either switch then clears the shadow column and journals `dispatcher_mode_changed`.
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
 * The external feedback nobody handled yet. An approval review is not a comment. In `on` mode
 * an entry is handled once a turn handed it over, or an older one; in `shadow`, once a worker
 * column submission was made at or after it.
 */
async function unhandledFeedback(
  trx: Trx,
  task: Task,
  project: Project,
  pr: PrFacts,
  mode: DispatcherMode,
): Promise<Handed[]> {
  const approvals = pr.reviews.filter((review) => review.state === 'approved');
  const entries = (pr.feedback ?? []).filter(
    (entry) =>
      isExternalAuthor(entry, project.operatorGithubLogin) &&
      !(
        entry.kind === 'review' &&
        approvals.some(
          (review) =>
            review.reviewer.toLowerCase() === entry.author?.login.toLowerCase() &&
            Date.parse(review.submittedAt) === Date.parse(entry.postedAt),
        )
      ),
  );
  if (mode === 'shadow') {
    const workerColumns = project.columns
      .filter((column) => column.orchestrator === 'none')
      .map((column) => column.id);
    const submitted =
      workerColumns.length === 0
        ? []
        : await trx
            .selectFrom('submission')
            .select('submitted_at')
            .where('task_id', '=', task.id)
            .where('column', 'in', workerColumns)
            .execute();
    const newest = Math.max(...submitted.map((row) => Date.parse(row.submitted_at)));
    return entries
      .filter((entry) => !(Date.parse(entry.postedAt) <= newest))
      .map((entry) => handedOf(pr, entry));
  }
  const [cursor] = await turnFeedbackCursors(trx, [
    { kind: 'pr', repo: pr.repo, number: pr.number },
  ]);
  return entries
    .filter((entry) => cursor === undefined || isNewer(entry, cursor))
    .map((entry) => handedOf(pr, entry));
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
  const handed = pr === null ? [] : await unhandledFeedback(trx, task, project, pr, mode);
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
        unhandledExternalComments: handed.length,
        marks,
      },
      reopened: task.reopen_link_floor !== null,
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
  const rerouted = turn.kind === 'reroute' ? read.unclosed?.reason : undefined;
  if (turn.kind === 'reroute')
    await closeTurns(trx, { taskId: current.id, reason: 'rerouted', at });
  await openTurn(trx, {
    task: current,
    reason: turnReason(turn, rerouted),
    handed: current.column === 'dev' ? read.handed : [],
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
