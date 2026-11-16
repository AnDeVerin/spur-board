import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import styles from './Scrim.module.css';

/**
 * The dimmed backdrop behind a layer. It fills its nearest positioned ancestor and is
 * pointer-only (`aria-hidden`): a click calls `onClick`, and the layer's Escape is the keyboard
 * equivalent.
 */
export function Scrim({ onClick }: { onClick?: (() => void) | undefined }) {
  return <div className={styles.scrim} aria-hidden="true" onClick={onClick} />;
}

// One per mounted `Layer`, linked to the layer it renders inside.
type LayerNode = { parent: LayerNode | null };
const LayerContext = createContext<LayerNode | null>(null);

// The z order of the layer roots: `--z-panel` under `--z-modal`.
const levels = { panel: 0, modal: 1 };

type Entry = {
  node: LayerNode;
  level: number;
  root: HTMLElement;
  surface: HTMLElement;
  close: HTMLElement | null;
  // Where focus goes when this layer closes on top: its own opener first, then the openers of
  // layers under it that left the stack before it, in the order they left.
  openers: HTMLElement[];
  onClose: { current: () => void };
};

// One stack for every open layer on the page, in visual order; the last entry is the top layer.
const stack: Entry[] = [];
// The roots of layers that left the stack and may still be in the document until React removes
// their portals later in the same commit; focus never returns into one.
const departed = new Set<HTMLElement>();
// Each element this module made inert, with its own `inert` state from before.
const priorInert = new Map<Element, boolean>();
let priorOverflow = '';

const tabbableSelector = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ');

const formControls = 'button, input, select, textarea';

/**
 * A form control's real disabled state, as `:disabled` reads it: its own `disabled`, or a
 * `fieldset[disabled]` ancestor unless the control sits in that fieldset's first `legend` child.
 * Written out because happy-dom's `:disabled` checks only the attribute.
 */
function disabled(element: HTMLElement): boolean {
  if (!element.matches(formControls)) return false;
  if (element.hasAttribute('disabled')) return true;
  for (
    let fieldset = element.parentElement?.closest('fieldset[disabled]');
    fieldset;
    fieldset = fieldset.parentElement?.closest('fieldset[disabled]')
  ) {
    const legend = [...fieldset.children].find((child) => child.localName === 'legend');
    if (!legend?.contains(element)) return true;
  }
  return false;
}

/**
 * The `tabindex` of a candidate: its attribute, or 0 when absent or not an integer. Read from the
 * attribute because happy-dom's `tabIndex` is -1 for a button with none.
 */
function tabOrder(element: Element): number {
  const index = Number.parseInt(element.getAttribute('tabindex') ?? '', 10);
  return Number.isNaN(index) ? 0 : index;
}

/** The name of the radio group an element belongs to, or null; `sameGroup` adds the form. */
function radioGroup(element: Element): string | null {
  if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name)
    return null;
  return element.name;
}

const sameGroup = (one: Element, other: Element) =>
  radioGroup(one) !== null &&
  radioGroup(one) === radioGroup(other) &&
  (one as HTMLInputElement).form === (other as HTMLInputElement).form;

/**
 * The candidate stops of the surface in sequential order: positive `tabindex` ascending, then the
 * rest in document order. Only DOM attributes decide; whether a candidate takes focus (CSS can hide
 * it) is found by focusing it. A radio group with a checked radio offers only that radio.
 */
function tabbables(surface: HTMLElement): HTMLElement[] {
  const found = [...surface.querySelectorAll<HTMLElement>(tabbableSelector)].filter((element) => {
    if (disabled(element)) return false;
    if (radioGroup(element) && !(element as HTMLInputElement).checked) {
      const checked = [...surface.querySelectorAll<HTMLInputElement>('input[type=radio]')].some(
        (other) => other.checked && sameGroup(element, other),
      );
      if (checked) return false;
    }
    return tabOrder(element) >= 0 && element.closest('[hidden], [inert]') === null;
  });
  const positive = found.filter((element) => tabOrder(element) > 0);
  positive.sort((one, other) => tabOrder(one) - tabOrder(other));
  return [...positive, ...found.filter((element) => tabOrder(element) === 0)];
}

/**
 * Tab and Shift+Tab in the top layer: the layer always moves focus itself, to the next candidate
 * in the direction of travel that takes focus, wrapping at the ends. From focus outside the
 * surface, Tab starts at the first candidate and Shift+Tab at the last; from an element that is
 * not a candidate, at the first candidate past it in document order. The rest of the active
 * element's radio group is skipped. When no other candidate takes focus, focus stays put.
 */
function moveFocus(surface: HTMLElement, back: boolean): void {
  const stops = tabbables(surface);
  if (back) stops.reverse();
  const active = document.activeElement;
  let start = 0;
  if (active instanceof HTMLElement && surface.contains(active)) {
    const index = stops.indexOf(active);
    const past = back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    start =
      index === -1
        ? stops.findIndex((stop) => active.compareDocumentPosition(stop) & past)
        : index + 1;
    if (start === -1) start = 0;
  }
  const order = [...stops.slice(start), ...stops.slice(0, start)].filter(
    (stop) => stop !== active && !(active && sameGroup(stop, active)),
  );
  focusFirst(order);
}

function onKeyDown(event: KeyboardEvent): void {
  const top = stack.at(-1);
  if (!top || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    top.onClose.current();
    return;
  }
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  moveFocus(top.surface, event.shiftKey);
}

/** Focuses the first candidate that takes focus; tells whether one did. */
function focusFirst(candidates: Iterable<HTMLElement>): boolean {
  for (const candidate of candidates) {
    candidate.focus();
    if (document.activeElement === candidate) return true;
  }
  return false;
}

/**
 * Keeps the layer roots in `body` in stack order, so that paint order (document order within one
 * z level) equals the stack: walking down from the top, a root found after the root above it
 * moves right before that root. The top root never moves; React inserts a nested layer's root
 * before its parent's in one commit, and only then does a lower root land out of order.
 *
 * Then marks every element child of `body` except the top layer's root `inert`, and gives each
 * element that leaves that set its own earlier state back. With no layer open it restores
 * everything, releases the scroll lock and drops the key listener. Only the attribute is written.
 */
function sync(): void {
  for (let index = stack.length - 2; index >= 0; index--) {
    const { root } = stack[index] as Entry;
    const above = (stack[index + 1] as Entry).root;
    const inBody = root.parentNode === document.body && above.parentNode === document.body;
    if (inBody && root.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_PRECEDING)
      document.body.insertBefore(root, above);
  }
  const top = stack.at(-1);
  const targets = new Set<Element>(
    top ? [...document.body.children].filter((element) => element !== top.root) : [],
  );
  for (const [element, prior] of priorInert)
    if (!targets.has(element)) {
      element.toggleAttribute('inert', prior);
      priorInert.delete(element);
    }
  for (const element of targets)
    if (!priorInert.has(element)) {
      priorInert.set(element, element.hasAttribute('inert'));
      element.setAttribute('inert', '');
    }
  if (!top) {
    document.documentElement.style.overflow = priorOverflow;
    window.removeEventListener('keydown', onKeyDown);
  }
}

/** Whether `entry` sits under `other`: a lower level, or the same level and an ancestor of it. */
function under(entry: Entry, other: Entry): boolean {
  if (entry.level !== other.level) return entry.level < other.level;
  for (let node = other.node.parent; node; node = node.parent) if (node === entry.node) return true;
  return false;
}

/** Inserts the entry under the first entry it sits under, else on top; returns the one above. */
function push(entry: Entry): Entry | undefined {
  if (stack.length === 0) {
    priorOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
  }
  departed.delete(entry.root);
  const index = stack.findIndex((other) => under(entry, other));
  if (index === -1) {
    stack.push(entry);
    return undefined;
  }
  stack.splice(index, 0, entry);
  return stack[index + 1];
}

/**
 * Removes the entry and tells whether it was the top layer. A lower entry hands its openers to
 * every entry above it: an opener of one of those may sit inside its root, which leaves with it.
 */
function remove(entry: Entry): boolean {
  const index = stack.indexOf(entry);
  if (index === -1) return false;
  stack.splice(index, 1);
  departed.add(entry.root);
  for (const other of stack.slice(index)) other.openers.push(...entry.openers);
  return index === stack.length;
}

/**
 * Focus after the top entry left: the first of its openers that is in the document, not `inert`
 * and not inside a layer root that left the stack, and that takes focus; else Close of the new
 * top layer.
 */
function returnFocus(entry: Entry): void {
  for (const root of departed) if (!root.isConnected) departed.delete(root);
  const live = entry.openers.filter(
    (opener) =>
      opener.isConnected &&
      !opener.closest('[inert]') &&
      ![...departed].some((root) => root.contains(opener)),
  );
  if (!focusFirst(live)) stack.at(-1)?.close?.focus();
}

/**
 * The shell `Modal` and `SidePanel` share; internal to the design system, not exported from
 * `index.ts`. It portals into `body` a root holding a `Scrim` and a `role="dialog"` surface:
 * a header with the optional icon, the title (the dialog's label), the optional detail and
 * actions, and Close, then a scrolling body that is a tab stop.
 *
 * The stack follows visual order, not effect order: a `modal` layer sits above every `panel`
 * layer (`--z-modal` over `--z-panel`); within one level a layer rendered inside another sits
 * above it, even when both mount in one commit, where React runs the inner effect first; other
 * layers of one level stack in mount order, so siblings mounting in one commit keep render order.
 * Paint order equals stack order: the layer roots stay in `body` in stack order (`sync` moves a
 * lower root that React inserted after a higher one), so a layer above another of the same level
 * also paints above it.
 *
 * Mounted means open. The opener is the element focused at the layer's first render: before the
 * commit, so a descendant's `autoFocus` or mount layout effect, which run before the layer's
 * effect, is never taken for it. On mount the layer joins the stack in that order (the first layer
 * locks `<html>` scrolling), makes everything outside the top layer `inert`, and, if it is the top
 * layer, focuses Close unless a descendant already took focus inside its surface (`autoFocus`
 * wins). A layer that lands under another (its nested layer from the same commit, whose effect
 * ran first) takes the openers of the layer right above it and moves no focus. Escape (unless
 * already handled or composing) and a scrim click call the latest `onClose` of the top layer only.
 *
 * The top layer moves every Tab and Shift+Tab itself (unless already handled, composing, or with
 * Ctrl, Alt or Meta): to the next candidate in tab order (positive `tabindex` first, then document
 * order) that actually takes focus, wrapping at the ends; focus outside the surface comes back to
 * the first or last candidate. Candidates come from DOM attributes (disabled controls, a
 * `disabled` fieldset, `hidden`, `inert` and negative `tabindex` are left out; a radio group with
 * a checked radio offers only that one, and the rest of the focused radio's group is skipped), and
 * each is focused and checked, so a control hidden by CSS or otherwise refusing focus is passed
 * over and focus never leaves the layer. Moving focus itself, not trusting the browser to move it
 * when the active element is not the last stop, is what keeps a CSS-hidden control from letting
 * focus out: attributes cannot tell what CSS hides, and the browser would skip it.
 *
 * On unmount a lower layer moves no focus and hands its openers to the layers above it, whose
 * own opener may be inside it (a panel closed with its modal open, or both closed in one render).
 * The top layer returns focus to the first of its openers, then the handed ones, that is still in
 * the document, not `inert`, not inside a layer that left the stack and takes focus; otherwise to
 * Close of the new top layer.
 *
 * Limits: elements added to `body` while a layer is open stay live until the next open or close.
 * Tab skips what the candidate selector does not list but a browser may focus (a scroll container
 * Chrome makes focusable, `iframe`, media controls), and Tab inside an `iframe` is the frame's own.
 */
export function Layer({
  level,
  classNames,
  side,
  icon,
  title,
  detail,
  actions,
  onClose,
  children,
}: {
  level: keyof typeof levels;
  classNames: {
    root?: string;
    surface?: string;
    header?: string;
    actions?: string;
    body?: string;
  };
  side?: string | undefined;
  icon?: IconName | undefined;
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLSpanElement>(null);
  const latest = useRef(onClose);
  const parent = useContext(LayerContext);
  const [node] = useState<LayerNode>(() => ({ parent }));
  // Read in the first render, before the commit: a descendant's `autoFocus` or mount layout
  // effect runs before this layer's effect and would otherwise be read as the opener.
  const [opener] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useLayoutEffect(() => {
    if (!root.current || !surface.current) return;
    const entry: Entry = {
      node,
      level: levels[level],
      root: root.current,
      surface: surface.current,
      close: close.current?.querySelector('button') ?? null,
      openers: opener ? [opener] : [],
      onClose: latest,
    };
    const above = push(entry);
    if (above) entry.openers = [...above.openers];
    sync();
    // A descendant that took focus on mount keeps it.
    const active = document.activeElement;
    if (!above && !(active && entry.surface.contains(active))) entry.close?.focus();
    return () => {
      const wasTop = remove(entry);
      sync();
      if (!wasTop) return;
      // After the inert recompute: focus() on an inert element is ignored.
      returnFocus(entry);
    };
  }, []);
  const join = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');
  return createPortal(
    <LayerContext value={node}>
      <div className={classNames.root} ref={root}>
        <Scrim
          onClick={() => {
            latest.current();
          }}
        />
        <div
          ref={surface}
          className={join(styles.surface, classNames.surface)}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-side={side}
        >
          <div className={join(styles.header, classNames.header)}>
            {icon !== undefined && <Icon name={icon} />}
            <span id={titleId} className={styles.title}>
              {title}
            </span>
            {detail !== undefined && <span className={styles.detail}>{detail}</span>}
            {actions !== undefined && (
              <span className={join(styles.actions, classNames.actions)}>{actions}</span>
            )}
            <span ref={close} className={styles.close}>
              <IconButton
                icon="x"
                label="Close"
                onClick={() => {
                  latest.current();
                }}
              />
            </span>
          </div>
          <div className={join(styles.body, classNames.body)} tabIndex={0}>
            {children}
          </div>
        </div>
      </div>
    </LayerContext>,
    document.body,
  );
}
