// A turn submit without a commit: outside Dev, on a task with no linked PR, the holder closes the
// turn with a reason and no sha. No submission row is written and no return is answered, so a
// return's `code` block waits for a submit with a sha.
import { eventPayloadSchemas, type ActorId, type SubmissionBasis } from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import type { TaskTable, TurnTable } from '../store/schema.ts';
import { emit, pastReopenFloor, taskMergedPr, taskPr, type Trx } from './board-utils.ts';
import { CommandError, type CommandContext } from './commands.ts';
import { closeTurns } from './turns.ts';

type Task = Selectable<TaskTable>;
type Turn = Selectable<TurnTable>;

/**
 * The PR that keeps a submit without a commit out: the task's active link (any state), else its
 * merged one, else an unbanned open conflict link past the reopen floor. A closed conflict link
 * alone does not count. `head` is the PR's stored head, null before the board saw it.
 */
async function linkedPrForSubmit(
  trx: Trx,
  taskId: number,
): Promise<{ repo: string; number: number; head: string | null } | null> {
  let pr: { repo: string; number: number } | null =
    (await taskPr(trx, taskId)) ?? (await taskMergedPr(trx, taskId));
  if (pr === null) {
    const conflict = await trx
      .selectFrom('link')
      .select(['link.repo', 'link.number'])
      .where('link.task_id', '=', taskId)
      .where('link.entity', '=', 'pr')
      .where('link.pr_state', '=', 'conflict')
      .where('link.banned', '=', 0)
      .where('link.pr_open', '=', 1)
      .where(pastReopenFloor)
      .orderBy('link.id', 'desc')
      .executeTakeFirst();
    if (conflict?.repo != null && conflict.number !== null)
      pr = { repo: conflict.repo, number: conflict.number };
  }
  if (pr === null) return null;
  const snapshot = await trx
    .selectFrom('pr_snapshot')
    .select('head_sha')
    .where(sql<boolean>`lower(repo) = ${pr.repo.toLowerCase()}`)
    .where('number', '=', pr.number)
    .executeTakeFirst();
  return { ...pr, head: snapshot?.head_sha ?? null };
}

/**
 * Closes the taken turn by a submit without a commit and journals it, after the refusals in
 * order: a linked PR, a Dev turn (both `submit_sha_required`), then a missing or blank reason or
 * a basis or from (`submit_basis_invalid`). The caller dispatches the task after.
 */
export async function closeWithoutCommit(
  trx: Trx,
  input: {
    turn: string;
    basis?: SubmissionBasis | undefined;
    from?: string | undefined;
    reason?: string | undefined;
  },
  { turn, task }: { turn: Turn; task: Task },
  ctx: CommandContext,
  closer: ActorId | undefined,
): Promise<void> {
  const pr = await linkedPrForSubmit(trx, task.id);
  if (pr !== null) {
    throw new CommandError(
      'submit_sha_required',
      `The task has pull request ${pr.repo}#${String(pr.number)} at head ${pr.head ?? 'unknown'}; submit that head with \`board submit ${input.turn} <sha>\`.`,
    );
  }
  if (turn.column === 'dev') {
    throw new CommandError(
      'submit_sha_required',
      `Dev needs a pull request: open one, then submit its head with \`board submit ${input.turn} <sha>\`; a task without code ends when its ticket is done and no worker is live.`,
    );
  }
  const { reason } = input;
  if (
    input.basis !== undefined ||
    input.from !== undefined ||
    reason === undefined ||
    reason.trim().length === 0
  ) {
    throw new CommandError(
      'submit_basis_invalid',
      'A submit without a commit takes a nonblank reason and no basis or from.',
    );
  }
  await closeTurns(trx, {
    taskId: task.id,
    reason: 'submitted',
    at: new Date(ctx.at),
    actor: closer,
  });
  await emit(
    trx,
    'task_submitted',
    task.project,
    task.id,
    ctx.at,
    { turn: input.turn, column: turn.column, reason },
    ctx.actor,
  );
}

/**
 * The current visit's newest closed turn when a submit without a commit closed it: its
 * `task_submitted` carries a reason and no sha. Undefined once the task left the visit.
 */
export async function submittedWithoutCommit(trx: Trx, task: Task) {
  const turn = await trx
    .selectFrom('turn')
    .select(['id', 'closed_at', 'closed_reason'])
    .where('task_id', '=', task.id)
    .where('column', '=', task.column)
    .where('epoch', '=', task.column_epoch)
    .where('closed_at', 'is not', null)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (turn?.closed_reason !== 'submitted' || turn.closed_at === null) return undefined;
  const id = `T${String(turn.id)}`;
  const event = await trx
    .selectFrom('event')
    .select('payload')
    .where('task_id', '=', task.id)
    .where('kind', '=', 'task_submitted')
    // `json_extract` throws on a payload that is not JSON; one bad row must not fail the read.
    .where(
      sql<boolean>`case when json_valid(payload) then json_extract(payload, '$.turn') end = ${id}`,
    )
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (event === undefined) return undefined;
  const payload = eventPayloadSchemas.task_submitted.safeParse(parsedJson(event.payload));
  if (!payload.success || payload.data.sha !== undefined) return undefined;
  const reason = payload.data.reason ?? '';
  return { turn: id, at: turn.closed_at, reason, text: `submitted without a commit: ${reason}` };
}

/** The payload as JSON, or undefined when it is not JSON, which no payload schema accepts. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
