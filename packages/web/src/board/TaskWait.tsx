// The wait strip under the task view's link chips: the open turn's active wait, when the card
// shows one too, and the operator's End wait link on an agent's wait.
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, TextToggle } from '../ds/index.ts';
import { ProblemError } from '../lib/api.ts';
import { shownWait } from './card.ts';
import type { BoardData, BoardTask } from './data.ts';
import { BoardUnavailableError } from './intents.ts';
import { clockTime } from './model.ts';
import { until } from './task-model.ts';
import { REREAD_LIMIT_MS } from './turn-model.ts';
import styles from './TaskWait.module.css';

type Turn = NonNullable<BoardTask['turn']>;
type Wait = NonNullable<Turn['wait']>;
/** Where focus goes when a strip that holds it goes away. */
type Handoff = { current: HTMLElement | null };

/**
 * The strip of the shown wait, keyed by turn and wait start so each wait gets fresh state. Nothing
 * while the Turn section's re-read is stale or no agent holder waits. A strip that goes away while
 * it holds focus hands it to the `Why it is here` toggle after it, so focus never drops to the page.
 */
export function TaskWait({
  turn,
  now,
  stale,
  endWaitIntent,
  refreshTask,
  unavailable,
}: {
  turn: BoardTask['turn'];
  now: number;
  stale: boolean;
  endWaitIntent: BoardData['endWaitIntent'];
  refreshTask: BoardData['refreshTask'];
  /** Why writes cannot be sent now; undefined while they can. */
  unavailable: string | undefined;
}) {
  const handoff = useRef<HTMLElement | null>(null);
  // Runs after a removed strip's cleanup in the same commit, once the strip is gone.
  useLayoutEffect(() => {
    const target = handoff.current;
    handoff.current = null;
    if (target?.isConnected) target.focus();
  });
  const wait = turn === null ? undefined : shownWait(turn);
  if (stale || turn === null || wait === undefined) return null;
  return (
    <WaitStrip
      key={`${turn.id}:${wait.since}`}
      turn={turn}
      wait={wait}
      now={now}
      endWaitIntent={endWaitIntent}
      refreshTask={refreshTask}
      unavailable={unavailable}
      handoff={handoff}
    />
  );
}

type Phase = 'idle' | 'sending' | 'refreshing';

/**
 * `waiting: <reason> · wakes <hh:mm> (in 20m)`, named in full for assistive technology by the
 * label of an image role: an image's children are ignored, so the text is read once, and
 * browse-mode screen readers do not skip it as they can a labelled group with no readable
 * content. The relative time keeps the full text colour, as dimmed it falls below AA contrast.
 * On an agent's wait the `End wait` link follows the image, outside it, and ends the wait with no
 * confirmation; it stays busy until the task is re-read or `REREAD_LIMIT_MS` passes.
 */
function WaitStrip({
  turn,
  wait,
  now,
  endWaitIntent,
  refreshTask,
  unavailable,
  handoff,
}: {
  turn: Turn;
  wait: Wait;
  now: number;
  endWaitIntent: BoardData['endWaitIntent'];
  refreshTask: BoardData['refreshTask'];
  unavailable: string | undefined;
  handoff: Handoff;
}) {
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  // A call, so a check after an await is not narrowed by the one before it.
  const live = () => mounted.current;
  // The latest re-read's timer, for the unmount cleanup only.
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // One intent per strip: a retry reuses its key, and after a confirmed end only re-reads.
  const intent = useRef<ReturnType<BoardData['endWaitIntent']> | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ text: string; unavailable: boolean } | undefined>();
  useLayoutEffect(() => {
    const element = root.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(deadline.current);
      if (element?.contains(document.activeElement))
        handoff.current = element.nextElementSibling?.querySelector('button') ?? null;
    };
  }, [handoff]);
  const reread = () =>
    new Promise<boolean>((resolve) => {
      // Each re-read clears only its own timer: a late answer to an earlier one keeps a retry's.
      const timer = setTimeout(() => {
        resolve(false);
      }, REREAD_LIMIT_MS);
      deadline.current = timer;
      void refreshTask().then((read) => {
        clearTimeout(timer);
        resolve(read);
      });
    });
  const end = () => {
    setError(undefined);
    setPhase('sending');
    intent.current ??= endWaitIntent(turn.id);
    intent.current.run().then(
      async () => {
        if (!live()) return;
        setPhase('refreshing');
        const read = await reread();
        if (!live()) return;
        setPhase('idle');
        if (!read)
          setError({
            text: 'The wait ended, but the task could not be re-read.',
            unavailable: false,
          });
      },
      (cause: unknown) => {
        if (!live()) return;
        // Only daemon problems and the refusal have operator-facing text.
        const message =
          cause instanceof ProblemError || cause instanceof BoardUnavailableError
            ? cause.message
            : 'the request failed.';
        setPhase('idle');
        setError({
          text: `Could not end the wait: ${message}`,
          unavailable: cause instanceof BoardUnavailableError,
        });
      },
    );
  };
  const shownError = error?.unavailable && unavailable === undefined ? undefined : error;
  const text = `waiting: ${wait.reason} · wakes ${clockTime(wait.wakesAt)}`;
  const relative = `(${until(wait.wakesAt, now)})`;
  return (
    <div ref={root} className={styles.wait}>
      <div className={styles.strip}>
        <div role="img" aria-label={`${text} ${relative}`} className={styles.label}>
          <span className={styles.icon} aria-hidden="true">
            <Icon name="clock" />
          </span>
          <p className={styles.text} aria-hidden="true">
            {text} {relative}
          </p>
        </div>
        {turn.taken !== null && turn.taken.by !== 'operator' && (
          <TextToggle className={styles.end} busy={phase !== 'idle'} onClick={end}>
            {phase === 'idle' ? 'End wait' : 'Ending wait'}
            <span className={styles.hidden}> for {turn.id}</span>
          </TextToggle>
        )}
      </div>
      {shownError && (
        <p className={styles.error} role="alert">
          {shownError.text}
        </p>
      )}
    </div>
  );
}
