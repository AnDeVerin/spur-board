import { useLayoutEffect, useRef, useState } from 'react';
import type { BoardData } from './data.ts';

/**
 * The Turn section's part in the board update guard, as `TaskWrite` reports its own: `text` is
 * the unsent reason of the open form, kept across a reload after a board update, and `busy` holds
 * that reload while the ack and the close run, so it never leaves the operator holding a turn.
 * Returns a function that hands a kept reason to the first form opened, once.
 */
export function useTurnDraft(
  drafts: BoardData['drafts'],
  taskKey: string,
  text: string | undefined,
  busy: boolean,
): () => string {
  const draftId = JSON.stringify(['turn', taskKey]);
  const [restored] = useState(() => drafts.restored(draftId));
  const kept = useRef(restored);
  useLayoutEffect(() => {
    drafts.report(draftId, { text: text ?? kept.current ?? '', busy });
  });
  useLayoutEffect(
    () => () => {
      drafts.release(draftId);
    },
    [drafts, draftId],
  );
  return () => {
    const value = kept.current ?? '';
    kept.current = undefined;
    return value;
  };
}
