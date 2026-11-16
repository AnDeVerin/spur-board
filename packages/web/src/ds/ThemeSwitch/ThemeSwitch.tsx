import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import styles from './ThemeSwitch.module.css';

export type ThemePreference = 'light' | 'dark' | 'auto';
const preferences = ['light', 'dark', 'auto'] as const;

/**
 * A theme menu button. The menu opens upward from the switch; ArrowDown or a click opens it with
 * focus on the checked item, arrows, Home and End move, Escape and Tab close it.
 * `defaultOpen` renders it open on mount without moving focus.
 */
export function ThemeSwitch({
  value,
  onChange,
  defaultOpen = false,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const focusOnOpen = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  const show = () => {
    focusOnOpen.current = true;
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
    const current = items.findIndex((item) => item === document.activeElement);
    let index: number | undefined;
    if (event.key === 'ArrowDown') index = (current + 1) % items.length;
    if (event.key === 'ArrowUp') index = (current + items.length - 1) % items.length;
    if (event.key === 'Home') index = 0;
    if (event.key === 'End') index = items.length - 1;
    if (index !== undefined) {
      event.preventDefault();
      items[index]?.focus();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') close();
  };
  return (
    <div className={styles.root} ref={root}>
      <button
        ref={trigger}
        className={styles.trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (open) setOpen(false);
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            show();
          }
        }}
      >
        Theme: {value}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-label="Theme"
          onKeyDown={menuKey}
        >
          {preferences.map((option) => (
            <button
              className={styles.item}
              type="button"
              role="menuitemradio"
              aria-checked={value === option}
              key={option}
              onClick={() => {
                onChange(option);
                close();
              }}
            >
              {option.charAt(0).toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
