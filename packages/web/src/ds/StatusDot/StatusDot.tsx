import styles from './StatusDot.module.css';

export type StatusDotTone = 'ok' | 'warn' | 'error' | 'unknown';

/** A decorative status light. Always place it next to the word it stands for. */
export function StatusDot({ tone, hollow = false }: { tone: StatusDotTone; hollow?: boolean }) {
  const className = [styles.dot, styles[tone], hollow ? styles.hollow : undefined]
    .filter(Boolean)
    .join(' ');
  return <span className={className} aria-hidden="true" />;
}
