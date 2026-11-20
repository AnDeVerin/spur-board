import { ProblemError, type createApi, type createMutationIntent } from '../lib/api.ts';
import { REREAD_LIMIT_MS } from './turn-model.ts';

/** The step a turn write is on: taking the turn through `inbox.ack`, then closing it. */
export type TurnPhase = 'taking' | 'closing';
/** A landed close: the task's column in the write's answer, and the re-read it started. */
export interface TurnClosed {
  column: string;
  /** True once a read of the task issued after the close answered; false when it failed. */
  refresh: Promise<boolean>;
}
type TurnWrite =
  | { id: 'task.submit'; input: Parameters<typeof createMutationIntent<'task.submit'>>[2] }
  | { id: 'task.return'; input: Parameters<typeof createMutationIntent<'task.return'>>[2] };

/** The writes a turn intent sends; each keeps its own idempotency key. */
type Write = 'inbox.ack' | 'task.submit' | 'task.return';

/**
 * Take turn `turn` with `inbox.ack`, then close it with the write; each write keeps one idempotency
 * key, so an unchanged resend reuses both. A confirmed ack is not sent again, nor one for a turn
 * `held` says the operator already holds, except after `not_turn_taker`: someone took the turn
 * back, so the next run takes it again with a new key. Every write has `REREAD_LIMIT_MS` to answer:
 * past it the request is aborted, a late answer is ignored, and the run fails with an unknown
 * outcome; a resend asks again with the same key, so a write that landed replays.
 * `refused` names why the board cannot send now; `refresh` re-reads the task the write was for and
 * answers whether that read succeeded.
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
  const keys: Record<Write, string> = {
    'inbox.ack': crypto.randomUUID(),
    'task.submit': crypto.randomUUID(),
    'task.return': crypto.randomUUID(),
  };
  /** One request of `id` under its kept key, aborted once it outlasts the deadline. */
  const bounded = async <T>(id: Write, send: (key: string, signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('The turn write got no answer in time; its outcome is unknown.'));
      }, REREAD_LIMIT_MS);
    });
    const asked = send(keys[id], controller.signal);
    // A late answer after the deadline settles nothing.
    asked.catch(() => undefined);
    try {
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const take = () =>
    bounded('inbox.ack', (key, signal) =>
      api('inbox.ack', { entries: [{ id: turn }] }, { key, signal }),
    );
  const close = () =>
    write.id === 'task.submit'
      ? bounded(write.id, (key, signal) => api('task.submit', write.input, { key, signal }))
      : bounded(write.id, (key, signal) => api('task.return', write.input, { key, signal }));
  let taken = options.held;
  let pending: Promise<TurnClosed> | undefined;
  let confirmed: TurnClosed | undefined;
  const run = async (onPhase: (phase: TurnPhase) => void): Promise<TurnClosed> => {
    if (!taken) {
      onPhase('taking');
      await take();
      taken = true;
    }
    onPhase('closing');
    try {
      const result = await close();
      confirmed = { column: result.task.column, refresh: options.refresh() };
      return confirmed;
    } catch (error) {
      if (error instanceof ProblemError && error.code === 'not_turn_taker') {
        taken = false;
        keys['inbox.ack'] = crypto.randomUUID();
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
    /** Re-read the task the write was for; true when that read answered. */
    refresh: () => options.refresh(),
  };
}
export type TurnIntent = ReturnType<typeof createTurnIntent>;
