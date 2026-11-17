import type { BannerVariant, IconName, StatusDotTone } from '../ds/index.ts';
import type { Output } from '../lib/api.ts';
import type { BoardConfig, BoardSnapshot } from './data.ts';

export type BoardProject = BoardConfig['projects'][number];
type BoardColumnConfig = BoardProject['columns'][number];
export type BoardRow = Output<'status.get'>['tasks'][number];
type BoardSource = Output<'status.get'>['sources'][number];

export interface BoardColumn {
  id: string;
  /** Executor line: kind, then the named Spur project when there is one. */
  executor: string;
  /** Rows of this column in `status.get` order; none makes the column a spine. */
  rows: BoardRow[];
}

const executorLine = ({ executor }: BoardColumnConfig) =>
  executor.name === null ? executor.kind : `${executor.kind} ${executor.name}`;

/** Configured groups in `config.get` order; the screen handles unmatched rows separately. */
export function boardColumns(
  columns: readonly BoardColumnConfig[],
  rows: readonly BoardRow[],
): BoardColumn[] {
  const byId = new Map<string, BoardColumn>(
    columns.map((column) => [
      column.id,
      { id: column.id, executor: executorLine(column), rows: [] },
    ]),
  );
  for (const row of rows) byId.get(row.column)?.rows.push(row);
  return [...byId.values()];
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
interface BoardBanner {
  variant: BannerVariant;
  icon: IconName;
  text: string;
  detail?: string;
}

const sourceName = (source: BoardSource) => (source.source === 'spur' ? 'Spur' : source.source);
const sinceText = (source: BoardSource) =>
  source.lastCompleteAt === null
    ? 'has never completed a poll'
    : `has not answered since ${formatDataTime(Date.parse(source.lastCompleteAt))}`;

function blindBanner(sources: readonly BoardSource[]): BoardBanner | undefined {
  const blind = sources.filter(
    (source) => source.blindReason !== null || (source.stale && !source.warmingUp),
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
  if (snapshot.readFailed)
    list.push({
      variant: 'error',
      icon: 'x',
      text: 'The board daemon does not answer.',
      detail: `${data} Answers and comments cannot be sent.`,
    });
  else if (snapshot.stream === 'offline')
    list.push({ variant: 'error', icon: 'x', text: 'Live updates are lost.', detail: data });
  const blind = blindBanner(snapshot.status?.sources ?? []);
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
