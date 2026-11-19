import { act, createElement, Fragment, useRef, useState, type ReactNode } from 'react';
import { afterEach, vi } from 'vitest';
import { HoverMenu, Modal, Popover, type HoverMenuItem } from '../src/ds/index.ts';
import { dialogs } from './ds-layers-helpers.ts';

// Shared by ds-popover.test.ts: the Popover harness, a Modal host, a HoverMenu, the anchor and
// scroller box stubs, and the placement the popover wrote.

const items: readonly HoverMenuItem<'a' | 'b'>[] = [
  { value: 'a', label: 'First' },
  { value: 'b', label: 'Second' },
];
export const menu = (label: string) =>
  createElement(HoverMenu<'a' | 'b'>, {
    label,
    icon: 'sun',
    items,
    value: 'a',
    onSelect: () => undefined,
  });

/**
 * A Help trigger inside an anchor inside a scroller, and the Popover it opens. `shared` puts a
 * collapsed menu trigger (`aria-expanded`) before Help in the anchor, as a column head holds;
 * `attached={false}` unmounts the anchor, as a column head leaving the board.
 */
export function Harness({
  initial = false,
  onClose = () => undefined,
  children,
  after,
  shared = false,
  attached = true,
}: {
  initial?: boolean;
  onClose?: () => void;
  children?: ReactNode;
  after?: ReactNode;
  shared?: boolean;
  attached?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(initial);
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { id: 'scroller' },
      attached &&
        createElement(
          'div',
          { id: 'anchor', ref: anchor },
          shared && createElement('button', { type: 'button', 'aria-expanded': false }, 'Order'),
          createElement(
            'button',
            {
              type: 'button',
              ref: trigger,
              'aria-expanded': open,
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
      trigger,
      title: 'Review',
      actions: createElement('span', { id: 'actions' }, 'Tabs'),
      children: children ?? createElement('p', null, 'Body'),
    }),
    after,
  );
}

/** A Modal opened by a button, rendered after the popover harness. */
export function ModalHost({ children }: { children?: ReactNode }) {
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

export const popover = () => dialogs().find((dialog) => !dialog.hasAttribute('aria-modal'));
export const opened = () => {
  const found = popover();
  if (!found) throw new Error('no popover');
  return found;
};
export const mouse = (type: 'mousedown', target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
};

export type Rect = { left: number; right: number; top: number; bottom: number };
let rect: Rect = { left: 100, right: 420, top: 20, bottom: 40 };
// The box of `#scroller` when a test makes it clip, else none.
let scrollerRect: Rect | undefined;
export const stubAnchorRect = (next: Rect) => {
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
export const anchorRect = () => {
  for (const [name, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const)
    Object.defineProperty(document.documentElement, name, { configurable: true, get: () => value });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return domRect(this.id === 'scroller' && scrollerRect ? scrollerRect : rect);
  });
};
/**
 * Makes `#scroller` clip both axes to `area` (its padding box: no border here), or stop, and
 * gives it `position`.
 */
export const clip = (area: Rect | undefined, position = '') => {
  scrollerRect = area;
  const scroller = document.getElementById('scroller');
  if (!scroller) throw new Error('no scroller');
  scroller.style.position = position;
  scroller.style.overflowX = area ? 'auto' : '';
  scroller.style.overflowY = area ? 'auto' : '';
  for (const [name, value] of [
    ['clientWidth', area ? area.right - area.left : 0],
    ['clientHeight', area ? area.bottom - area.top : 0],
  ] as const)
    Object.defineProperty(scroller, name, { configurable: true, get: () => value });
};
/** The anchor box the popover wrote: its four edges, and the side it left the view by. */
export const placement = () => {
  const style = opened().style;
  return {
    left: style.getPropertyValue('--popover-left'),
    right: style.getPropertyValue('--popover-right'),
    top: style.getPropertyValue('--popover-anchor-top'),
    bottom: style.getPropertyValue('--popover-top'),
    away: opened().getAttribute('data-away'),
  };
};
export const box = (
  left: number,
  right: number,
  top: number,
  bottom: number,
  away: string | null,
) => ({
  left: `${String(left)}px`,
  right: `${String(right)}px`,
  top: `${String(top)}px`,
  bottom: `${String(bottom)}px`,
  away,
});

/** Restores the window size, the anchor box and the scroller after each test. */
export function stubEachTest(): void {
  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, 'clientWidth');
    Reflect.deleteProperty(document.documentElement, 'clientHeight');
    rect = { left: 100, right: 420, top: 20, bottom: 40 };
    scrollerRect = undefined;
  });
}
