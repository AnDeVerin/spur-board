import { createMutationIntent, ProblemError, type createApi, type Output } from '../lib/api.ts';

/** `closeItemIntent`, `moveIntent` or `endWaitIntent` refused to send: the board is unavailable. */
export class BoardUnavailableError extends Error {
  constructor() {
    super('the board is unavailable.');
    this.name = 'BoardUnavailableError';
  }
}

/**
 * Board-level intents on `api`: each is refused while `unavailable()`, shares a pending run, and
 * after a confirmed run calls `onConfirm` to re-read; later runs then return at once.
 */
export function createBoardIntent(api: ReturnType<typeof createApi>, unavailable: () => boolean) {
  return <K extends 'item.close' | 'task.move' | 'task.wait'>(
    id: K,
    input: Parameters<typeof createMutationIntent<K>>[2],
    onConfirm: (value: Output<K>) => void,
  ) => {
    const intent = createMutationIntent(api, id, input);
    let pending: Promise<void> | undefined;
    let confirmed = false;
    return {
      run(): Promise<void> {
        if (confirmed) return Promise.resolve();
        if (pending) return pending;
        if (unavailable()) return Promise.reject(new BoardUnavailableError());
        pending = intent
          .run()
          .then((value) => {
            confirmed = true;
            onConfirm(value);
          })
          .finally(() => {
            pending = undefined;
          });
        return pending;
      },
    };
  };
}

/** A move of this task is already in flight with another part or reason. */
export class MovePendingError extends Error {
  constructor() {
    super('This task is already being moved. Wait until the Board shows it.');
    this.name = 'MovePendingError';
  }
}

type Run = { run: () => Promise<void> };
interface HeldMove {
  from: string | undefined;
  column: string;
  reason: string;
  /** The last send's outcome: in flight, accepted, or unknown (no answer could be read). */
  outcome: 'pending' | 'accepted' | 'unknown';
  /** Sends so far; a task read started before the latest send is ignored. */
  sends: number;
  reading: boolean;
  inner: Run;
}

/**
 * One move per task whose outcome is not known yet, whichever form or task view sends it, with
 * one key. Every send re-checks the hold: free, it takes it; held for the same part and reason,
 * it joins with the held key; held for another, it is refused. Only the daemon's own answer or
 * a read of the task frees it: a definite refusal at once; after an accepted or unknown outcome,
 * a `task.get` of the task issued after the send that shows the task out of its source part (moved),
 * or still in it after an unknown outcome (not moved). A board status row never frees it.
 */
export function createHeldMoves(api: ReturnType<typeof createApi>) {
  const held = new Map<string, HeldMove>();
  // A read of the task itself; a failed one settles nothing.
  const read = (task: string) =>
    api('task.get', { task }).then(
      (value): string | undefined => value.task.column,
      () => undefined,
    );
  const check = (task: string, entry: HeldMove) => {
    if (entry.outcome === 'pending' || entry.reading) return;
    entry.reading = true;
    const sends = entry.sends;
    void read(task).then((column) => {
      entry.reading = false;
      if (held.get(task) !== entry || entry.sends !== sends || column === undefined) return;
      if (column !== entry.from || entry.outcome === 'unknown') held.delete(task);
    });
  };
  const send = (task: string, entry: HeldMove) => {
    entry.outcome = 'pending';
    entry.sends++;
    return entry.inner.run().then(
      () => {
        entry.outcome = 'accepted';
        check(task, entry);
      },
      (cause: unknown) => {
        // A refusal, or a send the board never made, moved nothing; the daemon's `unexpected`
        // (its HTTP 500) leaves the outcome unknown, as a lost reply does.
        const refused =
          (cause instanceof ProblemError && cause.code !== 'unexpected') ||
          cause instanceof BoardUnavailableError;
        if (refused) {
          if (held.get(task) === entry) held.delete(task);
        } else {
          entry.outcome = 'unknown';
          check(task, entry);
        }
        throw cause;
      },
    );
  };
  return {
    /** A form's intent for one part and reason; `from` reads the task's part at each send. */
    intent(
      task: string,
      column: string,
      reason: string,
      from: () => string | undefined,
      create: (accepted: (from: string) => void) => Run,
    ): Run {
      // This form's send, or the one it joined: a retry keeps that key.
      let inner: Run | undefined;
      // An accepted move left the part the daemon names, which a stale row may not.
      const accepted = (source: string) => {
        const entry = held.get(task);
        if (entry === undefined || entry.inner !== inner) return;
        // A move into the part it was already in is a new visit there: settled at once.
        if (source === entry.column) held.delete(task);
        else entry.from = source;
      };
      return {
        run: () => {
          const current = held.get(task);
          if (current) {
            if (current.column !== column || current.reason !== reason) {
              check(task, current);
              return Promise.reject(new MovePendingError());
            }
            inner = current.inner;
            return send(task, current);
          }
          inner ??= create(accepted);
          const entry: HeldMove = {
            from: from(),
            column,
            reason,
            outcome: 'pending',
            sends: 0,
            reading: false,
            inner,
          };
          held.set(task, entry);
          return send(task, entry);
        },
      };
    },
  };
}
