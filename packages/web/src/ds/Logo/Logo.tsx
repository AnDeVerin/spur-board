import styles from './Logo.module.css';

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
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      {...a11y}
    >
      <rect x="1.5" y="1.5" width="13" height="13" />
      <path d="M8 4.2v7.6M4.7 6.1l6.6 3.8M11.3 6.1L4.7 9.9" />
    </svg>
  );
}
