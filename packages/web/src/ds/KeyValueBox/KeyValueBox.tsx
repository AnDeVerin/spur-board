import type { ReactNode } from 'react';
import { StatusDot, type StatusDotTone } from '../StatusDot/StatusDot.tsx';
import styles from './KeyValueBox.module.css';

export type KeyValueStatus = 'pass' | 'wait' | 'fail' | 'unchecked';

/** One row. A status row with a null or undefined value is a message row: its word is the value. */
export type KeyValueRow = {
  key: ReactNode;
  value?: ReactNode | undefined;
  status?: KeyValueStatus | undefined;
};

const STATUS: Record<KeyValueStatus, { word: string; tone: StatusDotTone }> = {
  pass: { word: 'passed', tone: 'ok' },
  wait: { word: 'waiting', tone: 'warn' },
  fail: { word: 'failed', tone: 'error' },
  unchecked: { word: 'not checked', tone: 'unknown' },
};

function Value({ value, status }: Pick<KeyValueRow, 'value' | 'status'>) {
  if (!status) return value == null ? null : <span className={styles.value}>{value}</span>;
  const { word, tone } = STATUS[status];
  // The word is in the DOM once: visible when there is no value, hidden unless the value says it.
  const saysWord = typeof value === 'string' && value.trim().toLowerCase() === word;
  return (
    <span className={styles.value}>
      <StatusDot tone={tone} />
      {value == null ? (
        word
      ) : (
        <>
          {!saysWord && <span className={styles.hidden}>{`${word}: `}</span>}
          {value}
        </>
      )}
    </span>
  );
}

/**
 * A bordered list of key and value rows. Status rows get a dot, a colour and their word;
 * `pass` and `unchecked` rows are muted, so put the box in a `quiet` container. Renders nothing
 * without rows or a title.
 */
export function KeyValueBox({
  title,
  rows,
}: {
  title?: ReactNode | undefined;
  rows: readonly KeyValueRow[];
}) {
  if (rows.length === 0 && title === undefined) return null;
  return (
    <div className={styles.root}>
      {title !== undefined && <div className={styles.title}>{title}</div>}
      {rows.map(({ key, value, status }, index) => (
        <div key={index} className={styles.row} data-status={status}>
          <span
            className={
              status === 'fail' && value == null
                ? `${styles.key ?? ''} ${styles.message ?? ''}`
                : styles.key
            }
          >
            {key}
          </span>
          <Value value={value} status={status} />
        </div>
      ))}
    </div>
  );
}
