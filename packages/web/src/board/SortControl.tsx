import { focusRing } from '../ds/index.ts';
import type { ColumnSort } from './model.ts';
import styles from './Columns.module.css';

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

const SORT_HINT: Record<ColumnSort, string> = {
  'entered-asc': 'Longest in the column first',
  'entered-desc': 'Newest in the column first',
  'key-asc': 'Lowest key first',
  'key-desc': 'Highest key first',
};

/** Two quiet buttons in a column head: the field, T time in the column or K key, and the direction. */
export function SortControl({
  id,
  sort,
  onChange,
}: {
  id: string;
  sort: ColumnSort;
  onChange: (sort: ColumnSort) => void;
}) {
  const byKey = sort.startsWith('key');
  const asc = sort.endsWith('-asc');
  const direction = asc ? 'asc' : 'desc';
  return (
    <div role="group" aria-label={`Sort ${id}`} className={styles.sort}>
      <button
        type="button"
        className={classes(styles.sortButton, focusRing)}
        aria-label={byKey ? 'Sorted by key' : 'Sorted by time in the column'}
        title={
          byKey
            ? 'K: sorted by key. Click for T, time in the column.'
            : 'T: sorted by time in the column. Click for K, key.'
        }
        onClick={() => {
          onChange(byKey ? `entered-${direction}` : `key-${direction}`);
        }}
      >
        {byKey ? 'K' : 'T'}
      </button>
      <button
        type="button"
        className={classes(styles.sortButton, focusRing)}
        aria-label={SORT_HINT[sort]}
        title={`${SORT_HINT[sort]}. Click to reverse.`}
        onClick={() => {
          onChange(`${byKey ? 'key' : 'entered'}-${asc ? 'desc' : 'asc'}`);
        }}
      >
        {asc ? '↑' : '↓'}
      </button>
    </div>
  );
}
