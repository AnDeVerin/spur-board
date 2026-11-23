import {
  COLUMNS,
  parseActorId,
  parseRef,
  prSourceId,
  type ActorId,
  type ColumnId,
  type Config,
  type PollPrError,
  type PrPoller,
} from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import type { TaskTable, TurnTable } from '../store/schema.ts';
import { isOperator, type ResolvedTarget } from './authorize.ts';
import { queueBlockOpen } from './block-thread.ts';
import { authorizationTarget, blockView, answerReturn, openBlock, taskTarget } from './blocks.ts';
import { emit, moveViews, taskPr, taskView, type Trx } from './board-utils.ts';
import { CommandError, type CommandContext, type Mutation } from './commands.ts';
import {
  correctColumn,
  dispatchTasks,
  judgedPr,
  manuallyMoveColumn,
  moveLeft,
} from './dispatch.ts';
import { storedKey } from './membership.ts';
import { taskSubject } from './subject.ts';
import { closeTurns } from './turns.ts';
import {
  submissionBasis,
  pollTaskPr,
  SUBMIT_POLL_TIMEOUT_MS,
  type SubmitPrepared,
} from './submissions.ts';

type Task = Selectable<TaskTable>;
type Turn = Selectable<TurnTable>;
type SubmitInput = Parameters<Mutation<'task.submit'>['run']>[1];

/** Columns a task returns to Dev from: right of Dev, before the terminal Done. */
const RETURNABLE: readonly ColumnId[] = COLUMNS.filter((c) => c.returnable).map((c) => c.id);

const turnNumber = (id: string) => Number(id.slice(1));
const turnLabel = (id: number) => `T${String(id)}`;

async function turnById(db: Trx, id: string): Promise<Turn | undefined> {
  return db.selectFrom('turn').selectAll().where('id', '=', turnNumber(id)).executeTakeFirst();
}

async function taskById(db: Trx, id: number): Promise<Task> {
  return db.selectFrom('task').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

const isTurnId = (id: string) => parseRef(id, 'turn').ok;

/** Authorizes against the turn's own column, so a late call on an old turn is `turn_closed`. */
export async function turnVisitTarget(db: Trx, id: string): Promise<readonly ResolvedTarget[]> {
  const turn = await turnById(db, id);
  if (turn === undefined) return [{ kind: 'missing', id }];
  const task = await taskById(db, turn.task_id);
  return [{ ...(await authorizationTarget(db, { ...task, column: turn.column })), id }];
}

/**
 * The task a submit names by its key. A key is taken only while the task's project dispatcher is
 * in shadow mode; otherwise `wrong_id_kind`.
 */
async function shadowTask(db: Trx, key: string, config: Config): Promise<Task | undefined> {
  const stored = storedKey(config, key);
  const task = await db.selectFrom('task').selectAll().where('key', '=', stored).executeTakeFirst();
  if (task === undefined) return undefined;
  const project = config.projects.find((entry) => entry.id === task.project);
  if (project?.dispatcher.mode !== 'shadow') {
    throw new CommandError(
      'wrong_id_kind',
      "Submit the turn ID from `board inbox`; the project's dispatcher is on.",
    );
  }
  return task;
}

const shadowColumn = (task: Task): ColumnId => task.shadow_column ?? task.column;

/** Authorizes a shadow submit against the task at its shadow column. */
async function shadowTarget(db: Trx, key: string, config: Config) {
  const task = await shadowTask(db, key, config);
  if (task === undefined) return [{ kind: 'missing' as const, id: key }];
  return [{ ...(await authorizationTarget(db, { ...task, column: shadowColumn(task) })), id: key }];
}

/**
 * Whether `actor` executes the task's shadow column: a worker session linked to the task for a
 * column without an orchestrator, a session of the orchestrator project otherwise. The operator
 * executes no shadow column.
 */
async function executesShadowColumn(
  db: Trx,
  task: Task,
  actor: ActorId,
  config: Config,
): Promise<boolean> {
  const parsed = parseActorId(actor);
  if (parsed?.actor !== 'agent') return false;
  const orchestrator =
    config.projects
      .find((project) => project.id === task.project)
      ?.columns.find((column) => column.id === shadowColumn(task))?.orchestrator ?? 'none';
  if (orchestrator === 'operator') return false;
  if (orchestrator !== 'none') return parsed.actorRef.project === orchestrator;
  const link = await db
    .selectFrom('link')
    .select('id')
    .where('task_id', '=', task.id)
    .where('entity', '=', 'session')
    .where('role', '=', 'worker')
    .where('banned', '=', 0)
    .where('session_id', '=', parsed.actorRef.session)
    .executeTakeFirst();
  return link !== undefined;
}

/** True when the turn is the current visit's, still unclosed. */
function current(turn: Turn, task: Task): boolean {
  return turn.closed_at === null && turn.column === task.column && turn.epoch === task.column_epoch;
}

/** The refusals every turn write shares, in order: not found, archived, closed. */
export async function unclosedTurn(trx: Trx, id: string): Promise<{ turn: Turn; task: Task }> {
  const turn = await turnById(trx, id);
  if (turn === undefined) throw new CommandError('not_found', 'Check the turn ID.');
  const task = await taskById(trx, turn.task_id);
  if (task.membership === 'archived') {
    throw new CommandError('task_archived', 'Add the task again before changing it.');
  }
  if (!current(turn, task)) {
    throw new CommandError(
      'turn_closed',
      `Turn ${id} is closed; read your open turns with \`board inbox\`.`,
    );
  }
  return { turn, task };
}

/** The refusals the holder's writes share, in order: those of `unclosedTurn`, not the taker. */
export async function takenTurn(
  trx: Trx,
  id: string,
  ctx: CommandContext,
): Promise<{ turn: Turn; task: Task }> {
  const { turn, task } = await unclosedTurn(trx, id);
  if (turn.acked_by === null || turn.acked_by !== ctx.actor) {
    throw new CommandError(
      'not_turn_taker',
      turn.acked_by === null
        ? `Take turn ${id} with \`board inbox ack ${id}\` first.`
        : `Turn ${id} was taken by another session; only that session can submit or return it.`,
    );
  }
  return { turn, task };
}

/** Ends a hint for a refusal that a later submit cannot fix. */
const noRepeat = (step: string) => `repeating will not help; ask the operator to ${step}.`;

/** The next step for an on-demand poll that answered nothing. */
function pollErrorHint(error: PollPrError, pr: string): string {
  switch (error.kind) {
    case 'timeout':
      return `GitHub did not answer for ${pr} within ${String(SUBMIT_POLL_TIMEOUT_MS / 1000)} s; wait a minute, then submit again.`;
    case 'blind':
      return error.reason === 'stale'
        ? `The board has no recent complete GitHub poll for ${pr}; submit again in a few minutes, once GitHub answers its polls.`
        : `The board cannot read ${pr} (${error.reason}); ${noRepeat('fix the GitHub access')}`;
    case 'failed':
      if (error.adapterKind === 'auth' || error.adapterKind === 'config') {
        return `The board cannot read ${pr} (${error.adapterKind}); ${noRepeat('fix the GitHub access')}`;
      }
      return error.retryAt === undefined
        ? `The GitHub poll of ${pr} failed (${error.adapterKind}); wait a minute, then submit again.`
        : `GitHub is throttled until ${error.retryAt}; submit again after that.`;
    case 'stopped':
      return 'The GitHub poller is not running; submit again once the daemon is up.';
    case 'unknown_source':
      return `The repo of ${pr} is not in the project's repos; ${noRepeat('add it to the config')}`;
    case 'unsupported':
      return `This daemon cannot poll a pull request on demand; ${noRepeat('update the daemon')}`;
  }
}

/** True when GitHub gave no answer this call and the last poll may stand in for it. */
function pollMayConfirm(error: PollPrError): boolean {
  return (
    error.kind === 'timeout' ||
    (error.kind === 'failed' &&
      (error.adapterKind === 'transient' ||
        error.adapterKind === 'unexpected' ||
        error.adapterKind === 'throttled'))
  );
}

/** How a submit's head was confirmed: `pending` waits for a later poll (`dispatch.ts`). */
type Confirmed = 'live' | 'poll' | 'pending';

/** A failed poll that waiting can fix, beyond `pollMayConfirm`: a stale source, a stopped poller. */
function submitAgain(error: PollPrError): boolean {
  return (error.kind === 'blind' && error.reason === 'stale') || error.kind === 'stopped';
}

/**
 * How the PR head behind a submit is confirmed: `live` by this call's poll, `poll` by the
 * board's newest poll when GitHub did not answer. Throws `head_mismatch` when the confirmed head
 * is not `sha`, `github_unavailable` when nothing confirms it. With `allowPending` (turn
 * submits), a result a later poll can settle is `pending` instead of `github_unavailable`.
 */
function confirmHead(input: {
  prepared: SubmitPrepared | undefined;
  pr: { repo: string; number: number };
  sha: string;
  snapshot: { head_sha: string; observed_at: string } | undefined;
  /** When the PR's source last completed a poll since start. */
  completeAt: string | undefined;
  allowPending: boolean;
}): Confirmed {
  const { prepared, pr, sha, snapshot, completeAt, allowPending } = input;
  const label = `${pr.repo}#${String(pr.number)}`;
  const unavailable = (hint: string) => new CommandError('github_unavailable', hint);
  const waitable = (hint: string): 'pending' => {
    if (allowPending) return 'pending';
    throw unavailable(hint);
  };
  if (
    prepared?.kind !== 'polled' ||
    prepared.repo !== pr.repo.toLowerCase() ||
    prepared.number !== pr.number
  ) {
    return waitable(`The board did not poll ${label} for this call; submit again.`);
  }
  const { result } = prepared;
  if (result === null) {
    throw unavailable(`This daemon runs no GitHub poller; ${noRepeat('check the daemon')}`);
  }
  if (!result.ok) {
    const hint = pollErrorHint(result.error, label);
    if (!pollMayConfirm(result.error)) {
      if (submitAgain(result.error)) return waitable(hint);
      throw unavailable(hint);
    }
    if (completeAt === undefined) {
      return waitable(`${hint} The board has had no complete GitHub poll since it started.`);
    }
    if (snapshot === undefined) {
      return waitable(`${hint} The board has not seen the head of ${label} yet.`);
    }
    if (Date.parse(snapshot.observed_at) < Date.parse(completeAt)) {
      return waitable(
        `${hint} The board last saw head ${snapshot.head_sha} at ${snapshot.observed_at}, before its last complete GitHub poll.`,
      );
    }
    if (snapshot.head_sha.toLowerCase() !== sha) {
      return waitable(`${hint} Its last poll saw head ${snapshot.head_sha}.`);
    }
    return 'poll';
  }
  if (result.value.status !== 'ok') {
    throw unavailable(
      `GitHub answered ${result.value.status} for ${label}; ${noRepeat("check the board's GitHub access")}`,
    );
  }
  if (snapshot?.head_sha.toLowerCase() !== sha) {
    throw new CommandError(
      'head_mismatch',
      `The head of ${label} is ${snapshot?.head_sha ?? 'unknown'}; push the commit, then submit the head.`,
    );
  }
  return 'live';
}

/**
 * Records the submit of `sha` for the task's `column` visit `epoch` and says how its head was
 * confirmed (`confirmHead`). Throws `head_mismatch` or `github_unavailable` otherwise. With
 * `pendingMs` (turn submits: the project's `submitConfirmMs`), a task with no PR or a head a later
 * poll can confirm records a pending row with `pending_until = at + pendingMs`.
 */
async function insertSubmission(
  trx: Trx,
  input: SubmitInput & { task: Task; column: ColumnId; epoch: number },
  ctx: CommandContext<SubmitPrepared>,
  completeSince: ReadonlyMap<string, string>,
  pendingMs?: number,
) {
  const { task, column, epoch, sha } = input;
  const provenance = await submissionBasis(trx, task.id, input);
  const pr = await taskPr(trx, task.id);
  if (pr === null && pendingMs === undefined) {
    throw new CommandError(
      'head_mismatch',
      'The task has no active pull request; ask the operator to link it with `board link`, then submit its head.',
    );
  }
  let confirmed: Confirmed = 'pending';
  if (pr !== null) {
    const snapshot = await trx
      .selectFrom('pr_snapshot')
      .select(['head_sha', 'observed_at'])
      .where(sql<boolean>`lower(repo) = ${pr.repo.toLowerCase()}`)
      .where('number', '=', pr.number)
      .executeTakeFirst();
    confirmed = confirmHead({
      prepared: ctx.prepared,
      pr,
      sha,
      snapshot,
      completeAt: completeSince.get(prSourceId(task.project, pr.repo)),
      allowPending: pendingMs !== undefined,
    });
  }
  await trx
    .insertInto('submission')
    .values({
      task_id: task.id,
      column,
      epoch,
      commit_sha: sha,
      author: ctx.actor,
      submitted_at: ctx.at,
      note: null,
      ...provenance.values,
      pr_repo: pr?.repo ?? null,
      pr_number: pr?.number ?? null,
      pending_until:
        confirmed === 'pending' && pendingMs !== undefined
          ? new Date(Date.parse(ctx.at) + pendingMs).toISOString()
          : null,
    })
    .execute();
  return { confirmed, event: provenance.event };
}

/** The `task_submitted` payload mark of a head confirmed by the board's last poll, or pending. */
const CONFIRMATION = {
  live: {},
  poll: { confirmedByPoll: true },
  pending: { pending: true },
} as const;

/**
 * The executor's submit and return of a turn it took, the turnless shadow submit, and the
 * operator's column correction.
 */
export function createTurnMutations(deps: {
  config: Config;
  /** Read at call time: the adapter runner starts after the registry and may be absent. */
  prPoller?: (() => PrPoller['pollPr'] | undefined) | undefined;
  completeSince: ReadonlyMap<string, string>;
}) {
  const { config, prPoller, completeSince } = deps;
  /** Dispatches the task after the command's change and returns its fresh row. */
  async function dispatched(trx: Trx, id: number, at: string, actor: ActorId): Promise<Task> {
    await dispatchTasks(trx, [id], { config, at: new Date(at), complete: completeSince, actor });
    return taskById(trx, id);
  }
  /** The operator who closes a turn is named on `turn_closed`; any other closer stays `system`. */
  const operatorCloser = (task: Task, actor: ActorId) =>
    isOperator(actor, config, task.project) ? actor : undefined;
  async function submitShadow(trx: Trx, input: SubmitInput, ctx: CommandContext<SubmitPrepared>) {
    const task = await shadowTask(trx, input.turn, config);
    if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
    if (task.membership === 'archived') {
      throw new CommandError('task_archived', 'Add the task again before changing it.');
    }
    const column = shadowColumn(task);
    if (!(await executesShadowColumn(trx, task, ctx.actor, config))) {
      throw new CommandError(
        'forbidden',
        `Only the executor of ${column} submits this task while the dispatcher is in shadow mode.`,
      );
    }
    const { confirmed, event } = await insertSubmission(
      trx,
      { ...input, task, column, epoch: task.column_epoch },
      ctx,
      completeSince,
    );
    await emit(
      trx,
      'task_submitted',
      task.project,
      task.id,
      ctx.at,
      { column, sha: input.sha, ...event, ...CONFIRMATION[confirmed] },
      ctx.actor,
    );
    return {
      task: taskView(await dispatched(trx, task.id, ctx.at, ctx.actor)),
      turn: null,
      sha: input.sha,
      status: 'confirmed' as const,
    };
  }
  const submit: Mutation<'task.submit', SubmitPrepared> = {
    id: 'task.submit',
    resolveTargets: (trx, input) =>
      isTurnId(input.turn)
        ? turnVisitTarget(trx, input.turn)
        : shadowTarget(trx, input.turn, config),
    // Polls only for the turn's taker on the current visit, or the shadow column's executor;
    // refusals are decided in `run`.
    async prepare(db, input, actor) {
      if (!isTurnId(input.turn)) {
        const task = await shadowTask(db, input.turn, config);
        if (
          task === undefined ||
          task.membership === 'archived' ||
          !(await executesShadowColumn(db, task, actor, config))
        )
          return { kind: 'skipped' };
        return pollTaskPr(db, task, prPoller?.());
      }
      const turn = await turnById(db, input.turn);
      if (turn?.acked_by !== actor) return { kind: 'skipped' };
      const task = await taskById(db, turn.task_id);
      if (task.membership === 'archived' || !current(turn, task)) return { kind: 'skipped' };
      return pollTaskPr(db, task, prPoller?.());
    },
    async run(trx, input, ctx) {
      if (!isTurnId(input.turn)) return submitShadow(trx, input, ctx);
      const { turn, task } = await takenTurn(trx, input.turn, ctx);
      const { confirmed, event } = await insertSubmission(
        trx,
        { ...input, task, column: turn.column, epoch: turn.epoch },
        ctx,
        completeSince,
        config.projects.find((entry) => entry.id === task.project)?.dispatcher.submitConfirmMs,
      );
      // A confirmed submit answers the return that opened this visit; a pending one closes its
      // block when the dispatcher confirms it (`confirmSubmit`).
      if (confirmed !== 'pending') await answerReturn(trx, task, turn, ctx, input.sha);
      await closeTurns(trx, {
        taskId: task.id,
        reason: 'submitted',
        at: new Date(ctx.at),
        actor: operatorCloser(task, ctx.actor),
      });
      await emit(
        trx,
        'task_submitted',
        task.project,
        task.id,
        ctx.at,
        {
          turn: input.turn,
          column: turn.column,
          sha: input.sha,
          ...event,
          ...CONFIRMATION[confirmed],
        },
        ctx.actor,
      );
      return {
        task: taskView(await dispatched(trx, task.id, ctx.at, ctx.actor)),
        turn: input.turn,
        sha: input.sha,
        status: confirmed === 'pending' ? ('pending' as const) : ('confirmed' as const),
      };
    },
  };
  const ret: Mutation<'task.return'> = {
    id: 'task.return',
    resolveTargets: (trx, input) => turnVisitTarget(trx, input.turn),
    async run(trx, input, ctx) {
      const { turn, task } = await takenTurn(trx, input.turn, ctx);
      if (!RETURNABLE.includes(task.column))
        throw new CommandError(
          'return_not_allowed',
          `The task is in ${task.column}; only a task right of Dev returns to Dev.`,
        );
      // Routed and rung from the pre-move column, so the block reaches the worker.
      const block = await openBlock(trx, taskSubject(task), 'code', input.reason, ctx, config);
      await queueBlockOpen(trx, taskSubject(task), block, ctx, config);
      await moveLeft(trx, {
        task,
        to: 'dev',
        at: new Date(ctx.at),
        actor: ctx.actor,
        config,
        turn: turnLabel(turn.id),
        block: `B${String(block.id)}`,
        findings: input.findings,
        closedBy: operatorCloser(task, ctx.actor),
      });
      const moved = await dispatched(trx, task.id, ctx.at, ctx.actor);
      return { task: taskView(moved), block: blockView(block, taskSubject(moved)) };
    },
  };
  /**
   * The operator's correction of a task's column. Refused for a column the project does not
   * enable. The gates then settle the task in the same transaction; when they send it straight to
   * Done on a merged PR (`judgedPr`, a conflict-linked merge included), the correction is refused
   * and rolled back, naming that PR. Every other settle, a move back to Dev included, stands.
   */
  const move: Mutation<'task.move'> = {
    id: 'task.move',
    resolveTargets: (trx, input) => taskTarget(trx, storedKey(config, input.task)),
    async run(trx, input, ctx) {
      const key = storedKey(config, input.task);
      const task = await trx
        .selectFrom('task')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirst();
      if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
      if (task.membership === 'archived') {
        throw new CommandError('task_archived', 'Add the task again before changing it.');
      }
      if (input.mode === 'manual') {
        const moved = await manuallyMoveColumn(trx, {
          taskId: task.id,
          to: input.column,
          ...input,
          at: new Date(ctx.at),
          actor: ctx.actor,
          config,
        });
        return { ...moved, task: taskView(await taskById(trx, task.id)), settled: [] };
      }
      const project = config.projects.find((entry) => entry.id === task.project);
      if (project === undefined) {
        throw new CommandError(
          'move_not_allowed',
          `Project ${task.project} is not in the config; add it before correcting its tasks.`,
        );
      }
      if (!project.columns.some((column) => column.id === input.column && column.enabled)) {
        throw new CommandError(
          'move_not_allowed',
          `Column ${input.column} is not enabled in project ${project.id}; pick one of ${project.columns
            .filter((column) => column.enabled && column.id !== 'done')
            .map((column) => column.id)
            .join(', ')}.`,
        );
      }
      const corrected = await correctColumn(trx, {
        taskId: task.id,
        to: input.column,
        at: new Date(ctx.at),
        actor: ctx.actor,
        reason: input.reason,
        config,
      });
      const settled = await dispatched(trx, task.id, ctx.at, ctx.actor);
      const moves = await moveViews(trx, task.id, { after: corrected.eventId });
      // The gates sent the task straight to Done on a merged PR: the throw rolls the correction
      // back, so no evidence is voided and no turn closed.
      if (moves.some((entry) => entry.reason === 'merged')) {
        // A merged move always judged the task on that merged PR.
        const pr = (await judgedPr(trx, task.id, project))?.pr;
        const ref =
          pr == null ? '<url>' : `https://github.com/${pr.repo}/pull/${String(pr.number)}`;
        throw new CommandError(
          'move_not_allowed',
          `Merged pull request ${pr == null ? '' : `${pr.repo}#${String(pr.number)} `}sets the task's column: its ticket is done, so the gates put the task back in Done; unlink it first with \`board unlink ${task.key} --pr ${ref} --reason <text>\`.`,
        );
      }
      return {
        task: taskView(settled),
        from: corrected.from,
        to: input.column,
        column: shadowColumn(settled),
        settled: moves,
      };
    },
  };
  return { submit, return: ret, move };
}
