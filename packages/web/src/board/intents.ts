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

interface HeldMove {
  from: string | undefined;
  column: string;
  reason: string;
  confirmed: boolean;
  intent: { run: () => Promise<void> };
}

/**
 * One move per task in flight, whichever form sends it: from the send until a read after the
 * daemon accepted shows the task out of its source part, or until the send fails. Meanwhile the
 * same part and reason get the held intent (its key), and any other move of the task is refused.
 */
export function createHeldMoves() {
  const held = new Map<string, HeldMove>();
  return {
    intent(
      task: string,
      column: string,
      reason: string,
      from: string | undefined,
      create: () => { run: () => Promise<void> },
    ) {
      const current = held.get(task);
      if (current)
        return current.column === column && current.reason === reason
          ? current.intent
          : { run: () => Promise.reject(new MovePendingError()) };
      const inner = create();
      const entry: HeldMove = {
        from,
        column,
        reason,
        confirmed: false,
        intent: {
          run: () =>
            inner.run().then(
              () => {
                entry.confirmed = true;
              },
              (cause: unknown) => {
                if (held.get(task) === entry) held.delete(task);
                throw cause;
              },
            ),
        },
      };
      held.set(task, entry);
      return entry.intent;
    },
    /** A status read landed: release accepted moves whose task left its source part. */
    settle(rows: readonly { key: string; column: string }[]) {
      for (const [task, entry] of held) {
        if (!entry.confirmed) continue;
        if (rows.find((row) => row.key === task)?.column !== entry.from) held.delete(task);
      }
    },
  };
}
