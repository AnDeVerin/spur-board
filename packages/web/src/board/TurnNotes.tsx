// The notes under an open turn's line in the Turn section: the operator's hold or the operator
// turn note, then the wait, then the close note.
import { waitText } from './card.ts';
import type { BoardTask } from './data.ts';
import { turnNotes } from './turn-model.ts';
import styles from './TaskTurn.module.css';

type Turn = NonNullable<BoardTask['turn']>;

/** Nothing while the re-read is pending or stale; else the lead notes, the wait, the rest. */
export function TurnNotes({
  turn,
  stale,
  formOpen,
}: {
  turn: Turn;
  stale: boolean;
  formOpen: boolean;
}) {
  if (stale) return null;
  const { lead, rest } = turnNotes(turn, formOpen);
  const note = (text: string) => (
    <p key={text} className={styles.note}>
      {text}
    </p>
  );
  return (
    <>
      {lead.map(note)}
      {turn.wait !== undefined && <p className={styles.wait}>{waitText(turn.wait)}</p>}
      {rest.map(note)}
    </>
  );
}
