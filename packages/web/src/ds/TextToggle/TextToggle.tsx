import type { ReactNode } from 'react';
import { focusRing } from '../FocusRing/FocusRing.tsx';
import { Icon } from '../Icon/Icon.tsx';
import styles from './TextToggle.module.css';

/**
 * A quiet text button that folds or unfolds text, such as "Show all": tertiary at rest, primary
 * on hover, with the ds focus ring. `caret` adds a caret after the text that points down, and up
 * while `expanded`. `aria-expanded` is set only when `expanded` is given; `controls` is the id of
 * the region it folds (`aria-controls`).
 */
export function TextToggle({
  children,
  onClick,
  expanded,
  controls,
  caret = false,
}: {
  children: ReactNode;
  onClick: () => void;
  expanded?: boolean | undefined;
  controls?: string | undefined;
  caret?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      className={`${styles.toggle ?? ''} ${focusRing}`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
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
