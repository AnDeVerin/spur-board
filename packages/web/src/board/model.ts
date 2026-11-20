import type { BannerVariant, IconName, StatusDotTone } from '../ds/index.ts';
import type { Output } from '../lib/api.ts';
import type { BoardConfig, BoardSnapshot } from './data.ts';

export type BoardProject = BoardConfig['projects'][number];
export type BoardColumnConfig = BoardProject['columns'][number];
export type BoardRow = Output<'status.get'>['tasks'][number];
type BoardSource = Output<'status.get'>['sources'][number];
type BoardGroup = NonNullable<BoardColumnConfig['group']>;
type PartSource = NonNullable<BoardColumnConfig['source']>;
/** A part the board fills from a GitHub Project field. */
export type MirrorSource = Extract<PartSource, { kind: 'mirror' }>;

export interface BoardColumn {
  id: BoardColumnConfig['id'];
  /** `config.get` group of a Todo-group column, else null. */
  group: BoardGroup | null;
  /** Executor line: kind, then the named Spur project when there is one. */
  executor: string;
  /** `config.get` executor kind; the head picks its actor icon from it. */
  kind: BoardColumnConfig['executor']['kind'];
  /** Rows of this column in `status.get` order, before `sortRows`; none makes it a spine. */
  rows: BoardRow[];
  /** `config.get` source of a Todo-group column; manual when the config view has none. */
  source: PartSource;
  /** `status.get` source of a mirrored part, when the read lists it; it tells why it is blind. */
  read: BoardSource | undefined;
}

const MANUAL: PartSource = { kind: 'manual' };

const executorLine = ({ executor }: BoardColumnConfig) =>
  executor.name === null ? executor.kind : `${executor.kind} ${executor.name}`;

/** Source id of a project's mirror in `status.get`, as core names it. */
const mirrorSourceId = (project: string | undefined, mirror: MirrorSource) =>
  `github-project:${project ?? ''}:${mirror.project.toLowerCase()}`;

/**
 * Configured groups in `config.get` order; the screen handles unmatched rows separately. A
 * mirrored part takes its source from `status` sources of `project`.
 */
export function boardColumns(
  columns: readonly BoardColumnConfig[],
  rows: readonly BoardRow[],
  status: { project: string | undefined; sources: readonly BoardSource[] } = {
    project: undefined,
    sources: [],
  },
): BoardColumn[] {
  const readOf = (source: PartSource) =>
    source.kind === 'mirror'
      ? status.sources.find(
          (candidate) => candidate.source === mirrorSourceId(status.project, source),
        )
      : undefined;
  const byId = new Map<string, BoardColumn>(
    columns.map((column) => [
      column.id,
      {
        id: column.id,
        group: column.group ?? null,
        executor: executorLine(column),
        kind: column.executor.kind,
        rows: [],
        source: column.source ?? MANUAL,
        read: readOf(column.source ?? MANUAL),
      },
    ]),
  );
  for (const row of rows) byId.get(row.column)?.rows.push(row);
  return [...byId.values()];
}

const GROUP_LABELS: Record<BoardGroup, string> = { todo: 'Backlog' };

/** Where a group part's tasks come from, on the second line of its head. */
export const partSource = ({ source }: Pick<BoardColumn, 'source'>) =>
  source.kind === 'mirror' ? `mirror · ${source.name}` : 'manual';

/** The mirror of a part whose last read failed: its tasks stay where they were until it reads. */
export const mirrorFrozen = ({ source }: Pick<BoardColumn, 'source'>): MirrorSource | undefined =>
  source.kind === 'mirror' && source.health === 'failing' ? source : undefined;

/**
 * Why a mirror is not readable: the failure of its last read, else why its source is blind, as a
 * stale source after a successful poll; then a rate-budget wait. Unknown, it claims no failure.
 */
function frozenCause(mirror: MirrorSource, read: BoardSource | undefined): string {
  const cause =
    mirror.error !== undefined
      ? `${mirror.error.message}.`
      : read?.blindReason != null
        ? `${read.message ?? `The source is blind: ${read.blindReason}`}.`
        : 'The mirror has no usable read.';
  return read?.waitsForBudget === true ? `${cause} Polls wait for the GitHub rate budget.` : cause;
}

/** The cause line of a frozen mirror: why it is not readable, its last complete read, the outcome. */
export function frozenDetail(mirror: MirrorSource, { read }: Pick<BoardColumn, 'read'>): string {
  const cause = frozenCause(mirror, read);
  const last =
    mirror.readAt === null
      ? 'No complete read yet.'
      : `Last complete read ${formatDataTime(Date.parse(mirror.readAt))}.`;
  return `${cause} ${last} Tasks stay where they were.`;
}

/**
 * Why a move from part `from` to part `to` is refused: either end is a mirrored part, whose tasks
 * move only in the tracker. The text follows the `column_mirrored` hint; undefined when allowed.
 */
export function mirrorRefusal(
  parts: readonly { id: string; source?: PartSource | undefined }[],
  from: string,
  to: string,
): string | undefined {
  for (const id of [to, from]) {
    const source = parts.find((part) => part.id === id)?.source;
    if (source?.kind === 'mirror')
      return `${id} mirrors GitHub Project "${source.name}". Change the task status there instead.`;
  }
  return undefined;
}

/** One board item: a plain column, or a group band over its parts. */
type BoardItem =
  | { kind: 'column'; column: BoardColumn }
  | { kind: 'group'; id: BoardGroup; label: string; parts: BoardColumn[] };

/** Columns in order, with each run of two or more adjacent columns of one group as one group. */
export function boardLayout(columns: readonly BoardColumn[]): BoardItem[] {
  const items: BoardItem[] = [];
  for (const column of columns) {
    const last = items.at(-1);
    const previous = last?.kind === 'group' ? last.parts.at(-1) : last?.column;
    const { group } = column;
    if (group === null || previous === undefined || previous.group !== group)
      items.push({ kind: 'column', column });
    else if (last?.kind === 'group') last.parts.push(column);
    else
      items[items.length - 1] = {
        kind: 'group',
        id: group,
        label: GROUP_LABELS[group],
        parts: [previous, column],
      };
  }
  return items;
}

/** How a column orders its rows: by the time in the column or by key, ascending or descending. */
export type ColumnSort = 'entered-asc' | 'entered-desc' | 'key-asc' | 'key-desc';
/** Longest in the column first: the order each column starts in. */
export const FIRST_SORT: ColumnSort = 'entered-asc';
const SORTS: readonly string[] = ['entered-asc', 'entered-desc', 'key-asc', 'key-desc'];
export const isColumnSort = (value: unknown): value is ColumnSort =>
  typeof value === 'string' && SORTS.includes(value);

const collator = new Intl.Collator('en', { numeric: true });

/**
 * A sorted copy of `rows`. Keys compare in full with numbers as numbers, so `#9` comes before
 * `#10`; rows with no time in the column come last in both time orders; ties keep input order.
 */
export function sortRows(rows: readonly BoardRow[], sort: ColumnSort): BoardRow[] {
  const sign = sort.endsWith('-desc') ? -1 : 1;
  if (sort.startsWith('key'))
    return [...rows].sort((a, b) => sign * collator.compare(a.key, b.key));
  const timed = rows.filter((row) => row.columnEnteredAt !== null);
  const at = (row: BoardRow) => Date.parse(row.columnEnteredAt ?? '');
  return [
    ...timed.sort((a, b) => sign * (at(a) - at(b))),
    ...rows.filter((row) => row.columnEnteredAt === null),
  ];
}

/** The `?open=` URL the task and inbox panels will read; the board only writes it. */
export const openHref = (value: string) => `?open=${encodeURIComponent(value)}`;

/** A key ending in a hash and a number reads as that ending; any other key, such as Jira's, stays. */
export function shortKey(key: string): string {
  return /#\d+$/.exec(key)?.[0] ?? key;
}

/** Filter text matches the full key, the short key, a session id or a block id; none matches all. */
export function matchesFilter(row: BoardRow, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === '') return true;
  return [
    row.key,
    shortKey(row.key),
    ...row.links.sessions.map((session) => session.id),
    ...row.blocks.map((block) => block.id),
  ].some((value) => value.toLowerCase().includes(needle));
}

const pad = (value: number) => String(value).padStart(2, '0');

/** UTC `hh:mm dd/mm/yy`, as the prototype and History write times. */
export function formatDataTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} ${pad(date.getUTCDate())}/${pad(
    date.getUTCMonth() + 1,
  )}/${pad(date.getUTCFullYear() % 100)}`;
}

/** An error banner offers Retry now. */
export interface BoardBanner {
  variant: BannerVariant;
  icon: IconName;
  text: string;
  detail?: string;
  /** `reload`: the banner's button reloads the page instead of Retry now. */
  action?: 'reload';
}

const sourceName = (source: BoardSource) => (source.source === 'spur' ? 'Spur' : source.source);
const sinceText = (source: BoardSource) =>
  source.lastCompleteAt === null
    ? 'has never completed a poll'
    : `has not answered since ${formatDataTime(Date.parse(source.lastCompleteAt))}`;

/**
 * The source of the chosen project's mirror when its Backlog part shows the frozen notice. With
 * no tasks the board shows its empty message instead of columns, so no notice names it.
 */
function noticedMirror(snapshot: BoardSnapshot): string | undefined {
  if (snapshot.status === undefined || snapshot.status.tasks.length === 0) return undefined;
  for (const column of chosenProject(snapshot)?.columns ?? []) {
    const mirror =
      column.group === undefined ? undefined : mirrorFrozen({ source: column.source ?? MANUAL });
    if (mirror !== undefined) return mirrorSourceId(snapshot.project, mirror);
  }
  return undefined;
}

/**
 * Blind or stale sources of the chosen project and the shared spur; other projects' are left out,
 * and so is the source `noticed`, which a frozen Backlog notice names instead.
 */
function blindBanner(
  sources: readonly BoardSource[],
  project: string | undefined,
  noticed: string | undefined,
): BoardBanner | undefined {
  const blind = sources.filter(
    (source) =>
      (source.project === null || source.project === project) &&
      source.source !== noticed &&
      (source.blindReason !== null || (source.stale && !source.warmingUp)),
  );
  const [first] = blind;
  if (first === undefined) return undefined;
  if (blind.length === 1)
    return {
      variant: 'warning',
      icon: 'clock',
      text: `${sourceName(first)} ${sinceText(first)}.`,
      detail:
        first.source === 'spur'
          ? 'Session states may be out of date.'
          : 'Its facts may be out of date.',
    };
  const times = blind.flatMap((source) =>
    source.lastCompleteAt === null ? [] : [Date.parse(source.lastCompleteAt)],
  );
  return {
    variant: 'warning',
    icon: 'clock',
    text: `${String(blind.length)} sources have not answered: ${blind.map(sourceName).join(', ')}.`,
    detail:
      times.length === 0
        ? 'None has completed a poll.'
        : `The oldest answer is from ${formatDataTime(Math.min(...times))}.`,
  };
}

/** The project `snapshot.project` names in the last good config. */
export const chosenProject = (snapshot: BoardSnapshot): BoardProject | undefined =>
  snapshot.config?.projects.find((project) => project.id === snapshot.project);

/** Banners that apply, ordered error, warning, info. */
export function banners(snapshot: BoardSnapshot): BoardBanner[] {
  const list: BoardBanner[] = [];
  const data =
    snapshot.lastGoodAt === undefined
      ? 'No data yet.'
      : `The board shows data from ${formatDataTime(snapshot.lastGoodAt)}.`;
  const { update } = snapshot;
  if (update?.mode === 'blocked')
    list.push({
      variant: 'error',
      icon: 'x',
      text: `The board was updated to ${update.version}. Reload to continue.`,
      detail: [
        update.keepsDrafts ? '' : 'Unsent text cannot be kept: copy it before reloading.',
        data,
        snapshot.readFailed ? 'Answers and comments cannot be sent.' : '',
      ]
        .filter((part) => part !== '')
        .join(' '),
      action: 'reload',
    });
  else if (snapshot.readFailed)
    list.push({
      variant: 'error',
      icon: 'x',
      text: snapshot.unreadable
        ? "The board daemon's answer could not be read."
        : 'The board daemon does not answer.',
      detail: `${data} Answers and comments cannot be sent.`,
    });
  else if (snapshot.stream === 'offline')
    list.push({ variant: 'error', icon: 'x', text: 'Live updates are lost.', detail: data });
  const blind = blindBanner(
    snapshot.status?.sources ?? [],
    snapshot.project,
    noticedMirror(snapshot),
  );
  if (blind) list.push(blind);
  if (chosenProject(snapshot)?.dispatcher.mode === 'shadow')
    list.push({
      variant: 'info',
      icon: 'shadow',
      text: 'Shadow mode: the board computes columns and turns but does not act.',
    });
  return list;
}

/** Header indicator: `connecting` until the first hello, then the stream state. */
export function indicator(snapshot: BoardSnapshot): { tone: StatusDotTone; word: string } {
  if (!snapshot.everLive) return { tone: 'warn', word: 'connecting' };
  if (snapshot.stream === 'live') return { tone: 'ok', word: 'live' };
  if (snapshot.stream === 'reconnecting') return { tone: 'warn', word: 'reconnecting' };
  return { tone: 'error', word: 'offline' };
}
