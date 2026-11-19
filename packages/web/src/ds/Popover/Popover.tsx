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
 * `aria-modal`, labelled by `title`. Controlled: it renders while `open` and calls `onClose`.
 * `anchor` is the element it sits under; `trigger` is the caller's control that opens it, which
 * carries `aria-expanded` and takes focus back on close. The header holds the title at the left,
 * then `actions` (e.g. an underline `Tabs`), then Close; the body scrolls.
 *
 * Placement: it sits `--space-1` under the anchor's bottom edge, starting at its left edge, and
 * follows the anchor on any scroll (a nested scroller included), on resize, and on any layout
 * change: it measures the anchor every animation frame while open and writes only a change. While
 * the anchor is in view the panel keeps `--space-2` inside the window edges. In view means the
 * anchor's box meets the visible area: the window cut, per axis, by the padding box of every
 * ancestor on the anchor's containing-block chain whose overflow clips, up to `body`. As in CSS,
 * an absolute anchor is clipped only from its nearest positioned ancestor up, and a fixed one by
 * none. An empty visible area (a scroller wholly outside the window) is not in view. An anchor out
 * of view, out of the window or clipped away by a scroller such as a board strip, hides the panel
 * (`display: none`, so nothing inside can show itself and its controls leave the tab order). With
 * no anchor (its element unmounted while the panel stays open, or not attached yet when both mount
 * in one commit) the panel hides the same way until the ref attaches.
 *
 * Near the bottom of the window its height shrinks to the space under the anchor, down to
 * `--space-2` above the window edge, and the body scrolls. With less space than the header as
 * rendered (measured each frame, so tabs that wrap to two rows count) and one standard control
 * (`--size-control`) in the padded body need, the panel moves up just enough to keep them in view
 * and may cover the bottom of the anchor; it never flips above the anchor.
 * It is never shorter than that least height, so it slides out whole with an anchor whose top is
 * below the window. At 375px it fills the window width less `--space-2` on each side, still under
 * its anchor: not a bottom sheet.
 *
 * Focus: `trigger` is the element that opens the panel (the caller's control with
 * `aria-expanded`); the opener is the element focused at the first render. With an opener, focus
 * moves to Close on open, or on the first placement that shows the panel when it opens hidden;
 * with none (focus on `body`, as after a click in Safari or an open from the URL), focus stays
 * put. Escape and Close call `onClose` and return focus to `trigger`, else,
 * while it is not attached, to the opener: in Safari a click does not focus the trigger, so the
 * opener may be an unrelated control. Close always returns it; Escape only when focus was inside
 * the panel or on `body`. Every handler (placement, the press outside, Escape and Close) reads the
 * current `anchor` and `trigger`, so a caller may swap either ref while the panel is open. Every
 * focus move, the one to Close on open included, uses `preventScroll`: returning to a trigger
 * scrolled out of its strip leaves the strip where it is.
 *
 * A `mousedown` outside the panel, the anchor and the trigger calls `onClose` and moves no focus;
 * the anchor and the trigger are not outside, so the trigger's own click toggles. Under a layer
 * (inside an `inert` element), as when a `Modal` opened from the panel portals to `body`, no press
 * is outside: the popover stays open under the layer. A `pointerdown` alone never closes it, so a
 * touch scroll of the board keeps it open, while a tap still closes it through the compatibility
 * `mousedown`. Leaving the panel by Tab does not close it.
 *
 * Escape is shared with `HoverMenu`: one Escape closes one surface, the innermost open menu or
 * popover holding focus (a menu inside the panel before the panel), else the most recently
 * opened one that is shown, else the most recently opened hidden one. A popover under a layer
 * (inside an `inert` element) ignores Escape; one inside a `Modal` closes before the Modal. An
 * Escape already handled or composing closes nothing.
 *
 * The body is not a tab stop: its content must be focusable or sit in a `TabPanel`.
 *
 * Stacking and limits: the panel is `position: fixed` at `--z-menu`, rendered in place (no
 * portal). An ancestor with `transform`, `filter` or `contain` becomes its containing block and
 * breaks the placement; such an ancestor of a fixed anchor, which would clip it, is not followed
 * by the in-view test either. Left open while a `SidePanel` opens by keyboard, it draws above that
 * panel (`--z-menu` over `--z-panel`), though inert; a mouse press closes it. Its root is a
 * stacking context: a `HoverMenu` inside stacks within the panel. Beside the title its menu may
 * extend past the panel; in `actions`, which scrolls sideways when its content is wider than the
 * room beside Close (Close always stays in the panel), and in the body, the scroll box clips it.
 */
export function Popover({
  open,
  ...props
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return <OpenPopover {...props} />;
}

type Area = { left: number; top: number; right: number; bottom: number };

/**
 * Where `element` can show: the window cut, per axis, by the padding box of every ancestor on its
 * containing-block chain whose overflow on that axis clips. Following the CSS rule, a box in flow
 * is clipped by its parent's overflow, an absolute box only by its nearest positioned ancestor's
 * and those above it, and a fixed box by none. `body` and the root are left out (their overflow
 * goes to the window), and inline and `display: contents` ancestors clip nothing. A `transform`,
 * `filter` or `contain` ancestor, which makes a fixed box's containing block, is not followed
 * (the limit the Popover doc comment states). An empty result means nothing is visible.
 */
function visibleArea(element: HTMLElement): Area {
  const root = document.documentElement;
  const area: Area = { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight };
  // The position of the last box on the chain: it decides which ancestor holds it next.
  let position = getComputedStyle(element).position;
  for (
    let node = element.parentElement;
    node && node !== document.body && node !== root && position !== 'fixed';
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    // An absolute box skips static ancestors up to its containing block.
    if (position === 'absolute' && (style.position === '' || style.position === 'static')) continue;
    position = style.position;
    if (style.display === 'inline' || style.display === 'contents') continue;
    const clipsX = style.overflowX !== '' && style.overflowX !== 'visible';
    const clipsY = style.overflowY !== '' && style.overflowY !== 'visible';
    if (!clipsX && !clipsY) continue;
    const box = node.getBoundingClientRect();
    const left = box.left + node.clientLeft;
    const top = box.top + node.clientTop;
    if (clipsX) {
      area.left = Math.max(area.left, left);
      area.right = Math.min(area.right, left + node.clientWidth);
    }
    if (clipsY) {
      area.top = Math.max(area.top, top);
      area.bottom = Math.min(area.bottom, top + node.clientHeight);
    }
  }
  return area;
}

/** The mounted panel: its effects run only while the popover is open. */
function OpenPopover({
  onClose,
  anchor,
  trigger,
  title,
  actions,
  children,
}: {
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLSpanElement>(null);
  // The move to Close on open, held while the panel is hidden (an anchor not attached yet).
  const pendingFocus = useRef(false);
  const focusClose = () => {
    close.current?.querySelector('button')?.focus({ preventScroll: true });
  };
  // The latest props every handler reads, so none holds a ref object from an earlier render: a
  // caller may swap `anchor` or `trigger` while the panel stays open.
  const latest = useRef({ onClose, anchor, trigger });
  // Read in the first render, before the commit, as a layer reads its opener. A server render
  // (the examples test renders each example to a string) has no document and no opener.
  const [opener] = useState(() => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  useLayoutEffect(() => {
    latest.current = { onClose, anchor, trigger };
  });
  // Where Escape and Close send focus: the trigger, else the opener. The trigger comes first: in
  // Safari a click does not focus it, so the opener may be an unrelated control.
  const returnTarget = (): HTMLElement | null => latest.current.trigger.current ?? opener;
  // The values last written, so an unchanged frame writes nothing.
  const written = useRef('');
  const headerWritten = useRef(0);
  // Writes the anchor's box on the panel, not in React state, and only when it changed.
  // `data-away` names the side an anchor out of view left by, `empty` when nothing of the window
  // is visible to it (a scroller wholly outside the window), or `detached` with no anchor (its
  // element unmounted); the frame loop places the panel again once the ref attaches.
  const place = () => {
    const element = panel.current;
    if (!element) return;
    const target = latest.current.anchor.current;
    if (!target) {
      if (written.current !== 'detached') element.setAttribute('data-away', 'detached');
      written.current = 'detached';
      return;
    }
    const rect = target.getBoundingClientRect();
    const view = visibleArea(target);
    let away: 'left' | 'right' | 'top' | 'bottom' | 'empty' | null = null;
    if (view.left >= view.right || view.top >= view.bottom) away = 'empty';
    else if (rect.right <= view.left) away = 'left';
    else if (rect.left >= view.right) away = 'right';
    else if (rect.bottom <= view.top) away = 'top';
    else if (rect.top >= view.bottom) away = 'bottom';
    const px = (value: number) => `${String(value)}px`;
    const values = [rect.left, rect.right, rect.top, rect.bottom, away].join(' ');
    if (values !== written.current) {
      written.current = values;
      element.style.setProperty('--popover-left', px(rect.left));
      element.style.setProperty('--popover-right', px(rect.right));
      element.style.setProperty('--popover-anchor-top', px(rect.top));
      element.style.setProperty('--popover-top', px(rect.bottom));
      if (away) element.setAttribute('data-away', away);
      else element.removeAttribute('data-away');
    }
    if (away) return;
    // The rendered header, which grows when its actions wrap, sets the least height. Read only
    // while shown: a hidden panel has no box. Zero means not laid out yet.
    const height = header.current?.offsetHeight ?? 0;
    if (height > 0 && height !== headerWritten.current) {
      headerWritten.current = height;
      element.style.setProperty('--popover-header', px(height));
    }
    // The first placement that shows the panel takes the held move to Close, unless focus has
    // moved on since the open.
    if (pendingFocus.current) {
      pendingFocus.current = false;
      if (document.activeElement === opener) focusClose();
    }
  };
  useLayoutEffect(() => {
    place();
    // Every frame while open: the anchor also moves on a layout change with no scroll or resize,
    // such as a column before it growing.
    let frame = 0;
    const tick = () => {
      place();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Scroll does not bubble: capture it on window to hear every scroller. These place the panel
    // in the same task as the scroll; the frame loop then finds nothing changed.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, []);
  // Again after the whole commit: a popover rendered inside its anchor runs its layout effects
  // before React attaches the anchor's ref, so the first measure finds no anchor.
  useEffect(() => {
    place();
  }, []);
  // A layout effect, as a layer's: inside a layer opening in the same commit it runs first.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    // A hidden panel cannot take focus: hold the move until a placement shows it.
    if (opener && element.hasAttribute('data-away')) pendingFocus.current = true;
    else if (opener) focusClose();
    const entry: OpenMenu = {
      root: element,
      hidden: () => element.hasAttribute('data-away'),
      escape: () => {
        const active = document.activeElement;
        const inside = !active || active === document.body || element.contains(active);
        latest.current.onClose();
        if (inside) returnTarget()?.focus({ preventScroll: true });
      },
    };
    const outside = (event: MouseEvent) => {
      const target = event.target;
      // Under a layer, such as a Modal opened from the panel, a press on the layer is not outside.
      if (!(target instanceof Node) || element.closest('[inert]')) return;
      // The anchor and the trigger are not outside, so the trigger's own click toggles.
      const { anchor: current, trigger: opens } = latest.current;
      if ([element, current.current, opens.current].some((node) => node?.contains(target))) return;
      latest.current.onClose();
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
      <div ref={header} className={styles.header}>
        <span id={titleId} className={styles.title}>
          {title}
        </span>
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        <span ref={close} className={styles.close}>
          <IconButton
            icon="x"
            label="Close"
            onClick={() => {
              latest.current.onClose();
              returnTarget()?.focus({ preventScroll: true });
            }}
          />
        </span>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
