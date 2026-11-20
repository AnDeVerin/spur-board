import type { IconName, KeyValueStatus } from '../ds/index.ts';
import {
  githubRef,
  sameJiraProject,
  sessionLinkHref,
  taskLinkHref,
  ticketBrowseHref,
} from '../lib/links.ts';
import type { BoardConfig, BoardHistory, BoardTask } from './data.ts';
import { formatDataTime, shortKey, type BoardColumnConfig, type BoardRow } from './model.ts';
import { age as cardAge, quickLinks } from './card.ts';

type TaskWhy = NonNullable<BoardTask['why']>;
type TaskGate = TaskWhy['gates'][number];
type TaskLink = BoardTask['links'][number];

/** One row of "Why it is here", as `KeyValueBox` takes it. */
export interface WhyRow {
  key: string;
  value?: string | undefined;
  status?: KeyValueStatus | undefined;
}

/** A link chip: a link when `href` is set, else plain text. */
export interface LinkChip {
  kind: TaskLink['kind'];
  icon: IconName;
  text: string;
  href: string | null;
  /** Accessible name of a link chip: the visible text, then the owner and repo or `Spur session`. */
  label: string | undefined;
}

/** `?open=` names a task; empty, absent, `inbox` and `services` name none. */
export function taskParam(search: string): string | null {
  const value = new URLSearchParams(search).get('open');
  return value === null || value === '' || value === 'inbox' || value === 'services' ? null : value;
}

/** Minutes, hours and minutes, or days since `iso`, as the prototype writes ages. */
export function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  if (minutes < 1440) {
    const hours = String(Math.floor(minutes / 60));
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${String(minutes % 60)}m`;
  }
  return `${String(Math.floor(minutes / 1440))}d`;
}

/** `agent:<project>/<session>` reads as the session; operator and system stay. */
export const actorName = (actor: string) =>
  actor.startsWith('agent:') ? actor.slice(actor.indexOf('/') + 1) : actor;

/**
 * How the task view names an actor: `you` for the operator, `<Spur project display name> /
 * <session>` for an agent, any other actor as it is.
 */
export function actorDisplayName(actor: string, config: BoardConfig | undefined): string {
  if (actor === 'operator') return 'you';
  if (!actor.startsWith('agent:')) return actor;
  const [project, ...session] = actor.slice(6).split('/');
  const binding = config?.projects
    .flatMap((entry) => entry.spurProjects)
    .find((entry) => entry.name === project);
  return `${binding?.displayName ?? project ?? actor} / ${session.join('/')}`;
}

/** The actor with the channel its write arrived through, when the journal has one. */
export const actorLabel = (actor: string, via: string | undefined) =>
  via === undefined ? actorName(actor) : `${actorName(actor)} (${via})`;

/** One History row; the kind stays the raw journal kind, a kind this bundle does not know too. */
export interface HistoryRow {
  /** Position in the server time order. */
  key: number;
  time: string;
  summary: string;
  actor: string;
  kind: string;
}

/** History rows newest first; events with one timestamp keep reverse journal order. */
export function historyRows(events: BoardHistory['events']): HistoryRow[] {
  return events
    .map((event, index) => ({
      key: index,
      time: formatDataTime(Date.parse(event.at)),
      summary: event.summary,
      actor: actorLabel(event.actor, event.via),
      kind: event.kind,
    }))
    .reverse();
}

/** Maximal adjacent raw matches fold at three rows; the oldest position survives newer appends. */
export function historyRuns(events: BoardHistory['events']) {
  const runs: HistoryRow[][] = [];
  for (const row of historyRows(events)) {
    const last = runs.at(-1);
    const previous = last?.[0];
    const a = previous === undefined ? undefined : events[previous.key];
    const b = events[row.key];
    if (
      last &&
      a &&
      b &&
      a.kind === b.kind &&
      a.actor === b.actor &&
      a.via === b.via &&
      a.summary === b.summary
    )
      last.push(row);
    else runs.push([row]);
  }
  return runs
    .flatMap((rows) => (rows.length >= 3 ? [rows] : rows.map((row) => [row])))
    .flatMap((rows) => {
      const newest = rows[0];
      const oldest = rows.at(-1);
      if (!newest || !oldest) return [];
      return [
        {
          key: oldest.key,
          rows,
          since:
            oldest.time.slice(6) === newest.time.slice(6) ? oldest.time.slice(0, 5) : oldest.time,
        },
      ];
    });
}

/**
 * Time in the task's `column`, from its held `status.get` row: `columnEnteredAt` skips shadow
 * moves and shadow corrections and falls back to when the task was added. It counts to
 * `statusReadAt`, the last good status read, with the card's `age`, so the header and the card
 * read the same. None without a row, an entry time or a read, or when the row is in another
 * column.
 */
export function timeInColumn(
  column: string,
  row: BoardRow | undefined,
  statusReadAt: number | undefined,
): string | undefined {
  if (row?.column !== column || row.columnEnteredAt === null || statusReadAt === undefined)
    return undefined;
  return cardAge(row.columnEnteredAt, statusReadAt);
}

/** The gate of the column the dispatcher works from; undefined means the gate is unknown. */
function currentGate(why: TaskWhy | undefined): TaskGate | undefined {
  return why?.gates.find((gate) => gate.column === why.column);
}

/** The `config.get` column fields the next-column line reads. */
type NextColumnConfig = Pick<BoardColumnConfig, 'id' | 'group'>;

/**
 * The enabled column after `column` in `columns` order; none when `column` is not enabled or is
 * the last. From a column of a group it skips the rest of that group, as the dispatcher does.
 */
export function columnAfter(
  column: string,
  columns: readonly NextColumnConfig[],
): string | undefined {
  const index = columns.findIndex((entry) => entry.id === column);
  if (index === -1) return undefined;
  const group = columns[index]?.group;
  return columns.slice(index + 1).find((entry) => group === undefined || entry.group !== group)?.id;
}

/**
 * The column after `why.column` when every one of its exit conditions is met, a known gate with
 * no conditions included; none when the gate is unknown.
 */
export function nextColumn(
  why: TaskWhy | undefined,
  columns: readonly NextColumnConfig[],
): string | undefined {
  const gate = currentGate(why);
  if (!why || !gate) return undefined;
  if (!gate.conditions.every((condition) => condition.state === 'met')) return undefined;
  return columnAfter(why.column, columns);
}

const CONDITIONS: Record<string, string> = {
  pr_open: 'PR open',
  not_draft: 'Not a draft',
  checks_green: 'Checks green',
  checks_not_red: 'Checks not red',
  no_conflict: 'No conflict',
  external_comments_handled: 'External comments handled',
  comment_history_read: 'Comment history read',
  threads_resolved: 'Threads resolved',
  submit_on_head: 'Submit on the head',
  review_on_head: 'Review on the head',
  approved: 'Approved',
  merged: 'Merged',
};
/** A condition, reason or hold in words: `_` as a space, `pr` as `PR`. */
const inWords = (value: string) => value.replace(/_/g, ' ').replace(/\bpr\b/g, 'PR');

function conditionRow(condition: TaskGate['conditions'][number]): WhyRow {
  const key = CONDITIONS[condition.condition] ?? inWords(condition.condition);
  const reason = condition.reason === null ? null : inWords(condition.reason);
  switch (condition.state) {
    case 'met':
      return { key, value: 'met', status: 'pass' };
    case 'failed':
      return { key, value: reason ?? undefined, status: 'fail' };
    case 'waiting':
      return { key, value: reason ?? undefined, status: 'wait' };
    case 'unchecked':
      return { key, status: 'unchecked' };
  }
}

function turnRow(turn: BoardTask['turn'], now: number, holderUnknown: boolean): WhyRow {
  if (turn === null) return { key: 'Open turn', value: 'none' };
  const key = `Open turn ${turn.id}`;
  if (turn.addressee === 'operator')
    return { key, value: `yours · open · ${age(turn.at, now)}`, status: 'wait' };
  const role = turn.addressee.split(':')[0] ?? turn.addressee;
  if (holderUnknown) return { key, value: `${role} · holder unknown`, status: 'unchecked' };
  if (turn.taken)
    return {
      key,
      value: `${role} ${actorName(turn.taken.by)} · taken · ${age(turn.taken.at, now)}`,
    };
  return { key, value: `${role} · not taken · ${age(turn.at, now)}`, status: 'wait' };
}

const openBlocks = (value: BoardTask) => value.blocks.filter((block) => block.state === 'open');

/**
 * "Why it is here": the exit conditions of the `why.column` gate (or why they are unknown), each
 * hold, the open turn, the open blocks, and the next column when every condition is met. With
 * `holderUnknown` (the Turn section's re-read after a write has not answered) the open turn names
 * no holder.
 */
export function whyRows(
  value: BoardTask,
  columns: readonly NextColumnConfig[],
  now: number,
  holderUnknown = false,
): WhyRow[] {
  const { why } = value;
  const gate = currentGate(why);
  const rows: WhyRow[] = [];
  if (!why || !gate) rows.push({ key: 'Exit conditions unknown', status: 'unchecked' });
  else if (gate.conditions.length === 0) rows.push({ key: `No exit conditions in ${why.column}` });
  else rows.push(...gate.conditions.map(conditionRow));
  for (const hold of why?.holds ?? [])
    rows.push({ key: 'Hold', value: inWords(hold), status: 'wait' });
  rows.push(turnRow(value.turn, now, holderUnknown));
  const blocks = openBlocks(value);
  rows.push(
    blocks.length > 0
      ? { key: 'Open blocks', value: blocks.map((block) => block.id).join(', '), status: 'fail' }
      : { key: 'Open blocks', value: 'none', status: 'pass' },
  );
  const next = nextColumn(why, columns);
  // For a Todo-group task the arrow means work started (an open PR or a live worker), not an
  // exit condition.
  if (why && next !== undefined)
    rows.push({ key: `When ${why.column} exit conditions pass`, value: `→ ${next}` });
  return rows;
}

/** The section summary: failed and waiting conditions of the current gate and open blocks. */
export function whySummary(value: BoardTask): string {
  const gate = currentGate(value.why);
  const conditions = gate?.conditions ?? [];
  const failed = conditions.filter((condition) => condition.state === 'failed').length;
  const waiting = conditions.filter((condition) => condition.state === 'waiting').length;
  const blocks = openBlocks(value).length;
  const parts = [
    failed > 0 ? `${String(failed)} failed` : '',
    waiting > 0 ? `${String(waiting)} waiting` : '',
    blocks > 0 ? `${String(blocks)} open ${blocks === 1 ? 'block' : 'blocks'}` : '',
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');
  return gate ? 'all pass' : 'unknown';
}

const KIND_ORDER: readonly TaskLink['kind'][] = ['ticket', 'pr', 'session'];

function linkChip(
  link: TaskLink,
  taskKey: string,
  spurUiOrigin: string | null,
  ticketBrowseBase: string | null,
): LinkChip {
  if (link.kind === 'session') {
    const text = `session ${link.ref}`;
    const href = sessionLinkHref(spurUiOrigin, link.ref);
    return {
      kind: link.kind,
      icon: 'term',
      text,
      href,
      label: href === null ? undefined : `${text}, Spur session`,
    };
  }
  if (link.kind === 'ticket' && taskLinkHref(link) === null) {
    const text = `ticket ${shortKey(link.ref)}`;
    const base = sameJiraProject(link.ref, taskKey) ? ticketBrowseBase : null;
    const href = ticketBrowseHref(base, link.ref);
    return {
      kind: link.kind,
      icon: 'ticket',
      text,
      href,
      label: href === null ? undefined : `${text}, Jira`,
    };
  }
  const href = taskLinkHref(link);
  const ref = githubRef(link.ref);
  const text =
    link.kind === 'ticket'
      ? `ticket ${shortKey(link.ref)}`
      : ref
        ? `PR #${ref.number}`
        : `PR ${link.ref}`;
  return {
    kind: link.kind,
    icon: link.kind === 'ticket' ? 'ticket' : 'pr',
    text,
    href,
    label: href !== null && ref ? `${text}, ${ref.owner}/${ref.repo}` : undefined,
  };
}

/**
 * Tickets, pull requests, then sessions, each kind in order. A held matching card supplies the
 * current ticket destination, inserting it if omitted and deduplicating it.
 * A session links to the Spur UI at `spurUiOrigin` (`config.get` `web.spurUiOrigin`); a Jira
 * ticket links to `<ticketBrowseBase><key>` (`config.get` `projects[].ticketBrowseBase`) only when
 * its key has the Jira project prefix of `taskKey`, the open task; else it is plain.
 */
export function linkChips(
  links: readonly TaskLink[],
  taskKey: string,
  spurUiOrigin: string | null,
  ticketBrowseBase: string | null,
  row?: BoardRow,
): LinkChip[] {
  const current = row?.key === taskKey ? row : undefined;
  const all: readonly TaskLink[] =
    current === undefined || links.some((link) => link.kind === 'ticket' && link.ref === taskKey)
      ? links
      : [{ kind: 'ticket', ref: taskKey, role: null }, ...links];
  let seenCurrent = false;
  return KIND_ORDER.flatMap((kind) => all.filter((link) => link.kind === kind)).flatMap((link) => {
    const chip = linkChip(link, taskKey, spurUiOrigin, ticketBrowseBase);
    if (current === undefined || link.kind !== 'ticket' || link.ref !== taskKey) return [chip];
    if (seenCurrent) return [];
    seenCurrent = true;
    const href =
      quickLinks(current, spurUiOrigin, ticketBrowseBase).find((entry) => entry.kind === 'ticket')
        ?.href ?? null;
    return [{ ...chip, href, label: href === null ? undefined : chip.label }];
  });
}
