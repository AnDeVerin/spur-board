import styles from './Skeleton.module.css';

const defaultWidths = [30, 100, 70] as const;

function percent(width: number): number {
  return Number.isFinite(width) ? Math.min(Math.max(width, 0), 100) : 100;
}

/**
 * A placeholder card for content still loading: one pulsing line per entry of `widths`, each that
 * percent of the card wide (clamped to 0-100; a non-finite width is full). The default matches
 * the loading card: 30, 100 and 70. No widths render nothing. Decorative (`aria-hidden`): the
 * screen announces that it is loading, once. The pulse stops under reduced motion.
 */
export function Skeleton({ widths = defaultWidths }: { widths?: readonly number[] }) {
  if (widths.length === 0) return null;
  return (
    <div className={styles.root} aria-hidden="true">
      {widths.map((width, index) => (
        <span
          // A line has no identity besides its position.
          key={index}
          className={styles.line}
          style={{ width: `${String(percent(width))}%` }}
        />
      ))}
    </div>
  );
}
