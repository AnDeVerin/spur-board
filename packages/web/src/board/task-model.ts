import type { KeyValueStatus } from '../ds/index.ts';
import { githubRef, taskLinkHref } from '../lib/links.ts';
import type { BoardTask } from './data.ts';
import { shortKey } from './model.ts';

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
  text: string;
  href: string | null;
  /** Accessible name of a link chip: the visible text, then the owner and repo. */
  label: string | undefined;
  /** Tooltip of a plain chip. */
  title: string | undefined;
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

/** Time in the task's column: since the last real move into it; none without such a move. */
export function timeInColumn(value: BoardTask, now: number): string | undefined {
  const move = value.why?.moves
    .filter((candidate) => candidate.to === value.task.column)
    .filter((candidate) => candidate.kind !== 'task_shadow_moved')
    .at(-1);
  return move === undefined ? undefined : age(move.at, now);
}

/** The gate of the column the dispatcher works from; undefined means the gate is unknown. */
function currentGate(why: TaskWhy | undefined): TaskGate | undefined {
  return why?.gates.find((gate) => gate.column === why.column);
}

/** The column after `why.column` when every one of its exit conditions is met; else none. */
export function nextColumn(
  why: TaskWhy | undefined,
  columns: readonly string[],
): string | undefined {
  const gate = currentGate(why);
  if (!why || !gate || gate.conditions.length === 0) return undefined;
  if (!gate.conditions.every((condition) => condition.state === 'met')) return undefined;
  const index = columns.indexOf(why.column);
  return index === -1 ? undefined : columns[index + 1];
}

const CONDITIONS: Record<string, string> = {
  pr_open: 'PR open',
  not_draft: 'Not a draft',
  checks_green: 'Checks green',
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

function turnRow(turn: BoardTask['turn'], now: number): WhyRow {
  if (turn === null) return { key: 'Open turn', value: 'none' };
  const key = `Open turn ${turn.id}`;
  if (turn.addressee === 'operator')
    return { key, value: `yours · open · ${age(turn.at, now)}`, status: 'wait' };
  const role = turn.addressee.split(':')[0] ?? turn.addressee;
  if (turn.taken)
    return {
      key,
      value: `${role} ${actorName(turn.taken.by)} · taken · ${age(turn.taken.at, now)}`,
    };
  return { key, value: `${role} unassigned · not taken · ${age(turn.at, now)}`, status: 'wait' };
}

const openBlocks = (value: BoardTask) => value.blocks.filter((block) => block.state === 'open');

/**
 * "Why it is here": the exit conditions of the `why.column` gate (or why they are unknown), each
 * hold, the open turn, the open blocks, and the next column when every condition is met.
 */
export function whyRows(value: BoardTask, columns: readonly string[], now: number): WhyRow[] {
  const { why } = value;
  const gate = currentGate(why);
  const rows: WhyRow[] = [];
  if (!why || !gate) rows.push({ key: 'Exit conditions unknown', status: 'unchecked' });
  else if (gate.conditions.length === 0) rows.push({ key: `No exit conditions in ${why.column}` });
  else rows.push(...gate.conditions.map(conditionRow));
  for (const hold of why?.holds ?? [])
    rows.push({ key: 'Hold', value: inWords(hold), status: 'wait' });
  rows.push(turnRow(value.turn, now));
  const blocks = openBlocks(value);
  rows.push(
    blocks.length > 0
      ? { key: 'Open blocks', value: blocks.map((block) => block.id).join(', '), status: 'fail' }
      : { key: 'Open blocks', value: 'none', status: 'pass' },
  );
  const next = nextColumn(why, columns);
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

function linkChip(link: TaskLink): LinkChip {
  const href = taskLinkHref(link);
  const ref = githubRef(link.ref);
  const text =
    link.kind === 'ticket'
      ? `ticket ${shortKey(link.ref)}`
      : link.kind === 'pr'
        ? ref
          ? `PR #${ref.number}`
          : `PR ${link.ref}`
        : `session ${link.ref}`;
  return {
    text,
    href,
    label: href !== null && ref ? `${text}, ${ref.owner}/${ref.repo}` : undefined,
    title: link.kind === 'session' ? `Spur session ${link.ref}` : undefined,
  };
}

/** One chip per `task.get` link: tickets, then pull requests, then sessions, each kind in order. */
export function linkChips(links: readonly TaskLink[]): LinkChip[] {
  return KIND_ORDER.flatMap((kind) => links.filter((link) => link.kind === kind)).map(linkChip);
}
