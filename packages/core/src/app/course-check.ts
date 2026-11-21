import {
  COLUMN_IDS,
  eventPayloadSchemas,
  type AddresseeRole,
  type ColumnId,
  type Config,
  type GateReason,
  type MoveReason,
  type PrFacts,
  prFactsSchema,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { returnCauses } from '../domain/dispatch.ts';
import { countCycles, type CycleEvent, type ReturnCause } from '../domain/gates.ts';
import type { Row } from '../store/schema.ts';
import { curatorProject } from './authorize.ts';
import { openSystemBlock } from './blocks.ts';
import { parsePr, taskPr, taskUrl, type Trx } from './board-utils.ts';
import { capPoints, raiseItem } from './feed.ts';

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
export const EXTERNAL_COUNTER = 'external-review' satisfies ColumnId;

/** Return causes that come from an external change request. */
export const EXTERNAL_CAUSES: readonly ReturnCause[] = ['external_comments', 'changes_requested'];

/** The project's External Review column when it is enabled. */
export const externalColumn = (project: Pick<Project, 'columns'>) =>
  project.columns.find((column) => column.id === EXTERNAL_COUNTER && column.enabled);

/** One entry of a course count: a return to Dev with its causes, or an external round. */
type CourseEntry =
  { kind: 'return'; column: ColumnId; causes: readonly ReturnCause[] } | { kind: 'external_round' };

/** Whether a return came from external feedback: an external cause, and not its executor. */
const externalCause = (causes: readonly ReturnCause[]) =>
  !causes.includes('executor') && causes.some((cause) => EXTERNAL_CAUSES.includes(cause));

/**
 * The column whose course count an entry adds to. An external round, and a return caused by
 * external comments while External Review is enabled, count under External Review, whatever
 * column the task left. An executor return, and every other return, stay on the column it left.
 */
export function courseCounter(entry: CourseEntry, project: Pick<Project, 'columns'>): ColumnId {
  if (entry.kind === 'external_round') return EXTERNAL_COUNTER;
  return externalCause(entry.causes) && externalColumn(project) !== undefined
    ? EXTERNAL_COUNTER
    : entry.column;
}

/**
 * A counted round of a course count, with the head it was counted on, or null when unknown; a
 * return's `cause` tells its executor, external feedback and every other cause apart.
 */
type Round =
  | { kind: 'return'; counter: ColumnId; from: ColumnId; head: string | null; cause: Cause }
  | { kind: 'external_round'; counter: ColumnId; reviewer: string; head: string };

/** A course log in journal order: the counted rounds and the resets of each counter. */
type CourseLog = (Round | { kind: 'reset'; counter: ColumnId })[];

/** A task's journal replayed once: its cycle events, course log and External Review's heads. */
export type CourseReplay = { cycle: CycleEvent[]; course: CourseLog; externalHeads: Set<string> };

const reviewsSchema = prFactsSchema.shape.reviews;

/**
 * The task's cycle events alone, as `courseRounds` gives them: its moves and limit resets, with
 * no PR history read. Enough for a cycle limit, which counts returns and nothing else.
 */
export async function cycleEvents(trx: Trx, taskId: number): Promise<CycleEvent[]> {
  return (await courseRounds(trx, taskId, { columns: [], operatorGithubLogin: '' }, false)).cycle;
}

/**
 * The task's journal replayed for its counts, in journal order: the cycle events, and the
 * course rounds with the resets of each counter. A return is resolved against the PR active
 * when it happened: the newest open PR among the facts journaled before it. Its head is that
 * PR's head then, or unknown without one; a return for external feedback takes the head of the
 * PR's latest external change request made since the dispatcher last moved the task, so a push
 * seen in the same poll does not take its place. A correction is no boundary: a request it
 * bounces on is still unhandled and is the return's cause. External Review counts each head of
 * external feedback (rounds and such returns) once, resets ignored; a later one on a counted
 * head adds to the cycle events only. `externalHeads` are those heads. With `history` false it
 * reads no PR history and gives the cycle events alone.
 */
async function courseRounds(
  trx: Trx,
  taskId: number,
  project: Pick<Project, 'columns' | 'operatorGithubLogin'>,
  history = true,
): Promise<CourseReplay> {
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
  // One `at` is shared by a whole transaction, so the journal order is the event id. A PR facts
  // row brings only its PR, state and head; the reviews and bot logins of the few rows an
  // External Review return needs come in a second read.
  const facts = (path: string) => sql<string | null>`json_extract(payload, ${'$.facts.' + path})`;
  const rows = await trx
    .selectFrom('event')
    .select([
      'id',
      'at',
      'kind',
      sql<string>`case when kind = 'pr_facts_changed' then '' else payload end`.as('payload'),
      facts('repo').as('repo'),
      sql<number | null>`json_extract(payload, '$.facts.number')`.as('number'),
      facts('state').as('state'),
      facts('headSha').as('head'),
    ])
    .where('task_id', '=', taskId)
    .where(
      'kind',
      'in',
      history
        ? ['task_moved', 'from_you_cleared', 'external_round', 'pr_facts_changed']
        : ['task_moved', 'from_you_cleared'],
    )
    .orderBy('id')
    .execute();
  /** Each PR's latest facts so far, with the id of its first facts row. */
  const prs = new Map<string, (typeof rows)[number] & { first: number }>();
  /** The PR active now: the newest open one by first facts. */
  const active = () =>
    [...prs.values()]
      .filter((entry) => entry.state === 'open')
      .sort((left, right) => right.first - left.first)[0];
  const replay: CourseReplay = { cycle: [], course: [], externalHeads: new Set<string>() };
  /**
   * The course entries in journal order; a return for external feedback names the facts row of
   * its PR and the visit start, to take the head of the change request it came from.
   */
  const queue: {
    entry: CourseLog[number];
    external: boolean;
    reviewed?: { id: number; since: number };
  }[] = [];
  let enteredAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.kind === 'pr_facts_changed') {
      if (row.repo === null || row.number === null) continue;
      const key = `${row.repo.toLowerCase()}#${String(row.number)}`;
      prs.set(key, { ...row, first: prs.get(key)?.first ?? row.id });
    } else if (row.kind === 'from_you_cleared') {
      const cleared = eventPayloadSchemas.from_you_cleared.safeParse(JSON.parse(row.payload));
      const reset = cleared.success ? resetOf.get(cleared.data.item) : undefined;
      if (reset === undefined || !isColumn(reset.column)) continue;
      if (reset.count === 'cycle') replay.cycle.push({ kind: 'limit_reset', column: reset.column });
      else if (history)
        queue.push({ entry: { kind: 'reset', counter: reset.column }, external: false });
    } else if (row.kind === 'external_round') {
      const round = eventPayloadSchemas.external_round.safeParse(JSON.parse(row.payload));
      if (round.success) queue.push({ entry: externalRound(round.data, project), external: true });
    } else if (row.kind === 'task_moved') {
      const since = enteredAt;
      enteredAt = Date.parse(row.at);
      const moved = eventPayloadSchemas.task_moved.safeParse(JSON.parse(row.payload));
      const event = moved.success ? counted(moved.data, moved.data.block !== undefined) : null;
      if (event?.kind !== 'return') continue;
      replay.cycle.push(event);
      if (!history || countCycles([event], event.column, Infinity).count === 0) continue;
      const counter = courseCounter(event, project);
      const external = counter === EXTERNAL_COUNTER && externalCause(event.causes);
      const pr = active();
      const cause = event.causes.includes('executor')
        ? 'executor'
        : external
          ? 'external'
          : 'other';
      const head = pr?.head?.toLowerCase() ?? null;
      queue.push({
        entry: { kind: 'return', counter, from: event.column, head, cause },
        external,
        ...(external && pr !== undefined ? { reviewed: { id: pr.id, since } } : {}),
      });
    }
  }
  const used = [...new Set(queue.flatMap(({ reviewed }) => (reviewed ? [reviewed.id] : [])))];
  const reviewed =
    used.length === 0
      ? []
      : await trx
          .selectFrom('event')
          .select([
            'id',
            facts('reviews').as('reviews'),
            sql<string>`(select json_group_array(lower(json_extract(value, '$.author.login'))) from json_each(event.payload, '$.facts.feedback') where json_extract(value, '$.author.type') = 'bot')`.as(
              'bots',
            ),
          ])
          // One JSON array binds every id, whatever SQLite's variable limit.
          .where(sql<boolean>`id in (select value from json_each(${JSON.stringify(used)}))`)
          .execute();
  /** The head of the latest external change request in facts row `id` made after `since`. */
  const reviewedHead = (id: number, since: number) => {
    const row = reviewed.find((entry) => entry.id === id);
    const reviews = reviewsSchema.safeParse(JSON.parse(row?.reviews ?? 'null'));
    if (row === undefined || !reviews.success) return null;
    const bots = new Set(JSON.parse(row.bots) as string[]);
    const latest = reviews.data
      .filter(
        (review) =>
          review.state === 'changes_requested' &&
          Date.parse(review.submittedAt) > since &&
          review.reviewer.toLowerCase() !== project.operatorGithubLogin.toLowerCase() &&
          !bots.has(review.reviewer.toLowerCase()),
      )
      .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))[0];
    return latest?.commitSha.toLowerCase() ?? null;
  };
  for (const { entry, external, reviewed: lookup } of queue) {
    const head = lookup === undefined ? null : reviewedHead(lookup.id, lookup.since);
    const round = head === null || entry.kind !== 'return' ? entry : { ...entry, head };
    if (external && round.kind !== 'reset' && round.head !== null) {
      if (replay.externalHeads.has(round.head)) continue;
      replay.externalHeads.add(round.head);
    }
    replay.course.push(round);
  }
  return replay;
}

/** An `external_round` as the round it counts. */
export const externalRound = (
  round: { reviewer: string; head: string },
  project: Pick<Project, 'columns'>,
): Round => ({
  kind: 'external_round',
  counter: courseCounter({ kind: 'external_round' }, project),
  reviewer: round.reviewer,
  head: round.head.toLowerCase(),
});

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
  return countsFrom(await courseRounds(trx, taskId, project), column);
}

/** `returnCounts` of `column` from a replay already read. */
function countsFrom(replay: CourseReplay, column: ColumnId) {
  return {
    cycle: countCycles(replay.cycle, column, Infinity).count,
    course: roundsSince(replay.course, column).length,
  };
}

/** The task's replay, read on first use and reused for the rest of one dispatcher pass. */
export function replayOnce(
  trx: Trx,
  taskId: number,
  project: Pick<Project, 'columns' | 'operatorGithubLogin'>,
): () => Promise<CourseReplay> {
  let replay: Promise<CourseReplay> | undefined;
  return () => (replay ??= courseRounds(trx, taskId, project));
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
    /** The task's replay when the caller already read it. */
    replay?: CourseReplay;
  },
): Promise<Row<'operator_item'> | null> {
  const { task, project, config, at, counter } = input;
  const threshold = project.columns.find((column) => column.id === counter)?.courseCheck ?? 0;
  if (threshold <= 0) return null;
  const replay = input.replay ?? (await courseRounds(trx, task.id, project));
  const count = roundsSince(replay.course, counter).length;
  if (count < threshold) return null;
  return raiseCourseCheck(trx, { task, column: counter, count, at, config, replay });
}

/** Whether a reviewer is external: not the agent login and not a bot that left feedback. */
export function externalReviewer(pr: PrFacts, agentLogin: string, login: string): boolean {
  return (
    login.toLowerCase() !== agentLogin.toLowerCase() &&
    !(pr.feedback ?? []).some(
      (entry) =>
        entry.author?.type === 'bot' && entry.author.login.toLowerCase() === login.toLowerCase(),
    )
  );
}

/**
 * Raises the course check of a task's column, once while it is open: a `system` question to the
 * column's `courseCheckTo` addressee (`courseAddressee`), with the counted rounds and the open
 * findings in its reason.
 * The answer to the block resets the course count.
 */
export async function raiseCourseCheck(
  trx: Trx,
  input: {
    task: Task;
    column: ColumnId;
    count: number;
    at: Date;
    config: Config;
    replay?: CourseReplay;
  },
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
    reason: await courseSummary(trx, task, { column, count, url, config, replay: input.replay }),
    at: at.toISOString(),
    config,
    addressee: courseAddressee(config, task.project, column),
  });
  return raiseItem(trx, {
    itemKey,
    kind: 'course_check',
    text:
      column === EXTERNAL_COUNTER
        ? `${task.key}: course check after ${countOf(count, EXTERNAL_ROUNDS)}`
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

/** A counted return's cause in the course question. */
type Cause = Exclude<keyof typeof ROUND_KINDS, 'request'>;

/** How External Review's course question counts each kind of round: `[singular, plural]`. */
const ROUND_KINDS = {
  executor: ['executor return', 'executor returns'],
  external: ['return for external comments', 'returns for external comments'],
  other: ['other return', 'other returns'],
  request: ['change request on a new head', 'change requests on new heads'],
} as const;

/** External Review's rounds, in the singular for one. */
const EXTERNAL_ROUNDS = ['external review round', 'external review rounds'] as const;

/** `n` of a thing, in the singular form for one. */
const countOf = (n: number, [one, many]: readonly [string, string]) =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The question of a course check: the count, the counted rounds, the open findings and the links. */
async function courseSummary(
  trx: Trx,
  task: Task,
  input: {
    column: ColumnId;
    count: number;
    url: string;
    config: Config;
    replay: CourseReplay | undefined;
  },
): Promise<string> {
  const { column, count, url, config } = input;
  const pr = await prFacts(trx, task.id);
  const current = pr?.headSha.toLowerCase();
  const short = (sha: string) =>
    sha.toLowerCase() === current ? `${sha.slice(0, 7)} (current head)` : sha.slice(0, 7);
  const project = config.projects.find((entry) => entry.id === task.project) ?? {
    columns: [],
    operatorGithubLogin: '',
  };
  const replay = input.replay ?? (await courseRounds(trx, task.id, project));
  const rounds = roundsSince(replay.course, column);
  const external = column === EXTERNAL_COUNTER;
  const kinds = rounds.map((round) => (round.kind === 'external_round' ? 'request' : round.cause));
  const split = Object.entries(ROUND_KINDS)
    .map(([kind, forms]) => ({ n: kinds.filter((entry) => entry === kind).length, forms }))
    .filter(({ n }) => n > 0)
    .map(({ n, forms }) => countOf(n, forms))
    .join(', ');
  const findings = await openFindings(trx, task.id);
  const lines = [
    external
      ? `course check: ${countOf(count, EXTERNAL_ROUNDS)} since the last check: ${split}`
      : `course check: ${String(count)} returns to Dev from ${column} since the last check`,
    rounds.length === 0 ? 'Counted rounds: none recorded' : 'Counted rounds:',
    ...rounds.map((round) => {
      const head = round.head === null ? 'unknown head' : short(round.head);
      if (round.kind === 'external_round')
        return `- change request by ${round.reviewer} on ${head}`;
      if (external && round.cause === 'executor')
        return `- return to Dev by the ${round.from} executor on ${head}`;
      return round.cause === 'external'
        ? `- return to Dev from ${round.from} for external comments on ${head}`
        : `- return to Dev from ${round.from} on ${head}`;
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
    "To you, the recipient: the last line guides the worker. To clarify the task's goal or setup, answer this question; your answer reaches the worker as a task comment.",
    '',
    "Repeated mechanism: fix its class once, one table test. Code a finding only if it breaks the task's goal in its target setup or regresses the release, whatever its severity; else PR Risk with a thread reply, no code. Unclear scope: `board ask` first.",
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
