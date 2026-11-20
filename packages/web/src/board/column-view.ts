import { FIRST_SORT, isColumnSort, type ColumnSort } from './model.ts';

const sortKey = (project: string, column: string) => `board-sort:${project}:${column}`;
const foldKey = (project: string, group: string) => `board-fold:${project}:${group}`;

/** Column order and group folds per project: view state in storage that never reaches the daemon. */
export function createColumnView(storage: () => Pick<Storage, 'getItem' | 'setItem'>) {
  return {
    /** The stored order of a column; `T ↑` when none is stored, it is unknown or storage fails. */
    columnSort(project: string, column: string): ColumnSort {
      try {
        const stored = storage().getItem(sortKey(project, column));
        return isColumnSort(stored) ? stored : FIRST_SORT;
      } catch {
        return FIRST_SORT;
      }
    },
    /** Keep the order of a column for its project; it is view state and never reaches the daemon. */
    setColumnSort(project: string, column: string, sort: ColumnSort) {
      try {
        storage().setItem(sortKey(project, column), sort);
      } catch {
        /* The order lasts until reload without storage. */
      }
    },
    /** Whether a column group is folded; unfolded when none is stored, it is unknown or storage fails. */
    columnFold(project: string, group: string): boolean {
      try {
        return storage().getItem(foldKey(project, group)) === 'folded';
      } catch {
        return false;
      }
    },
    /** Keep the fold of a column group for its project; view state, like the column order. */
    setColumnFold(project: string, group: string, folded: boolean) {
      try {
        storage().setItem(foldKey(project, group), folded ? 'folded' : 'unfolded');
      } catch {
        /* The fold lasts until reload without storage. */
      }
    },
  };
}
