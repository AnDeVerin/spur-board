// The wait strip under the task view's link chips: the open turn's active wait, when the card
// shows one too.
import { Icon } from '../ds/index.ts';
import { shownWait } from './card.ts';
import type { BoardTask } from './data.ts';
import { clockTime } from './model.ts';
import { until } from './task-model.ts';
import styles from './TaskWait.module.css';

/**
 * `waiting: <reason> · wakes <hh:mm> (in 20m)`, named in full for assistive technology by the
 * label of an image role: an image's children are ignored, so the text is read once, and
 * browse-mode screen readers do not skip it as they can a labelled group with no readable
 * content. The relative time keeps the full text colour, as dimmed it falls below AA contrast.
 * Nothing while
 * the Turn section's re-read is stale or no agent holder waits; the right end stays free for an
 * action.
 */
export function TaskWait({
  turn,
  now,
  stale,
}: {
  turn: BoardTask['turn'];
  now: number;
  stale: boolean;
}) {
  const wait = turn === null ? undefined : shownWait(turn);
  if (stale || wait === undefined) return null;
  const text = `waiting: ${wait.reason} · wakes ${clockTime(wait.wakesAt)}`;
  const relative = `(${until(wait.wakesAt, now)})`;
  return (
    <div role="img" aria-label={`${text} ${relative}`} className={styles.strip}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name="clock" />
      </span>
      <p className={styles.text} aria-hidden="true">
        {text} {relative}
      </p>
    </div>
  );
}
