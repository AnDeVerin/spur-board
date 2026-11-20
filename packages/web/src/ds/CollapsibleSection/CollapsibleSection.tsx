import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { quiet } from '../Quiet/Quiet.tsx';
import styles from './CollapsibleSection.module.css';

/**
 * A section with a sticky header: chevron, title, optional count and a summary shown open and
 * collapsed. The chevron button toggles the body (click, Enter, Space); a double click on the rest
 * of the header toggles it too. The section is a `quiet` container, so count, summary and chevron
 * brighten on hover or focus. Uncontrolled: `defaultOpen` sets the first state, and
 * `onOpenChange` hears the new state once per toggle, never on render.
 */
export function CollapsibleSection({
  title,
  count,
  summary,
  defaultOpen = true,
  onOpenChange,
  children,
}: {
  title: string;
  count?: number | undefined;
  summary?: ReactNode | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <section className={`${quiet} ${styles.root ?? ''}`}>
      <div
        className={styles.header}
        title={open ? 'Double-click to collapse' : 'Double-click to expand'}
        onDoubleClick={(event) => {
          // A double click on the button is already two clicks.
          if (event.target instanceof Node && button.current?.contains(event.target)) return;
          toggle();
        }}
      >
        <button
          ref={button}
          className={styles.chevron}
          type="button"
          aria-labelledby={titleId}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <Icon name="caret" />
        </button>
        <span id={titleId} className={styles.title}>
          {title}
        </span>
        {count !== undefined && <span className={styles.count}>{count}</span>}
        {summary !== undefined && <span className={styles.summary}>{summary}</span>}
      </div>
      <div id={bodyId} className={styles.body} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
