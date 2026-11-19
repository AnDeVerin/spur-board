import { useLayoutEffect } from 'react';
import type { BoardData } from './data.ts';

/**
 * Sends in flight per board data's drafts and per task and turn: they outlive a closed task view,
 * so a reopened one sees an earlier send still running, and the reload stays held until the last
 * one settles.
 */
const SENDING = new WeakMap<BoardData['drafts'], Map<string, number>>();
const sendingOf = (drafts: BoardData['drafts']) => {
  let map = SENDING.get(drafts);
  if (map === undefined) {
    map = new Map();
    SENDING.set(drafts, map);
  }
  return map;
};

/** The draft id of one form: a reason belongs to its task, turn and form. */
const draftId = (taskKey: string, turn: string, form: 'submit' | 'return') =>
  JSON.stringify(['turn', taskKey, turn, form]);

/**
 * The Turn section's part in the board update guard, as `TaskWrite` reports its own. The open
 * form reports its unsent reason under its task, turn and form, so a reload after a board update
 * keeps it and only the same form of the same turn gets it back. A send holds the reload until its
 * promise settles, even when the task view closes first, so a reload never falls between the ack
 * and the close.
 */
export function useTurnDraft(
  drafts: BoardData['drafts'],
  taskKey: string,
  open: { turn: string; form: 'submit' | 'return' } | undefined,
  text: string,
) {
  const id = open === undefined ? undefined : draftId(taskKey, open.turn, open.form);
  useLayoutEffect(() => {
    if (id !== undefined) drafts.report(id, { text, busy: false });
  });
  useLayoutEffect(
    () => () => {
      if (id !== undefined) drafts.release(id);
    },
    [drafts, id],
  );
  return {
    /** The reason a reload kept for this form of this turn, else empty. */
    restored: (turn: string, form: 'submit' | 'return') =>
      drafts.restored(draftId(taskKey, turn, form)) ?? '',
    /** A send of `turn` is still in flight, from this view or one closed before. */
    sending: (turn: string) =>
      (sendingOf(drafts).get(JSON.stringify(['turn-send', taskKey, turn])) ?? 0) > 0,
    /** Hold a board update reload until `sending` and every other send of `turn` settle. */
    hold(turn: string, sending: Promise<unknown>) {
      const sendId = JSON.stringify(['turn-send', taskKey, turn]);
      const counts = sendingOf(drafts);
      counts.set(sendId, (counts.get(sendId) ?? 0) + 1);
      drafts.report(sendId, { text: '', busy: true });
      const release = () => {
        const left = (counts.get(sendId) ?? 1) - 1;
        if (left > 0) counts.set(sendId, left);
        else {
          counts.delete(sendId);
          drafts.release(sendId);
        }
      };
      sending.then(release, release);
    },
  };
}
