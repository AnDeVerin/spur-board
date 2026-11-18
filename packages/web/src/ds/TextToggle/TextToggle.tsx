import type { ReactNode } from 'react';
import { focusRing } from '../FocusRing/FocusRing.tsx';
import { Icon } from '../Icon/Icon.tsx';
import styles from './TextToggle.module.css';

/**
 * A quiet text button that folds or unfolds text, such as "Show all", or runs one small action,
 * such as "Close I3": tertiary at rest, primary on hover, with the ds focus ring. `caret` adds a
 * caret after the text that points down, and up while `expanded`. `aria-expanded` is set only
 * when `expanded` is given; `controls` is the id of the region it folds (`aria-controls`). As with
 * `Button`, `busy` keeps it focusable, sets `aria-busy` and `aria-disabled` and ignores clicks;
 * pass children naming the action in flight, since busy looks like rest apart from the cursor.
 * `className` adds classes to the root button alongside its toggle and focus-ring classes.
 */
export function TextToggle({
  children,
  className,
  onClick,
  expanded,
  controls,
  caret = false,
  busy = false,
}: {
  children: ReactNode;
  className?: string | undefined;
  onClick: () => void;
  expanded?: boolean | undefined;
  controls?: string | undefined;
  caret?: boolean | undefined;
  busy?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      className={[styles.toggle, focusRing, className].filter(Boolean).join(' ')}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {children}
      {caret ? (
        <span className={styles.caret} data-expanded={expanded === true ? '' : undefined}>
          <Icon name="caret" />
        </span>
      ) : null}
    </button>
  );
}
