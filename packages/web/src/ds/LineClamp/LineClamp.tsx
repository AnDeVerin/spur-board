import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import styles from './LineClamp.module.css';

/**
 * Folded text: a paragraph clamped to `--lines-fold` lines with an ellipsis. Line breaks in the
 * text show (`pre-wrap`), and the full text stays in the DOM and selectable.
 *
 * `onOverflowChange` hears whether the text runs past the fold, `scrollHeight > clientHeight + 1`
 * (one pixel of rounding tolerance). The first measurement is always reported, later ones only
 * when the answer changes. It re-measures after every render and when the box resizes.
 *
 * It measures only while mounted, that is while clamped: a screen that unfolds by swapping the
 * clamp for the full text keeps the last reported `true`.
 */
export function LineClamp({
  children,
  onOverflowChange,
}: {
  children: ReactNode;
  onOverflowChange?: ((overflows: boolean) => void) | undefined;
}) {
  const node = useRef<HTMLParagraphElement>(null);
  const report = useRef(onOverflowChange);
  const last = useRef<boolean | undefined>(undefined);
  const measure = useRef(() => {
    const element = node.current;
    if (!element) return;
    const overflows = element.scrollHeight > element.clientHeight + 1;
    if (overflows === last.current) return;
    last.current = overflows;
    report.current?.(overflows);
  });
  useLayoutEffect(() => {
    report.current = onOverflowChange;
    measure.current();
  });
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      measure.current();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <p ref={node} className={styles.clamp}>
      {children}
    </p>
  );
}
