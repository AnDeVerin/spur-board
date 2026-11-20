// @vitest-environment happy-dom
import { act, createElement, Fragment, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from '../src/ds/index.ts';
import { button, mountEachTest, press, render } from './ds-layers-helpers.ts';
import {
  Closing,
  Harness,
  box,
  clip,
  flush,
  gaps,
  intersect,
  observers,
  opened,
  placement,
  popover,
  resized,
  scrolled,
  stubAnchorRect,
  stubEachTest,
  stubObservers,
  stubPanelSize,
} from './ds-popover-helpers.ts';

// Placement through @floating-ui/dom, on the stubbed boxes of ds-popover-helpers.ts: a 1024x768
// window, a 320x200 panel with a least height of 120, and the gap tokens 4px and 8px.

mountEachTest();
stubEachTest();
beforeEach(stubObservers);

/** A Harness opened with its anchor at `anchor`, settled. */
const openAt = async (anchor: { left: number; right: number; top: number; bottom: number }) => {
  stubAnchorRect(anchor);
  render(createElement(Harness, { initial: true }));
  await flush();
};

describe('Popover placement', () => {
  it('sits the --space-1 gap under the anchor and keeps --space-2 off the window edge', async () => {
    await openAt({ left: 100, right: 420, top: 20, bottom: 40 });
    expect(placement()).toEqual(box(100, 44));
    // A right-edge anchor: shifted to 1024 - 8 - 320.
    stubAnchorRect({ left: 900, right: 1000, top: 20, bottom: 40 });
    await scrolled();
    expect(placement()).toEqual(box(696, 44));
    // The gaps are read from the panel's computed style at each update, not fixed in code.
    Object.assign(gaps, { '--space-1': '6px', '--space-2': '12px' });
    try {
      await scrolled();
      expect(placement()).toEqual(box(1024 - 12 - 320, 46));
    } finally {
      Object.assign(gaps, { '--space-1': '4px', '--space-2': '8px' });
    }
  });

  it('flips above once less than the least height fits below; stays below otherwise; shifts into view when neither fits', async () => {
    // 156px below (768 - 8 - 604): it stays and shrinks to that room.
    await openAt({ left: 100, right: 420, top: 580, bottom: 600 });
    expect(placement()).toEqual(box(100, 604));
    expect(opened().style.getPropertyValue('--popover-available')).toBe('156px');
    // 56px below, less than the least height 120: above, at 680 - 4 - 200. The first result
    // measured the pending panel as 0x0 and fitted below; the update after it uses the shown size.
    stubAnchorRect({ left: 100, right: 420, top: 680, bottom: 700 });
    render(createElement(Fragment, null));
    render(createElement(Harness, { initial: true }));
    await flush();
    expect(placement()).toEqual(box(100, 476));
    // A tall anchor: 56px below and 88px above. It stays below at its least height, shifted up to
    // keep its header in the window: 768 - 8 - 120.
    stubAnchorRect({ left: 100, right: 420, top: 100, bottom: 700 });
    await scrolled();
    expect(placement()).toEqual(box(100, 640));
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
      await flush();
      const row = String(bottom);
      expect(placement(), row).toEqual({ left: '100px', top: `${String(top)}px`, away: null });
      expect(opened().style.getPropertyValue('--popover-available'), row).toBe(room);
    }
  });

  it('places again when an input changes with no commit, DOM change or autoUpdate trigger', async () => {
    // swap: the caller points the same ref at another connected element, then a scroll: the
    // panel's element is gone, so it closes once. header: tabs wrap while the panel is capped by
    // the room below, so its outer size stays: the header's own resize raises the least height
    // to 152, over the 146px below, and the panel flips above (582 - 4 - 570).
    for (const row of ['swap', 'header'] as const) {
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
      await flush();
      expect(placement(), row).toEqual(box(100, 614));
      if (row === 'swap') {
        held.current = two;
        await scrolled();
        await scrolled();
        expect(onClose, row).toHaveBeenCalledTimes(1);
      } else {
        const header = opened().firstElementChild as HTMLElement;
        Object.defineProperty(header, 'offsetHeight', { configurable: true, get: () => 66 });
        await resized(header);
        expect(opened().style.getPropertyValue('--popover-header'), row).toBe('66px');
        expect(placement(), row).toEqual(box(100, 8));
        expect(onClose, row).not.toHaveBeenCalled();
      }
      render(createElement(Fragment, null));
      one.remove();
      two.remove();
    }
  });

  it('follows a transform ancestor that clips a fixed anchor', async () => {
    // The transform makes the scroller the fixed anchor's containing block, so it clips it.
    await openAt({ left: 300, right: 400, top: 20, bottom: 40 });
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
      await scrolled();
      expect(opened().getAttribute('data-away'), String(left)).toBe(away);
    }
  });

  it('follows a layout shift and a resize with no frame of its own', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    await openAt({ left: 100, right: 420, top: 20, bottom: 40 });
    const panel = opened();
    const anchor = document.getElementById('anchor');
    if (!anchor) throw new Error('no anchor');
    // A column before it grows: the anchor moves with no scroll or resize event.
    stubAnchorRect({ left: 400, right: 720, top: 20, bottom: 40 });
    await intersect();
    expect(placement()).toEqual(box(400, 44));
    // Tabs wrap: the panel resizes and its header sets the new least height.
    const header = panel.firstElementChild as HTMLElement;
    Object.defineProperty(header, 'offsetHeight', { configurable: true, get: () => 66 });
    await resized(panel);
    expect(panel.style.getPropertyValue('--popover-header')).toBe('66px');
    expect(frames).not.toHaveBeenCalled();
    // An anchor resize: floating-ui itself waits one frame to observe the panel again.
    await resized(anchor);
    expect(frames).toHaveBeenCalledTimes(1);
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
      await flush();
      expect(opened().getAttribute('data-away'), how).toBe('hidden');
      expect(document.activeElement, how).toBe(button('Help'));
      expect(onClose, how).not.toHaveBeenCalled();
      if (how === 'movedOn')
        act(() => {
          button('Other').focus();
        });
      stubAnchorRect({ left: 100, right: 420, top: 20, bottom: 40 });
      await scrolled();
      expect(opened().hasAttribute('data-away'), how).toBe(false);
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
    await flush();
    expect(write.mock.calls.filter(([, value]) => value === 'hidden')).toEqual([]);
    expect(placement()).toEqual(box(500, 84));
    expect(document.activeElement).toBe(document.body);
  });

  it('a close before the result flushes writes nothing', async () => {
    render(createElement(Harness, { initial: true }));
    const panel = opened();
    press(button('Help'));
    await flush();
    expect(popover()).toBeUndefined();
    expect(panel.getAttribute('data-away')).toBe('pending');
    expect(panel.style.left).toBe('');
  });

  it('an anchor moved under another clipping parent is re-tracked: hidden when it clips, re-placed on its scroll', async () => {
    const other = createElement('div', { id: 'other' });
    render(createElement(Harness, { initial: true, after: other }));
    await flush();
    expect(placement()).toEqual(box(100, 44));
    const anchor = document.getElementById('anchor');
    const scroller = document.getElementById('scroller');
    const parent = document.getElementById('other');
    if (!anchor || !scroller || !parent) throw new Error('no anchor');
    // The new parent clips the anchor away.
    clip({ left: 600, right: 900, top: 0, bottom: 600 }, '', 'other');
    act(() => {
      parent.append(anchor);
    });
    await flush();
    expect(placement().away).toBe('hidden');
    // A scroll of the new parent alone brings it in: autoUpdate listens there now.
    stubAnchorRect({ left: 650, right: 850, top: 20, bottom: 40 });
    act(() => {
      parent.dispatchEvent(new Event('scroll'));
    });
    await flush();
    expect(placement()).toEqual(box(650, 44));
    // Back in place, so React can remove it on unmount.
    scroller.append(anchor);
  });

  it('a close that unmounts the panel inside an update leaves nothing observed', async () => {
    render(createElement(Closing, { attached: true }));
    await flush();
    const anchor = document.getElementById('anchor');
    const parent = anchor?.parentElement;
    if (!anchor || !parent) throw new Error('no anchor');
    // The anchor leaves the document with no re-render: the DOM change closes the panel.
    act(() => {
      anchor.remove();
    });
    await flush();
    expect(popover()).toBeUndefined();
    const live = [...observers.intersection, ...observers.resize].filter(
      ({ targets }) => targets.size > 0,
    );
    expect(live).toEqual([]);
    parent.prepend(anchor);
  });
});
