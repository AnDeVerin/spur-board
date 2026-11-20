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
  box,
  clip,
  flush,
  menu,
  mouse,
  opened,
  placement,
  popover,
  refuseHiddenFocus,
  scrolled,
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
  it('opens labelled, header in order, focus to Close from a focused trigger, none from body', async () => {
    render(createElement(Harness));
    expect(popover()).toBeUndefined();
    press(button('Help'));
    const dialog = opened();
    // Not drawn and focus held on the opener until the first placement result.
    expect(dialog.getAttribute('data-away')).toBe('pending');
    expect(document.activeElement).toBe(button('Help'));
    await flush();
    expect(dialog.hasAttribute('data-away')).toBe(false);
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
    await flush();
    expect(opened().hasAttribute('data-away')).toBe(false);
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

  it('returns focus to its trigger without scrolling, however it opened and closed', async () => {
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
          await flush();
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

  it('moves focus to the trigger while hidden and back when shown, unless focus moved on', async () => {
    refuseHiddenFocus();
    const control = createElement('button', { type: 'button' }, 'Body control');
    const other = createElement('button', { type: 'button' }, 'Other');
    const scroll = async (left: number) => {
      stubAnchorRect({ left, right: left + 320, top: 20, bottom: 40 });
      await scrolled();
    };
    // stay: the anchor scrolls out and back; movedOn: the user focuses Other meanwhile.
    for (const how of ['stay', 'movedOn'] as const) {
      render(createElement(Fragment, null));
      render(createElement(Harness, { children: control, after: other }));
      press(button('Help'));
      await flush();
      act(() => {
        button('Body control', opened()).focus();
      });
      // The anchor scrolls wholly out: the panel hides, and focus goes to the trigger first.
      await scroll(-400);
      expect(opened().getAttribute('data-away')).toBe('hidden');
      expect(document.activeElement).toBe(button('Help'));
      if (how === 'movedOn')
        act(() => {
          button('Other').focus();
        });
      await scroll(100);
      expect(opened().hasAttribute('data-away')).toBe(false);
      expect(document.activeElement, how).toBe(
        how === 'movedOn' ? button('Other') : button('Body control', opened()),
      );
    }
  });

  it('closes once when its anchor unmounts, is replaced under the same ref, or is disconnected', async () => {
    const control = createElement('button', { type: 'button' }, 'Body control');
    for (const how of ['unmounts', 'replaced', 'disconnected'] as const) {
      const onClose = vi.fn();
      const harness = (change: boolean) =>
        createElement(Harness, {
          initial: true,
          onClose,
          children: control,
          ...(change && how === 'unmounts' ? { attached: false } : {}),
          ...(change && how === 'replaced' ? { generation: 1 } : {}),
        });
      render(createElement(Fragment, null));
      render(harness(false));
      await flush();
      act(() => {
        button('Body control', opened()).focus();
      });
      // The column re-renders under the panel, or its element leaves the document while the ref
      // still holds it, with no re-render: the commit or the DOM change finds it gone.
      const anchor = document.getElementById('anchor');
      if (how === 'disconnected') anchor?.remove();
      else render(harness(true));
      await flush();
      for (let index = 0; index < 2; index++) await scrolled();
      expect(onClose, how).toHaveBeenCalledTimes(1);
      expect(popover(), how).toBeUndefined();
      // The popover moved no focus: the removed control's focus fell to body.
      expect(document.activeElement, how).toBe(document.body);
      // Back in place, so React can remove it on unmount.
      if (how === 'disconnected' && anchor) document.getElementById('scroller')?.append(anchor);
    }
  });

  it('stays hidden until its anchor attaches', async () => {
    const onClose = vi.fn();
    // unmounted: the anchor element is not rendered yet; detached: the ref already holds an
    // element that is not in the document yet.
    const element = document.createElement('div');
    element.id = 'anchor';
    const held = { current: element };
    const props = { open: true, onClose, anchor: held, trigger: held, title: 'T', children: 'B' };
    for (const how of ['unmounted', 'detached'] as const) {
      render(createElement(Fragment, null));
      render(
        how === 'unmounted'
          ? createElement(Harness, { initial: true, attached: false, onClose })
          : createElement(Popover, props),
      );
      for (let index = 0; index < 2; index++) await scrolled();
      expect(opened().getAttribute('data-away'), how).toBe('pending');
      expect(onClose, how).not.toHaveBeenCalled();
      // A re-render, or a DOM append with no event at all.
      if (how === 'unmounted') render(createElement(Harness, { initial: true, onClose }));
      else document.body.append(element);
      await flush();
      expect(placement(), how).toEqual(box(100, 44));
    }
    element.remove();
  });

  it('a mousedown outside closes; inside the panel or the anchor, or a pointerdown alone, does not', async () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    await flush();
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

  it('follows the anchor on nested scroll and resize', async () => {
    // A scroller that clips around the anchor before the open, so autoUpdate listens on it.
    render(createElement(Harness));
    clip({ left: 0, right: 1024, top: 0, bottom: 768 });
    press(button('Help'));
    await flush();
    expect(placement()).toEqual(box(100, 44));
    stubAnchorRect({ left: 60, right: 380, top: 10, bottom: 30 });
    act(() => {
      document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
    });
    await flush();
    expect(placement()).toEqual(box(60, 34));
    stubAnchorRect({ left: 200, right: 520, top: 50, bottom: 70 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await flush();
    expect(placement()).toEqual(box(200, 74));
  });
  it('is in view only while the anchor meets the window and every clipping ancestor', async () => {
    render(createElement(Harness, { initial: true }));
    const scroller: Rect = { left: 200, right: 800, top: 0, bottom: 600 };
    // Wholly right of the window: its cut with the window is empty.
    const beyond: Rect = { left: 1100, right: 1500, top: 0, bottom: 600 };
    // Anchor edges, the clipping scroller if any, `data-away` (null: in view), and the layout: in
    // flow, a fixed anchor, an absolute one with the scroller static or positioned. An edge
    // exactly on the window edge is out of view.
    const positions = {
      flow: ['', ''],
      fixed: ['fixed', ''],
      // happy-dom computes an unset position as '', a browser as 'static'.
      absolute: ['absolute', 'static'],
      positioned: ['absolute', 'relative'],
    } as const;
    for (const [left, right, top, bottom, area, away, layout] of [
      [-400, -20, 20, 40, undefined, 'hidden', 'flow'],
      [-300, -20, 20, 40, undefined, 'hidden', 'flow'],
      [-249, 0, 20, 40, undefined, 'hidden', 'flow'],
      [1024, 1344, 20, 40, undefined, 'hidden', 'flow'],
      [100, 420, -21, -1, undefined, 'hidden', 'flow'],
      [100, 420, -20, 0, undefined, 'hidden', 'flow'],
      [100, 420, 768, 788, undefined, 'hidden', 'flow'],
      [100, 420, 769, 789, undefined, 'hidden', 'flow'],
      [-100, 200, 20, 40, scroller, 'hidden', 'flow'],
      [800, 1000, 20, 40, scroller, 'hidden', 'flow'],
      [300, 620, -40, 0, scroller, 'hidden', 'flow'],
      [300, 620, 600, 620, scroller, 'hidden', 'flow'],
      [100, 420, 20, 40, undefined, null, 'flow'],
      [1000, 1320, 20, 40, undefined, null, 'flow'],
      [-300, 20, 20, 40, undefined, null, 'flow'],
      [100, 420, -19, 1, undefined, null, 'flow'],
      [100, 420, 767, 787, undefined, null, 'flow'],
      [150, 470, 590, 610, scroller, null, 'flow'],
      // A wide anchor spanning both edges of an empty visible area counts as in view: floating-ui
      // does not test the cut for being empty (the limit in the Popover doc comment).
      [-100, 1200, 20, 40, beyond, null, 'flow'],
      // The scroller is not on the anchor's containing-block chain: it does not clip.
      [-100, 180, 20, 40, scroller, null, 'fixed'],
      [-100, 180, 20, 40, scroller, null, 'absolute'],
      [-100, 180, 20, 40, scroller, 'hidden', 'positioned'],
    ] as const) {
      const [anchorPosition, scrollerPosition] = positions[layout];
      clip(area, scrollerPosition);
      document.getElementById('anchor')?.style.setProperty('position', anchorPosition);
      stubAnchorRect({ left, right, top, bottom });
      await scrolled();
      const row = JSON.stringify({ left, right, top, bottom, area, layout });
      expect(opened().getAttribute('data-away'), row).toBe(away);
    }
  });

  it('reads the current anchor and trigger, a trigger outside the anchor, after a swap', async () => {
    const onClose = vi.fn();
    // Anchors One and Two, each with its trigger outside it, Help one and Help two.
    function Swap({ second }: { second: boolean }) {
      const refs = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)] as const;
      const triggers = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)] as const;
      const names = ['One', 'Two', 'Help one', 'Help two'];
      const ids = ['one', 'two', undefined, undefined];
      return createElement(
        Fragment,
        null,
        [...refs, ...triggers].map((ref, index) =>
          createElement(
            'button',
            { key: index, id: ids[index], type: 'button', ref },
            names[index],
          ),
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
    stubAnchorRect({ left: 10, right: 90, top: 20, bottom: 40 }, 'one');
    stubAnchorRect({ left: 500, right: 580, top: 60, bottom: 80 }, 'two');
    render(createElement(Swap, { second: false }));
    await flush();
    expect(placement()).toEqual(box(10, 44));
    render(createElement(Swap, { second: true }));
    await flush();
    // Placement follows anchor Two.
    expect(placement()).toEqual(box(500, 84));
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

  it('measures on open as a child of its anchor, whose ref attaches after its layout effect', async () => {
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
    await flush();
    expect(placement()).toEqual(box(100, 44));
    // Something held focus at open: the move to Close waits until the panel is shown.
    expect(document.activeElement).toBe(button('Close', opened()));
  });

  it('with focus on body, Escape returns focus to the trigger only from a shown panel', async () => {
    // A hidden panel (its anchor scrolled out) closes and leaves focus where it was: on body.
    for (const [left, shown] of [
      [100, true],
      [-400, false],
    ] as const) {
      stubAnchorRect({ left, right: left + 320, top: 20, bottom: 40 });
      const onClose = vi.fn();
      render(createElement(Fragment, null));
      render(createElement(Harness, { initial: true, onClose }));
      await flush();
      expect(opened().hasAttribute('data-away')).toBe(!shown);
      key('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.activeElement, String(shown)).toBe(shown ? button('Help') : document.body);
    }
  });

  it('with focus on body, Escape closes the most recent shown surface, else a hidden one', async () => {
    // The hidden popover opens last: an ancestor clips its anchor away (happy-dom gives the clip
    // no width, so the visible area is empty).
    const clipped = { overflowX: 'hidden', overflowY: 'hidden' } as const;
    for (const shown of [true, false]) {
      const hidden = createElement(
        'div',
        { key: 'hidden', style: clipped },
        createElement(Harness, { initial: true }),
      );
      render(createElement(Fragment, null));
      render([shown && createElement(Harness, { key: 'shown', initial: true }), hidden]);
      await flush();
      const away = () => dialogs().map((dialog) => dialog.hasAttribute('data-away'));
      expect(away()).toEqual(shown ? [false, true] : [true]);
      key('Escape');
      expect(away(), String(shown)).toEqual(shown ? [true] : []);
    }
  });

  it('a HoverMenu and a Popover: Escape closes the focused one, else the most recent', async () => {
    render(createElement(Harness, { after: menu('Sort') }));
    press(button('Help'));
    await flush();
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
    await flush();
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

  it('a HoverMenu inside a Popover: Escape closes the menu, then the Popover', async () => {
    render(createElement(Harness, { children: menu('Sort') }));
    press(button('Help'));
    await flush();
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

  it('a handled or composing Escape leaves it open', async () => {
    const onClose = vi.fn();
    render(createElement(Harness, { onClose }));
    press(button('Help'));
    await flush();
    key('Escape', { isComposing: true });
    const close = button('Close', opened());
    close.addEventListener('keydown', (event) => {
      event.preventDefault();
    });
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(popover()).toBeDefined();
  });

  it('has six examples; only Open and FollowsColumn start open', () => {
    const module = popoverExamples['../src/ds/Popover/Popover.examples.tsx'] ?? {};
    expect(Object.keys(module).sort()).toEqual(
      ['Closed', 'FlipsAbove', 'FollowsColumn', 'LongContent', 'Open', 'WindowEdge'].sort(),
    );
    for (const [name, Example] of Object.entries(module)) {
      render(createElement(Fragment, null));
      render(createElement(Example));
      expect(dialogs(), name).toHaveLength(name === 'Open' || name === 'FollowsColumn' ? 1 : 0);
      expect(document.activeElement, name).toBe(document.body);
    }
  });
});
