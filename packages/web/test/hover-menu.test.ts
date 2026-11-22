// @vitest-environment happy-dom
import { act, createElement, useRef, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverMenu, Modal, SidePanel, type HoverMenuItem } from '../src/ds/index.ts';

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

const examples = import.meta.glob<Record<string, ComponentType>>(
  '../src/ds/HoverMenu/HoverMenu.examples.tsx',
  { eager: true },
);

describe('HoverMenu controlled', () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  beforeEach(() => {
    onOpenChange = vi.fn<(open: boolean) => void>();
  });
  const render = (open: boolean) => {
    act(() => {
      root.render(
        createElement(HoverMenu<Choice>, {
          label: 'Theme',
          icon: 'moon',
          items,
          value: 'dark',
          onSelect,
          open,
          onOpenChange,
          defaultOpen: !open,
        }),
      );
    });
  };
  /** Runs `step` and expects one `onOpenChange(next)` from it. */
  const reports = (next: boolean, step: () => void) => {
    onOpenChange.mockClear();
    step();
    expect(onOpenChange.mock.calls).toEqual([[next]]);
  };

  it('(n) controlled: reports each open and close and shows only what the parent passes', () => {
    render(false);
    expect(isOpen()).toBe(false);
    reports(true, () => {
      click(trigger(), 1);
    });
    reports(true, () => {
      key(trigger(), 'ArrowDown');
    });
    reports(true, () => {
      move('mouse', document.body, trigger());
    });
    expect(isOpen()).toBe(false);
    render(true);
    expect(isOpen()).toBe(true);
    reports(false, () => {
      click(option(2), 1);
    });
    expect(onSelect).toHaveBeenCalledWith('auto');
    reports(false, () => {
      key(option(0), 'Escape');
    });
    reports(false, () => {
      key(option(0), 'Tab');
    });
    reports(false, () => {
      fire(document.body, new PointerEvent('pointerdown', { bubbles: true }));
    });
    // Still open: only the parent closes it.
    expect(isOpen()).toBe(true);
    // A click pins it; the parent's close drops the pin, so a later hover-open closes on leave.
    click(trigger(), 1);
    render(false);
    expect(isOpen()).toBe(false);
    render(true);
    reports(false, () => {
      move('mouse', trigger(), document.body);
    });
  });

  /** Renders the Controlled example and returns its two triggers. */
  const controlledExample = () => {
    const Controlled = Object.values(examples)[0]?.Controlled;
    if (!Controlled) throw new Error('no Controlled example');
    act(() => {
      root.render(createElement(Controlled));
    });
    const [first, second] = [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'),
    ];
    if (!first || !second) throw new Error('no two triggers');
    return [first, second] as const;
  };

  it('(o) the Controlled example keeps one of its two menus open', () => {
    const [first, second] = controlledExample();
    const menus = () => [...container.querySelectorAll('[role="menu"]')];
    click(first, 1);
    expect(menus()).toHaveLength(1);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    click(second, 1);
    expect(menus().map((found) => found.id)).toEqual([second.getAttribute('aria-controls')]);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    move('mouse', document.body, first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-expanded')).toBe('false');
    expect(menus()).toHaveLength(1);
  });

  it.each([
    { path: 'the Controlled example opened by ArrowDown, then a hover on the other', open: 'key' },
    { path: 'the Controlled example opened by click, then a hover on the other', open: 'click' },
    { path: 'a menu its parent closes', open: 'parent' },
  ] as const)('(p) $path: focus inside moves to the closed menu trigger', ({ open }) => {
    if (open === 'parent') render(true);
    const [first, second] = open === 'parent' ? [trigger(), undefined] : controlledExample();
    if (open === 'click') click(first, 1);
    else key(first, 'ArrowDown');
    expect(menu()?.contains(document.activeElement)).toBe(true);
    if (second) move('mouse', document.body, second);
    else render(false);
    expect(isOpen()).toBe(open !== 'parent');
    expect(document.activeElement).toBe(first);
  });
});

describe('Escape with several menus and layers', () => {
  const render = (node: ReactNode) => {
    act(() => {
      root.render(node);
    });
  };
  const themeMenu = (props: { defaultOpen?: boolean } = {}) =>
    createElement(HoverMenu<Choice>, {
      key: 'theme',
      label: 'Theme',
      icon: 'moon',
      items,
      value: 'dark',
      onSelect,
      ...props,
    });
  const accentMenu = (props: { defaultOpen?: boolean } = {}) =>
    createElement(HoverMenu<Choice>, {
      key: 'accent',
      label: 'Accent',
      icon: 'sun',
      items,
      onSelect,
      ...props,
    });
  const triggerOf = (label: string) => {
    const found = document.querySelector<HTMLButtonElement>(
      `button[aria-haspopup="menu"][aria-label="${label}"]`,
    );
    if (!found) throw new Error(`no trigger ${label}`);
    return found;
  };
  const openMenu = (label: string) =>
    document.querySelector(`[role="menu"][aria-label="${label}"]`) !== null;
  const escape = (target: EventTarget, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
      ...init,
    });
    fire(target, event);
    return event;
  };
  const focused = () => document.activeElement ?? document.body;

  it('two open menus: Escape closes the focused one, else the most recent', () => {
    render([themeMenu(), accentMenu()]);
    click(triggerOf('Theme'), 1);
    move('mouse', document.body, triggerOf('Accent'));
    expect(openMenu('Theme')).toBe(true);
    expect(openMenu('Accent')).toBe(true);
    expect(document.activeElement?.textContent).toContain('Dark');
    const first = escape(focused());
    expect(first.defaultPrevented).toBe(true);
    expect(openMenu('Theme')).toBe(false);
    expect(openMenu('Accent')).toBe(true);
    expect(document.activeElement).toBe(triggerOf('Theme'));
    triggerOf('Theme').blur();
    escape(document.body);
    expect(openMenu('Accent')).toBe(false);

    render(null);
    render([themeMenu({ defaultOpen: true }), accentMenu({ defaultOpen: true })]);
    expect(document.activeElement).toBe(document.body);
    escape(document.body);
    expect(openMenu('Theme')).toBe(true);
    expect(openMenu('Accent')).toBe(false);
    escape(document.body);
    expect(openMenu('Theme')).toBe(false);
  });

  it('a menu inside a Modal closes first, then the Modal', () => {
    const onClose = vi.fn<() => void>();
    render(createElement(Modal, { open: true, onClose, title: 'Settings', children: themeMenu() }));
    key(triggerOf('Theme'), 'ArrowDown');
    expect(openMenu('Theme')).toBe(true);
    escape(focused());
    expect(openMenu('Theme')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(document.activeElement).toBe(triggerOf('Theme'));
    escape(focused());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a menu under a layer ignores Escape', () => {
    const onPanelClose = vi.fn<() => void>();
    render([
      themeMenu({ defaultOpen: true }),
      createElement(SidePanel, {
        key: 'panel',
        open: true,
        onClose: onPanelClose,
        title: 'Services',
        children: 'Body',
      }),
    ]);
    escape(focused());
    expect(onPanelClose).toHaveBeenCalledTimes(1);
    expect(openMenu('Theme')).toBe(true);

    render(null);
    onPanelClose.mockClear();
    const onModalClose = vi.fn<() => void>();
    render(
      createElement(SidePanel, {
        open: true,
        onClose: onPanelClose,
        title: 'Services',
        children: [
          themeMenu({ defaultOpen: true }),
          createElement(Modal, {
            key: 'modal',
            open: true,
            onClose: onModalClose,
            title: 'Settings',
            children: 'Body',
          }),
        ],
      }),
    );
    escape(focused());
    expect(onModalClose).toHaveBeenCalledTimes(1);
    expect(onPanelClose).toHaveBeenCalledTimes(0);
    expect(openMenu('Theme')).toBe(true);
  });

  it('a menu in the element the panel keeps live closes first', () => {
    const onClose = vi.fn<() => void>();
    function Host() {
      const footer = useRef<HTMLElement>(null);
      return [
        createElement('footer', { key: 'footer', ref: footer }, themeMenu({ defaultOpen: true })),
        createElement(SidePanel, {
          key: 'panel',
          open: true,
          onClose,
          title: 'Services',
          keepLive: footer,
          children: 'Body',
        }),
      ];
    }
    render(createElement(Host));
    expect(triggerOf('Theme').closest('[inert]')).toBeNull();
    escape(focused());
    expect(openMenu('Theme')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(0);
    escape(focused());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an Escape already handled or composing leaves the menu open', () => {
    render([
      themeMenu({ defaultOpen: true }),
      createElement(
        'div',
        {
          key: 'handler',
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'Escape') event.preventDefault();
          },
        },
        createElement('button', { type: 'button' }, 'Inside'),
      ),
    ]);
    const inside = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Inside',
    );
    if (!inside) throw new Error('no inside button');
    escape(inside);
    expect(openMenu('Theme')).toBe(true);
    escape(document.body, { isComposing: true });
    expect(openMenu('Theme')).toBe(true);
    escape(document.body);
    expect(openMenu('Theme')).toBe(false);
  });
});
