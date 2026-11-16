import { breakpoints } from './Breakpoints.tsx';
import styles from './Breakpoints.module.css';

// Matching is shown by CSS alone, so the example calls no matchMedia while it renders.
export function List() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Resize the window below 760px to see narrow match
      </p>
      <ul className={styles.list}>
        {Object.entries(breakpoints).map(([name, query]) => (
          <li key={name} className={styles.row}>
            <span className={styles.name}>{name}</span>
            <code className={styles.query}>{query}</code>
            <span className={styles.wide}>does not match now</span>
            <span className={`${styles.narrow ?? ''} ${styles.match ?? ''}`}>matches now</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
