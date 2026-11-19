// @vitest-environment happy-dom
import {
  act,
  createElement,
  Fragment,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoverMenu, Modal, Popover, type HoverMenuItem } from '../src/ds/index.ts';
import {
  button,
  dialogs,
  emulateFocusFixup,
  key,
  mountEachTest,
  press,
  render,
} from './ds-layers-helpers.ts';

mountEachTest();
emulateFocusFixup();

const popoverExamples: Record<string, Record<string, ComponentType>> = import.meta.glob(
  '../src/ds/Popover/*.examples.tsx',
  { eager: true },
);

const items: readonly HoverMenuItem<'a' | 'b'>[] = [
  { value: 'a', label: 'First' },
  { value: 'b', label: 'Second' },
];
const menu = (label: string) =>
  createElement(HoverMenu<'a' | 'b'>, {
    label,
    icon: 'sun',
    items,
    value: 'a',
    onSelect: () => undefined,
  });

/** A Help trigger inside an anchor inside a scroller, and the Popover it opens. */
function Harness({
  initial = false,
  onClose = () => undefined,
  children,
  after,
}: {
  initial?: boolean;
  onClose?: () => void;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(initial);
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { id: 'scroller' },
      createElement(
        'div',
        { id: 'anchor', ref: anchor },
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              setOpen(!open);
            },
          },
          'Help',
        ),
      ),
    ),
    createElement(
      Popover,
      {
        open,
        onClose: () => {
          onClose();
          setOpen(false);
        },
        anchor,
        title: 'Review',
        actions: createElement('span', { id: 'actions' }, 'Tabs'),
      },
      children ?? createElement('p', null, 'Body'),
    ),
    after,
  );
}

/** A Modal opened by a button, rendered after the popover harness. */
function ModalHost({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => {
          setOpen(true);
        },
      },
      'Open modal',
    ),
    createElement(
      Modal,
      {
        open,
        onClose: () => {
          setOpen(false);
        },
        title: 'Task',
      },
      children ?? 'Modal body',
    ),
  );
}

const popover = () => dialogs().find((dialog) => !dialog.hasAttribute('aria-modal'));
const opened = () => {
  const found = popover();
  if (!found) throw new Error('no popover');
  return found;
};
const mouse = (type: 'mousedown', target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
};

let rect = { left: 100, right: 420, top: 20, bottom: 40 };
const stubAnchorRect = (next: typeof rect) => {
  rect = next;
};
/** Stubs the anchor's box and a 1024px window: happy-dom reports `clientWidth` 0. */
const anchorRect = () => {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => 1024,
  });
  // Only the popover reads a box in these tests, and only the anchor's.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
    const { left, right, top, bottom } = rect;
    const box = { left, right, top, bottom, x: left, y: top, width: right - left };
    return { ...box, height: bottom - top, toJSON: () => box };
  });
};
const placement = () => ({
  left: opened().style.getPropertyValue('--popover-left'),
  top: opened().style.getPropertyValue('--popover-top'),
  away: opened().hasAttribute('data-away'),
});

afterEach(() => {
  Reflect.deleteProperty(document.documentElement, 'clientWidth');
  rect = { left: 100, right: 420, top: 20, bottom: 40 };
});

describe('Popover', () => {
  it('opens labelled, header in order, focus to Close from a focused trigger, none from body', () => {
    render(createElement(Harness));
    expect(popover()).toBeUndefined();
    press(button('Help'));
    const dialog = opened();
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Review');
    const header = dialog.firstElementChild;
    expect([...(header?.children ?? [])].map((child) => child.textContent)).toEqual([
      'Review',
      'Tabs',
      '',
    ]);
    expect(header?.lastElementChild?.contains(button('Close', dialog))).toBe(true);
    expect(document.activeElement).toBe(button('Close', dialog));

    press(button('Help'));
    expect(popover()).toBeUndefined();
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    render(createElement(Fragment, null));
    render(createElement(Harness, { initial: true }));
    expect(popover()).toBeDefined();
    expect(document.activeElement).toBe(document.body);
  });

  it('Escape closes and returns focus to the opener', () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    const event = key('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(popover()).toBeUndefined();
    expect(document.activeElement).toBe(button('Help'));
  });

  it('Close returns focus to the opener', () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    press(button('Close', opened()));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(popover()).toBeUndefined();
    expect(document.activeElement).toBe(button('Help'));
  });

  it('a mousedown outside closes; inside the panel or the anchor, or a pointerdown alone, does not', () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    mouse('mousedown', opened().lastElementChild as Element);
    mouse('mousedown', button('Help'));
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(popover()).toBeDefined();
    mouse('mousedown', document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(popover()).toBeUndefined();
    expect(document.activeElement).not.toBe(button('Help'));
    // Its listener left with it.
    mouse('mousedown', document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('follows the anchor on nested scroll and resize', () => {
    anchorRect();
    render(createElement(Harness, { initial: true }));
    expect(placement()).toEqual({ left: '100px', top: '40px', away: false });
    stubAnchorRect({ left: 60, right: 380, top: 10, bottom: 30 });
    act(() => {
      document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
    });
    expect(placement()).toEqual({ left: '60px', top: '30px', away: false });
    stubAnchorRect({ left: 200, right: 520, top: 50, bottom: 70 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(placement()).toEqual({ left: '200px', top: '70px', away: false });
  });

  it('leaves with an anchor scrolled out of the window', () => {
    anchorRect();
    render(createElement(Harness, { initial: true }));
    const scroll = (next: typeof rect) => {
      stubAnchorRect(next);
      act(() => {
        document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
      });
    };
    scroll({ left: -400, right: -20, top: 20, bottom: 40 });
    expect(placement()).toEqual({ left: '-400px', top: '40px', away: true });
    scroll({ left: 1024, right: 1344, top: 20, bottom: 40 });
    expect(placement()).toEqual({ left: '1024px', top: '40px', away: true });
    scroll({ left: 1000, right: 1320, top: 20, bottom: 40 });
    expect(placement()).toEqual({ left: '1000px', top: '40px', away: false });
    scroll({ left: -300, right: 20, top: 20, bottom: 40 });
    expect(placement().away).toBe(false);
  });

  it('a HoverMenu and a Popover: Escape closes the focused one, else the most recent', () => {
    render(createElement(Harness, { after: menu('Sort') }));
    press(button('Help'));
    press(button('Sort'));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // Focus back in the popover: it closes first, though the menu opened later.
    act(() => {
      button('Close', opened()).focus();
    });
    key('Escape');
    expect(popover()).toBeUndefined();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // With focus on body, the most recently opened closes first.
    press(button('Help'));
    press(button('Sort'));
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(popover()).toBeDefined();
    key('Escape');
    expect(popover()).toBeUndefined();
  });

  it('a HoverMenu inside a Popover: Escape closes the menu, then the Popover', () => {
    render(createElement(Harness, { children: menu('Sort') }));
    press(button('Help'));
    press(button('Sort', opened()));
    const items = opened().querySelector('[role="menu"]');
    expect(items?.contains(document.activeElement)).toBe(true);
    key('Escape');
    expect(opened().querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button('Sort', opened()));
    key('Escape');
    expect(popover()).toBeUndefined();
    expect(document.activeElement).toBe(button('Help'));
  });

  it('a Popover inside a Modal closes first, then the Modal', () => {
    render(createElement(ModalHost, { children: createElement(Harness) }));
    press(button('Open modal'));
    press(button('Help'));
    expect(popover()).toBeDefined();
    key('Escape');
    expect(popover()).toBeUndefined();
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(button('Help'));
    key('Escape');
    expect(dialogs()).toHaveLength(0);
  });

  it('a Popover under a Modal ignores Escape', () => {
    render(createElement(Harness, { after: createElement(ModalHost) }));
    press(button('Help'));
    press(button('Open modal'));
    expect(dialogs()).toHaveLength(2);
    key('Escape');
    expect(dialogs()).toHaveLength(1);
    expect(popover()).toBeDefined();
    key('Escape');
    expect(popover()).toBeUndefined();
  });

  it('a handled or composing Escape leaves it open', () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    key('Escape', { isComposing: true });
    const close = button('Close', opened());
    close.addEventListener('keydown', (event) => {
      event.preventDefault();
    });
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(popover()).toBeDefined();
  });

  it('has five examples; only Open and FollowsColumn start open', () => {
    const module = popoverExamples['../src/ds/Popover/Popover.examples.tsx'] ?? {};
    expect(Object.keys(module).sort()).toEqual(
      ['Closed', 'FollowsColumn', 'LongContent', 'Open', 'WindowEdge'].sort(),
    );
    for (const [name, Example] of Object.entries(module)) {
      render(createElement(Fragment, null));
      render(createElement(Example));
      expect(dialogs(), name).toHaveLength(name === 'Open' || name === 'FollowsColumn' ? 1 : 0);
      expect(document.activeElement, name).toBe(document.body);
    }
  });
});
