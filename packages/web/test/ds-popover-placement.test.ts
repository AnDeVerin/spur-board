// @vitest-environment happy-dom
import { act, createElement, Fragment, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverMenu, Popover } from '../src/ds/index.ts';
import { button, key, mountEachTest, press, render } from './ds-layers-helpers.ts';
import {
  Closing,
  Harness,
  box,
  clip,
  flush,
  gaps,
  holds,
  intersect,
  observers,
  opened,
  placement,
  popover,
  resized,
  scrolled,
  shown,
  stubAnchorRect,
  stubEachTest,
  stubObservers,
  stubPanelSize,
  until,
} from './ds-popover-helpers.ts';

// Placement through @floating-ui/dom, on the stubbed boxes of ds-popover-helpers.ts: a 1024x768
// window, a 320x200 panel with a least height of 120, and the gap tokens 4px and 8px.

mountEachTest();
stubEachTest();
beforeEach(stubObservers);

/** A Harness opened with its anchor at `anchor`; its placement lands later. */
const openAt = (anchor: { left: number; right: number; top: number; bottom: number }) => {
  stubAnchorRect(anchor);
  render(createElement(Harness, { initial: true }));
};

describe('Popover placement', () => {
  it('sits the --space-1 gap under the anchor and keeps --space-2 off the window edge', async () => {
    openAt({ left: 100, right: 420, top: 20, bottom: 40 });
    await until(() => {
      expect(placement()).toEqual(box(100, 44));
    });
    // A right-edge anchor: shifted to 1024 - 8 - 320.
    stubAnchorRect({ left: 900, right: 1000, top: 20, bottom: 40 });
    scrolled();
    await until(() => {
      expect(placement()).toEqual(box(696, 44));
    });
    // The gaps are read from the panel's computed style at each update, not fixed in code.
    Object.assign(gaps, {
      '--space-1': '6px',
      'scroll-padding-top': '12px',
      'scroll-padding-right': '12px',
      'scroll-padding-bottom': '12px',
      'scroll-padding-left': '12px',
    });
    scrolled();
    await until(() => {
      expect(placement()).toEqual(box(1024 - 12 - 320, 46));
    });
  });

  it('keeps each window edge its own resolved width: a safe-area inset larger than --space-2', async () => {
    // A notch inset of 40px on the right and 30px at the bottom (#760), resolved by the CSS into
    // scroll-padding: the shift bound moves to 1024 - 40 - 320, and the room below to
    // 768 - 30 - 604.
    Object.assign(gaps, { 'scroll-padding-right': '40px', 'scroll-padding-bottom': '30px' });
    stubPanelSize({ height: 600 });
    openAt({ left: 900, right: 1000, top: 580, bottom: 600 });
    await until(() => {
      expect(placement()).toEqual(box(664, 604));
    });
    expect(opened().style.getPropertyValue('--popover-available')).toBe('134px');
    // On the left the inset is under --space-2: the bound stays at 8.
    stubAnchorRect({ left: -50, right: 50, top: 580, bottom: 600 });
    scrolled();
    await until(() => {
      expect(placement()).toEqual(box(8, 604));
    });
  });

  it('flips above once less than the least height fits below; stays below otherwise; shifts into view when neither fits', async () => {
    // 156px below (768 - 8 - 604): it stays and shrinks to that room.
    openAt({ left: 100, right: 420, top: 580, bottom: 600 });
    await until(() => {
      expect(placement()).toEqual(box(100, 604));
    });
    expect(opened().style.getPropertyValue('--popover-available')).toBe('156px');
    // 56px below, less than the least height 120: above, at 680 - 4 - 200. The first result
    // measured the pending panel as 0x0 and fitted below; the update after it uses the shown size.
    stubAnchorRect({ left: 100, right: 420, top: 680, bottom: 700 });
    render(createElement(Fragment, null));
    render(createElement(Harness, { initial: true }));
    await until(() => {
      expect(placement()).toEqual(box(100, 476));
    });
    // A tall anchor: 56px below and 88px above. It stays below at its least height, shifted up to
    // keep its header in the window: 768 - 8 - 120.
    stubAnchorRect({ left: 100, right: 420, top: 100, bottom: 700 });
    scrolled();
    await until(() => {
      expect(placement()).toEqual(box(100, 640));
    });
  });

  it('stays below with room on a fractional anchor edge: the room it writes is whole pixels', async () => {
    // A computed height at three decimals can exceed a fractional room by a hair, which flip
    // took as overflow: 768 - 8 - 431.703125 = 328.296875 reads back as 328.297px.
    for (const [bottom, top, room] of [
      [427.703125, 431.703125, '328px'],
      [427.5, 431.5, '328px'],
      [428, 432, '328px'],
    ] as const) {
      stubAnchorRect({ left: 100, right: 420, top: bottom - 28, bottom });
      stubPanelSize({ height: 600 });
      render(createElement(Fragment, null));
      render(createElement(Harness, { initial: true }));
      const row = String(bottom);
      // A flip would land after the first shown result: wait, then check it holds.
      await holds(() => {
        expect(placement(), row).toEqual({ left: '100px', top: `${String(top)}px`, away: null });
      });
      expect(opened().style.getPropertyValue('--popover-available'), row).toBe(room);
    }
  });

  it('places again when an input changes with no commit, DOM change or autoUpdate trigger', async () => {
    // swap: the caller points the same ref at another connected element, then a scroll: the
    // panel's element is gone, so it closes once. header: tabs wrap while the panel is capped by
    // the room below, so its outer size stays: the header's own resize raises the least height
    // to 152, over the 146px below, and the panel flips above (582 - 4 - 570). newRef: a
    // re-render passes a fresh ref object holding the same element, which retargets: placement
    // keeps following it.
    for (const row of ['swap', 'header', 'newRef'] as const) {
      const onClose = vi.fn();
      const attach = (id: string) => {
        const element = document.createElement('button');
        element.id = id;
        document.body.append(element);
        return element;
      };
      const one = attach('one');
      const two = attach('two');
      stubAnchorRect({ left: 100, right: 420, top: 582, bottom: 610 }, 'one');
      stubAnchorRect({ left: 500, right: 580, top: 60, bottom: 80 }, 'two');
      stubPanelSize({ height: 600 });
      const held = { current: one };
      const props = { open: true, onClose, anchor: held, trigger: held, title: 'T' };
      render(createElement(Fragment, null));
      render(createElement(Popover, { ...props, children: 'Body' }));
      await until(() => {
        expect(placement(), row).toEqual(box(100, 614));
      });
      if (row === 'swap') {
        held.current = two;
        scrolled();
        await until(() => {
          expect(onClose, row).toHaveBeenCalled();
        });
        scrolled();
        await flush();
        expect(onClose, row).toHaveBeenCalledTimes(1);
      } else if (row === 'newRef') {
        const fresh = { current: one };
        render(
          createElement(Popover, { ...props, anchor: fresh, trigger: fresh, children: 'Body' }),
        );
        stubAnchorRect({ left: 200, right: 520, top: 300, bottom: 320 }, 'one');
        scrolled();
        await until(() => {
          expect(placement(), row).toEqual(box(200, 324));
        });
        expect(onClose, row).not.toHaveBeenCalled();
      } else {
        const header = opened().firstElementChild as HTMLElement;
        Object.defineProperty(header, 'offsetHeight', { configurable: true, get: () => 66 });
        resized(header);
        await until(() => {
          expect(placement(), row).toEqual(box(100, 8));
        });
        expect(opened().style.getPropertyValue('--popover-header'), row).toBe('66px');
        expect(onClose, row).not.toHaveBeenCalled();
      }
      render(createElement(Fragment, null));
      one.remove();
      two.remove();
    }
  });

  it('follows the anchor on nested scroll and resize', async () => {
    // A scroller that clips around the anchor before the open, so autoUpdate listens on it.
    render(createElement(Harness));
    clip({ left: 0, right: 1024, top: 0, bottom: 768 });
    press(button('Help'));
    await until(() => {
      expect(placement()).toEqual(box(100, 44));
    });
    stubAnchorRect({ left: 60, right: 380, top: 10, bottom: 30 });
    act(() => {
      document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
    });
    await until(() => {
      expect(placement()).toEqual(box(60, 34));
    });
    stubAnchorRect({ left: 200, right: 520, top: 50, bottom: 70 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await until(() => {
      expect(placement()).toEqual(box(200, 74));
    });
  });

  it('follows a transform ancestor that clips a fixed anchor', async () => {
    // The transform makes the scroller the fixed anchor's containing block, so it clips it.
    openAt({ left: 300, right: 400, top: 20, bottom: 40 });
    await shown();
    const scroller = document.getElementById('scroller');
    clip({ left: 200, right: 800, top: 0, bottom: 600 });
    scroller?.style.setProperty('transform', 'translateX(0)');
    document.getElementById('anchor')?.style.setProperty('position', 'fixed');
    for (const [left, away] of [
      [300, null],
      [850, 'hidden'],
      [-200, 'hidden'],
    ] as const) {
      stubAnchorRect({ left, right: left + 100, top: 20, bottom: 40 });
      scrolled();
      await holds(() => {
        expect(opened().getAttribute('data-away'), String(left)).toBe(away);
      });
    }
  });

  it('a display: contents wrapper clips nothing, even with its own position and overflow', async () => {
    // A #769 limit, kept: floating-ui skips a `display: contents` ancestor as a clipper, as the
    // old walk did, so an anchor outside such a wrapper's area still counts as in view. The same
    // wrapper laid out as a block clips it away.
    openAt({ left: 100, right: 420, top: 20, bottom: 40 });
    await shown();
    for (const [display, away] of [
      ['contents', null],
      ['block', 'hidden'],
    ] as const) {
      clip({ left: 600, right: 900, top: 0, bottom: 600 }, 'relative');
      document.getElementById('scroller')?.style.setProperty('display', display);
      scrolled();
      await holds(() => {
        expect(opened().getAttribute('data-away'), display).toBe(away);
      });
    }
  });

  it('with focus on body, Escape closes an offscreen defaultOpen HoverMenu first: it counts as shown', async () => {
    // A #769 limit, kept: a HoverMenu has no in-view test, so one opened by `defaultOpen` outside
    // the window counts as shown, and as the most recently opened shown surface it closes first.
    const offscreen = createElement(
      'div',
      { id: 'offscreen', style: { position: 'fixed', left: '-9999px' } },
      createElement(HoverMenu<'a'>, {
        label: 'Sort',
        icon: 'sun',
        items: [{ value: 'a', label: 'First' }],
        value: 'a',
        onSelect: () => undefined,
        defaultOpen: true,
      }),
    );
    render(createElement(Harness, { initial: true }));
    await shown();
    render(createElement(Harness, { initial: true, after: offscreen }));
    // The registered root and its menu get a real box wholly left of the 1024x768 window, so an
    // in-view check on either would flip this result.
    const root = document.getElementById('offscreen')?.firstElementChild;
    const list = document.querySelector('[role="menu"]');
    if (!root || !list) throw new Error('no open menu');
    root.id = 'menu-root';
    list.id = 'menu-list';
    stubAnchorRect({ left: -9999, right: -9919, top: 300, bottom: 328 }, 'menu-root');
    stubAnchorRect({ left: -10119, right: -9919, top: 328, bottom: 400 }, 'menu-list');
    for (const element of [root, list]) {
      const box = element.getBoundingClientRect();
      expect(box.width * box.height, element.id).toBeGreaterThan(0);
      expect(box.right, element.id).toBeLessThan(0);
    }
    expect(document.activeElement).toBe(document.body);
    key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(popover()).toBeDefined();
    key('Escape');
    expect(popover()).toBeUndefined();
  });

  it('follows a layout shift and a resize with no frame of its own', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    openAt({ left: 100, right: 420, top: 20, bottom: 40 });
    await shown();
    const panel = opened();
    const anchor = document.getElementById('anchor');
    if (!anchor) throw new Error('no anchor');
    // A column before it grows: the anchor moves with no scroll or resize event.
    stubAnchorRect({ left: 400, right: 720, top: 20, bottom: 40 });
    intersect();
    await until(() => {
      expect(placement()).toEqual(box(400, 44));
    });
    // Tabs wrap: the panel resizes and its header sets the new least height.
    const header = panel.firstElementChild as HTMLElement;
    Object.defineProperty(header, 'offsetHeight', { configurable: true, get: () => 66 });
    resized(panel);
    await until(() => {
      expect(panel.style.getPropertyValue('--popover-header')).toBe('66px');
    });
    expect(frames).not.toHaveBeenCalled();
    // An anchor resize: floating-ui itself waits one frame to observe the panel again.
    resized(anchor);
    await holds(() => {
      expect(frames).toHaveBeenCalledTimes(1);
    });
  });

  it('opens with an attached, out-of-view anchor: focus stays on the opener until it shows', async () => {
    // stay: focus is still on the opener when the anchor comes in; movedOn: the user focused
    // Other meanwhile, and it stays there.
    for (const how of ['stay', 'movedOn'] as const) {
      const onClose = vi.fn();
      const other = createElement('button', { type: 'button' }, 'Other');
      stubAnchorRect({ left: -400, right: -80, top: 20, bottom: 40 });
      render(createElement(Fragment, null));
      render(createElement(Harness, { onClose, after: other }));
      press(button('Help'));
      await until(() => {
        expect(opened().getAttribute('data-away'), how).toBe('hidden');
      });
      expect(document.activeElement, how).toBe(button('Help'));
      expect(onClose, how).not.toHaveBeenCalled();
      if (how === 'movedOn')
        act(() => {
          button('Other').focus();
        });
      stubAnchorRect({ left: 100, right: 420, top: 20, bottom: 40 });
      scrolled();
      await shown();
      expect(document.activeElement, how).toBe(
        how === 'stay' ? button('Close', opened()) : button('Other'),
      );
    }
  });

  it('a ref swap before the first result flushes: no write and no focus move from the old run', async () => {
    // Anchor One is out of view, Two in view; the swap comes before One's result.
    stubAnchorRect({ left: -400, right: -80, top: 20, bottom: 40 }, 'one');
    stubAnchorRect({ left: 500, right: 580, top: 60, bottom: 80 }, 'two');
    function Swap({ second }: { second: boolean }) {
      const one = useRef<HTMLButtonElement>(null);
      const two = useRef<HTMLButtonElement>(null);
      return createElement(
        Fragment,
        null,
        createElement('button', { id: 'one', type: 'button', ref: one }, 'One'),
        createElement('button', { id: 'two', type: 'button', ref: two }, 'Two'),
        createElement(Popover, {
          open: true,
          onClose: () => undefined,
          anchor: second ? two : one,
          trigger: second ? two : one,
          title: 'T',
          children: 'Body',
        }),
      );
    }
    render(createElement(Swap, { second: false }));
    const write = vi.spyOn(Element.prototype, 'setAttribute');
    render(createElement(Swap, { second: true }));
    await until(() => {
      expect(placement()).toEqual(box(500, 84));
    });
    // One's result never landed, also not after a bounded wait.
    await flush();
    expect(write.mock.calls.filter(([, value]) => value === 'hidden')).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });

  it('a close before the result flushes writes nothing', async () => {
    render(createElement(Harness, { initial: true }));
    const panel = opened();
    press(button('Help'));
    // Nothing lands within a bounded wait.
    await flush();
    expect(popover()).toBeUndefined();
    expect(panel.getAttribute('data-away')).toBe('pending');
    expect(panel.style.left).toBe('');
  });

  it('an anchor moved under another clipping parent is re-tracked: hidden when it clips, re-placed on its scroll', async () => {
    const other = createElement('div', { id: 'other' });
    render(createElement(Harness, { initial: true, after: other }));
    await until(() => {
      expect(placement()).toEqual(box(100, 44));
    });
    const anchor = document.getElementById('anchor');
    const scroller = document.getElementById('scroller');
    const parent = document.getElementById('other');
    if (!anchor || !scroller || !parent) throw new Error('no anchor');
    // The new parent clips the anchor away.
    clip({ left: 600, right: 900, top: 0, bottom: 600 }, '', 'other');
    act(() => {
      parent.append(anchor);
    });
    await until(() => {
      expect(placement().away).toBe('hidden');
    });
    // A scroll of the new parent alone brings it in: autoUpdate listens there now.
    stubAnchorRect({ left: 650, right: 850, top: 20, bottom: 40 });
    act(() => {
      parent.dispatchEvent(new Event('scroll'));
    });
    await until(() => {
      expect(placement()).toEqual(box(650, 44));
    });
    // Back in place, so React can remove it on unmount.
    scroller.append(anchor);
  });

  it('a close that unmounts the panel inside an update leaves nothing observed', async () => {
    render(createElement(Closing, { attached: true }));
    await shown();
    const anchor = document.getElementById('anchor');
    const parent = anchor?.parentElement;
    if (!anchor || !parent) throw new Error('no anchor');
    // The anchor leaves the document with no re-render: the DOM change closes the panel.
    act(() => {
      anchor.remove();
    });
    await until(() => {
      expect(popover()).toBeUndefined();
    });
    const live = [...observers.intersection, ...observers.resize].filter(
      ({ targets }) => targets.size > 0,
    );
    expect(live).toEqual([]);
    parent.prepend(anchor);
  });
});
