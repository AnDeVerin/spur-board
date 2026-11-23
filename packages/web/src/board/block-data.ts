import { browserOperations } from '@spur-board/contracts/browser';
import {
  coordinateRead,
  createMutationIntent,
  ProblemError,
  type createApi,
  type Output,
} from '../lib/api.ts';
import type { RefreshScope } from '../lib/stream.ts';

export type BoardBlock = Output<'block.get'>;

/**
 * The open block panel: `loading` until its first answer and while a Retry runs, `ready` with a
 * good answer, `missing` when the daemon knows no such block or the id is not a block id,
 * `failed` when the last read failed. `value` is the last good answer for this id, kept through a
 * failure.
 */
export interface BlockState {
  id: string;
  state: 'loading' | 'ready' | 'missing' | 'failed';
  value: BoardBlock | undefined;
  /** `retryBlock` ran after a failure and its read has not settled yet. */
  retrying: boolean;
}

export type ReadResult<T> =
  { key: string; kind: 'ok'; value: T } | { key: string; kind: 'missing' | 'failed' };

/**
 * One read of the open task or block: an unknown one, or a key that is not a task key or block
 * id, is `missing`.
 */
export async function readResult<T>(key: string, read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { key, kind: 'ok', value: await read() };
  } catch (error) {
    const missing =
      error instanceof ProblemError &&
      (error.code === 'not_found' || error.code === 'wrong_id_kind');
    return { key, kind: missing ? 'missing' : 'failed' };
  }
}

const REFUSED = 'Answers and comments cannot be sent while the board is unavailable.';

/**
 * The board's `block.get` read for the block panel `?open=block:<id>` names, and its writes. It
 * re-reads on a full re-read, on Retry, after a write, and on an invalidate that names the loaded
 * block's project, or that came while a read of a block with no value ran and names the project it
 * answers; invalidates never name blocks. An id that is not a block id is never read.
 */
export function createBlockRead(
  api: ReturnType<typeof createApi>,
  publish: (patch: { block: BlockState | undefined }) => void,
  current: () => BlockState | undefined,
  /** The board cannot send writes now: stopped, its reads failing, or offline. */
  refused: () => boolean,
) {
  // The requested block id; an id that is not a block id is never read.
  let blockId: string | null = null;
  let readable = false;
  let disposed = false;
  let epoch = 0;
  let reads = 0;
  let issuedEpoch = 0;
  // A `block.get` was sent and has not settled, whatever the panel shows meanwhile.
  let inFlight = false;
  // Projects invalidated while a read ran for a block with no value; its answer names the project.
  const unseen = new Set<string>();
  const waits = new Set<{ epoch: number; after: number; resolve: (ok: boolean) => void }>();
  const endWaits = () => {
    for (const wait of waits) wait.resolve(false);
    waits.clear();
  };
  const show = (block: BlockState | undefined) => {
    publish({ block });
  };
  const read = coordinateRead<ReadResult<BoardBlock>>(
    (signal) => {
      const id = blockId ?? '';
      reads++;
      issuedEpoch = epoch;
      inFlight = true;
      return readResult(id, () => api('block.get', { block: id }, { signal }));
    },
    (result) => {
      inFlight = false;
      // An answer for an id that is no longer open is dropped; its trailing read follows.
      const shown = current();
      if (
        result === undefined ||
        issuedEpoch !== epoch ||
        result.key !== blockId ||
        shown?.id !== result.key
      )
        return;
      const id = result.key;
      const stale = result.kind === 'ok' && unseen.has(result.value.project);
      unseen.clear();
      if (result.kind === 'ok') show({ id, state: 'ready', value: result.value, retrying: false });
      else if (result.kind === 'missing')
        show({ id, state: 'missing', value: undefined, retrying: false });
      else show({ ...shown, state: 'failed', retrying: false });
      for (const wait of waits) {
        if (wait.epoch === epoch && reads > wait.after) {
          waits.delete(wait);
          wait.resolve(result.kind === 'ok');
        }
      }
      // A change to its project may have landed after this read was answered.
      if (stale) read.refresh();
    },
  );
  const refreshWritten = (id: string, at: number): Promise<boolean> => {
    if (disposed || !readable || id !== blockId || at !== epoch) return Promise.resolve(false);
    return new Promise((resolve) => {
      waits.add({ epoch: at, after: reads, resolve });
      read.refresh();
    });
  };
  /** A write on the open block; refused while the board cannot send or another block is open. */
  const writeIntent = (id: 'block.answer' | 'block.followup', block: string, text: string) => {
    const at = epoch;
    const intent = createMutationIntent(api, id, { block, text });
    let pending: Promise<{ refresh: Promise<boolean> }> | undefined;
    let confirmed: { refresh: Promise<boolean> } | undefined;
    return {
      run() {
        if (confirmed) return Promise.resolve(confirmed);
        if (pending) return pending;
        if (disposed || refused() || block !== blockId || at !== epoch)
          return Promise.reject(new Error(REFUSED));
        pending = intent
          .run()
          .then(() => {
            confirmed = { refresh: refreshWritten(block, at) };
            return confirmed;
          })
          .finally(() => {
            pending = undefined;
          });
        return pending;
      },
    };
  };
  /**
   * A null scope re-reads; a scope re-reads only a loaded block whose project it names, so a
   * block with no value waits for a full re-read or Retry. While any read runs for a block with no
   * value (first read, Retry or a full re-read), the scope's projects are kept, and its answer
   * re-reads when it names one of them.
   */
  const refresh = (scope: RefreshScope | null) => {
    if (!readable) return;
    const project = current()?.value?.project;
    if (scope === null || (project !== undefined && scope.projects.includes(project)))
      read.refresh();
    else if (inFlight && project === undefined) for (const name of scope.projects) unseen.add(name);
  };
  const dispose = () => {
    disposed = true;
    endWaits();
    read.dispose();
  };
  /** What the board exposes to the panel. */
  const panel = {
    /** Open a block by id, or close it with null; an id that is not a block id shows `missing`. */
    openBlock: (id: string | null) => {
      if (id === blockId) return;
      epoch++;
      endWaits();
      unseen.clear();
      blockId = id;
      readable =
        id !== null && browserOperations['block.get'].input.safeParse({ block: id }).success;
      if (id === null) show(undefined);
      else if (!readable) show({ id, state: 'missing', value: undefined, retrying: false });
      else {
        show({ id, state: 'loading', value: undefined, retrying: false });
        read.refresh();
      }
    },
    /** Re-read the open block after a failure; the last good answer stays while it runs. */
    retryBlock: () => {
      const shown = current();
      if (!readable || shown === undefined) return;
      show({ ...shown, state: 'loading', retrying: true });
      read.refresh();
    },
    /** The panel's writes, shaped as the task view's; the first argument is the panel's key. */
    blockAnswerIntent: (_key: string, block: string, text: string) =>
      writeIntent('block.answer', block, text),
    blockFollowUpIntent: (_key: string, block: string, text: string) =>
      writeIntent('block.followup', block, text),
    /** Re-read the open block after a write; false at once when there is none to read. */
    refreshBlock: () => refreshWritten(blockId ?? '', epoch),
  };
  return { refresh, dispose, panel };
}
