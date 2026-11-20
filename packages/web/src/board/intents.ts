import { createMutationIntent, type createApi } from '../lib/api.ts';

/** `closeItemIntent` or `moveIntent` refused to send because the board is unavailable. */
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
  return <K extends 'item.close' | 'task.move'>(
    id: K,
    input: Parameters<typeof createMutationIntent<K>>[2],
    onConfirm: () => void,
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
          .then(() => {
            confirmed = true;
            onConfirm();
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
  confirmed: boolean;
  inner: Run;
}

/**
 * One move per task in flight, whichever form sends it. Every send re-checks the hold: free, it
 * takes it; held for the same part and reason, it joins the held send and its key; held for
 * another, it is refused. A failed send frees the task. An accepted move frees it once every read
 * that shows the task (`where`: its status row, its open task view) shows it out of the source
 * part; `settle` checks that after each read.
 */
export function createHeldMoves(where: (task: string) => readonly string[]) {
  const held = new Map<string, HeldMove>();
  /** Free each accepted move no read shows in its source part any more. */
  const settle = () => {
    for (const [task, entry] of held) {
      if (entry.confirmed && where(task).every((column) => column !== entry.from))
        held.delete(task);
    }
  };
  const send = (task: string, entry: HeldMove) =>
    entry.inner.run().then(
      () => {
        entry.confirmed = true;
        // A read may have landed before the accept was seen.
        settle();
      },
      (cause: unknown) => {
        if (held.get(task) === entry) held.delete(task);
        throw cause;
      },
    );
  return {
    /** A form's intent for one part and reason; `from` reads the task's part at each send. */
    intent(
      task: string,
      column: string,
      reason: string,
      from: () => string | undefined,
      create: () => Run,
    ): Run {
      // This form's send, or the one it joined: a retry keeps that key.
      let inner: Run | undefined;
      return {
        run: () => {
          const current = held.get(task);
          if (current) {
            if (current.column !== column || current.reason !== reason)
              return Promise.reject(new MovePendingError());
            inner = current.inner;
            return send(task, current);
          }
          inner ??= create();
          const entry: HeldMove = { from: from(), column, reason, confirmed: false, inner };
          held.set(task, entry);
          return send(task, entry);
        },
      };
    },
    /** A read landed. */
    settle,
  };
}
