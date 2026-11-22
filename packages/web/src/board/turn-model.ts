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
/** Shown in place of the holder when the re-read after a take or a close failed. */
export const STALE = 'Could not refresh the turn. Reload to see who holds it.';
/**
 * How long the re-read after a take or a close may run before the section treats it as failed;
 * the shared read coordinator has no deadline, and a later answer still clears the state.
 */
export const REREAD_LIMIT_MS = 15_000;
/** In a form whose close got no server answer: why its fields stay as sent. */
export const UNSETTLED = 'The earlier send may still land; send it again to settle it, or Cancel.';
/** Shown in place of the holder while that re-read runs. */
export const REFRESHING = 'Refreshing the turn…';
export const ARCHIVED = 'This task is archived. The turn cannot be closed.';
const NOTE =
  'You can close this turn yourself when the orchestrator is down or you have the verdict from elsewhere.';

/** The note of a turn addressed to the operator while the operator token does not hold it. */
const OPERATOR_NOTE = 'No agent takes this turn, so it is yours to close.';

/**
 * The notes under an open turn, split around the wait note: `lead` holds the hold line while the
 * operator token holds it, `rest` the note unless a form is open. An operator turn the token
 * holds shows its short hold line alone; one it does not hold leads with its own note.
 */
export function turnNotes(
  turn: NonNullable<BoardTask['turn']>,
  formOpen: boolean,
): { lead: string[]; rest: string[] } {
  const held = turn.taken?.by === 'operator';
  if (turn.addressee === 'operator') {
    if (held) return { lead: [`You hold ${turn.id}.`], rest: [] };
    return { lead: formOpen ? [] : [OPERATOR_NOTE], rest: [] };
  }
  const hold = `You hold ${turn.id}; the orchestrator cannot submit or return it until you finish or it takes the turn back.`;
  return { lead: held ? [hold] : [], rest: formOpen ? [] : [NOTE] };
}

/** The open turn the operator can close here: an orchestrator turn or one addressed to it. */
export const closable = (turn: BoardTask['turn']) =>
  turn?.addressee.startsWith('orchestrator:') === true || turn?.addressee === 'operator'
    ? turn
    : undefined;
function shaError(value: string, what: string): string | undefined {
  if (value === '') return `Enter ${what}.`;
  return SHA.test(value)
    ? undefined
    : 'Enter the full lowercase commit SHA: 40 to 64 characters, 0-9 and a-f.';
}
function reasonError(value: string, max: number): string | undefined {
  if (value.trim() === '') return 'Enter a reason.';
  return value.length > max
    ? `The reason must be ${max.toLocaleString('en-US')} characters or fewer.`
    : undefined;
}
export type FieldErrors = Partial<Record<'sha' | 'from' | 'reason', string | undefined>>;
/** The errors of a submit or return form's input, `sha` and `from` trimmed; none means send. */
export function fieldErrors(
  form: 'submit' | 'return',
  input: { sha: string; from: string; basis: Basis; reason: string },
): FieldErrors {
  const { sha, from, basis, reason } = input;
  if (form === 'return') return { reason: reasonError(reason, 20_000) };
  return {
    sha: shaError(sha, 'the commit you tested'),
    from: basis === 'carried' ? shaError(from, 'the commit the tested work comes from') : undefined,
    reason: basis === 'tested' ? undefined : reasonError(reason, 2000),
  };
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
 * The line above the submit button: what the submit closes and what it hands on, stated without
 * predicting the dispatcher. The board's gates decide where the task goes; the next enabled column
 * is named only as a fact of the configuration.
 */
export function submitConfirmation(
  turn: { id: string; column: string },
  columns: readonly Pick<BoardColumnConfig, 'id' | 'group'>[],
): string {
  const next = columnAfter(turn.column, columns);
  return `This closes ${turn.id} in your name and hands the task to the board's gates for ${turn.column}.${next === undefined ? '' : ` Next column: ${next}.`} It cannot be undone.`;
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

/** The closed notice's detail: how long ago the turn was submitted or returned. */
export function closedDetail(
  record: { closed: { at: string; outcome: string } | null } | undefined,
  now: number,
): string | undefined {
  if (!record?.closed) return undefined;
  const { at, outcome } = record.closed;
  if (outcome === 'submitted') return `Submitted ${age(at, now)} ago.`;
  return outcome === 'returned' ? `Returned to dev ${age(at, now)} ago.` : undefined;
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
    own: 'submitted' | 'returned' | undefined;
    /** The bound turn while it is still open. */
    open: SummaryTurn | undefined;
    record: { taken: { by: string } | null; closed: { outcome: string } | null } | undefined;
    refused: boolean;
  },
): string {
  if (state.inFlight) return `Closing ${id}…`;
  if (state.own) return `${id} ${state.own}`;
  const { open, record } = state;
  if (open === undefined) {
    const outcome = record?.closed?.outcome;
    if ((outcome === 'submitted' || outcome === 'returned') && record?.taken)
      return `${id} closed by ${brief(record.taken.by)}`;
    if (outcome === 'submitted' || outcome === 'returned') return `${id} closed by the board`;
    return outcome === undefined ? `${id} closed` : `${id} closed: ${OUTCOME[outcome] ?? outcome}`;
  }
  if (state.refused)
    // `open` carries the effective holder (`withOwnHold`): the ack's hold until a read shows otherwise.
    return `${id} · refused${open.taken?.by === 'operator' ? ', you hold it' : ''}`;
  return openSummary(open);
}
