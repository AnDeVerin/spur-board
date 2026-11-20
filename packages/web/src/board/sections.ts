/** The task view sections whose open or closed state the browser keeps. */
export type TaskSectionId = 'why' | 'turn' | 'approvals' | 'submission' | 'blocks' | 'comments';

/** One key per section for every task and project, like the column order keeps per column. */
const sectionKey = (id: TaskSectionId) => `board-section:${id}`;

/**
 * Open or closed state of each task view section in browser storage. It is view state: it never
 * reaches the daemon, and a failing storage or an unknown value gives the section's default.
 * Arrows, so the board can hand them out unbound.
 */
export function createSectionStore(storage: () => Pick<Storage, 'getItem' | 'setItem'>) {
  return {
    sectionOpen: (id: TaskSectionId, fallback: boolean): boolean => {
      try {
        const stored = storage().getItem(sectionKey(id));
        return stored === 'open' ? true : stored === 'closed' ? false : fallback;
      } catch {
        return fallback;
      }
    },
    setSectionOpen: (id: TaskSectionId, open: boolean) => {
      try {
        storage().setItem(sectionKey(id), open ? 'open' : 'closed');
      } catch {
        /* The state lasts until the section unmounts without storage. */
      }
    },
  };
}
