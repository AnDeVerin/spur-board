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
    createElement(Popover, {
      open,
      onClose: () => {
        onClose();
        setOpen(false);
      },
      anchor,
      title: 'Review',
      actions: createElement('span', { id: 'actions' }, 'Tabs'),
      children: children ?? createElement('p', null, 'Body'),
    }),
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
    createElement(Modal, {
      open,
      onClose: () => {
        setOpen(false);
      },
      title: 'Task',
      children: children ?? 'Modal body',
    }),
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

type Rect = { left: number; right: number; top: number; bottom: number };
let rect: Rect = { left: 100, right: 420, top: 20, bottom: 40 };
// The box of `#scroller` when a test makes it clip, else none.
let scrollerRect: Rect | undefined;
const stubAnchorRect = (next: Rect) => {
  rect = next;
};
const domRect = ({ left, right, top, bottom }: Rect) => {
  const box = { left, right, top, bottom, x: left, y: top, width: right - left };
  return { ...box, height: bottom - top, toJSON: () => box };
};
/**
 * Stubs the anchor's box and a 1024x768 window: happy-dom reports `clientWidth` and
 * `clientHeight` 0. The popover reads only the anchor's box and those of its clipping ancestors.
 */
const anchorRect = () => {
  for (const [name, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const)
    Object.defineProperty(document.documentElement, name, { configurable: true, get: () => value });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return domRect(this.id === 'scroller' && scrollerRect ? scrollerRect : rect);
  });
};
/** Makes `#scroller` clip both axes to `area` (its padding box: no border here), or stop. */
const clip = (area: Rect | undefined) => {
  scrollerRect = area;
  const scroller = document.getElementById('scroller');
  if (!scroller) throw new Error('no scroller');
  scroller.style.overflowX = area ? 'auto' : '';
  scroller.style.overflowY = area ? 'auto' : '';
  for (const [name, value] of [
    ['clientWidth', area ? area.right - area.left : 0],
    ['clientHeight', area ? area.bottom - area.top : 0],
  ] as const)
    Object.defineProperty(scroller, name, { configurable: true, get: () => value });
};
/** The anchor box the popover wrote: left, right, top and bottom edges, and which side it left by. */
const placement = () => {
  const style = opened().style;
  return {
    left: style.getPropertyValue('--popover-left'),
    right: style.getPropertyValue('--popover-right'),
    top: style.getPropertyValue('--popover-anchor-top'),
    bottom: style.getPropertyValue('--popover-top'),
    away: opened().getAttribute('data-away'),
  };
};
const box = (left: number, right: number, top: number, bottom: number, away: string | null) => ({
  left: `${String(left)}px`,
  right: `${String(right)}px`,
  top: `${String(top)}px`,
  bottom: `${String(bottom)}px`,
  away,
});

afterEach(() => {
  Reflect.deleteProperty(document.documentElement, 'clientWidth');
  Reflect.deleteProperty(document.documentElement, 'clientHeight');
  rect = { left: 100, right: 420, top: 20, bottom: 40 };
  scrollerRect = undefined;
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

  it('under a layer (inside an inert element) a mousedown outside does not close it', () => {
    const onClose = vi.fn();
    render(
      createElement(
        'div',
        { id: 'under', inert: true },
        createElement(Harness, { initial: true, onClose }),
      ),
    );
    // A press on a Modal control the popover opened lands outside it.
    mouse('mousedown', document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(popover()).toBeDefined();
    act(() => {
      document.getElementById('under')?.removeAttribute('inert');
    });
    mouse('mousedown', document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('follows the anchor on nested scroll and resize', () => {
    anchorRect();
    render(createElement(Harness, { initial: true }));
    expect(placement()).toEqual(box(100, 420, 20, 40, null));
    stubAnchorRect({ left: 60, right: 380, top: 10, bottom: 30 });
    act(() => {
      document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
    });
    expect(placement()).toEqual(box(60, 380, 10, 30, null));
    stubAnchorRect({ left: 200, right: 520, top: 50, bottom: 70 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(placement()).toEqual(box(200, 520, 50, 70, null));
  });

  it('is in view only while the anchor meets the window and every clipping ancestor', () => {
    anchorRect();
    render(createElement(Harness, { initial: true }));
    const scroller: Rect = { left: 200, right: 800, top: 0, bottom: 600 };
    // Anchor edges, the clipping scroller if any, and the side `data-away` names (null: in view).
    // An anchor narrower than the panel leaves by the left too: the CSS then puts the panel's
    // right edge at or left of the anchor's (web-popover.test.ts).
    for (const [left, right, top, bottom, area, away] of [
      [-400, -20, 20, 40, undefined, 'left'],
      [-300, -20, 20, 40, undefined, 'left'],
      [-249, 0, 20, 40, undefined, 'left'],
      [1024, 1344, 20, 40, undefined, 'right'],
      [100, 420, -21, -1, undefined, 'top'],
      [100, 420, -20, 0, undefined, 'top'],
      [100, 420, 768, 788, undefined, 'bottom'],
      [100, 420, 769, 789, undefined, 'bottom'],
      [-100, 200, 20, 40, scroller, 'left'],
      [800, 1000, 20, 40, scroller, 'right'],
      [300, 620, -40, 0, scroller, 'top'],
      [300, 620, 600, 620, scroller, 'bottom'],
      [100, 420, 20, 40, undefined, null],
      [1000, 1320, 20, 40, undefined, null],
      [-300, 20, 20, 40, undefined, null],
      [100, 420, -19, 1, undefined, null],
      [100, 420, 767, 787, undefined, null],
      [150, 470, 590, 610, scroller, null],
    ] as const) {
      clip(area);
      stubAnchorRect({ left, right, top, bottom });
      act(() => {
        document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
      });
      expect(placement(), JSON.stringify({ left, right, top, bottom, area })).toEqual(
        box(left, right, top, bottom, away),
      );
    }
  });

  it('measures on open as a child of its anchor, whose ref attaches after its layout effect', () => {
    anchorRect();
    function Inside() {
      const anchor = useRef<HTMLDivElement>(null);
      return createElement(
        'div',
        { id: 'anchor', ref: anchor },
        createElement(Popover, {
          open: true,
          onClose: () => undefined,
          anchor,
          title: 'Review',
          children: 'Body',
        }),
      );
    }
    render(createElement(Inside));
    expect(placement()).toEqual(box(100, 420, 20, 40, null));
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
