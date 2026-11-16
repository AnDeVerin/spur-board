import styles from './Meter.module.css';

/**
 * Fractions of the limit, both inclusive. `worse: 'low'` goes to warning at or below `warn` and
 * to error at or below `error` (a budget left); `worse: 'high'` at or above them (disk used).
 */
export type MeterThresholds = { warn: number; error: number; worse: 'low' | 'high' };

type Level = 'ok' | 'warning' | 'error';

function levelOf(ratio: number, thresholds: MeterThresholds | undefined): Level {
  if (!thresholds) return 'ok';
  const reached =
    thresholds.worse === 'low' ? (at: number) => ratio <= at : (at: number) => ratio >= at;
  if (reached(thresholds.error)) return 'error';
  if (reached(thresholds.warn)) return 'warning';
  return 'ok';
}

/**
 * A thin bar with a `value / limit` label. `name` is the visible key it sits next to. A null or
 * non-finite value, or a limit that is not a finite number above 0, is unknown: an empty track and
 * `— / limit` (`— / —` for a non-finite limit), never a reading.
 */
export function Meter({
  name,
  value,
  limit,
  thresholds,
}: {
  name: string;
  value: number | null;
  limit: number;
  thresholds?: MeterThresholds | undefined;
}) {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(limit) || !(limit > 0)) {
    const max = Number.isFinite(limit) ? String(limit) : '—';
    return (
      <span
        className={styles.root}
        role="img"
        aria-label={`${name}: unknown / ${max}`}
        data-level="unknown"
      >
        <span className={styles.track} />
        <span className={styles.label}>— / {max}</span>
      </span>
    );
  }
  const ratio = value / limit;
  const level = levelOf(ratio, thresholds);
  const reading = `${String(value)} / ${String(limit)}`;
  const word = level === 'ok' ? '' : ` · ${level}`;
  const width = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
  return (
    <span
      className={styles.root}
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(Math.max(value, 0), limit)}
      aria-valuetext={reading + word}
      data-level={level}
    >
      <span className={styles.track}>
        <span className={styles.fill} style={{ width: `${String(width)}%` }} />
      </span>
      <span className={styles.label}>
        {reading}
        {word && <span className={styles.word}>{word}</span>}
      </span>
    </span>
  );
}
