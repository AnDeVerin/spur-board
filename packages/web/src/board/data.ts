import { browserOperations } from '@spur-board/contracts/browser';
import {
  coordinateRead,
  createApi,
  createMutationIntent,
  ProblemError,
  type Output,
} from '../lib/api.ts';
import { connectStream, type RefreshScope, type StreamState } from '../lib/stream.ts';
import { FIRST_SORT, isColumnSort, type ColumnSort } from './model.ts';

export type BoardConfig = Output<'config.get'>;
type BoardStatus = Output<'status.get'>;
type BoardInbox = Output<'inbox.operator'>;
export type BoardTask = Output<'task.get'>;
export type BoardHistory = Output<'task.history'>;

/**
 * The open task: `loading` until its first answer and while a Retry runs, `ready` with a good
 * answer, `missing` when the daemon knows no such task or the key is not a task key, `failed` when
 * the last read failed. `value` is the last good answer for this key, kept through a failure.
 */
export interface TaskState {
  key: string;
  state: 'loading' | 'ready' | 'missing' | 'failed';
  value: BoardTask | undefined;
  /** `retryTask` ran after a failure and its read has not settled yet. */
  retrying: boolean;
}
/**
 * The open task's `task.history`, read only while the History tab shows: states as `TaskState`;
 * a re-read keeps `ready` and its rows.
 */
export interface HistoryState {
  key: string;
  state: 'loading' | 'ready' | 'missing' | 'failed';
  value: BoardHistory | undefined;
  /** `retryHistory` ran after a failure and its read has not settled yet. */
  retrying: boolean;
}
type ReadResult<T> =
  { key: string; kind: 'ok'; value: T } | { key: string; kind: 'missing' | 'failed' };

/** One read of the open task: an unknown task or a key that is not a task key is `missing`. */
async function readResult<T>(key: string, read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { key, kind: 'ok', value: await read() };
  } catch (error) {
    const missing =
      error instanceof ProblemError &&
      (error.code === 'not_found' || error.code === 'wrong_id_kind');
    return { key, kind: missing ? 'missing' : 'failed' };
  }
}

/** The facts the board screen derives its state from; a new object on every change. */
export interface BoardSnapshot {
  /** Last good `config.get` answer. */
  config: BoardConfig | undefined;
  /** Chosen project: the stored one when config lists it, else config's first project. */
  project: string | undefined;
  /** Last good `status.get` answer for the chosen project. */
  status: BoardStatus | undefined;
  /** Last good `inbox.operator` answer; its failures never show. */
  inbox: BoardInbox | undefined;
  /** The latest `config.get` or `status.get` attempt failed. */
  readFailed: boolean;
  stream: StreamState;
  /** The stream has said hello at least once. */
  everLive: boolean;
  /** Client time of the last good `status.get` for the chosen project. */
  lastGoodAt: number | undefined;
  /** Retry now was pressed and its reads have not settled yet. */
  retrying: boolean;
  /** The task `open` names; undefined when none is open. */
  task: TaskState | undefined;
  /** History of the open task; undefined until `showHistory` first reads it. */
  history: HistoryState | undefined;
}

interface BoardDataOptions {
  fetch: typeof fetch;
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  now: () => number;
}

const PROJECT_KEY = 'board-project';
const sortKey = (project: string, column: string) => `board-sort:${project}:${column}`;

/**
 * Board reads outside React: `config.get`, then `status.get` for the chosen project, and
 * `inbox.operator`, refreshed from the event stream. `subscribe` and `snapshot` fit
 * `useSyncExternalStore`.
 */
export function createBoardData(options: BoardDataOptions) {
  const api = createApi(options.fetch);
  const listeners = new Set<() => void>();
  let state: BoardSnapshot = {
    config: undefined,
    project: undefined,
    status: undefined,
    inbox: undefined,
    readFailed: false,
    stream: 'reconnecting',
    everLive: false,
    lastGoodAt: undefined,
    retrying: false,
    task: undefined,
    history: undefined,
  };
  let preferred: string | null = null;
  try {
    preferred = options.storage().getItem(PROJECT_KEY);
  } catch {
    /* The first project is chosen without storage. */
  }
  let configFailed = false;
  let statusFailed = false;
  // Each read is tagged when issued; a coordinator has one read in flight, so its answer
  // belongs to the latest tag.
  let issued = 0;
  let configIssued = 0;
  let inboxIssued = 0;
  let statusIssued = { seq: 0, project: '' };
  // Retry now stays busy until the reads issued after the press settle.
  let retryFrom: number | undefined;
  let retryWaits = new Set<'chain' | 'inbox'>();

  const update = (patch: Partial<BoardSnapshot>) => {
    state = {
      ...state,
      ...patch,
      readFailed: configFailed || statusFailed,
      retrying: retryFrom !== undefined,
    };
    for (const listener of listeners) listener();
  };
  const settleRetry = (wait: 'chain' | 'inbox', seq: number) => {
    if (retryFrom === undefined || seq < retryFrom) return;
    retryWaits.delete(wait);
    if (retryWaits.size === 0) retryFrom = undefined;
  };
  const resolveProject = (config: BoardConfig) => {
    const ids = config.projects.map((project) => project.id);
    return preferred !== null && ids.includes(preferred) ? preferred : ids[0];
  };

  const status = coordinateRead(
    (signal) => {
      const project = state.project ?? '';
      statusIssued = { seq: ++issued, project };
      return api('status.get', { project, detail: true }, { signal });
    },
    (value, error) => {
      const { seq, project } = statusIssued;
      // An answer for a project that is no longer chosen is dropped; its trailing read follows.
      if (project !== state.project) return;
      statusFailed = error;
      settleRetry('chain', seq);
      update(value ? { status: value, lastGoodAt: options.now() } : {});
    },
  );
  const config = coordinateRead(
    (signal) => {
      configIssued = ++issued;
      return api('config.get', {}, { signal });
    },
    (value, error) => {
      configFailed = error;
      const project = value ? resolveProject(value) : state.project;
      const patch: Partial<BoardSnapshot> = value ? { config: value } : {};
      if (project !== state.project) {
        statusFailed = false;
        Object.assign(patch, { project, status: undefined, lastGoodAt: undefined });
      }
      // `status.get` throws for an unknown project, so it takes the project from config.
      if (project === undefined) settleRetry('chain', configIssued);
      update(patch);
      if (project !== undefined) status.refresh();
    },
  );
  const inbox = coordinateRead(
    (signal) => {
      inboxIssued = ++issued;
      return api('inbox.operator', {}, { signal });
    },
    (value) => {
      settleRetry('inbox', inboxIssued);
      update(value ? { inbox: value } : {});
    },
  );

  // The requested task key; a key that is not a task key is never read.
  let taskKey: string | null = null;
  let taskReadable = false;
  let taskEpoch = 0;
  let taskRead = 0;
  let taskIssuedEpoch = 0;
  const refreshWaits = new Set<{ epoch: number; after: number; resolve: (ok: boolean) => void }>();
  const task = coordinateRead<ReadResult<BoardTask>>(
    (signal) => {
      const key = taskKey ?? '';
      taskRead++;
      taskIssuedEpoch = taskEpoch;
      return readResult(key, () => api('task.get', { task: key, why: true }, { signal }));
    },
    (result) => {
      // An answer for a key that is no longer open is dropped; its trailing read follows.
      if (
        result === undefined ||
        taskIssuedEpoch !== taskEpoch ||
        result.key !== taskKey ||
        state.task?.key !== result.key
      )
        return;
      const { key } = result;
      if (result.kind === 'ok')
        update({ task: { key, state: 'ready', value: result.value, retrying: false } });
      else if (result.kind === 'missing')
        update({ task: { key, state: 'missing', value: undefined, retrying: false } });
      else update({ task: { ...state.task, state: 'failed', retrying: false } });
      for (const wait of refreshWaits) {
        if (wait.epoch === taskEpoch && taskRead > wait.after) {
          refreshWaits.delete(wait);
          wait.resolve(result.kind === 'ok');
        }
      }
    },
  );
  const refreshTask = () => {
    if (taskReadable) task.refresh();
  };
  let historyShown = false;
  const history = coordinateRead<ReadResult<BoardHistory> | undefined>(
    (signal) => {
      // A trailing read queued while History showed is skipped once the tab hides or the task changes.
      if (!historyShown || !taskReadable) return Promise.resolve(undefined);
      const key = taskKey ?? '';
      return readResult(key, () => api('task.history', { task: key }, { signal }));
    },
    (result) => {
      // As for the task: an answer for a key that is no longer open is dropped.
      if (result === undefined || result.key !== taskKey || state.history?.key !== result.key)
        return;
      const { key } = result;
      if (result.kind === 'ok')
        update({ history: { key, state: 'ready', value: result.value, retrying: false } });
      else if (result.kind === 'missing')
        update({ history: { key, state: 'missing', value: undefined, retrying: false } });
      else update({ history: { ...state.history, state: 'failed', retrying: false } });
    },
  );
  const refreshHistory = () => {
    if (taskReadable && historyShown) history.refresh();
  };

  const readAll = () => {
    config.refresh();
    inbox.refresh();
    refreshTask();
    refreshHistory();
  };
  const refresh = (scope: RefreshScope | null) => {
    if (scope === null) {
      readAll();
      return;
    }
    if (state.project !== undefined && scope.projects.includes(state.project)) config.refresh();
    // The inbox spans every project.
    inbox.refresh();
    // `task.get` answers the canonical key, which a short requested key may not equal.
    const loaded = state.task?.value?.task.key;
    if (
      (taskKey !== null && scope.tasks.includes(taskKey)) ||
      (loaded !== undefined && scope.tasks.includes(loaded))
    ) {
      refreshTask();
      refreshHistory();
    }
  };
  const onStream = (value: StreamState) => {
    const previous = state.stream;
    update({ stream: value, everLive: state.everLive || value === 'live' });
    if (value === previous) return;
    // Offline: probe the reads once to tell a lost stream from a daemon that does not answer.
    if (value === 'offline') readAll();
    else if (value === 'live' && state.readFailed) readAll();
  };
  let stream: ReturnType<typeof connectStream> | undefined;
  let stopped = false;

  const refreshWrittenTask = (key: string, epoch: number): Promise<boolean> => {
    if (stopped || key !== taskKey || epoch !== taskEpoch) return Promise.resolve(false);
    return new Promise((resolve) => {
      refreshWaits.add({ epoch, after: taskRead, resolve });
      task.refresh();
    });
  };
  const writeIntent = <K extends 'block.answer' | 'block.followup' | 'comment.add'>(
    key: string,
    id: K,
    input: Parameters<typeof createMutationIntent<K>>[2],
  ) => {
    const epoch = taskEpoch;
    const intent = createMutationIntent(api, id, input);
    let pending: Promise<{ refresh: Promise<boolean> }> | undefined;
    let confirmed: { refresh: Promise<boolean> } | undefined;
    return {
      run() {
        if (confirmed) return Promise.resolve(confirmed);
        if (pending) return pending;
        if (state.task?.value?.task.membership === 'archived')
          return Promise.reject(
            new Error('This task is archived. Answers and comments cannot be sent.'),
          );
        if (
          stopped ||
          key !== taskKey ||
          epoch !== taskEpoch ||
          state.readFailed ||
          state.stream === 'offline'
        )
          return Promise.reject(
            new Error('Answers and comments cannot be sent while the board is unavailable.'),
          );
        pending = intent
          .run()
          .then(() => {
            confirmed = { refresh: refreshWrittenTask(key, epoch) };
            return confirmed;
          })
          .finally(() => {
            pending = undefined;
          });
        return pending;
      },
    };
  };

  return {
    /** An arrow, so `useSyncExternalStore(data.subscribe, ...)` can pass it unbound. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    start() {
      if (stream || stopped) return;
      // A task opened before start already issued its read in `open`.
      config.refresh();
      inbox.refresh();
      stream = connectStream({ fetch: options.fetch, state: onStream, refresh });
    },
    /** End the controller for good: the stream closes and no read publishes again. */
    stop() {
      stopped = true;
      for (const wait of refreshWaits) wait.resolve(false);
      refreshWaits.clear();
      stream?.stop();
      status.dispose();
      config.dispose();
      inbox.dispose();
      task.dispose();
      history.dispose();
    },
    /** The client clock the snapshot's times are read against. */
    now: () => options.now(),
    /** The three task-view writes; each object owns one idempotent intent. */
    answerIntent: (key: string, block: string, text: string) =>
      writeIntent(key, 'block.answer', { block, text }),
    followUpIntent: (key: string, block: string, text: string) =>
      writeIntent(key, 'block.followup', { block, text }),
    commentIntent: (key: string, text: string) =>
      writeIntent(key, 'comment.add', { task: state.task?.value?.task.key ?? key, text }),
    /**
     * Close one operator inbox item; the object owns one idempotent intent. Refused while the
     * board is unavailable; a confirmed close re-reads the inbox and later runs return at once.
     */
    closeItemIntent: (item: string) => {
      const intent = createMutationIntent(api, 'item.close', { item });
      let pending: Promise<void> | undefined;
      let confirmed = false;
      return {
        run(): Promise<void> {
          if (confirmed) return Promise.resolve();
          if (pending) return pending;
          if (stopped || state.readFailed || state.stream === 'offline')
            return Promise.reject(new Error('the board is unavailable.'));
          pending = intent
            .run()
            .then(() => {
              confirmed = true;
              inbox.refresh();
            })
            .finally(() => {
              pending = undefined;
            });
          return pending;
        },
      };
    },
    refreshTask: () => refreshWrittenTask(taskKey ?? '', taskEpoch),
    /**
     * Open a task by key, or close it with null: read `task.get` with why, then again whenever the
     * stream names the task, the board re-reads everything, or `retryTask` runs. History hides.
     */
    open(key: string | null) {
      if (key === taskKey) return;
      taskEpoch++;
      for (const wait of refreshWaits) wait.resolve(false);
      refreshWaits.clear();
      taskKey = key;
      historyShown = false;
      taskReadable =
        key !== null &&
        browserOperations['task.get'].input.safeParse({ task: key, why: true }).success;
      if (key === null) update({ task: undefined, history: undefined });
      else if (!taskReadable)
        update({
          task: { key, state: 'missing', value: undefined, retrying: false },
          history: undefined,
        });
      else {
        update({
          task: { key, state: 'loading', value: undefined, retrying: false },
          history: undefined,
        });
        task.refresh();
      }
    },
    /**
     * The History tab of the open task shows or hides. Shown, it reads `task.history`, then again
     * whenever the task re-reads; hidden, it reads nothing and keeps the last answer.
     */
    showHistory(shown: boolean) {
      if (shown === historyShown) return;
      historyShown = shown;
      if (!shown || !taskReadable || taskKey === null) return;
      if (state.history?.key !== taskKey)
        update({ history: { key: taskKey, state: 'loading', value: undefined, retrying: false } });
      history.refresh();
    },
    /** Re-read the history after a failure; the last good answer stays while it runs. */
    retryHistory() {
      if (!taskReadable || !historyShown || !state.history || state.history.retrying) return;
      update({ history: { ...state.history, state: 'loading', retrying: true } });
      history.refresh();
    },
    /** Re-read the open task after a failure; the last good answer stays while it runs. */
    retryTask() {
      if (!taskReadable || !state.task) return;
      update({ task: { ...state.task, state: 'loading', retrying: true } });
      task.refresh();
    },
    /** Choose a project `config.get` lists; its cards show only after its own `status.get`. */
    choose(project: string) {
      if (!state.config?.projects.some((candidate) => candidate.id === project)) return;
      preferred = project;
      try {
        options.storage().setItem(PROJECT_KEY, project);
      } catch {
        /* The choice lasts until reload without storage. */
      }
      if (project === state.project) return;
      configFailed = false;
      statusFailed = false;
      update({ project, status: undefined, lastGoodAt: undefined });
      status.refresh();
    },
    /** The stored order of a column; `T ↑` when none is stored, it is unknown or storage fails. */
    columnSort(project: string, column: string): ColumnSort {
      try {
        const stored = options.storage().getItem(sortKey(project, column));
        return isColumnSort(stored) ? stored : FIRST_SORT;
      } catch {
        return FIRST_SORT;
      }
    },
    /** Keep the order of a column for its project; it is view state and never reaches the daemon. */
    setColumnSort(project: string, column: string, sort: ColumnSort) {
      try {
        options.storage().setItem(sortKey(project, column), sort);
      } catch {
        /* The order lasts until reload without storage. */
      }
    },
    /** Retry now: reconnect the stream if it waits in backoff and re-read everything. */
    retry() {
      if (retryFrom !== undefined) return;
      retryFrom = issued + 1;
      retryWaits = new Set(['chain', 'inbox']);
      update({});
      stream?.retry();
      readAll();
    },
  };
}

export type BoardData = ReturnType<typeof createBoardData>;
