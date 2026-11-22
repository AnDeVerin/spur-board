import {
  autoUpdate,
  computePosition,
  flip,
  hide as hideMiddleware,
  offset,
  shift,
  size,
} from '@floating-ui/dom';
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
 * Placement comes from `@floating-ui/dom`: `computePosition` with `offset`, `size`, `flip`,
 * `shift` and `hide`, run by `autoUpdate` on any scroll of the anchor's or the panel's scrolling
 * ancestors, on resize, on a resize of either element and on a layout shift of the anchor, and
 * again when the header resizes. The panel has no frame loop of its own. It sits `--space-1`
 * under the anchor's bottom edge, starting at its left edge, and keeps `--space-2` inside the
 * window edges, or the safe-area inset on a side where it is larger; both gaps are read from the
 * panel's computed style at each update. The panel is hidden (`display: none`, so nothing inside
 * can show itself and its controls leave the tab order) while the anchor is out of view: out of
 * the window or clipped away by a scroller such as a board strip. Clipping follows the anchor's
 * containing-block chain, a `transform`, `filter` or `contain` ancestor included. A hide that
 * would take focus with it moves focus to the trigger first, and the panel showing again gives
 * it back, unless the element left the panel or focus moved on from the trigger.
 *
 * An open panel renders hidden (`data-away="pending"`) until its first placement, and a placement
 * that shows a hidden panel places it once more, so its first shown position uses its rendered
 * size. It closes (calls `onClose` once, moving no focus) when its anchor element unmounts or
 * leaves the document, or when the column re-renders a different element under the same ref: the
 * panel belongs to an element that is gone. Every commit and every DOM change reads the ref
 * again. Until an anchor attaches, as when both mount in one commit, the panel stays pending. A
 * caller that passes a new ref object retargets the panel to it, pending until that ref attaches,
 * and an anchor moved under another parent is tracked again from there. Every placement update
 * (a scroll, a resize, a layout shift) reads the ref again too, so a `ref.current` swap with
 * neither a commit nor a DOM change is seen at the next one.
 *
 * Height: it shrinks to the space under the anchor, down to that bottom edge, and the body
 * scrolls. It is never shorter than its least height: the header as rendered (so tabs that wrap
 * to two rows count) and one standard control (`--size-control`) in the padded body. With less
 * room than that under the anchor, it flips above the anchor (`top-start`); when neither side has
 * room it shifts to keep its header in the window. At 375px it fills the window width less
 * `--space-2` on each side (or the safe-area inset), still next to its anchor: not a bottom
 * sheet.
 *
 * Focus: `trigger` is the element that opens the panel (the caller's control with
 * `aria-expanded`); the opener is the element focused at the first render. With an opener, focus
 * moves to Close on the first placement that shows the panel, if it is still on the opener; with
 * none (focus on `body`, as after a click in Safari or an open from the URL), focus stays put.
 * Escape and Close call `onClose` and return focus to `trigger`, else,
 * while it is not attached, to the opener: in Safari a click does not focus the trigger, so the
 * opener may be an unrelated control. Close always returns it; Escape only when focus was inside
 * the panel, or on `body` while the panel was shown: a hidden panel (its anchor out of view, its
 * trigger maybe offscreen) closed from `body` leaves focus there. Every handler (placement, the
 * press outside, Escape and Close) reads the current `anchor` and `trigger`, so a caller may swap
 * either ref while the panel is open. Every focus move, the one to Close on open included, uses
 * `preventScroll`: returning to a trigger scrolled out of its strip leaves the strip where it is.
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
 * Stacking and limits: the panel is `position: fixed` at `--z-menu`, or at `--z-panel` with
 * `layer="panel"`, rendered in place (no portal). A `transform`, `filter` or `contain` ancestor
 * of the panel becomes its containing block: the position follows it, but the panel's width
 * (`100%` is that ancestor's), the ancestor's overflow clipping and its z stacking within its
 * stacking context do not escape it. A `display: contents` wrapper clips nothing. An anchor
 * spanning both edges of an empty visible area (a scroller wholly outside the window) counts as
 * in view. At the default layer, left open while a `SidePanel` opens by keyboard, it draws above
 * that panel (`--z-menu` over `--z-panel`), though inert; a mouse press closes it. At
 * `layer="panel"` a `HoverMenu` outside it, as one in its anchor, opens over it, and a `SidePanel`
 * opened while it is open draws over it (same z, the SidePanel's layer portals later in `body`).
 * Its root is a stacking context: a `HoverMenu` inside stacks within the panel. Beside the title
 * its menu may extend past the panel; in `actions`, which scrolls sideways when its content is
 * wider than the room beside Close (Close always stays in the panel), and in the body, the scroll
 * box clips it.
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
  /** `panel` stacks it at `--z-panel`, under the menus of its anchor; default `menu`. */
  layer?: 'menu' | 'panel';
  children: ReactNode;
}) {
  if (!open) return null;
  return <OpenPopover {...props} />;
}

const px = (value: number) => `${String(value)}px`;

/** The mounted panel: its effects run only while the popover is open. */
function OpenPopover({
  onClose,
  anchor,
  trigger,
  title,
  actions,
  layer = 'menu',
  children,
}: {
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  title: ReactNode;
  actions?: ReactNode;
  layer?: 'menu' | 'panel';
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLSpanElement>(null);
  // The move to Close on open, held until a placement shows the panel.
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
  // The focused element a hide moved focus away from, to restore when the panel shows again.
  const parked = useRef<HTMLElement | null>(null);
  // Hiding the panel would drop focus to the page: move it to the trigger first.
  const hide = (element: HTMLElement, away: 'hidden' | 'pending') => {
    const active = document.activeElement;
    if (
      !element.hasAttribute('data-away') &&
      active instanceof HTMLElement &&
      element.contains(active)
    ) {
      parked.current = active;
      returnTarget()?.focus({ preventScroll: true });
    }
    if (element.getAttribute('data-away') !== away) element.setAttribute('data-away', away);
  };
  // Shown again: focus goes back where it was, unless the element left the panel or focus moved
  // on from the trigger meanwhile.
  const show = (element: HTMLElement) => {
    element.removeAttribute('data-away');
    const held = parked.current;
    parked.current = null;
    if (held?.isConnected && element.contains(held) && document.activeElement === returnTarget())
      held.focus({ preventScroll: true });
  };
  const headerWritten = useRef(0);
  // The number of the latest placement call. A stop, a new run, a close and an unmount raise it,
  // so a result from an older call writes nothing and moves no focus.
  const calls = useRef(0);
  // The anchor element `autoUpdate` is bound to, and how to stop it.
  const run = useRef<{ element: HTMLElement; stop: () => void } | null>(null);
  // The anchor element a run was bound to, under the ref object that held it.
  const seen = useRef<{ ref: RefObject<HTMLElement | null>; element: HTMLElement } | null>(null);
  const closed = useRef(false);
  const stop = () => {
    run.current?.stop();
    run.current = null;
    calls.current++;
  };
  // One placement of the panel next to `target`.
  const place = (target: HTMLElement) => {
    const element = panel.current;
    if (!element || closed.current) return;
    const call = ++calls.current;
    const current = () => call === calls.current && !closed.current;
    const style = getComputedStyle(element);
    const near = parseFloat(style.getPropertyValue('--space-1')) || 0;
    // The window edges to keep clear, resolved by CSS from --space-2 and the safe-area insets.
    const side = (name: string) =>
      parseFloat(style.getPropertyValue(`scroll-padding-${name}`)) || 0;
    const edge = {
      top: side('top'),
      right: side('right'),
      bottom: side('bottom'),
      left: side('left'),
    };
    void computePosition(target, element, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [
        offset(near),
        // Before flip: the panel shrinks under the anchor down to its CSS least height, and only
        // a panel that still does not fit flips.
        size({
          padding: edge,
          // Whole pixels: the panel's height is read back from its computed style, which a
          // browser rounds to three decimals, so a fractional room could read back a hair over
          // itself and make flip take a panel that fits for one that overflows.
          apply: ({ availableHeight }) => {
            if (current())
              element.style.setProperty('--popover-available', px(Math.floor(availableHeight)));
          },
        }),
        flip({
          fallbackStrategy: 'initialPlacement',
          fallbackPlacements: ['top-start'],
          crossAxis: false,
          padding: edge,
        }),
        shift({ padding: edge, crossAxis: true }),
        hideMiddleware({ strategy: 'referenceHidden' }),
      ],
    }).then(({ x, y, middlewareData }) => {
      if (!current()) return;
      if (middlewareData.hide?.referenceHidden) {
        hide(element, 'hidden');
        return;
      }
      element.style.left = px(x);
      element.style.top = px(y);
      const wasHidden = element.hasAttribute('data-away');
      show(element);
      // The rendered header, which grows when its actions wrap, sets the least height. Read only
      // while shown: a hidden panel has no box. Zero means not laid out yet.
      const height = header.current?.offsetHeight ?? 0;
      const headerChanged = height > 0 && height !== headerWritten.current;
      if (headerChanged) {
        headerWritten.current = height;
        element.style.setProperty('--popover-header', px(height));
      }
      // The first placement that shows the panel takes the held move to Close, unless focus has
      // moved on since the open.
      if (pendingFocus.current) {
        pendingFocus.current = false;
        if (opener && document.activeElement === opener) focusClose();
      }
      // A hidden panel was measured with no box, and a new header height moves the least height
      // flip reacts to: place it again, before the frame paints.
      if (wasHidden || headerChanged) place(target);
    });
  };
  // Binds placement to the current anchor element. `moved`: a DOM change re-inserted the anchor,
  // so its scrolling ancestors may have changed.
  const track = (moved = false) => {
    const element = panel.current;
    if (!element || closed.current) return;
    const ref = latest.current.anchor;
    const target = ref.current;
    // The anchor unmounted, left the document, or the column re-rendered a new element under the
    // same ref: the panel belongs to an element that is gone, so it closes once. A new ref object
    // retargets.
    if (seen.current?.ref === ref && (seen.current.element !== target || !target.isConnected)) {
      stop();
      closed.current = true;
      latest.current.onClose();
      return;
    }
    // Not attached yet (it mounts in the same commit as the panel, or a new ref holds none or an
    // element not in the document yet): pending, so it neither paints at its static or old place
    // nor takes focus, until it attaches. Only an anchor bound while connected can close it.
    if (!target?.isConnected) {
      if (run.current) stop();
      hide(element, 'pending');
      return;
    }
    seen.current = { ref, element: target };
    if (run.current?.element === target && !moved) return;
    stop();
    // Each update first rereads the anchor element: a caller may swap it with no commit and no
    // DOM change, which the close and retarget rules above then apply to. Only the element
    // counts: a new ref object holding the same one keeps this run.
    const update = () => {
      if (latest.current.anchor.current === target) place(target);
      else track();
    };
    const followed = autoUpdate(target, element, update);
    // The header can grow (its actions wrap) while a capped panel keeps its outer size: neither
    // element autoUpdate watches resizes, but the least height changes.
    const resized = new ResizeObserver(update);
    if (header.current) resized.observe(header.current);
    run.current = {
      element: target,
      stop: () => {
        followed();
        resized.disconnect();
      },
    };
  };
  // After each commit: a re-render may swap the ref or replace the anchor element.
  useLayoutEffect(() => {
    track();
  });
  // Again after the whole commit: a popover rendered inside its anchor runs its layout effects
  // before React attaches the anchor's ref, so the layout effect finds no anchor.
  useEffect(() => {
    track();
  });
  // Any DOM change while open: an anchor removed, attached or moved without a re-render.
  useLayoutEffect(() => {
    const observer = new MutationObserver((records) => {
      const target = run.current?.element;
      const moved =
        target !== undefined &&
        records.some((record) =>
          [...record.addedNodes].some((node) => node === target || node.contains(target)),
        );
      track(moved);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);
  // A layout effect, as a layer's: inside a layer opening in the same commit it runs first.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    // The panel opens pending: hold the move to Close until a placement shows it.
    if (opener) pendingFocus.current = true;
    const entry: OpenMenu = {
      root: element,
      hidden: () => element.hasAttribute('data-away'),
      escape: () => {
        const active = document.activeElement;
        const onBody = !active || active === document.body;
        // A hidden panel closed from body leaves focus there: its trigger may be offscreen.
        const back = element.contains(active) || (onBody && !element.hasAttribute('data-away'));
        latest.current.onClose();
        if (back) returnTarget()?.focus({ preventScroll: true });
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
    <div
      ref={panel}
      className={styles.root}
      role="dialog"
      aria-labelledby={titleId}
      data-away="pending"
      data-layer={layer === 'panel' ? 'panel' : undefined}
    >
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
