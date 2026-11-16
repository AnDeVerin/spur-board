// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverMenu, type HoverMenuItem } from '../src/ds/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Choice = 'light' | 'dark' | 'auto';
const items: readonly HoverMenuItem<Choice>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];

let container: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn<(value: Choice) => void>>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onSelect = vi.fn<(value: Choice) => void>();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount(props: { value?: Choice; defaultOpen?: boolean } = {}) {
  act(() => {
    root.render(
      createElement(HoverMenu<Choice>, { label: 'Theme', icon: 'moon', items, onSelect, ...props }),
    );
  });
}
const trigger = () => {
  const found = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!found) throw new Error('no trigger');
  return found;
};
const menu = () => container.querySelector<HTMLElement>('[role="menu"]');
const options = () => [...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const option = (index: number) => {
  const found = options()[index];
  if (!found) throw new Error(`no item ${String(index)}`);
  return found;
};
const isOpen = () => menu() !== null;
const fire = (target: EventTarget, event: Event) => {
  act(() => {
    target.dispatchEvent(event);
  });
};
// React builds pointerenter and pointerleave from pointerover and pointerout with relatedTarget.
const move = (type: string, from: Element, to: Element) => {
  fire(
    from,
    new PointerEvent('pointerout', { bubbles: true, pointerType: type, relatedTarget: to }),
  );
  fire(
    to,
    new PointerEvent('pointerover', { bubbles: true, pointerType: type, relatedTarget: from }),
  );
};
const click = (target: Element, detail: number) => {
  fire(target, new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
};
const key = (target: EventTarget, name: string, type = 'keydown') => {
  fire(target, new KeyboardEvent(type, { bubbles: true, cancelable: true, key: name }));
};

describe('HoverMenu', () => {
  it('(a) has menu button, menu and radio item roles', () => {
    mount({ value: 'dark' });
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-label')).toBe('Theme');
    expect(menu()).toBeNull();
    click(trigger(), 1);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(menu()?.id);
    expect(menu()?.getAttribute('aria-label')).toBe('Theme');
    expect(options()).toHaveLength(3);
    const checked = options().filter((item) => item.getAttribute('aria-checked') === 'true');
    expect(checked.map((item) => item.textContent)).toEqual(['Dark']);
    for (const item of options()) expect(item.getAttribute('tabindex')).toBe('-1');
  });

  it('(b) opens on mouse hover without focus and stays open from trigger into the menu', () => {
    mount({ value: 'dark' });
    move('mouse', document.body, trigger());
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(document.body);
    move('mouse', trigger(), option(0));
    expect(isOpen()).toBe(true);
    move('mouse', option(0), document.body);
    expect(isOpen()).toBe(false);
  });

  it('(c) opens on pen hover', () => {
    mount();
    move('pen', document.body, trigger());
    expect(isOpen()).toBe(true);
  });

  it('(d) ignores touch hover, and a tap toggles', () => {
    mount({ value: 'dark' });
    move('touch', document.body, trigger());
    expect(isOpen()).toBe(false);
    click(trigger(), 1);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(option(1));
    move('touch', trigger(), document.body);
    expect(isOpen()).toBe(true);
    click(trigger(), 1);
    expect(isOpen()).toBe(false);
  });

  it('(e) a click on a hover-opened menu pins it', () => {
    mount({ value: 'dark' });
    move('mouse', document.body, trigger());
    click(trigger(), 1);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(option(1));
    move('mouse', trigger(), document.body);
    expect(isOpen()).toBe(true);
  });

  it('(f) opens once from Space, Enter and ArrowDown', () => {
    mount({ value: 'dark' });
    trigger().focus();
    key(trigger(), ' ');
    key(trigger(), ' ', 'keyup');
    click(trigger(), 0);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(option(1));
    key(option(1), 'Escape');
    expect(isOpen()).toBe(false);
    key(trigger(), 'Enter');
    click(trigger(), 0);
    expect(isOpen()).toBe(true);
    key(option(1), 'Escape');
    key(trigger(), 'ArrowDown');
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(option(1));
    // A keyboard click never toggles: it leaves a pinned menu open.
    click(trigger(), 0);
    expect(isOpen()).toBe(true);
  });

  it('(f) ArrowDown with no value focuses the first item', () => {
    mount();
    trigger().focus();
    key(trigger(), 'ArrowDown');
    expect(document.activeElement).toBe(option(0));
  });

  it('(g) arrows wrap, Home and End jump', () => {
    mount({ value: 'auto' });
    key(trigger(), 'ArrowDown');
    expect(document.activeElement).toBe(option(2));
    key(option(2), 'ArrowDown');
    expect(document.activeElement).toBe(option(0));
    key(option(0), 'ArrowUp');
    expect(document.activeElement).toBe(option(2));
    key(option(2), 'Home');
    expect(document.activeElement).toBe(option(0));
    key(option(0), 'End');
    expect(document.activeElement).toBe(option(2));
  });

  it('(h) Escape closes from an item, from the trigger and from a hover-opened menu', () => {
    mount({ value: 'dark' });
    key(trigger(), 'ArrowDown');
    key(option(1), 'Escape');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
    trigger().blur();
    move('mouse', document.body, trigger());
    expect(document.activeElement).toBe(document.body);
    key(document.body, 'Escape');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
    move('mouse', trigger(), document.body);
    trigger().focus();
    move('mouse', document.body, trigger());
    expect(isOpen()).toBe(true);
    key(trigger(), 'Escape');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('(i) choosing an item selects it, closes and focuses the trigger', () => {
    mount({ value: 'dark' });
    click(trigger(), 1);
    click(option(2), 1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('auto');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('(j) Tab on an item closes and focuses the trigger', () => {
    mount({ value: 'dark' });
    key(trigger(), 'ArrowDown');
    key(option(1), 'Tab');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('(k) a pointer down outside closes, inside does not', () => {
    mount();
    click(trigger(), 1);
    fire(option(0), new PointerEvent('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(true);
    fire(document.body, new PointerEvent('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it('(l) defaultOpen stays open after the mouse enters and leaves', () => {
    mount({ value: 'dark', defaultOpen: true });
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(document.body);
    move('mouse', document.body, trigger());
    move('mouse', trigger(), document.body);
    expect(isOpen()).toBe(true);
  });

  it('(m) a pen that hovers before each tap toggles with two taps', () => {
    mount();
    move('pen', document.body, trigger());
    expect(isOpen()).toBe(true);
    click(trigger(), 1);
    expect(isOpen()).toBe(true);
    move('pen', trigger(), document.body);
    expect(isOpen()).toBe(true);
    move('pen', document.body, trigger());
    expect(isOpen()).toBe(true);
    click(trigger(), 1);
    expect(isOpen()).toBe(false);
  });
});
