import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
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

type Entry = {
  root: HTMLElement;
  surface: HTMLElement;
  onClose: { current: () => void };
};

// One stack for every open layer on the page; the last entry is the top layer.
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
 * Marks every element child of `body` except the top layer's root `inert`, and gives each element
 * that leaves that set its own earlier state back. With no layer open it restores everything,
 * releases the scroll lock and drops the key listener. Only the attribute is written.
 */
function sync(): void {
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

function push(entry: Entry): void {
  if (stack.length === 0) {
    priorOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
  }
  stack.push(entry);
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
 * Mounted means open. On mount it records the focused element as the opener, joins the layer
 * stack (the first layer locks `<html>` scrolling), makes everything outside the top layer
 * `inert` and focuses Close. Escape (unless already handled or composing) and a scrim click call
 * the latest `onClose` of the top layer only. Tab and Shift+Tab wrap inside the top surface and
 * pull focus back in from outside. On unmount the top layer returns focus to its opener when
 * the opener is still in the document; a lower layer moves no focus.
 *
 * Limits: elements added to `body` while a layer is open stay live until the next open or close;
 * the Tab wrap reads DOM attributes, so controls hidden only by CSS or a roving radio group can
 * break it.
 */
export function Layer({
  classNames,
  side,
  icon,
  title,
  detail,
  actions,
  onClose,
  children,
}: {
  classNames: { root?: string; surface?: string; header?: string; body?: string };
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
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useLayoutEffect(() => {
    // Read the opener before any inert write: browser focus fixup would move focus to body.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    if (!root.current || !surface.current) return;
    const entry: Entry = { root: root.current, surface: surface.current, onClose: latest };
    push(entry);
    sync();
    close.current?.querySelector('button')?.focus();
    return () => {
      const wasTop = remove(entry);
      sync();
      // After the inert recompute: focus() on an inert element is ignored.
      if (wasTop && opener?.isConnected) opener.focus();
    };
  }, []);
  const join = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');
  return createPortal(
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
          {actions !== undefined && <span className={styles.actions}>{actions}</span>}
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
    </div>,
    document.body,
  );
}
