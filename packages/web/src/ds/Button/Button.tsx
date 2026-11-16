import type { MouseEvent, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'outlined';

/**
 * A text button, `outlined` by default. `busy` marks an action in flight: the button stays
 * focusable, exposes `aria-busy` and ignores clicks, including form submission. While `busy`,
 * pass children naming the action in flight, e.g. "Sending": busy and disabled look alike.
 * `expanded` and `controls` make it a disclosure trigger: they render `aria-expanded` and
 * `aria-controls` (the id of the shown or hidden region) only when passed.
 *
 * Keep it free of hooks: the click guard test calls the component directly.
 */
export function Button({
  variant = 'outlined',
  type = 'button',
  disabled = false,
  busy = false,
  expanded,
  controls,
  onClick,
  children,
}: {
  variant?: ButtonVariant | undefined;
  type?: 'button' | 'submit' | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  expanded?: boolean | undefined;
  controls?: string | undefined;
  onClick?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  children: ReactNode;
}) {
  const className = [styles.button, variant === 'primary' ? styles.primary : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      className={className}
      type={type}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
