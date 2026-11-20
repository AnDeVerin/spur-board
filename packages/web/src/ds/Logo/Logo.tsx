import styles from './Logo.module.css';
import { MARK_FRAME, MARK_PATH, MARK_VIEWBOX } from './mark.ts';

export type LogoSize = 'header' | 'small';

/**
 * The Spur mark in a square frame, drawn in the current text colour. `header` is the board
 * header size, `small` the icon size. Decorative (`aria-hidden`) unless `label` names it: pass a
 * label only where no visible product name sits next to the logo.
 */
export function Logo({ size = 'header', label }: { size?: LogoSize; label?: string }) {
  const a11y = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <svg
      className={[styles.logo, styles[size]].filter(Boolean).join(' ')}
      viewBox={`0 0 ${String(MARK_VIEWBOX)} ${String(MARK_VIEWBOX)}`}
      fill="none"
      stroke="currentColor"
      {...a11y}
    >
      <rect x={MARK_FRAME.x} y={MARK_FRAME.y} width={MARK_FRAME.width} height={MARK_FRAME.height} />
      <path d={MARK_PATH} />
    </svg>
  );
}
