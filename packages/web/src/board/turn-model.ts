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
export const OUTCOME: Record<string, string> = {
  moved: 'the task was moved',
  corrected: 'the column was corrected',
  rerouted: 'the turn went to another executor',
  mode_changed: 'the dispatcher mode changed',
  archived: 'the task was archived',
};
const BRIEF_MAX = 16;
/** What follows `T<n> submitted.` on the own-close line, by `ownSubmitState`. */
export const OWN_SUBMIT = {
  pending: ' The board confirms the head on its next polls.',
  voided:
    ' The board voided this submission: it no longer counts for the gates, so the work needs another submit.',
  counted: '',
} as const;
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
export function brief(actor: string): string {
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
      ? `the task stays in ${turn.column} until it completes: a merged pull request or a done ticket`
      : `the task moves to ${next}`;
  return `This closes ${turn.id} in your name and the board re-evaluates the task's gates. If they hold, ${outcome}.${unmet ? ' Some exit conditions do not hold now, so the task may wait, or move back to a column whose gate fails.' : ''} It cannot be undone.`;
}

type Submission = NonNullable<BoardTask['submission']>;
/**
 * The detail of a submit that closed turn `closed` elsewhere. `task.get` lists only the task's
 * latest submission, which carries no turn: its basis and SHA are shown only when it was made in
 * the turn's column at the moment the turn closed, as one submit writes both.
 */
export function closedSubmitDetail(
  submission: Submission | null | undefined,
  closed: { column: string; closed: { at: string } | null },
  now: number,
): string | undefined {
  if (closed.closed === null) return undefined;
  const at = closed.closed.at;
  if (
    submission &&
    submission.column === closed.column &&
    Date.parse(submission.at) === Date.parse(at)
  )
    return `Submitted ${submission.basis}, ${submission.sha.slice(0, 7)}, ${age(at, now)} ago.`;
  return `Submitted ${age(at, now)} ago.`;
}

/**
 * What became of an own submit of `sha` in `column`: the latest submission tells once a read
 * shows it, `voided` when it no longer counts for the gates; before that, the write's answer does.
 */
export function ownSubmitState(
  submission: Submission | null | undefined,
  own: { sha: string; column: string; pending: boolean },
): 'pending' | 'voided' | 'counted' {
  const matched =
    submission && submission.sha === own.sha && submission.column === own.column
      ? submission
      : undefined;
  if (matched?.voided === true) return 'voided';
  return (matched?.pending ?? own.pending) ? 'pending' : 'counted';
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
