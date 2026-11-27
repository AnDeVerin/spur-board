// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HoverMenu, Modal, type HoverMenuItem } from '../src/ds/index.ts';

// Open requests of a controlled HoverMenu: each request sets its own pin and focus intent, a
// declined one leaves none behind, and dismissal reports through the current `onOpenChange`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Choice = 'light' | 'dark' | 'auto';
const items: readonly HoverMenuItem<Choice>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];

let container: HTMLDivElement;
let root: Root;
/** Requests the parent still declines, and every report with the callback's render version. */
let declines: number;
let version: number;
let reports: { menu: string; next: boolean; from: number; rendered: number }[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  declines = 0;
  version = 1;
  reports = [];
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** Two controlled menus sharing one open slot; each render passes new `onOpenChange` callbacks. */
function Host({ rendered }: { rendered: number }) {
  const [slot, setSlot] = useState<string | null>(null);
  const menuOf = (name: string) =>
    createElement(HoverMenu<Choice>, {
      key: name,
      label: name,
      icon: 'moon',
      items,
      value: 'dark',
      onSelect: () => undefined,
      open: slot === name,
      onOpenChange: (next: boolean) => {
        reports.push({ menu: name, next, from: rendered, rendered: version });
        if (declines > 0) declines -= 1;
        else setSlot((current) => (next ? name : current === name ? null : current));
      },
    });
  return [menuOf('First'), menuOf('Second')];
}
const render = () => {
  act(() => {
    root.render(createElement(Host, { rendered: version }));
  });
};
const triggerOf = (label: string) => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no trigger ${label}`);
  return found;
};
const firstMenu = () => container.querySelector<HTMLElement>('[role="menu"][aria-label="First"]');
const fire = (target: EventTarget, event: Event) => {
  act(() => {
    target.dispatchEvent(event);
  });
};
// React builds pointerenter and pointerleave from pointerover and pointerout with relatedTarget.
const move = (from: Element, to: Element) => {
  fire(
    from,
    new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: to }),
  );
  fire(
    to,
    new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: from }),
  );
};

type Step =
  | 'hover'
  | 'leave'
  | 'key'
  | 'click'
  | 'decline'
  | 'new callback'
  | 'escape'
  | 'outside'
  | 'hover second';
const steps: Record<Step, () => void> = {
  hover: () => {
    move(document.body, triggerOf('First'));
  },
  leave: () => {
    move(triggerOf('First'), document.body);
  },
  key: () => {
    fire(
      triggerOf('First'),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
    );
  },
  click: () => {
    fire(
      triggerOf('First'),
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
    );
  },
  decline: () => {
    declines += 1;
  },
  'new callback': () => {
    version += 1;
    render();
  },
  escape: () => {
    fire(
      document.activeElement ?? document.body,
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
  },
  outside: () => {
    fire(document.body, new PointerEvent('pointerdown', { bubbles: true }));
  },
  'hover second': () => {
    move(triggerOf('First'), triggerOf('Second'));
  },
};
type Focus = 'body' | 'checked item' | 'first trigger';
const focusOf = (): Focus | Element | null => {
  const active = document.activeElement;
  if (active === document.body) return 'body';
  if (active === triggerOf('First')) return 'first trigger';
  if (active?.getAttribute('aria-checked') === 'true' && firstMenu()?.contains(active))
    return 'checked item';
  return active;
};

describe('HoverMenu open requests', () => {
  it('reports each hover entry once after a Modal portal unmounts', () => {
    act(() => {
      root.render(
        createElement(Modal, {
          open: true,
          onClose: () => undefined,
          title: 'Settings',
          children: 'Preferences',
        }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    declines = 2;
    render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const button = triggerOf('First');
    const icon = button.querySelector('svg');
    if (!icon) throw new Error('no trigger icon');
    const openRequest = { menu: 'First', next: true, from: version, rendered: version };

    move(document.body, button);
    expect(reports).toEqual([openRequest]);
    expect(firstMenu()).toBeNull();
    move(button, icon);
    expect(reports).toEqual([openRequest]);
    move(icon, document.body);
    expect(reports).toEqual([openRequest]);
    move(document.body, icon);
    expect(reports).toEqual([openRequest, openRequest]);
    expect(firstMenu()).toBeNull();
  });

  it.each([
    { path: 'a hover opens without focus', run: ['hover'], open: true, focus: 'body' },
    {
      path: 'ArrowDown opens on the checked item',
      run: ['key'],
      open: true,
      focus: 'checked item',
    },
    {
      path: 'a click opens on the checked item',
      run: ['click'],
      open: true,
      focus: 'checked item',
    },
    {
      path: 'a declined ArrowDown, then a hover, opens unpinned without focus',
      run: ['decline', 'key', 'hover'],
      open: true,
      focus: 'body',
    },
    {
      path: 'a declined ArrowDown, then a hover, closes on leave',
      run: ['decline', 'key', 'hover', 'leave'],
      open: false,
      focus: 'body',
    },
    {
      path: 'a declined click, then a hover, closes on leave without focus',
      run: ['decline', 'click', 'hover', 'leave'],
      open: false,
      focus: 'body',
    },
    {
      path: 'leaving after a hover open closes',
      run: ['hover', 'leave'],
      open: false,
      focus: 'body',
    },
    {
      path: 'leaving after a click open keeps it open',
      run: ['hover', 'click', 'leave'],
      open: true,
      focus: 'checked item',
    },
    {
      path: 'Escape and an outside press after a new callback report through it',
      run: ['click', 'new callback', 'decline', 'escape', 'decline', 'outside'],
      open: true,
      focus: 'first trigger',
    },
    {
      path: 'a hover on the second menu with focus in the first',
      run: ['key', 'hover second'],
      open: false,
      focus: 'first trigger',
    },
  ] as const)('$path', ({ run, open, focus }) => {
    render();
    for (const step of run) steps[step]();
    expect(firstMenu() !== null).toBe(open);
    expect(focusOf()).toBe(focus);
    // Every report comes from the callback of the render current at the time.
    expect(reports.filter((report) => report.from !== report.rendered)).toEqual([]);
    expect(reports.length).toBeGreaterThan(0);
  });
});
