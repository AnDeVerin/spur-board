// The texts and field rules of the task view's Turn section (`TaskTurn.tsx`).
import { COLUMNS } from '@spur-board/contracts/browser';
import type { BoardTask } from './data.ts';
import { actorName } from './task-model.ts';
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
