// The texts and field rules of the task view's Turn section (`TaskTurn.tsx`).
import { COLUMNS } from '@spur-board/contracts/browser';
import type { BoardTask } from './data.ts';
import type { BoardColumnConfig } from './model.ts';
import { actorName, age, columnAfter } from './task-model.ts';
import type { TurnPhase } from './turn-intent.ts';

export type Basis = 'tested' | 'carried' | 'skipped';
export const BASIS_ID = 'turn-basis';
export const BASES = [
  { value: 'tested', label: 'Tested' },
  { value: 'carried', label: 'Carried' },
  { value: 'skipped', label: 'Skipped' },
];
export const isBasis = (value: string): value is Basis =>
  BASES.some((basis) => basis.value === value);
const SHA = /^[0-9a-f]{40,64}$/;
export const RETURNABLE = new Set<string>(
  COLUMNS.filter((column) => column.returnable).map((column) => column.id),
);
export const PHASE: Record<TurnPhase, string> = {
  taking: 'Taking the turn',
  closing: 'Closing the turn',
};
/** A close by anything but a submit or a return names no closer: the read does not know one. */
const OUTCOME: Record<string, string> = {
  moved: 'the task was moved',
  corrected: 'the column was corrected',
  rerouted: 'the turn went to another executor',
  mode_changed: 'the dispatcher mode changed',
  archived: 'the task was archived',
};
const BRIEF_MAX = 16;
export const UNAVAILABLE = 'The turn cannot be closed while the board is unavailable.';
export const ARCHIVED = 'This task is archived. The turn cannot be closed.';
export const NOTE =
  'You can close this turn yourself when the orchestrator is down or you have the verdict from elsewhere.';

export const orchestrated = (turn: BoardTask['turn']) =>
  turn?.addressee.startsWith('orchestrator:') ? turn : undefined;
export function shaError(value: string, what: string): string | undefined {
  if (value === '') return `Enter ${what}.`;
  return SHA.test(value)
    ? undefined
    : 'Enter the full lowercase commit SHA: 40 to 64 characters, 0-9 and a-f.';
}
export function reasonError(value: string, max: number): string | undefined {
  if (value.trim() === '') return 'Enter a reason.';
  return value.length > max
    ? `The reason must be ${max.toLocaleString('en-US')} characters or fewer.`
    : undefined;
}

/**
 * The fold summary names an actor by its session alone, cut to `BRIEF_MAX` characters, so a long
 * session id leaves the section title room; the turn line and the notice keep the full name.
 */
function brief(actor: string): string {
  const short = actor === 'operator' ? 'you' : actorName(actor);
  return short.length > BRIEF_MAX ? `${short.slice(0, BRIEF_MAX - 1)}…` : short;
}

/**
 * Where a passing submit sends the task: the next enabled column, or none when the turn is in
 * Done, is the last enabled column, or the next one is Done. The dispatcher never moves a task
 * into Done on a passing gate; only completion does (`nextColumn` and `COMPLETION_RULE` in
 * `packages/core/src/domain/dispatch.ts`).
 */
export function submitMove(
  column: string,
  columns: readonly Pick<BoardColumnConfig, 'id' | 'group'>[],
): string | undefined {
  if (column === 'done') return undefined;
  const next = columnAfter(column, columns);
  return next === 'done' ? undefined : next;
}

/**
 * The line above the submit button. A submit closes the turn and the board re-evaluates every
 * gate: `next` is where the task goes if they hold; `unmet` says some do not hold now, so the task
 * may wait, or move back to an earlier column whose gate fails.
 */
export function submitConfirmation(
  turn: { id: string; column: string },
  next: string | undefined,
  unmet: boolean,
): string {
  if (turn.column === 'done')
    return `This closes ${turn.id} in your name; the task stays in done. It cannot be undone.`;
  const outcome =
    next === undefined
      ? `the task stays in ${turn.column} until the board's completion rule moves it to done`
      : `the task moves to ${next}`;
  return `This closes ${turn.id} in your name and the board re-evaluates the task's gates. If they hold, ${outcome}.${unmet ? ' Some exit conditions do not hold now, so the task may wait, or move back to a column whose gate fails.' : ''} It cannot be undone.`;
}

type Submission = NonNullable<BoardTask['submission']>;
/** A closed turn as `task.get` detail lists it. */
type ClosedTurn = { column: string; closed: { at: string } | null };
/**
 * The task's latest submission when it is the submit that closed `turn`. `task.get` lists only
 * the latest submission and it carries no turn, but one submit writes the submission and closes
 * the turn at the same instant, in the turn's column.
 */
function closingSubmission(
  submission: Submission | null | undefined,
  turn: ClosedTurn | undefined,
): Submission | undefined {
  if (!submission || !turn?.closed) return undefined;
  return submission.column === turn.column &&
    Date.parse(submission.at) === Date.parse(turn.closed.at)
    ? submission
    : undefined;
}

/** The detail of a submit that closed `closed` elsewhere: its basis and SHA when the read ties them. */
function closedSubmitDetail(
  submission: Submission | null | undefined,
  closed: ClosedTurn,
  now: number,
): string | undefined {
  if (closed.closed === null) return undefined;
  const at = closed.closed.at;
  const own = closingSubmission(submission, closed);
  return own
    ? `Submitted ${own.basis}, ${own.sha.slice(0, 7)}, ${age(at, now)} ago.`
    : `Submitted ${age(at, now)} ago.`;
}

/** The closed notice's main line: who closed the turn for a submit or a return, else how. */
export function closedNotice(
  id: string,
  closer: string | undefined,
  outcome: string | undefined,
): string {
  if (closer !== undefined) return `${id} was closed by ${closer}`;
  return outcome === undefined
    ? `${id} was closed`
    : `${id} was closed: ${OUTCOME[outcome] ?? outcome}`;
}

/** The closed notice's detail: the submit that closed the turn, or how long ago it returned. */
export function closedDetail(
  submission: Submission | null | undefined,
  record: (ClosedTurn & { closed: { at: string; outcome: string } | null }) | undefined,
  now: number,
): string | undefined {
  if (!record?.closed) return undefined;
  if (record.closed.outcome === 'submitted') return closedSubmitDetail(submission, record, now);
  return record.closed.outcome === 'returned'
    ? `Returned to dev ${age(record.closed.at, now)} ago.`
    : undefined;
}

/** The section's own close of a turn, by submit or return. */
export interface OwnClose {
  outcome: 'submitted' | 'returned';
  pending: boolean;
  sha: string;
  /** How the submit settled once a read showed it, kept after a later one replaces it. */
  seen: SettledSubmit | undefined;
}

/** A settled own submit: the Board confirmed it, or voided it. */
export type SettledSubmit = 'counted' | 'voided';
/** How the submission that closed `turn` settled, once a read shows it; none while it waits. */
export function settledSubmit(
  submission: Submission | null | undefined,
  turn: ClosedTurn | undefined,
): SettledSubmit | undefined {
  const matched = closingSubmission(submission, turn);
  if (matched === undefined || (matched.pending && !matched.voided)) return undefined;
  return matched.voided ? 'voided' : 'counted';
}

/**
 * What follows `T<n> submitted.` on the own-close line. The submission that closed the turn tells
 * how it went once a read shows it; `seen` keeps how it settled after a later submission replaces
 * it. A replaced submission, or a task that left the column, waits for nothing, so only the
 * write's own answer, before any of that, says the Board still confirms the head. A voided one
 * asks for another submit only when the Board handed the work back: the task is in Dev or a
 * worker turn is open; a pull request merged at another head can void it and still end in Done.
 */
export function ownSubmitNote(
  value: BoardTask,
  turn: { column: string },
  record: ClosedTurn | undefined,
  own: { pending: boolean; seen: SettledSubmit | undefined },
): string {
  const matched = closingSubmission(value.submission, record);
  const replaced = record?.closed != null && value.submission != null && matched === undefined;
  const state =
    settledSubmit(value.submission, record) ??
    (matched !== undefined ? 'pending' : own.seen) ??
    (replaced || value.task.column !== turn.column || !own.pending ? 'counted' : 'pending');
  if (state === 'pending') return ' The board confirms the head on its next polls.';
  if (state === 'counted') return '';
  const handedBack = value.task.column === 'dev' || value.turn?.addressee === 'worker';
  return ` The board voided this submission: it no longer counts for the gates.${handedBack ? ' The work went back to Dev and needs another submit.' : ''}`;
}

/**
 * The Commit field's start: the head of the task's only open pull request in the chosen
 * project's status row, else the head `task.get` why stored when `turn` opened (it may be stale;
 * the field stays editable and the server refuses a wrong head with `head_mismatch`).
 */
export function commitDefault(
  row: { prs?: readonly { state: string; headSha: string }[] | undefined } | undefined,
  why: BoardTask['why'],
  turn: string,
): string {
  const prs = row?.prs?.filter((pr) => pr.state === 'open') ?? [];
  const only = prs.length === 1 ? prs[0]?.headSha : undefined;
  return only ?? (why?.turn?.id === turn ? (why.turn.head ?? '') : '');
}

/**
 * An enabled gate of the task has an unmet exit condition other than the submit or review on the
 * head, which the submit itself provides.
 */
export function otherConditionsUnmet(why: BoardTask['why']): boolean {
  return (
    why?.gates.some(
      (gate) =>
        gate.enabled &&
        gate.conditions.some(
          (condition) =>
            condition.state !== 'met' &&
            condition.condition !== 'submit_on_head' &&
            condition.condition !== 'review_on_head',
        ),
    ) ?? false
  );
}

/** The fields of the submit form, kept together in its draft. */
export interface SubmitFields {
  sha: string;
  basis: Basis;
  from: string;
  reason: string;
}
/**
 * The draft text of a form: a return keeps its reason; a submit keeps commit, basis, source and
 * reason together, so a resumed Skipped or Carried draft never comes back as Tested. A submit with
 * no source and no reason typed has nothing unsent.
 */
export function draftText(form: 'submit' | 'return', fields: SubmitFields): string {
  if (form === 'return') return fields.reason;
  return fields.from === '' && fields.reason === '' ? '' : JSON.stringify(fields);
}
/** The fields a form opens with from its kept draft text; `sha` starts the commit without one. */
export function restoreDraft(form: 'submit' | 'return', text: string, sha: string): SubmitFields {
  const empty: SubmitFields = { sha, basis: 'tested', from: '', reason: '' };
  if (form === 'return') return { ...empty, reason: text };
  if (text === '') return empty;
  try {
    const kept: unknown = JSON.parse(text);
    if (typeof kept !== 'object' || kept === null) return empty;
    const field = (name: string) => {
      const value: unknown = (kept as Record<string, unknown>)[name];
      return typeof value === 'string' ? value : undefined;
    };
    const basis = field('basis');
    return {
      sha: field('sha') ?? sha,
      basis: basis !== undefined && isBasis(basis) ? basis : 'tested',
      from: field('from') ?? '',
      reason: field('reason') ?? '',
    };
  } catch {
    return empty;
  }
}

type SummaryTurn = NonNullable<BoardTask['turn']>;
/** The fold summary of an open turn: who holds it, with the taker's session cut short. */
export function openSummary(turn: SummaryTurn): string {
  if (turn.taken === null) return `${turn.id} · not taken`;
  return turn.taken.by === 'operator'
    ? `${turn.id} · you hold it`
    : `${turn.id} · taken by ${brief(turn.taken.by)}`;
}

/**
 * The fold summary of the bound turn `id`: closing while a send runs, the own close, how it closed
 * elsewhere (the taker named for a submit or a return), a refusal, else as an open turn.
 */
export function boundSummary(
  id: string,
  state: {
    inFlight: boolean;
    own: OwnClose | undefined;
    /** The bound turn while it is still open. */
    open: SummaryTurn | undefined;
    record: { taken: { by: string } | null; closed: { outcome: string } | null } | undefined;
    refused: boolean;
    /** This section's ack landed. */
    held: boolean;
  },
): string {
  if (state.inFlight) return `Closing ${id}…`;
  if (state.own) return `${id} ${state.own.outcome}`;
  const { open, record } = state;
  if (open === undefined) {
    const outcome = record?.closed?.outcome;
    if ((outcome === 'submitted' || outcome === 'returned') && record?.taken)
      return `${id} closed by ${brief(record.taken.by)}`;
    if (outcome === 'submitted' || outcome === 'returned') return `${id} closed by the board`;
    return outcome === undefined ? `${id} closed` : `${id} closed: ${OUTCOME[outcome] ?? outcome}`;
  }
  if (state.refused)
    return `${id} · refused${state.held || open.taken?.by === 'operator' ? ', you hold it' : ''}`;
  return openSummary(open);
}
