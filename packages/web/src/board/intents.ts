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
