import { focusRing, HoverMenu } from '../ds/index.ts';
import type { ColumnSort } from './model.ts';
import styles from './Columns.module.css';

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

type Field = 'time' | 'key' | 'manual';
const FIELDS: readonly { value: Field; label: string }[] = [
  { value: 'time', label: 'Time' },
  { value: 'key', label: 'Key' },
  { value: 'manual', label: 'Manual' },
];
const FIELD_LABEL: Record<Field, string> = {
  time: 'Sorted by time in the column',
  key: 'Sorted by key',
  manual: 'Sorted by manual order',
};
const SORT_HINT: Record<Exclude<ColumnSort, 'manual'>, string> = {
  'entered-asc': 'Longest in the column first',
  'entered-desc': 'Newest in the column first',
  'key-asc': 'Lowest key first',
  'key-desc': 'Highest key first',
};

/**
 * A column head's sort: the field's letter, T time in the column, K key or M manual, opens a menu
 * of the three; Time and Key add a quiet button that reverses the direction.
 */
export function SortControl({
  id,
  sort,
  onChange,
}: {
  id: string;
  sort: ColumnSort;
  onChange: (sort: ColumnSort) => void;
}) {
  const field: Field = sort === 'manual' ? 'manual' : sort.startsWith('key') ? 'key' : 'time';
  // Time and Key keep the direction; coming from Manual they start ascending.
  const direction = sort.endsWith('-desc') ? 'desc' : 'asc';
  return (
    <div role="group" aria-label={`Sort ${id}`} className={styles.sort}>
      <HoverMenu
        label={FIELD_LABEL[field]}
        text={field === 'manual' ? 'M' : field === 'key' ? 'K' : 'T'}
        items={FIELDS}
        value={field}
        opens="down"
        onSelect={(next) => {
          if (next === 'manual') onChange('manual');
          else onChange(`${next === 'key' ? 'key' : 'entered'}-${direction}`);
        }}
      />
      {sort !== 'manual' && (
        <button
          type="button"
          className={classes(styles.sortButton, focusRing)}
          aria-label={SORT_HINT[sort]}
          title={`${SORT_HINT[sort]}. Click to reverse.`}
          onClick={() => {
            onChange(
              `${field === 'key' ? 'key' : 'entered'}-${direction === 'asc' ? 'desc' : 'asc'}`,
            );
          }}
        >
          {direction === 'asc' ? '↑' : '↓'}
        </button>
      )}
    </div>
  );
}
