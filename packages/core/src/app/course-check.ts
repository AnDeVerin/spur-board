import {
  COLUMN_IDS,
  eventPayloadSchemas,
  type AddresseeRole,
  type ColumnId,
  type Config,
  type GateReason,
  type MoveReason,
  prSourceId,
  type PrFacts,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { returnCauses } from '../domain/dispatch.ts';
import { countCycles, type CycleEvent, type ReturnCause } from '../domain/gates.ts';
import type { Row } from '../store/schema.ts';
import { curatorProject } from './authorize.ts';
import { openSystemBlock } from './blocks.ts';
import { emit, parsePr, taskPr, taskUrl, type Trx } from './board-utils.ts';
import { capPoints, raiseItem } from './feed.ts';
import { readStatusColumnEntries } from './status-views.ts';

// The course check: after `columns[].courseCheck` counted rounds under a column, the board holds
// the task and asks `columns[].courseCheckTo` (by default the curator, or the operator without
// one) to check its course. A round is a counted return to Dev, or an external change request on
// a new PR head while the task is in Dev (`external_round`); `courseCounter` names the column it
// counts under.
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

/** The counter that takes every round caused by an external change request. */
const EXTERNAL_COUNTER = 'external-review' satisfies ColumnId;

/** Return causes that come from an external change request. */
const EXTERNAL_CAUSES: readonly ReturnCause[] = ['external_comments', 'changes_requested'];

/** The project's External Review column when it is enabled. */
export const externalColumn = (project: Pick<Project, 'columns'>) =>
  project.columns.find((column) => column.id === EXTERNAL_COUNTER && column.enabled);

/** One entry of a course count: a return to Dev with its causes, or an external round. */
type CourseEntry =
  { kind: 'return'; column: ColumnId; causes: readonly ReturnCause[] } | { kind: 'external_round' };

/**
 * The column whose course count an entry adds to. An external round, and a return caused by
 * external comments while External Review is enabled, count under External Review, whatever
 * column the task left. An executor return, and every other return, stay on the column it left.
 */
export function courseCounter(entry: CourseEntry, project: Pick<Project, 'columns'>): ColumnId {
  if (entry.kind === 'external_round') return EXTERNAL_COUNTER;
  if (entry.causes.includes('executor')) return entry.column;
  return entry.causes.some((cause) => EXTERNAL_CAUSES.includes(cause)) &&
    externalColumn(project) !== undefined
    ? EXTERNAL_COUNTER
    : entry.column;
}

/** A counted round of a course count, with the head it was counted on, or null when unknown. */
type Round =
  | { kind: 'return'; counter: ColumnId; from: ColumnId; head: string | null }
  | { kind: 'external_round'; counter: ColumnId; reviewer: string; head: string };

/** A course log in journal order: the counted rounds and the resets of each counter. */
type CourseLog = (Round | { kind: 'reset'; counter: ColumnId })[];

/**
 * The task's journal replayed for its counts, in journal order: the cycle events, and the
 * course rounds with the resets of each counter. A return's head is the head the active PR moved
 * to last before it, else the one the next head change left, else the PR's current head; a
 * return counted under External Review takes the head of the latest external change request
 * made since the dispatcher last moved the task, as the active PR's facts journaled before the
 * return show it, so a push seen in the same poll does not take its place. A correction is no
 * boundary: a request it bounces on is still unhandled and is the return's cause. External
 * Review counts each head once, resets ignored: a later return or round on a head it already
 * counted adds to the cycle events only. `externalHeads` are the heads External Review counted.
 */
async function courseRounds(
  trx: Trx,
  taskId: number,
  project: Pick<Project, 'columns' | 'operatorGithubLogin'>,
): Promise<{ cycle: CycleEvent[]; course: CourseLog; externalHeads: Set<string> }> {
  const pr = await prFacts(trx, taskId);
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
    .select(['id', 'at', 'kind', 'payload'])
    .where('task_id', '=', taskId)
    .where('kind', 'in', ['task_moved', 'from_you_cleared', 'external_round', 'head_moved'])
    .orderBy('id')
    .execute();
  const heads: { id: number; from: string | null; to: string }[] = [];
  if (pr !== null)
    for (const row of rows) {
      if (row.kind !== 'head_moved') continue;
      const moved = eventPayloadSchemas.head_moved.safeParse(JSON.parse(row.payload));
      if (
        moved.success &&
        moved.data.repo.toLowerCase() === pr.repo.toLowerCase() &&
        moved.data.pr === pr.number
      )
        heads.push({ id: row.id, from: moved.data.from, to: moved.data.to });
    }
  const headAt = (id: number) =>
    (
      heads.filter((head) => head.id < id).at(-1)?.to ??
      heads.find((head) => head.id > id && head.from !== null)?.from ??
      pr?.headSha
    )?.toLowerCase() ?? null;
  const reviewedHead = async (id: number, since: number) => {
    if (pr === null) return null;
    const row = await trx
      .selectFrom('event')
      .select('payload')
      .where('task_id', '=', taskId)
      .where('kind', '=', 'pr_facts_changed')
      .where(sql<boolean>`json_extract(payload, '$.facts.number') = ${pr.number}`)
      .where(sql<boolean>`lower(json_extract(payload, '$.facts.repo')) = ${pr.repo.toLowerCase()}`)
      .where('id', '<', id)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const seen = eventPayloadSchemas.pr_facts_changed.safeParse(JSON.parse(row?.payload ?? 'null'));
    if (!seen.success) return null;
    const latest = seen.data.facts.reviews
      .filter(
        (review) =>
          review.state === 'changes_requested' &&
          Date.parse(review.submittedAt) > since &&
          externalReviewer(seen.data.facts, project.operatorGithubLogin, review.reviewer),
      )
      .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))[0];
    return latest?.commitSha.toLowerCase() ?? null;
  };
  const cycle: CycleEvent[] = [];
  const course: CourseLog = [];
  const externalHeads = new Set<string>();
  let enteredAt = Number.NEGATIVE_INFINITY;
  const count = (round: Round) => {
    if (round.counter === EXTERNAL_COUNTER && round.head !== null) {
      if (externalHeads.has(round.head)) return;
      externalHeads.add(round.head);
    }
    course.push(round);
  };
  for (const row of rows) {
    if (row.kind === 'from_you_cleared') {
      const cleared = eventPayloadSchemas.from_you_cleared.safeParse(JSON.parse(row.payload));
      const reset = cleared.success ? resetOf.get(cleared.data.item) : undefined;
      if (reset === undefined || !isColumn(reset.column)) continue;
      if (reset.count === 'cycle') cycle.push({ kind: 'limit_reset', column: reset.column });
      else course.push({ kind: 'reset', counter: reset.column });
    } else if (row.kind === 'external_round') {
      const round = eventPayloadSchemas.external_round.safeParse(JSON.parse(row.payload));
      if (round.success)
        count({
          kind: 'external_round',
          counter: courseCounter({ kind: 'external_round' }, project),
          reviewer: round.data.reviewer,
          head: round.data.head.toLowerCase(),
        });
    } else if (row.kind === 'task_moved') {
      const since = enteredAt;
      enteredAt = Date.parse(row.at);
      const moved = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
      const event = moved.success ? counted(moved.data, moved.data.block !== undefined) : null;
      if (event?.kind !== 'return') continue;
      cycle.push(event);
      if (countCycles([event], event.column, Infinity).count === 0) continue;
      const counter = courseCounter(event, project);
      count({
        kind: 'return',
        counter,
        from: event.column,
        head:
          (counter === EXTERNAL_COUNTER ? await reviewedHead(row.id, since) : null) ??
          headAt(row.id),
      });
    }
  }
  return { cycle, course, externalHeads };
}

/** The rounds counted under `counter` since the last close of its course-check item. */
function roundsSince(course: CourseLog, counter: ColumnId): Round[] {
  const rounds: Round[] = [];
  for (const entry of course) {
    if (entry.counter !== counter) continue;
    if (entry.kind === 'reset') rounds.length = 0;
    else rounds.push(entry);
  }
  return rounds;
}

/**
 * The counted returns from `column` since the last close of its cycle-limit item (`cycle`), and
 * the rounds counted under `column` (`courseCounter`) since the last close of its course-check
 * item (`course`).
 */
export async function returnCounts(
  trx: Trx,
  taskId: number,
  column: ColumnId,
  project: Pick<Project, 'columns' | 'operatorGithubLogin'>,
): Promise<{ cycle: number; course: number }> {
  const { cycle, course } = await courseRounds(trx, taskId, project);
  return {
    cycle: countCycles(cycle, column, Infinity).count,
    course: roundsSince(course, column).length,
  };
}

/**
 * Raises the course check of `counter` when its rounds since the last check reach the column's
 * `courseCheck`. Returns the
 * open item, or null when nothing is due.
 */
export async function raiseCourseDue(
  trx: Trx,
  input: {
    task: Task;
    project: Project;
    config: Config;
    at: Date;
    counter: ColumnId;
  },
): Promise<Row<'operator_item'> | null> {
  const { task, project, config, at, counter } = input;
  const threshold = project.columns.find((column) => column.id === counter)?.courseCheck ?? 0;
  if (threshold <= 0) return null;
  const rounds = roundsSince((await courseRounds(trx, task.id, project)).course, counter);
  if (rounds.length < threshold) return null;
  return raiseCourseCheck(trx, { task, column: counter, count: rounds.length, at, config });
}

/** Whether a reviewer is external: not the agent login and not a bot that left feedback. */
function externalReviewer(pr: PrFacts, agentLogin: string, login: string): boolean {
  return (
    login.toLowerCase() !== agentLogin.toLowerCase() &&
    !(pr.feedback ?? []).some(
      (entry) =>
        entry.author?.type === 'bot' && entry.author.login.toLowerCase() === login.toLowerCase(),
    )
  );
}

/**
 * While the task is in Dev with the dispatcher on and External Review's course check on, records
 * one `external_round` for each external change request on the open PR that came after the task
 * entered Dev, on a head not yet counted under External Review: by an earlier round or by a
 * return counted there, resets ignored, and not while the PR's GitHub source is `blind` (no
 * complete poll since the start, or blind). Then, with no cycle-limit or course-check item open,
 * raises External Review's course check once its rounds since the last check reach its
 * `courseCheck`, returns alone included: a return that reached it while another item was open.
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

/**
 * Raises the course check of a task's column, once while it is open: a `system` question to the
 * column's `courseCheckTo` addressee (`courseAddressee`), with the counted rounds and the open
 * findings in its reason.
 * The answer to the block resets the course count.
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
    reason: await courseSummary(trx, task, column, count, url, config),
    at: at.toISOString(),
    config,
    addressee: courseAddressee(config, task.project, column),
  });
  return raiseItem(trx, {
    itemKey,
    kind: 'course_check',
    text:
      column === EXTERNAL_COUNTER
        ? `${task.key}: course check after ${String(count)} external review rounds`
        : `${task.key}: course check after ${String(count)} returns from ${column}`,
    url,
    taskId: task.id,
    blockId: block.id,
    at,
  });
}

/**
 * Who a column's course check asks: `courseCheckTo` read as the operator, the curator, or the
 * orchestrator of this column or else of the first column it orchestrates. Without the key, or
 * with a name that no longer fits, the curator, or the operator when the project has none.
 */
export function courseAddressee(
  config: Config,
  projectId: string,
  column: ColumnId,
): AddresseeRole {
  const fallback = curatorProject(config, projectId) === null ? 'operator' : 'curator';
  const columns = config.projects.find((project) => project.id === projectId)?.columns ?? [];
  const to = columns.find((c) => c.id === column)?.courseCheckTo;
  if (to === undefined) return fallback;
  if (to === 'operator') return 'operator';
  if (to === curatorProject(config, projectId)) return 'curator';
  const own = columns.find((c) => c.id === column && c.orchestrator === to);
  const orchestrated = own ?? columns.find((c) => c.orchestrator === to);
  return orchestrated === undefined ? fallback : `orchestrator:${orchestrated.id}`;
}

/** The question of a course check: the count, the counted rounds, the open findings and the links. */
async function courseSummary(
  trx: Trx,
  task: Task,
  column: ColumnId,
  count: number,
  url: string,
  config: Config,
): Promise<string> {
  const pr = await prFacts(trx, task.id);
  const current = pr?.headSha.toLowerCase();
  const short = (sha: string) =>
    sha.toLowerCase() === current ? `${sha.slice(0, 7)} (current head)` : sha.slice(0, 7);
  const project = config.projects.find((entry) => entry.id === task.project) ?? {
    columns: [],
    operatorGithubLogin: '',
  };
  const rounds = roundsSince((await courseRounds(trx, task.id, project)).course, column);
  const returns = rounds.filter((round) => round.kind === 'return').length;
  const findings = await openFindings(trx, task.id);
  const lines = [
    column === EXTERNAL_COUNTER
      ? `course check: ${String(count)} external review rounds since the last check: ${String(returns)} returns to Dev for external comments, ${String(rounds.length - returns)} change requests on new heads`
      : `course check: ${String(count)} returns to Dev from ${column} since the last check`,
    rounds.length === 0 ? 'Counted rounds: none recorded' : 'Counted rounds:',
    ...rounds.map((round) => {
      const head = round.head === null ? 'unknown head' : short(round.head);
      return round.kind === 'return'
        ? `- return to Dev from ${round.from} on ${head}`
        : `- change request by ${round.reviewer} on ${head}`;
    }),
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
  lines.push(
    '',
    'If returns keep hitting the same mechanism, fix the bug class once and cover its variants with one table test. Put remaining edges with no user-visible effect under Risk in the PR description instead of fixing them here. Still fix P0/P1 and user-visible findings in this PR.',
  );
  return lines.join('\n');
}

/** The task's active PR facts, or null without a readable snapshot. */
export async function prFacts(trx: Trx, taskId: number): Promise<PrFacts | null> {
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
