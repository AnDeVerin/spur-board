import type { ReactNode } from 'react';
import { focusRing } from '../FocusRing/FocusRing.tsx';
import styles from './Chip.module.css';

export type ChipTone = 'default' | 'warn' | 'you' | 'ghost';

/**
 * A small bordered label. With `href` it is an external link that opens in a new tab
 * (`rel="noopener noreferrer"`), brightens on hover and takes the ds focus ring; pass only a URL
 * already checked as http(s). `label` is its accessible name: start it with the visible text,
 * e.g. `PR #12, acme/app`. Without `href` the chip is a plain `span` and `label` is ignored.
 */
export function Chip({
  tone = 'default',
  href,
  label,
  children,
}: {
  tone?: ChipTone;
  href?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
}) {
  const className = [styles.chip, tone === 'default' ? undefined : styles[tone]]
    .filter(Boolean)
    .join(' ');
  if (href === undefined) return <span className={className}>{children}</span>;
  return (
    <a
      className={`${className} ${styles.link ?? ''} ${focusRing}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
    >
      {children}
    </a>
  );
}
