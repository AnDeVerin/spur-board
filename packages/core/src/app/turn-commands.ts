import {
  parseActorId,
  parseRef,
  type ActorId,
  type ColumnId,
  type Config,
  type PollPrError,
  type PollPrResult,
  type PrPoller,
} from '@spur-board/contracts';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Tables, TaskTable, TurnTable } from '../store/schema.ts';
import type { ResolvedTarget } from './authorize.ts';
import { queueBlockOpen } from './block-thread.ts';
import { authorizationTarget, blockView, openBlock } from './blocks.ts';
import { emit, taskPr, taskView } from './board-utils.ts';
import { CommandError, type CommandContext, type Mutation } from './commands.ts';
import { dispatchTasks, moveLeft, type DispatchContext } from './dispatch.ts';
import { closeTurns } from './turns.ts';

type Trx = Kysely<Tables>;
type Task = Selectable<TaskTable>;
type Turn = Selectable<TurnTable>;

/** How long `task.submit` waits for its on-demand PR poll; the CLI gives up at 30 s. */
const SUBMIT_POLL_TIMEOUT_MS = 10_000;

/** Columns a task returns to Dev from: right of Dev, before the terminal Done. */
const RETURNABLE: readonly ColumnId[] = [
  'review',
  'product-review',
  'external-review',
  'qa',
  'ready-to-merge',
];

/** The PR poll `prepare` ran for a submit, or why it ran none. */
type SubmitPrepared =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'polled';
      /** Lowercase. */
      readonly repo: string;
      readonly number: number;
      /** Null when the daemon has no poller. */
      readonly result: PollPrResult | null;
    };

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
async function turnVisitTarget(db: Trx, id: string): Promise<readonly ResolvedTarget[]> {
  const turn = await turnById(db, id);
  if (turn === undefined) return [{ kind: 'missing', id }];
  const task = await taskById(db, turn.task_id);
  return [{ ...(await authorizationTarget(db, { ...task, column: turn.column })), id }];
}

/**
 * The task a submit names by its key. A key is taken only while the task's project dispatcher
 * is in shadow mode; otherwise `wrong_id_kind`.
 */
async function shadowTask(db: Trx, key: string, config: Config): Promise<Task | undefined> {
  const task = await db.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
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

/** The refusals both operations share, in order: archived, closed, not the taker. */
async function takenTurn(
  trx: Trx,
  id: string,
  ctx: CommandContext,
): Promise<{ turn: Turn; task: Task }> {
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

function pollErrorHint(error: PollPrError, pr: string): string {
  switch (error.kind) {
    case 'timeout':
      return `GitHub did not answer for ${pr} within ${String(SUBMIT_POLL_TIMEOUT_MS / 1000)} s; wait, then submit again.`;
    case 'blind':
      return `The board cannot read ${pr} (${error.reason}); ask the operator to fix the GitHub access, then submit again.`;
    case 'failed':
      return error.retryAt === undefined
        ? `The GitHub poll of ${pr} failed (${error.adapterKind}); wait, then submit again.`
        : `GitHub is throttled until ${error.retryAt}; submit again after that.`;
    case 'stopped':
      return 'The GitHub poller is not running; submit again once the daemon is up.';
    case 'unknown_source':
      return `The repo of ${pr} is not in the project's repos; ask the operator to add it to the config.`;
    case 'unsupported':
      return 'This daemon cannot poll a pull request on demand; ask the operator to update the daemon.';
  }
}

/** Throws `github_unavailable` unless `prepared` is a successful poll of this PR. */
function confirmPolled(
  prepared: SubmitPrepared | undefined,
  pr: { repo: string; number: number },
): void {
  const label = `${pr.repo}#${String(pr.number)}`;
  const unavailable = (hint: string) => new CommandError('github_unavailable', hint);
  if (
    prepared?.kind !== 'polled' ||
    prepared.repo !== pr.repo.toLowerCase() ||
    prepared.number !== pr.number
  ) {
    throw unavailable(`The board did not poll ${label} for this call; submit again.`);
  }
  const { result } = prepared;
  if (result === null) {
    throw unavailable('This daemon runs no GitHub poller; ask the operator to check the daemon.');
  }
  if (!result.ok) throw unavailable(pollErrorHint(result.error, label));
  if (result.value.status !== 'ok') {
    throw unavailable(
      `GitHub answered ${result.value.status} for ${label}; ask the operator to check the board's GitHub access.`,
    );
  }
}

/** Polls the task's PR on demand for a submit; `skipped` when the task has none. */
async function pollTaskPr(
  db: Trx,
  task: Task,
  poll: PrPoller['pollPr'] | undefined,
): Promise<SubmitPrepared> {
  const pr = await taskPr(db, task.id);
  if (pr === null) return { kind: 'skipped' };
  const repo = pr.repo.toLowerCase();
  const result =
    poll === undefined
      ? null
      : await poll(
          `github:${task.project}:${repo}`,
          { kind: 'pr', repo: pr.repo, number: pr.number },
          { timeoutMs: SUBMIT_POLL_TIMEOUT_MS },
        );
  return { kind: 'polled', repo, number: pr.number, result };
}

/** Throws `head_mismatch` or `github_unavailable` unless `sha` is the freshly polled PR head. */
async function confirmHead(
  trx: Trx,
  task: Task,
  sha: string,
  prepared: SubmitPrepared | undefined,
): Promise<void> {
  const pr = await taskPr(trx, task.id);
  if (pr === null) {
    throw new CommandError(
      'head_mismatch',
      'The task has no active pull request; ask the operator to link it with `board link`, then submit its head.',
    );
  }
  confirmPolled(prepared, pr);
  const snapshot = await trx
    .selectFrom('pr_snapshot')
    .select('head_sha')
    .where(sql<boolean>`lower(repo) = ${pr.repo.toLowerCase()}`)
    .where('number', '=', pr.number)
    .executeTakeFirst();
  if (snapshot?.head_sha.toLowerCase() !== sha) {
    throw new CommandError(
      'head_mismatch',
      `The head of ${pr.repo}#${String(pr.number)} is ${snapshot?.head_sha ?? 'unknown'}; push the commit, then submit the head.`,
    );
  }
}

/** The executor's submit and return of a turn it took, and the turnless shadow submit. */
export function createTurnMutations(deps: {
  config: Config;
  /** Read at call time: the adapter runner starts after the registry and may be absent. */
  prPoller?: (() => PrPoller['pollPr'] | undefined) | undefined;
  completeSince: ReadonlyMap<string, string>;
}) {
  const { config, prPoller, completeSince } = deps;
  const dispatchContext = (at: string): DispatchContext => ({
    config,
    at: new Date(at),
    complete: completeSince,
  });
  /** Dispatches the task after the command's change and returns its fresh row. */
  async function dispatched(trx: Trx, taskId: number, at: string): Promise<Task> {
    await dispatchTasks(trx, [taskId], dispatchContext(at));
    return taskById(trx, taskId);
  }
  async function submitShadow(
    trx: Trx,
    input: { turn: string; sha: string },
    ctx: CommandContext<SubmitPrepared>,
  ) {
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
    await confirmHead(trx, task, input.sha, ctx.prepared);
    await trx
      .insertInto('submission')
      .values({
        task_id: task.id,
        column,
        epoch: task.column_epoch,
        commit_sha: input.sha,
        author: ctx.actor,
        submitted_at: ctx.at,
        note: null,
      })
      .execute();
    await emit(
      trx,
      'task_submitted',
      task.project,
      task.id,
      ctx.at,
      { column, sha: input.sha },
      ctx.actor,
    );
    return { task: taskView(await dispatched(trx, task.id, ctx.at)), turn: null, sha: input.sha };
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
        if (task === undefined || task.membership === 'archived') return { kind: 'skipped' };
        if (!(await executesShadowColumn(db, task, actor, config))) return { kind: 'skipped' };
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
      await confirmHead(trx, task, input.sha, ctx.prepared);
      await trx
        .insertInto('submission')
        .values({
          task_id: task.id,
          column: turn.column,
          epoch: turn.epoch,
          commit_sha: input.sha,
          author: ctx.actor,
          submitted_at: ctx.at,
          note: null,
        })
        .execute();
      await closeTurns(trx, { taskId: task.id, reason: 'submitted', at: new Date(ctx.at) });
      await emit(
        trx,
        'task_submitted',
        task.project,
        task.id,
        ctx.at,
        { turn: input.turn, column: turn.column, sha: input.sha },
        ctx.actor,
      );
      return {
        task: taskView(await dispatched(trx, task.id, ctx.at)),
        turn: input.turn,
        sha: input.sha,
      };
    },
  };
  const ret: Mutation<'task.return'> = {
    id: 'task.return',
    resolveTargets: (trx, input) => turnVisitTarget(trx, input.turn),
    async run(trx, input, ctx) {
      const { turn, task } = await takenTurn(trx, input.turn, ctx);
      if (!RETURNABLE.includes(task.column)) {
        throw new CommandError(
          'return_not_allowed',
          `The task is in ${task.column}; only a task right of Dev returns to Dev.`,
        );
      }
      // Routed and rung from the pre-move column, so the block reaches the worker.
      const block = await openBlock(trx, task, 'code', input.reason, ctx, config);
      await queueBlockOpen(trx, task, block, ctx, config);
      await moveLeft(trx, {
        task,
        to: 'dev',
        at: new Date(ctx.at),
        actor: ctx.actor,
        config,
        turn: turnLabel(turn.id),
        block: `B${String(block.id)}`,
      });
      const moved = await dispatched(trx, task.id, ctx.at);
      return { task: taskView(moved), block: blockView(block, moved) };
    },
  };
  return { submit, return: ret };
}
