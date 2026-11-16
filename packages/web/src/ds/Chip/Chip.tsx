import type { ReactNode } from 'react';
import styles from './Chip.module.css';

export type ChipTone = 'default' | 'warn' | 'you' | 'ghost';

/** A small bordered label. */
export function Chip({ tone = 'default', children }: { tone?: ChipTone; children: ReactNode }) {
  const className = [styles.chip, tone === 'default' ? undefined : styles[tone]]
    .filter(Boolean)
    .join(' ');
  return <span className={className}>{children}</span>;
}
