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
  opener: HTMLElement | null;
  onClose: { current: () => void };
};

// One stack for every open layer on the page, in visual order; the last entry is the top layer.
const stack: Entry[] = [];
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

function tabbables(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(tabbableSelector)].filter((element) => {
    if (element.hasAttribute('disabled')) return false;
    const index = element.getAttribute('tabindex');
    if (index !== null && Number(index) < 0) return false;
    return element.closest('[hidden], [inert]') === null;
  });
}

function onKeyDown(event: KeyboardEvent): void {
  const top = stack.at(-1);
  if (!top || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    if (event.isComposing) return;
    event.preventDefault();
    top.onClose.current();
    return;
  }
  if (event.key !== 'Tab') return;
  const list = tabbables(top.surface);
  const first = list[0];
  const last = list.at(-1);
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !top.surface.contains(active);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault();
    first.focus();
  }
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
  const index = stack.findIndex((other) => under(entry, other));
  if (index === -1) {
    stack.push(entry);
    return undefined;
  }
  stack.splice(index, 0, entry);
  return stack[index + 1];
}

/** Removes the entry and tells whether it was the top layer. */
function remove(entry: Entry): boolean {
  const index = stack.indexOf(entry);
  if (index === -1) return false;
  stack.splice(index, 1);
  return index === stack.length;
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
 * Mounted means open. On mount it records the focused element as the opener, joins the layer
 * stack in that order (the first layer locks `<html>` scrolling), makes everything outside the
 * top layer `inert`, and focuses Close if it is the top layer. A layer that lands under another
 * (its nested layer from the same commit, whose effect ran first and took focus) takes the
 * opener of the layer right above it, which is what had focus before the commit, and moves no
 * focus. Escape (unless already handled or composing) and a scrim click call the latest
 * `onClose` of the top layer only. Tab and Shift+Tab wrap inside the top surface and pull focus
 * back in from outside. On unmount the top layer returns focus to its opener when the opener is
 * still in the document and not `inert`, otherwise to Close of the new top layer; a lower layer
 * moves no focus.
 *
 * Limits: elements added to `body` while a layer is open stay live until the next open or close;
 * the Tab wrap reads DOM attributes, so controls hidden only by CSS or a roving radio group can
 * break it.
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
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useLayoutEffect(() => {
    // Read the opener before any inert write: browser focus fixup would move focus to body.
    const active = document.activeElement;
    if (!root.current || !surface.current) return;
    const entry: Entry = {
      node,
      level: levels[level],
      root: root.current,
      surface: surface.current,
      close: close.current?.querySelector('button') ?? null,
      opener: active instanceof HTMLElement && active !== document.body ? active : null,
      onClose: latest,
    };
    const above = push(entry);
    if (above) entry.opener = above.opener;
    sync();
    if (!above) entry.close?.focus();
    return () => {
      const wasTop = remove(entry);
      sync();
      if (!wasTop) return;
      // After the inert recompute: focus() on an inert element is ignored.
      const { opener } = entry;
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
      else stack.at(-1)?.close?.focus();
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
