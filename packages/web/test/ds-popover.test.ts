// @vitest-environment happy-dom
import { act, createElement, Fragment, useRef, type ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from '../src/ds/index.ts';
import {
  button,
  dialogs,
  emulateFocusFixup,
  key,
  mountEachTest,
  press,
  render,
} from './ds-layers-helpers.ts';
import {
  Harness,
  ModalHost,
  type Rect,
  anchorRect,
  box,
  clip,
  menu,
  mouse,
  opened,
  placement,
  popover,
  refuseHiddenFocus,
  stubAnchorRect,
  stubEachTest,
} from './ds-popover-helpers.ts';

mountEachTest();
emulateFocusFixup();

const popoverExamples: Record<string, Record<string, ComponentType>> = import.meta.glob(
  '../src/ds/Popover/*.examples.tsx',
  { eager: true },
);

stubEachTest();

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

  it('Escape and Close each call onClose once; the Escape is handled', () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    press(button('Help'));
    press(button('Close', opened()));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(popover()).toBeUndefined();
  });

  it('returns focus to its trigger without scrolling, however it opened and closed', () => {
    const other = createElement('button', { type: 'button' }, 'Other');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    // keyboard: the trigger holds focus; pointer: Safari leaves focus on body; unrelated: Safari
    // leaves it on a control elsewhere. Shared: a collapsed menu trigger sits before Help.
    for (const opening of ['keyboard', 'pointer', 'unrelated'] as const)
      for (const shared of [false, true])
        for (const closing of ['Escape inside', 'Escape on body', 'Close'] as const) {
          const row = `${opening}, ${shared ? 'shared' : 'single'}, ${closing}`;
          render(createElement(Fragment, null));
          render(createElement(Harness, { shared, after: other }));
          act(() => {
            if (opening === 'keyboard') button('Help').focus();
            if (opening === 'unrelated') button('Other').focus();
            button('Help').click();
          });
          const close = button('Close', opened());
          // Focus moves to Close only when something held focus, and without scrolling.
          expect(document.activeElement, row).toBe(opening === 'pointer' ? document.body : close);
          if (opening !== 'pointer')
            expect(focus.mock.calls.at(-1), row).toEqual([{ preventScroll: true }]);
          act(() => {
            if (closing === 'Escape inside') close.focus();
            if (closing === 'Escape on body') (document.activeElement as HTMLElement).blur();
          });
          focus.mockClear();
          if (closing === 'Close')
            act(() => {
              close.click();
            });
          else key('Escape');
          expect(popover(), row).toBeUndefined();
          expect(document.activeElement, row).toBe(button('Help'));
          expect(focus.mock.calls, row).toEqual([[{ preventScroll: true }]]);
        }
  });

  it('moves focus to the trigger while hidden and back when shown, unless focus moved on', () => {
    refuseHiddenFocus();
    const control = createElement('button', { type: 'button' }, 'Body control');
    const other = createElement('button', { type: 'button' }, 'Other');
    const scroll = (left: number) => {
      stubAnchorRect({ left, right: left + 320, top: 20, bottom: 40 });
      act(() => {
        document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
      });
    };
    // stay: the anchor scrolls out and back; movedOn: the user focuses Other meanwhile; detached:
    // the column head (anchor and trigger together) unmounts and mounts again.
    for (const how of ['stay', 'movedOn', 'detached'] as const) {
      const harness = (attached: boolean) =>
        createElement(Harness, { children: control, after: other, attached });
      render(createElement(Fragment, null));
      render(harness(true));
      press(button('Help'));
      act(() => {
        button('Body control', opened()).focus();
      });
      if (how === 'detached') {
        render(harness(false));
        scroll(100);
        expect(opened().getAttribute('data-away')).toBe('detached');
        // No trigger to move to: the browser drops focus from the hidden panel to body.
        expect(document.activeElement).toBe(button('Body control', opened()));
        act(() => {
          (document.activeElement as HTMLElement).blur();
        });
        render(harness(true));
      } else {
        // The anchor scrolls wholly out: the panel hides, and focus goes to the trigger first.
        scroll(-400);
        expect(opened().getAttribute('data-away')).toBe('left');
        expect(document.activeElement).toBe(button('Help'));
      }
      if (how === 'movedOn')
        act(() => {
          button('Other').focus();
        });
      scroll(100);
      expect(opened().hasAttribute('data-away')).toBe(false);
      expect(document.activeElement, how).toBe(
        how === 'movedOn' ? button('Other') : button('Body control', opened()),
      );
    }
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

  it('follows a layout change each frame, writes only a change, and stops on close', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++next, callback);
      return next;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const frame = () => {
      const queued = [...frames.entries()];
      frames.clear();
      act(() => {
        for (const [, callback] of queued) callback(0);
      });
    };
    anchorRect();
    render(createElement(Harness, { initial: true }));
    expect(frames.size).toBe(1);
    // A column before it expands: the anchor moves with no scroll or resize.
    stubAnchorRect({ left: 400, right: 720, top: 20, bottom: 40 });
    frame();
    expect(placement()).toEqual(box(400, 720, 20, 40, null));
    const write = vi.spyOn(opened().style, 'setProperty');
    frame();
    expect(write).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    // Segmented tabs wrap: the header grows, and the least height follows it.
    const header = opened().firstElementChild as HTMLElement;
    Object.defineProperty(header, 'offsetHeight', { configurable: true, get: () => 66 });
    frame();
    expect(opened().style.getPropertyValue('--popover-header')).toBe('66px');
    press(button('Help'));
    expect(popover()).toBeUndefined();
    expect(frames.size).toBe(0);
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
    // Wholly right of the window: its cut with the window is empty.
    const beyond: Rect = { left: 1100, right: 1500, top: 0, bottom: 600 };
    // Anchor edges, the clipping scroller if any, the side `data-away` names (null: in view), and
    // the layout: in flow, a fixed anchor, an absolute one with the scroller static or positioned.
    // An anchor narrower than the panel leaves by the left too: the CSS then puts the panel's
    // right edge at or left of the anchor's (web-popover.test.ts).
    const positions = {
      flow: ['', ''],
      fixed: ['fixed', ''],
      absolute: ['absolute', ''],
      positioned: ['absolute', 'relative'],
      detached: ['', ''],
    } as const;
    for (const [left, right, top, bottom, area, away, layout] of [
      [-400, -20, 20, 40, undefined, 'left', 'flow'],
      [-300, -20, 20, 40, undefined, 'left', 'flow'],
      [-249, 0, 20, 40, undefined, 'left', 'flow'],
      [1024, 1344, 20, 40, undefined, 'right', 'flow'],
      [100, 420, -21, -1, undefined, 'top', 'flow'],
      [100, 420, -20, 0, undefined, 'top', 'flow'],
      [100, 420, 768, 788, undefined, 'bottom', 'flow'],
      [100, 420, 769, 789, undefined, 'bottom', 'flow'],
      [-100, 200, 20, 40, scroller, 'left', 'flow'],
      [800, 1000, 20, 40, scroller, 'right', 'flow'],
      [300, 620, -40, 0, scroller, 'top', 'flow'],
      [300, 620, 600, 620, scroller, 'bottom', 'flow'],
      // The anchor unmounted: hidden where it was; the next row mounts it again, placed and shown.
      [300, 620, 600, 620, scroller, 'detached', 'detached'],
      [100, 420, 20, 40, undefined, null, 'flow'],
      [1000, 1320, 20, 40, undefined, null, 'flow'],
      [-300, 20, 20, 40, undefined, null, 'flow'],
      [100, 420, -19, 1, undefined, null, 'flow'],
      [100, 420, 767, 787, undefined, null, 'flow'],
      [150, 470, 590, 610, scroller, null, 'flow'],
      // A wide anchor spanning both window edges, in an empty visible area.
      [-100, 1200, 20, 40, beyond, 'empty', 'flow'],
      // The scroller is not on the anchor's containing-block chain: it does not clip.
      [-100, 180, 20, 40, scroller, null, 'fixed'],
      [-100, 180, 20, 40, scroller, null, 'absolute'],
      [-100, 180, 20, 40, scroller, 'left', 'positioned'],
    ] as const) {
      const [anchorPosition, scrollerPosition] = positions[layout];
      render(createElement(Harness, { initial: true, attached: layout !== 'detached' }));
      clip(area, scrollerPosition);
      document.getElementById('anchor')?.style.setProperty('position', anchorPosition);
      stubAnchorRect({ left, right, top, bottom });
      act(() => {
        document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
      });
      expect(placement(), JSON.stringify({ left, right, top, bottom, area, layout })).toEqual(
        box(left, right, top, bottom, away),
      );
    }
  });

  it('reads the current anchor and trigger, a trigger outside the anchor, after a swap', () => {
    const onClose = vi.fn();
    // Anchors One and Two, each with its trigger outside it, Help one and Help two.
    function Swap({ second }: { second: boolean }) {
      const refs = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)] as const;
      const triggers = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)] as const;
      const names = ['One', 'Two', 'Help one', 'Help two'];
      return createElement(
        Fragment,
        null,
        [...refs, ...triggers].map((ref, index) =>
          createElement('button', { key: index, type: 'button', ref }, names[index]),
        ),
        createElement(Popover, {
          open: true,
          onClose,
          anchor: refs[second ? 1 : 0],
          trigger: triggers[second ? 1 : 0],
          title: 'T',
          children: 'Body',
        }),
      );
    }
    render(createElement(Swap, { second: false }));
    render(createElement(Swap, { second: true }));
    // The current anchor and the current trigger are not outside; the old ones are.
    for (const [name, closes] of [
      ['Two', 0],
      ['Help two', 0],
      ['One', 1],
      ['Help one', 2],
    ] as const) {
      mouse('mousedown', button(name));
      expect(onClose, name).toHaveBeenCalledTimes(closes);
    }
    act(() => {
      button('Close', opened()).focus();
    });
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(document.activeElement).toBe(button('Help two'));
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
          trigger: anchor,
          title: 'Review',
          children: 'Body',
        }),
      );
    }
    const opener = createElement('button', { key: 'opener', type: 'button' }, 'Opener');
    render([opener]);
    act(() => {
      button('Opener').focus();
    });
    refuseHiddenFocus();
    render([opener, createElement(Inside, { key: 'inside' })]);
    expect(placement()).toEqual(box(100, 420, 20, 40, null));
    // Something held focus at open: the move to Close waits until the panel is shown.
    expect(document.activeElement).toBe(button('Close', opened()));
  });

  it('with focus on body, Escape returns focus to the trigger only from a shown panel', () => {
    // A hidden panel (its anchor scrolled out) closes and leaves focus where it was: on body.
    for (const [left, shown] of [
      [100, true],
      [-400, false],
    ] as const) {
      stubAnchorRect({ left, right: left + 320, top: 20, bottom: 40 });
      const onClose = vi.fn();
      render(createElement(Fragment, null));
      render(createElement(Harness, { initial: true, onClose }));
      expect(opened().hasAttribute('data-away')).toBe(!shown);
      key('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.activeElement, String(shown)).toBe(shown ? button('Help') : document.body);
    }
  });

  it('with focus on body, Escape closes the most recent shown surface, else a hidden one', () => {
    anchorRect();
    // The hidden popover opens last: its anchor is not mounted.
    for (const shown of [true, false]) {
      const hidden = createElement(Harness, { key: 'hidden', initial: true, attached: false });
      render(createElement(Fragment, null));
      render([shown && createElement(Harness, { key: 'shown', initial: true }), hidden]);
      const away = () => dialogs().map((dialog) => dialog.hasAttribute('data-away'));
      expect(away()).toEqual(shown ? [false, true] : [true]);
      key('Escape');
      expect(away(), String(shown)).toEqual(shown ? [true] : []);
    }
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
