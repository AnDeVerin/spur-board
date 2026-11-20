import { coordinateRead, type createApi, type Output } from '../lib/api.ts';

export type BoardColumns = Output<'columns.describe'>;

/**
 * `columns.describe` of the chosen project. `value` is the last good answer, kept through a
 * failure. `help` is the state of the read the last column help open waits for: `loading` until a
 * read issued after the open settles, then `ready` or `failed`; undefined before any open.
 */
export interface ColumnsState {
  project: string;
  value: BoardColumns | undefined;
  help: 'loading' | 'ready' | 'failed' | undefined;
}

/**
 * The board's `columns.describe` read for the chosen project. Like the inbox, a failure never
 * shows on the board: the heads keep the last good answer, and `help` alone says it failed.
 */
export function createColumnsRead(
  api: ReturnType<typeof createApi>,
  board: {
    project: () => string | undefined;
    columns: () => ColumnsState | undefined;
    publish: (columns: ColumnsState) => void;
  },
) {
  // Each read is tagged when issued; one is in flight at a time, so its answer has the latest tag.
  let issued = { seq: 0, project: '' };
  // A column help open waits for the first read issued at or after this tag.
  let helpFrom: number | undefined;
  const last = (project: string) => {
    const columns = board.columns();
    return columns?.project === project ? columns : undefined;
  };
  const read = coordinateRead(
    (signal) => {
      const project = board.project() ?? '';
      issued = { seq: issued.seq + 1, project };
      return api('columns.describe', { project }, { signal });
    },
    (value) => {
      const { seq, project } = issued;
      // An answer for a project that is no longer chosen is dropped; its trailing read follows.
      if (project !== board.project()) return;
      let help = last(project)?.help;
      if (helpFrom !== undefined && seq >= helpFrom) {
        help = value ? 'ready' : 'failed';
        helpFrom = undefined;
      }
      board.publish({ project, value: value ?? last(project)?.value, help });
    },
  );
  return {
    refresh: () => {
      read.refresh();
    },
    dispose: () => {
      read.dispose();
    },
    /** The chosen project changed: an open's wait ends with it. */
    reset() {
      helpFrom = undefined;
    },
    /** A column help panel opened: `help` is `loading` until a read issued after now settles. */
    open() {
      const project = board.project();
      if (project === undefined) return;
      helpFrom = issued.seq + 1;
      board.publish({ project, value: last(project)?.value, help: 'loading' });
      read.refresh();
    },
  };
}
