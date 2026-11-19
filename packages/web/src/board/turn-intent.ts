import { createMutationIntent, ProblemError, type createApi } from '../lib/api.ts';

/** The step a turn write is on: taking the turn through `inbox.ack`, then closing it. */
export type TurnPhase = 'taking' | 'closing';
/** A landed close: the task's column in the write's answer, and the re-read it started. */
export interface TurnClosed {
  column: string;
  refresh: Promise<boolean>;
}
type TurnWrite =
  | { id: 'task.submit'; input: Parameters<typeof createMutationIntent<'task.submit'>>[2] }
  | { id: 'task.return'; input: Parameters<typeof createMutationIntent<'task.return'>>[2] };

/**
 * Take turn `turn` with `inbox.ack`, then close it with the write; each step owns one idempotent
 * intent, so an unchanged resend reuses both keys. A confirmed ack is not sent again, nor one for a
 * turn `held` says the operator already holds, except after `not_turn_taker`: someone took the
 * turn back, so the next run takes it again with a new key.
 * `refused` names why the board cannot send now; `refresh` re-reads the task after the close.
 */
export function createTurnIntent(options: {
  api: ReturnType<typeof createApi>;
  turn: string;
  write: TurnWrite;
  held: boolean;
  refused: () => string | undefined;
  refresh: () => Promise<boolean>;
}) {
  const { api, turn, write } = options;
  const takeIntent = () => createMutationIntent(api, 'inbox.ack', { entries: [{ id: turn }] });
  let take = takeIntent();
  let taken = options.held;
  const close =
    write.id === 'task.submit'
      ? createMutationIntent(api, 'task.submit', write.input)
      : createMutationIntent(api, 'task.return', write.input);
  let pending: Promise<TurnClosed> | undefined;
  let confirmed: TurnClosed | undefined;
  const run = async (onPhase: (phase: TurnPhase) => void): Promise<TurnClosed> => {
    if (!taken) {
      onPhase('taking');
      await take.run();
      taken = true;
    }
    onPhase('closing');
    try {
      const result = await close.run();
      confirmed = { column: result.task.column, refresh: options.refresh() };
      return confirmed;
    } catch (error) {
      if (error instanceof ProblemError && error.code === 'not_turn_taker') {
        taken = false;
        take = takeIntent();
      }
      throw error;
    }
  };
  return {
    /** Send, or join the send in flight; a landed close answers at once. */
    run(onPhase: (phase: TurnPhase) => void): Promise<TurnClosed> {
      if (confirmed) return Promise.resolve(confirmed);
      if (pending) return pending;
      const reason = options.refused();
      if (reason !== undefined) return Promise.reject(new Error(reason));
      pending = run(onPhase).finally(() => {
        pending = undefined;
      });
      return pending;
    },
    /** The ack landed and no `not_turn_taker` undid it since. */
    taken: () => taken,
  };
}
export type TurnIntent = ReturnType<typeof createTurnIntent>;
