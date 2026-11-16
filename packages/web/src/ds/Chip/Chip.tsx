import type { ReactNode } from 'react';
import styles from './Chip.module.css';

export type ChipTone = 'default' | 'warn' | 'you' | 'ghost';

/** A small bordered label; `title` is its tooltip, for a chip that stands for more than it says. */
export function Chip({
  tone = 'default',
  title,
  children,
}: {
  tone?: ChipTone;
  title?: string | undefined;
  children: ReactNode;
}) {
  const className = [styles.chip, tone === 'default' ? undefined : styles[tone]]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}
