import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import styles from './HoverMenu.module.css';

export type HoverMenuItem<V extends string> = { value: V; label: string; icon?: IconName };

type OpenMenu = { root: HTMLElement; escape: () => void };

/** Open menus in opening order; one document key listener serves them all while any is open. */
const openMenus: OpenMenu[] = [];

/**
 * Closes one menu per Escape: the live menu holding focus, else the most recently opened live
 * one. A menu under a layer (inside an `inert` element) is not live. The listener sits on
 * `document`, so it runs before the layer's `window` listener, which skips the handled event.
 */
function onEscape(event: globalThis.KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  const live = openMenus.filter((menu) => menu.root.closest('[inert]') === null);
  const target = live.find((menu) => menu.root.contains(document.activeElement)) ?? live.at(-1);
  if (!target) return;
  event.preventDefault();
  target.escape();
}

function addOpenMenu(entry: OpenMenu): void {
  if (openMenus.length === 0) document.addEventListener('keydown', onEscape);
  openMenus.push(entry);
}

function removeOpenMenu(entry: OpenMenu): void {
  const index = openMenus.indexOf(entry);
  if (index !== -1) openMenus.splice(index, 1);
  if (openMenus.length === 0) document.removeEventListener('keydown', onEscape);
}

/**
 * A small icon trigger whose menu opens upward and end-aligned, with one radio choice checked.
 *
 * - Mouse or pen hover opens it; the pointer may cross from the trigger into the menu. Leaving
 *   closes it unless a click or a key pinned it, and entering never unpins it. Touch hover is
 *   ignored.
 * - A click or tap opens it pinned with focus on the checked item (or the first); a second click
 *   or tap on a pinned menu closes it. Enter and Space arrive as a click with `detail` 0 and only
 *   ever open, so a Space keyup cannot close what keydown opened. ArrowDown opens it as well.
 * - Arrows wrap, Home and End jump; Tab and choosing an item close it and focus the trigger.
 * - Escape closes it from anywhere while open and returns focus to the trigger when focus was
 *   inside; a pointer down outside closes it. One Escape closes one menu: the open menu holding
 *   focus, else the most recently opened. A menu under a layer (inside an `inert` element)
 *   ignores Escape, so the top Modal or SidePanel closes instead; a menu in the element a layer
 *   keeps live still closes first. An Escape already handled (`defaultPrevented`) or composing
 *   closes no menu.
 *
 * `defaultOpen` renders it open and pinned on mount without moving focus.
 */
export function HoverMenu<V extends string>({
  label,
  icon,
  items,
  value,
  onSelect,
  defaultOpen = false,
}: {
  label: string;
  icon: IconName;
  items: readonly HoverMenuItem<V>[];
  value?: V | undefined;
  onSelect: (value: V) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const pinned = useRef(defaultOpen);
  const focusOnOpen = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusChecked = () => {
    const current = menu.current;
    (
      current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      current?.querySelector<HTMLElement>('[role="menuitemradio"]')
    )?.focus();
  };
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  const closeToTrigger = () => {
    close();
    trigger.current?.focus();
  };
  const openPinned = () => {
    pinned.current = true;
    if (open) focusChecked();
    else {
      focusOnOpen.current = true;
      setOpen(true);
    }
  };
  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      focusChecked();
    }
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const element = root.current;
    const entry: OpenMenu | undefined = element
      ? {
          root: element,
          escape: () => {
            const inside = element.contains(document.activeElement);
            close();
            if (inside) trigger.current?.focus();
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
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
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
      onPointerEnter={(event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== 'touch' && !open) setOpen(true);
      }}
      onPointerLeave={() => {
        if (open && !pinned.current) close();
      }}
    >
      <button
        ref={trigger}
        className={styles.trigger}
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
        <Icon name={icon} />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-label={label}
          onKeyDown={menuKey}
        >
          {items.map((item) => (
            <button
              className={styles.item}
              type="button"
              role="menuitemradio"
              aria-checked={item.value === value}
              tabIndex={-1}
              key={item.value}
              onClick={() => {
                onSelect(item.value);
                closeToTrigger();
              }}
            >
              {item.icon !== undefined && <Icon name={item.icon} />}
              {item.label}
              <span className={styles.tick}>
                <Icon name="check" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
