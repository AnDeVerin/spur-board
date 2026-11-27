import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import styles from './HoverMenu.module.css';

export type HoverMenuItem<V extends string> = {
  value: V;
  label: string;
  icon?: IconName;
  /** Listed but not chosen: it keeps roving focus and is announced as disabled. */
  disabled?: boolean;
  /** A short line under the item, meant for a disabled one: why it cannot be chosen now. */
  cause?: string;
  /** Items of one group sit together; a rule separates a group from the one before it. */
  group?: string;
};

/** Both menu item roles, in DOM order: the roving focus and the open target walk these. */
const itemSelector = '[role="menuitemradio"], [role="menuitem"]';

/** An open surface; `hidden` tells when it is not shown, as a Popover whose anchor left. */
export type OpenMenu = { root: HTMLElement; escape: () => void; hidden?: () => boolean };

/**
 * Open menus and popovers in registration order; one document key listener serves them all while
 * any is open. Registration order is not nesting order: a child's effect runs before its parent's.
 */
const openMenus: OpenMenu[] = [];

/**
 * Closes one menu or popover per Escape: the innermost live entry holding focus (one whose root
 * contains no other live entry holding focus), else the most recently registered live one that
 * is shown (not inside a `hidden` entry), else the most recently registered live one. An
 * entry under a layer (inside an `inert` element) is not live. The listener sits on `document`,
 * so it runs before the layer's `window` listener, which skips the handled event.
 */
function onEscape(event: globalThis.KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  const live = openMenus.filter((menu) => menu.root.closest('[inert]') === null);
  const focused = live.filter((menu) => menu.root.contains(document.activeElement));
  // A surface inside a hidden one is hidden too.
  const shown = live.filter(
    (menu) =>
      !openMenus.some((other) => other.hidden?.() === true && other.root.contains(menu.root)),
  );
  const target =
    focused.find(
      (menu) => !focused.some((other) => other !== menu && menu.root.contains(other.root)),
    ) ??
    shown.at(-1) ??
    live.at(-1);
  if (!target) return;
  event.preventDefault();
  target.escape();
}

/**
 * Registers an open surface for the shared Escape; internal to the design system, not exported
 * from `index.ts`. Callers: `HoverMenu` and `Popover`.
 */
export function addOpenMenu(entry: OpenMenu): void {
  if (openMenus.length === 0) document.addEventListener('keydown', onEscape);
  openMenus.push(entry);
}

/** Unregisters a surface `addOpenMenu` registered; the last one drops the key listener. */
export function removeOpenMenu(entry: OpenMenu): void {
  const index = openMenus.indexOf(entry);
  if (index !== -1) openMenus.splice(index, 1);
  if (openMenus.length === 0) document.removeEventListener('keydown', onEscape);
}

/**
 * A small icon trigger whose menu opens upward and end-aligned, with one radio choice checked.
 * The trigger takes `icon` or `text`, never both: `text` shows a short word or letter (a sort
 * field, `⋯`) at chevron size in place of the icon. `label` names the trigger and the menu.
 * `opens="down"` opens it downward instead, still end-aligned and touching the trigger.
 * `variant="action"` lists commands instead (`menuitem`, no checked state or tick, no `value`):
 * an enabled item calls `onSelect`, closes the menu and focuses the trigger.
 *
 * - An item may be `disabled`, with a `cause` line under it that its `aria-describedby` names.
 *   A disabled item stays in the roving focus, as the ARIA menu pattern keeps disabled items:
 *   arrows, Home and End land on it, and opening by keyboard focuses it when it comes first, so
 *   a keyboard or screen reader user hears it and its cause. Click, Enter and Space do nothing
 *   there and the menu stays open. Its content is dimmed, not the ring.
 * - Items with a `group` other than the item before them start after a rule.
 * - `note` is a last line of text under the items that the menu's `aria-describedby` names.
 * - With no items the empty box still opens: render no HoverMenu with nothing to list.
 *
 * - Mouse or pen hover opens it; the pointer may cross from the trigger into the menu. Leaving
 *   closes it unless a click or a key pinned it, and entering never unpins it. Touch hover is
 *   ignored.
 * - A click or tap opens it pinned with focus on the checked item (or the first); a second click
 *   or tap on a pinned menu closes it. Enter and Space arrive as a click with `detail` 0 and only
 *   ever open, so a Space keyup cannot close what keydown opened. ArrowDown opens it as well.
 * - Arrows wrap, Home and End jump; Tab and choosing an item close it and focus the trigger.
 * - Escape closes it from anywhere while open and returns focus to the trigger when focus was
 *   inside; a pointer down outside closes it. One Escape closes one menu or `Popover`: the
 *   innermost open one holding focus (a menu inside a popover before the popover), else the most
 *   recently opened. A menu under a layer (inside an `inert` element) ignores Escape, so the top
 *   Modal or SidePanel closes instead; a menu in the element a layer keeps live still closes
 *   first. An Escape already handled (`defaultPrevented`) or composing closes no menu.
 *
 * `defaultOpen` renders it open and pinned on mount without moving focus.
 *
 * Controlled: with `open` given, the parent owns the open state and `defaultOpen` is ignored.
 * Every open or close the menu would make (hover enter and leave, click, ArrowDown, an item,
 * Tab, Escape, a pointer down outside) calls `onOpenChange` instead, only on a real change, and
 * shows only once the parent passes the new `open`; `onOpenChange` also reports changes in the
 * uncontrolled mode. Each open request sets its own intent: a hover opens unpinned without
 * moving focus, a click or ArrowDown pinned with focus on the checked item. A request the parent
 * declines (`open` stays false) and any close, a parent's included, drop that intent, so a later
 * hover-open closes on leave. Escape and a pointer down outside report through the current
 * `onOpenChange`, also one passed while the menu is open.
 *
 * Any close, a parent's included, that drops focus from inside the menu (focus then on nothing,
 * `body` or a removed node) moves it to the trigger; a menu opened by click or key in the same
 * update still moves it on to its checked item.
 */
export function HoverMenu<V extends string>({
  label,
  icon,
  text,
  items,
  value,
  onSelect,
  defaultOpen = false,
  opens = 'up',
  variant = 'choice',
  note,
  open: controlled,
  onOpenChange,
}: {
  label: string;
  items: readonly HoverMenuItem<V>[];
  onSelect: (value: V) => void;
  defaultOpen?: boolean;
  /** Controlled open state; the menu then reports every change through `onOpenChange`. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  opens?: 'up' | 'down';
  note?: string | undefined;
} & ({ icon: IconName; text?: undefined } | { text: string; icon?: undefined }) &
  ({ variant?: 'choice'; value?: V | undefined } | { variant: 'action'; value?: undefined })) {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlled ?? inner;
  // Every internal open and close: the parent decides when it owns the state.
  const setOpen = (next: boolean) => {
    if (next === open) return;
    if (controlled === undefined) setInner(next);
    onOpenChange?.(next);
  };
  const pinned = useRef(controlled === undefined && defaultOpen);
  const focusOnOpen = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const action = variant === 'action';
  const focusChecked = () => {
    const current = menu.current;
    (
      current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      current?.querySelector<HTMLElement>(itemSelector)
    )?.focus();
  };
  // Counts open requests: each renders, so the effect below sees a request the parent declined.
  const [request, setRequest] = useState(0);
  // Each open request sets the whole intent: a hover neither pins nor moves focus.
  const requestOpen = (pin: boolean) => {
    pinned.current = pin;
    focusOnOpen.current = pin;
    setRequest((count) => count + 1);
    setOpen(true);
  };
  const close = () => {
    pinned.current = false;
    focusOnOpen.current = false;
    setOpen(false);
  };
  const closeToTrigger = () => {
    close();
    trigger.current?.focus();
  };
  const openPinned = () => {
    if (!open) {
      requestOpen(true);
      return;
    }
    pinned.current = true;
    focusChecked();
  };
  // Listeners added while open close through the latest render's `onOpenChange`.
  const dismiss = useEffectEvent((toTrigger: boolean) => {
    if (toTrigger) closeToTrigger();
    else close();
  });
  // Whether the last focus inside the root was in the menu.
  const focusInMenu = useRef(false);
  // Before the passive effects: a menu opened by click or key moves focus on after this.
  useLayoutEffect(() => {
    if (open) return;
    const active = document.activeElement;
    if (focusInMenu.current && (active === null || active === document.body || !active.isConnected))
      trigger.current?.focus({ preventScroll: true });
    focusInMenu.current = false;
  }, [open]);
  useEffect(() => {
    if (!open) {
      // A parent close skips `close`: no pin or pending focus outlives it.
      pinned.current = false;
      focusOnOpen.current = false;
      return;
    }
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      focusChecked();
    }
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss(false);
    };
    const element = root.current;
    const entry: OpenMenu | undefined = element
      ? {
          root: element,
          escape: () => {
            dismiss(element.contains(document.activeElement));
          },
        }
      : undefined;
    document.addEventListener('pointerdown', outside);
    if (entry) addOpenMenu(entry);
    return () => {
      document.removeEventListener('pointerdown', outside);
      if (entry) removeOpenMenu(entry);
    };
  }, [open]);
  useEffect(() => {
    // A request the parent declined (still closed after it) leaves no pin or pending focus.
    if (open) return;
    pinned.current = false;
    focusOnOpen.current = false;
  }, [request]);
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(itemSelector)];
    const current = options.findIndex((option) => option === document.activeElement);
    let index: number | undefined;
    if (event.key === 'ArrowDown') index = (current + 1) % options.length;
    if (event.key === 'ArrowUp') index = (current + options.length - 1) % options.length;
    if (event.key === 'Home') index = 0;
    if (event.key === 'End') index = options.length - 1;
    if (index !== undefined) {
      event.preventDefault();
      options[index]?.focus();
    }
    if (event.key === 'Tab') closeToTrigger();
  };
  return (
    <div
      className={styles.root}
      ref={root}
      data-opens={opens === 'down' ? 'down' : undefined}
      onFocus={(event) => {
        focusInMenu.current = menu.current?.contains(event.target) ?? false;
      }}
      onPointerOver={(event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'touch' || open) return;
        // React can synthesize two enters from a move off body after a portal has mounted there.
        const from = event.relatedTarget;
        if (from instanceof Node && event.currentTarget.contains(from)) return;
        requestOpen(false);
      }}
      onPointerLeave={() => {
        if (open && !pinned.current) close();
      }}
    >
      <button
        ref={trigger}
        className={[styles.trigger, text === undefined ? undefined : styles.text]
          .filter(Boolean)
          .join(' ')}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={(event) => {
          if (event.detail !== 0 && open && pinned.current) close();
          else openPinned();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openPinned();
          }
        }}
      >
        {icon === undefined ? text : <Icon name={icon} />}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className={[styles.menu, action ? styles.action : undefined].filter(Boolean).join(' ')}
          role="menu"
          aria-label={label}
          aria-describedby={note === undefined ? undefined : `${menuId}-note`}
          onKeyDown={menuKey}
        >
          {items.map((item, index) => {
            const causeId = `${menuId}-cause-${String(index)}`;
            return (
              <Fragment key={item.value}>
                {index > 0 && item.group !== items[index - 1]?.group && (
                  <div className={styles.separator} role="separator" />
                )}
                <button
                  className={styles.item}
                  type="button"
                  role={action ? 'menuitem' : 'menuitemradio'}
                  aria-checked={action ? undefined : item.value === value}
                  aria-disabled={item.disabled === true ? true : undefined}
                  aria-describedby={item.cause === undefined ? undefined : causeId}
                  tabIndex={-1}
                  onClick={() => {
                    if (item.disabled === true) return;
                    onSelect(item.value);
                    closeToTrigger();
                  }}
                >
                  {item.icon !== undefined && <Icon name={item.icon} />}
                  <span>{item.label}</span>
                  {!action && (
                    <span className={styles.tick}>
                      <Icon name="check" />
                    </span>
                  )}
                </button>
                {item.cause !== undefined && (
                  <div id={causeId} className={styles.cause} role="none">
                    {item.cause}
                  </div>
                )}
              </Fragment>
            );
          })}
          {note !== undefined && (
            <div id={`${menuId}-note`} className={styles.note} role="none">
              {note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
