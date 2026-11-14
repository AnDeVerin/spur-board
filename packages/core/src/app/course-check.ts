import {
  COLUMN_IDS,
  eventPayloadSchemas,
  type ColumnId,
  type Config,
  type GateReason,
  type MoveReason,
  type PrFacts,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { returnCauses } from '../domain/dispatch.ts';
import { countCycles, type CycleEvent } from '../domain/gates.ts';
import type { Row } from '../store/schema.ts';
import { curatorProject } from './authorize.ts';
import { openSystemBlock } from './blocks.ts';
import { parsePr, taskPr, taskUrl, type Trx } from './board-utils.ts';
import { capPoints, raiseItem } from './feed.ts';

// The course check: after `columns[].courseCheck` counted returns to Dev from a column, the
// board holds the task and asks the curator, or the operator without one, to check its course.
// Its count is replayed from the journal next to the cycle limit's, with its own resets.

type Task = Row<'task'>;
type Project = Config['projects'][number];

/** The longest text of one open finding in the course check's question. */
const MAX_FINDING = 300;

export const cycleKeyPrefix = (taskId: number) => `cycle-limit:${String(taskId)}:`;
export const courseKeyPrefix = (taskId: number) => `course-check:${String(taskId)}:`;

/** A reopened ticket or a mode switch moves a task left without counting a return. */
export const uncounted = (reason: MoveReason | undefined) =>
  reason === 'ticket_reopened' || reason === 'mode_changed';

const indexOf = (column: ColumnId) => COLUMN_IDS.indexOf(column);
const isColumn = (text: string): text is ColumnId =>
  (COLUMN_IDS as readonly string[]).includes(text);

/** A left move as a return with its causes, or null when it is no counted return. */
function counted(
  move: {
    from: ColumnId;
    to: ColumnId;
    reason?: MoveReason | undefined;
    gate?: readonly GateReason[] | undefined;
  },
  blocked: boolean,
): CycleEvent | null {
  if (indexOf(move.to) >= indexOf(move.from) || uncounted(move.reason)) return null;
  const [first, ...rest] = returnCauses(move.gate ?? [], blocked);
  return first === undefined
    ? null
    : { kind: 'return', column: move.from, causes: [first, ...rest] };
}

/**
 * The counted returns from `column`: `cycle` since the last close of its cycle-limit item, and
 * `course` since the last close of its course-check item.
 */
export async function returnCounts(
  trx: Trx,
  taskId: number,
  column: ColumnId,
): Promise<{ cycle: number; course: number }> {
  const prefixes = { cycle: cycleKeyPrefix(taskId), course: courseKeyPrefix(taskId) };
  const items = await trx
    .selectFrom('operator_item')
    .select(['id', 'item_key'])
    .where((eb) =>
      eb.or([
        eb('item_key', 'like', `${prefixes.cycle}%`),
        eb('item_key', 'like', `${prefixes.course}%`),
      ]),
    )
    .execute();
  const resetOf = new Map<string, { count: 'cycle' | 'course'; column: string }>(
    items.map((item) => {
      const count = item.item_key.startsWith(prefixes.cycle) ? 'cycle' : 'course';
      return [
        `I${String(item.id)}`,
        { count, column: item.item_key.slice(prefixes[count].length) },
      ];
    }),
  );
  // One `at` is shared by a whole transaction, so the journal order is the event id.
  const rows = await trx
    .selectFrom('event')
    .select(['kind', 'payload'])
    .where('task_id', '=', taskId)
    .where('kind', 'in', ['task_moved', 'from_you_cleared'])
    .orderBy('id')
    .execute();
  const events = { cycle: [] as CycleEvent[], course: [] as CycleEvent[] };
  for (const row of rows) {
    if (row.kind === 'from_you_cleared') {
      const cleared = eventPayloadSchemas.from_you_cleared.safeParse(JSON.parse(row.payload));
      const reset = cleared.success ? resetOf.get(cleared.data.item) : undefined;
      if (reset !== undefined && isColumn(reset.column))
        events[reset.count].push({ kind: 'limit_reset', column: reset.column });
      continue;
    }
    const moved = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
    const event = moved.success ? counted(moved.data, moved.data.block !== undefined) : null;
    if (event === null) continue;
    events.cycle.push(event);
    events.course.push(event);
  }
  return {
    cycle: countCycles(events.cycle, column, Infinity).count,
    course: countCycles(events.course, column, Infinity).count,
  };
}

/**
 * Raises the course check of a task's column, once while it is open: a `system` question to the
 * curator, or to the operator when the project has no curator, with the open findings in its
 * reason. The answer to the block resets the course count.
 */
export async function raiseCourseCheck(
  trx: Trx,
  input: { task: Task; column: ColumnId; count: number; at: Date; config: Config },
): Promise<Row<'operator_item'>> {
  const { task, column, count, at, config } = input;
  const itemKey = `${courseKeyPrefix(task.id)}${column}`;
  const active = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('item_key', '=', itemKey)
    .where('cleared_at', 'is', null)
    .executeTakeFirst();
  if (active !== undefined) return active;
  const url = taskUrl(task, config);
  const block = await openSystemBlock(trx, {
    task,
    reason: await courseSummary(trx, task, column, count, url),
    at: at.toISOString(),
    config,
    addressee: curatorProject(config, task.project) === null ? 'operator' : 'curator',
  });
  return raiseItem(trx, {
    itemKey,
    kind: 'course_check',
    text: `${task.key}: course check after ${String(count)} returns from ${column}`,
    url,
    taskId: task.id,
    blockId: block.id,
    at,
  });
}

/** The question of a course check: the count, the open findings and the links. */
async function courseSummary(
  trx: Trx,
  task: Task,
  column: ColumnId,
  count: number,
  url: string,
): Promise<string> {
  const pr = await prFacts(trx, task.id);
  const current = pr?.headSha.toLowerCase();
  const short = (sha: string) =>
    sha.toLowerCase() === current ? `${sha.slice(0, 7)} (current head)` : sha.slice(0, 7);
  const findings = await openFindings(trx, task.id);
  const lines = [
    `course check: ${String(count)} returns to Dev from ${column} since the last check`,
    findings.length === 0 ? 'Open findings: none on the board' : 'Open findings:',
    ...findings.map(
      (finding) =>
        `- B${String(finding.id)} by ${finding.author.replace(/^agent:/, '')} on ${
          finding.head === null ? 'unknown head' : short(finding.head)
        }: ${capPoints(finding.text, MAX_FINDING)}`,
    ),
  ];
  if (pr !== null) {
    for (const review of pr.reviews)
      if (review.state === 'changes_requested')
        lines.push(`- ${review.reviewer} requested changes on ${short(review.commitSha)}`);
    lines.push(
      `Unresolved review threads: ${String(pr.reviewThreads.filter((t) => !t.resolved).length)}`,
    );
    lines.push(`PR: ${pr.url}`);
  }
  lines.push(`Issue: ${url}`);
  return lines.join('\n');
}

/** The task's active PR facts, or null without a readable snapshot. */
async function prFacts(trx: Trx, taskId: number): Promise<PrFacts | null> {
  const link = await taskPr(trx, taskId);
  if (link === null) return null;
  const snapshot = await trx
    .selectFrom('pr_snapshot')
    .select('detail')
    .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
    .where('number', '=', link.number)
    .executeTakeFirst();
  return parsePr(snapshot?.detail);
}

/**
 * The task's open `code` blocks, oldest first, each with the head of the turn whose return opened
 * it, or null when no return names it.
 */
async function openFindings(
  trx: Trx,
  taskId: number,
): Promise<{ id: number; author: string; text: string; head: string | null }[]> {
  const blocks = await trx
    .selectFrom('block')
    .select(['id', 'author', 'reason'])
    .where('task_id', '=', taskId)
    .where('type', '=', 'code')
    .where('state', '=', 'open')
    .orderBy('id')
    .execute();
  if (blocks.length === 0) return [];
  const turnOf = new Map<string, string>();
  const moves = await trx
    .selectFrom('event')
    .select('payload')
    .where('task_id', '=', taskId)
    .where('kind', '=', 'task_moved')
    .execute();
  for (const row of moves) {
    const moved = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
    const { block, turn } = moved.success ? moved.data : {};
    if (block !== undefined && turn !== undefined) turnOf.set(block, turn);
  }
  const findings = [];
  for (const block of blocks) {
    const turn = turnOf.get(`B${String(block.id)}`);
    const row =
      turn === undefined
        ? undefined
        : await trx
            .selectFrom('turn')
            .select('head_sha')
            .where('id', '=', Number(turn.slice(1)))
            .where('task_id', '=', taskId)
            .executeTakeFirst();
    findings.push({
      id: block.id,
      author: block.author,
      text: block.reason,
      head: row?.head_sha ?? null,
    });
  }
  return findings;
}

/**
 * Whether a shadow move reaches the course check of its column: a counted return whose count of
 * counted shadow returns from that column, itself included, is a multiple of `courseCheck`.
 * Shadow mode has no answer, so the count never resets.
 */
export async function shadowCourseCheck(
  trx: Trx,
  taskId: number,
  move: { from: ColumnId; to: ColumnId; reason: MoveReason; gate?: readonly GateReason[] },
  project: Project,
): Promise<boolean> {
  const every = project.columns.find((column) => column.id === move.from)?.courseCheck ?? 0;
  const current = counted(move, false);
  if (every <= 0 || current === null) return false;
  const rows = await trx
    .selectFrom('event')
    .select('payload')
    .where('task_id', '=', taskId)
    .where('kind', '=', 'task_shadow_moved')
    .orderBy('id')
    .execute();
  const past: CycleEvent[] = [];
  for (const row of rows) {
    const moved = eventPayloadSchemas.task_shadow_moved.safeParse(JSON.parse(row.payload));
    const event = moved.success ? counted(moved.data, false) : null;
    if (event !== null) past.push(event);
  }
  const before = countCycles(past, move.from, every).count;
  const after = countCycles([...past, current], move.from, every).count;
  return after > before && after % every === 0;
}
