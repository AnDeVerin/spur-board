import { coordinateRead, createApi, type Output } from '../lib/api.ts';
import { connectStream, type RefreshScope, type StreamState } from '../lib/stream.ts';

export type BoardConfig = Output<'config.get'>;
type BoardStatus = Output<'status.get'>;
type BoardInbox = Output<'inbox.operator'>;

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
}

interface BoardDataOptions {
  fetch: typeof fetch;
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  now: () => number;
}

const PROJECT_KEY = 'board-project';

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

  const readAll = () => {
    config.refresh();
    inbox.refresh();
  };
  const refresh = (scope: RefreshScope | null) => {
    if (scope === null) {
      readAll();
      return;
    }
    if (state.project !== undefined && scope.projects.includes(state.project)) config.refresh();
    // The inbox spans every project.
    inbox.refresh();
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

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    start() {
      if (stream || stopped) return;
      readAll();
      stream = connectStream({ fetch: options.fetch, state: onStream, refresh });
    },
    /** End the controller for good: the stream closes and no read publishes again. */
    stop() {
      stopped = true;
      stream?.stop();
      status.dispose();
      config.dispose();
      inbox.dispose();
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
