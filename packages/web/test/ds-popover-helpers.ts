import { act, createElement, Fragment, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { HoverMenu, Modal, Popover, type HoverMenuItem } from '../src/ds/index.ts';
import { dialogs } from './ds-layers-helpers.ts';

// Shared by ds-popover.test.ts and ds-popover-placement.test.ts: the Popover harness, a Modal
// host, a HoverMenu, the element box and panel size stubs, the gap tokens, fake observers, and
// the placement the popover wrote.

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
 * `attached={false}` unmounts the anchor, as a column head leaving the board; a new
 * `generation` replaces the anchor element under the same ref, as a column head re-rendered.
 */
export function Harness({
  initial = false,
  onClose = () => undefined,
  children,
  after,
  shared = false,
  attached = true,
  generation = 0,
}: {
  initial?: boolean;
  onClose?: () => void;
  children?: ReactNode;
  after?: ReactNode;
  shared?: boolean;
  attached?: boolean;
  generation?: number;
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
          { id: 'anchor', ref: anchor, key: generation },
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
const anchorDefault: Rect = { left: 100, right: 420, top: 20, bottom: 40 };
// Boxes by element id; `anchor` defaults to `anchorDefault`, any other element has an empty box.
const rects = new Map<string, Rect>();
// The box of `#scroller` when a test makes it clip, else none.
let scrollerRect: Rect | undefined;
export const stubAnchorRect = (next: Rect, id = 'anchor') => {
  rects.set(id, next);
};
const domRect = ({ left, right, top, bottom }: Rect) => {
  const box = { left, right, top, bottom, x: left, y: top, width: right - left };
  return { ...box, height: bottom - top, toJSON: () => box };
};
const empty: Rect = { left: 0, right: 0, top: 0, bottom: 0 };
/**
 * Stubs the element boxes and a 1024x768 window: happy-dom reports `clientWidth` and
 * `clientHeight` 0. An element's box is the one stubbed for its id (`#anchor` has a default, a
 * clipping `#scroller` its area), else empty, so the panel's offset parent adds nothing.
 */
const anchorRect = () => {
  for (const [name, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const)
    Object.defineProperty(document.documentElement, name, { configurable: true, get: () => value });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.id === 'scroller' && scrollerRect) return domRect(scrollerRect);
    return domRect(rects.get(this.id) ?? (this.id === 'anchor' ? anchorDefault : empty));
  });
};
/**
 * Makes `#scroller` clip both axes to `area` (its padding box: no border here), or stop, and
 * gives it `position`.
 */
export const clip = (area: Rect | undefined, position = '', id = 'scroller') => {
  if (id === 'scroller') scrollerRect = area;
  else if (area) rects.set(id, area);
  const scroller = document.getElementById(id);
  if (!scroller) throw new Error(`no ${id}`);
  scroller.style.position = position;
  scroller.style.overflowX = area ? 'auto' : '';
  scroller.style.overflowY = area ? 'auto' : '';
  for (const [name, value] of [
    ['clientWidth', area ? area.right - area.left : 0],
    ['clientHeight', area ? area.bottom - area.top : 0],
  ] as const)
    Object.defineProperty(scroller, name, { configurable: true, get: () => value });
};

/**
 * The panel's size as a browser would lay it out: `width` and the content `height`, capped by the
 * CSS `max-height` (the room placement wrote as `--popover-available`, floored at `least`, which
 * grows with `--popover-header`). A
 * panel under `[data-away]` is not rendered and has no box. As in Chrome, `offsetWidth` and
 * `offsetHeight` round it to whole pixels and `getComputedStyle` to three decimals.
 */
const panelSize = { width: 320, height: 200, least: 120 };
export const stubPanelSize = (next: Partial<typeof panelSize>) => {
  Object.assign(panelSize, next);
};
const isPanel = (element: Element): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.getAttribute('role') === 'dialog' &&
  !element.hasAttribute('aria-modal');
const laidOut = (panel: HTMLElement) => {
  if (panel.closest('[data-away]')) return { width: 0, height: 0 };
  const available = parseFloat(panel.style.getPropertyValue('--popover-available'));
  // The least height grows with a header written taller than the one-row 34px.
  const header = parseFloat(panel.style.getPropertyValue('--popover-header'));
  const least = panelSize.least + Math.max(0, (Number.isNaN(header) ? 34 : header) - 34);
  const cap = Math.max(least, Number.isNaN(available) ? Infinity : available);
  return { width: panelSize.width, height: Math.min(panelSize.height, cap) };
};
const offsets = (['offsetWidth', 'offsetHeight'] as const).map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
);
const stubPanelBox = () => {
  for (const [name, original] of offsets)
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement): number {
        if (!isPanel(this)) return Number(original?.get?.call(this) ?? 0);
        const { width, height } = laidOut(this);
        return Math.round(name === 'offsetWidth' ? width : height);
      },
    });
};

/**
 * The gap tokens as `tokens.css` sets them on `:root`. happy-dom does not inherit custom
 * properties into `getComputedStyle`, so a computed style falls back to them, as in a browser.
 * The panel's computed `width` and `height` are its laid-out size at three decimals.
 */
export const gaps: Record<string, string> = { '--space-1': '4px', '--space-2': '8px' };
const computedStyle = () => {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = original(element, pseudo);
    return new Proxy(style, {
      get(target, property) {
        if (property === 'getPropertyValue')
          return (name: string) => target.getPropertyValue(name) || (gaps[name] ?? '');
        if ((property === 'width' || property === 'height') && isPanel(element))
          return `${String(Math.round(laidOut(element)[property] * 1000) / 1000)}px`;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  });
};

/** The position the popover wrote and its `data-away`. */
export const placement = () => {
  const style = opened().style;
  return { left: style.left, top: style.top, away: opened().getAttribute('data-away') };
};
export const box = (left: number, top: number, away: string | null = null) => ({
  left: `${String(left)}px`,
  top: `${String(top)}px`,
  away,
});

/** Lets placement results, effects and observer callbacks settle. */
export const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 3; index++)
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
  });
};

/**
 * Emulates a browser that does not focus an element it does not render: one inside a popover
 * hidden by `data-away`. happy-dom would focus it.
 */
export const refuseHiddenFocus = () => {
  type Focus = (this: HTMLElement, options?: FocusOptions) => void;
  const focus: Focus = Reflect.get(HTMLElement.prototype, 'focus');
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (!this.closest('[data-away]')) focus.call(this, options);
  });
};

/** A popover whose `onClose` unmounts it at once (`flushSync`); `attached` keeps its anchor. */
export function Closing({ attached }: { attached: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  return createElement(
    Fragment,
    null,
    attached && createElement('div', { id: 'anchor', ref: anchor }),
    createElement(Popover, {
      open,
      // Unmounts the panel synchronously, inside the update that closes it.
      onClose: () => {
        flushSync(() => {
          setOpen(false);
        });
      },
      anchor,
      trigger: anchor,
      title: 'T',
      children: 'Body',
    }),
  );
}

/**
 * A scroll of the window, and of `#scroller` when it clips: `autoUpdate` listens on the anchor's
 * and the panel's scrolling ancestors. Then the placement settles.
 */
export const scrolled = async () => {
  act(() => {
    const scroller = document.getElementById('scroller');
    if (scroller?.style.overflowX) scroller.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
  });
  await flush();
};

type Observed = { callback: (entries: unknown[]) => void; targets: Set<Element> };
/** The observers placement created, with their callbacks and current targets. */
export const observers = { intersection: [] as Observed[], resize: [] as Observed[] };
/**
 * Fake observers that keep their callbacks and targets: happy-dom's never call back, so a layout
 * shift or a resize happens only when a test fires one.
 */
export const stubObservers = () => {
  const fake = (list: Observed[]) =>
    class {
      observed: Observed;
      constructor(callback: Observed['callback']) {
        this.observed = { callback, targets: new Set() };
        list.push(this.observed);
      }
      observe(target: Element) {
        this.observed.targets.add(target);
      }
      unobserve(target: Element) {
        this.observed.targets.delete(target);
      }
      disconnect() {
        this.observed.targets.clear();
      }
      takeRecords() {
        return [];
      }
    };
  observers.intersection = [];
  observers.resize = [];
  vi.stubGlobal('IntersectionObserver', fake(observers.intersection));
  vi.stubGlobal('ResizeObserver', fake(observers.resize));
};
/** Fires every live IntersectionObserver for its targets, fully visible, then settles. */
export const intersect = async () => {
  act(() => {
    for (const { callback, targets } of observers.intersection)
      if (targets.size > 0)
        callback([...targets].map((target) => ({ target, intersectionRatio: 1 })));
  });
  await flush();
};
/** Fires every ResizeObserver watching `target` with one entry for it, then settles. */
export const resized = async (target: Element) => {
  act(() => {
    for (const { callback, targets } of observers.resize)
      if (targets.has(target)) callback([{ target }]);
  });
  await flush();
};

export function stubEachTest(): void {
  // A shown panel by default: without a window size happy-dom gives an empty view, which hides it.
  beforeEach(() => {
    anchorRect();
    stubPanelBox();
    computedStyle();
  });
  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, 'clientWidth');
    Reflect.deleteProperty(document.documentElement, 'clientHeight');
    for (const [name, original] of offsets)
      if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    rects.clear();
    Object.assign(panelSize, { width: 320, height: 200, least: 120 });
    scrollerRect = undefined;
    vi.unstubAllGlobals();
  });
}
