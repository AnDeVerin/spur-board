import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import styles from './Banner.module.css';

export type BannerVariant = 'error' | 'warning' | 'info';

/**
 * A full-width strip under the header: an icon, the main text, an optional muted `detail` and an
 * optional `action` slot, which takes a ds `Button`. `error` is an alert; `warning` and `info`
 * are status messages. The height is the same with and without an action; long text wraps.
 */
export function Banner({
  variant,
  icon,
  children,
  detail,
  action,
}: {
  variant: BannerVariant;
  icon: IconName;
  children: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={styles.root}
      role={variant === 'error' ? 'alert' : 'status'}
      data-variant={variant}
    >
      <span className={styles.icon}>
        <Icon name={icon} />
      </span>
      <span className={styles.text}>
        <span className={styles.main}>{children}</span>
        {detail !== undefined && <span className={styles.detail}>{detail}</span>}
      </span>
      {action !== undefined && <span className={styles.action}>{action}</span>}
    </div>
  );
}
