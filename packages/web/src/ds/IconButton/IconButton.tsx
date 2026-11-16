import type { MouseEvent } from 'react';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import styles from './IconButton.module.css';

export type IconButtonSize = 'small' | 'control';

/**
 * A square bordered button holding one decorative icon. `label` names it (`aria-label` and
 * `title`). `small` is the icon button height, `control` matches a Button next to it.
 * Placement, such as pushing a close button to the end of a header, is the caller's.
 */
export function IconButton({
  icon,
  label,
  size = 'small',
  type = 'button',
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  size?: IconButtonSize | undefined;
  type?: 'button' | 'submit' | undefined;
  disabled?: boolean | undefined;
  onClick?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
}) {
  return (
    <button
      className={[styles.iconButton, styles[size]].filter(Boolean).join(' ')}
      type={type}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}
