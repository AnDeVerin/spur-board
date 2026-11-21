// The notes under an open turn's line in the Turn section: the operator's hold, then the wait.
import { waitText } from './card.ts';
import type { BoardTask } from './data.ts';
import styles from './TaskTurn.module.css';

type Turn = NonNullable<BoardTask['turn']>;

/** Nothing while the re-read is pending or stale; else the hold note, then the wait note. */
export function TurnNotes({ turn, stale }: { turn: Turn; stale: boolean }) {
  if (stale) return null;
  return (
    <>
      {turn.taken?.by === 'operator' && (
        <p className={styles.note}>
          You hold {turn.id}; the orchestrator cannot submit or return it until you finish or it
          takes the turn back.
        </p>
      )}
      {turn.wait !== undefined && <p className={styles.wait}>{waitText(turn.wait)}</p>}
    </>
  );
}
