import type { ReactNode } from 'react';
import { focusRing } from '../FocusRing/FocusRing.tsx';
import styles from './Chip.module.css';

/**
 * `ready` and `error` are tints: a soft status fill and a coloured icon; text and border stay
 * neutral. Coloured text and border stay on `warn` and `you`, for what asks for attention.
 */
export type ChipTone = 'default' | 'warn' | 'you' | 'ghost' | 'ready' | 'error';

/**
 * A small bordered label. `title` is its tooltip, for a chip that stands for more than it says.
 * With `href` it is an external link that opens in a new tab (`rel="noopener noreferrer"`),
 * brightens on hover and takes the ds focus ring; pass only a URL already checked as http(s).
 * `label` is its accessible name: start it with the visible text, e.g. `PR #12, acme/app`.
 * Without `href` the chip is a plain `span` and `label` is ignored. `wrap` lets long text, such
 * as a path name, break onto more lines within its container instead of running past it; by
 * default a chip stays on one line.
 */
export function Chip({
  tone = 'default',
  title,
  href,
  label,
  wrap = false,
  children,
}: {
  tone?: ChipTone;
  title?: string | undefined;
  href?: string | undefined;
  label?: string | undefined;
  wrap?: boolean | undefined;
  children: ReactNode;
}) {
  const className = [
    styles.chip,
    tone === 'default' ? undefined : styles[tone],
    wrap ? styles.wrap : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  if (href === undefined)
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  return (
    <a
      className={`${className} ${styles.link ?? ''} ${focusRing}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={title}
    >
      {children}
    </a>
  );
}
