import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { addOpenMenu, removeOpenMenu, type OpenMenu } from '../HoverMenu/HoverMenu.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import styles from './Popover.module.css';

/**
 * A non-modal panel under an anchor element, such as a column head: `role="dialog"` without
 * `aria-modal`, labelled by `title`. Controlled: it renders while `open` and calls `onClose`; the
 * caller's trigger carries `aria-expanded`. The header holds the title at the left, then
 * `actions` (e.g. an underline `Tabs`), then Close; the body scrolls.
 *
 * Placement: it sits `--space-1` under the anchor's bottom edge, starting at its left edge, and
 * follows the anchor on any scroll (a nested scroller included) and on resize. While the anchor
 * shows in the window horizontally the panel keeps `--space-2` inside the window edges; an anchor
 * scrolled wholly out of the window takes the panel out with it. Vertically it follows the anchor
 * out of the window too; an anchor narrower than the panel still takes all of it out, by the
 * anchor's right edge on the left side. Near the bottom of the window its height shrinks to the
 * space under the anchor, down to `--space-2` above the window edge, and the body scrolls. With
 * less space than the header and the body padding need, the panel moves up just enough to keep
 * its header in view and may cover the bottom of the anchor; it never flips above the anchor.
 * It is never shorter than that least height, so an anchor whose top is below the window takes
 * the whole panel out with it. At 375px it fills the window width less `--space-2` on each side,
 * still under its anchor: not a bottom sheet.
 *
 * Focus: the opener is the element focused at the first render. With one, focus moves to Close
 * on open; with none (focus on `body`), focus stays put. Escape and Close call `onClose`; Close
 * then focuses the opener, Escape only when focus was inside the panel. A `mousedown` outside the
 * panel and the anchor calls `onClose` and moves no focus; the anchor is not outside, so its own
 * click toggles. A `pointerdown` alone never closes it, so a touch scroll of the board keeps it
 * open, while a tap still closes it through the compatibility `mousedown`. Leaving the panel by
 * Tab does not close it.
 *
 * Escape is shared with `HoverMenu`: one Escape closes one surface, the innermost open menu or
 * popover holding focus (a menu inside the panel before the panel), else the most recently
 * opened. A popover under a layer (inside an `inert` element) ignores Escape; one inside a
 * `Modal` closes before the Modal. An Escape already handled or composing closes nothing.
 *
 * The body is not a tab stop: its content must be focusable or sit in a `TabPanel`.
 *
 * Stacking and limits: the panel is `position: fixed` at `--z-menu`, rendered in place (no
 * portal). An ancestor with `transform`, `filter` or `contain` becomes its containing block and
 * breaks the placement. Left open while a `SidePanel` opens by keyboard, it draws above that
 * panel (`--z-menu` over `--z-panel`), though inert; a mouse press closes it. Its root is a
 * stacking context: a `HoverMenu` inside stacks within the panel; in the header its menu may
 * extend past the panel, in the body the scrolling body clips it.
 */
export function Popover({
  open,
  ...props
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return <OpenPopover {...props} />;
}

/** The mounted panel: its effects run only while the popover is open. */
function OpenPopover({
  onClose,
  anchor,
  title,
  actions,
  children,
}: {
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLSpanElement>(null);
  const latest = useRef(onClose);
  // Read in the first render, before the commit, as a layer reads its opener. A server render
  // (the examples test renders each example to a string) has no document and no opener.
  const [opener] = useState(() => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  // Writes the anchor's box on the panel, not in React state: one style write per scroll frame.
  // `data-away` names the side an anchor wholly out of the window left by.
  const place = () => {
    const element = panel.current;
    const rect = anchor.current?.getBoundingClientRect();
    if (!element || !rect) return;
    const px = (value: number) => `${String(value)}px`;
    element.style.setProperty('--popover-left', px(rect.left));
    element.style.setProperty('--popover-right', px(rect.right));
    element.style.setProperty('--popover-anchor-top', px(rect.top));
    element.style.setProperty('--popover-top', px(rect.bottom));
    const away =
      rect.right <= 0 ? 'left' : rect.left >= document.documentElement.clientWidth ? 'right' : null;
    if (away) element.setAttribute('data-away', away);
    else element.removeAttribute('data-away');
  };
  useLayoutEffect(() => {
    place();
    // Scroll does not bubble: capture it on window to hear every scroller.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);
  // Again after the whole commit: a popover rendered inside its anchor runs its layout effects
  // before React attaches the anchor's ref, so the first measure finds no anchor.
  useEffect(() => {
    place();
  }, [anchor]);
  // A layout effect, as a layer's: inside a layer opening in the same commit it runs first.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    if (opener) close.current?.querySelector('button')?.focus();
    const entry: OpenMenu = {
      root: element,
      escape: () => {
        const inside = element.contains(document.activeElement);
        latest.current();
        if (inside) opener?.focus();
      },
    };
    const outside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (element.contains(target) || anchor.current?.contains(target)) return;
      latest.current();
    };
    document.addEventListener('mousedown', outside);
    addOpenMenu(entry);
    return () => {
      document.removeEventListener('mousedown', outside);
      removeOpenMenu(entry);
    };
  }, []);
  return (
    <div ref={panel} className={styles.root} role="dialog" aria-labelledby={titleId}>
      <div className={styles.header}>
        <span id={titleId} className={styles.title}>
          {title}
        </span>
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        <span ref={close} className={styles.close}>
          <IconButton
            icon="x"
            label="Close"
            onClick={() => {
              latest.current();
              opener?.focus();
            }}
          />
        </span>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
