// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Modal } from '../src/ds/index.ts';
import { bodyOf, cssHidden, key, mountEachTest, render, top } from './ds-layers-helpers.ts';

mountEachTest();

describe('Tab wraps past controls that cannot take focus', () => {
  const h = createElement;
  // A control that refuses focus, as one hidden only by CSS does in a browser.
  const refusing = cssHidden('Refusing', {});
  const radio = (name: string, checked = false) =>
    h('input', { type: 'radio', name: 'group', 'aria-label': name, defaultChecked: checked });
  const where = () => {
    const active = document.activeElement;
    if (active === bodyOf(top())) return 'body';
    if (!(active instanceof HTMLElement) || active === document.body) return 'page';
    return active.getAttribute('aria-label') ?? active.textContent;
  };
  // `order` is the stops after Close in Tab order; Tab from the last wraps to Close. Shift+Tab
  // from Close visits `back` (default: `order` reversed) and wraps to Close. Every Tab is the
  // layer's own move. From outside the layer Tab lands on the first stop in tab order and
  // Shift+Tab on the last: `ends`, by default Close and the first of `back`.
  type Row = {
    name: string;
    content: ReactNode;
    order: string[];
    back?: string[];
    ends?: [string, string];
  };
  it.each<Row>([
    {
      name: 'a control in a disabled fieldset',
      content: h('fieldset', { disabled: true }, h('button', null, 'Save')),
      order: ['body'],
    },
    {
      name: 'a control in the first legend of a disabled fieldset stays',
      content: h(
        'fieldset',
        { disabled: true },
        h('legend', null, h('button', null, 'Help')),
        h('button', null, 'Save'),
      ),
      order: ['body', 'Help'],
    },
    {
      name: 'a control in a second legend of a disabled fieldset',
      content: h(
        'fieldset',
        { disabled: true },
        h('legend', null, 'Title'),
        h('legend', null, h('button', null, 'Help')),
      ),
      order: ['body'],
    },
    {
      name: 'a legend control in a fieldset nested in a disabled one',
      content: h(
        'fieldset',
        { disabled: true },
        h('fieldset', null, h('legend', null, h('button', null, 'Help'))),
      ),
      order: ['body'],
    },
    {
      name: 'a link in a disabled fieldset stays',
      content: h('fieldset', { disabled: true }, h('a', { href: '#top' }, 'Link')),
      order: ['body', 'Link'],
    },
    {
      name: 'disabled, hidden, inert and tabindex=-1 controls',
      content: h(
        Fragment,
        null,
        h('button', { disabled: true }, 'Disabled'),
        h('button', { hidden: true }, 'Hidden'),
        h('div', { inert: true }, h('button', null, 'Inert')),
        h('button', { tabIndex: -1 }, 'Skipped'),
      ),
      order: ['body'],
    },
    { name: 'a last control that refuses focus', content: refusing, order: ['body'] },
    {
      name: 'a control that refuses focus in the middle',
      content: h(Fragment, null, h('button', null, 'A'), refusing, h('button', null, 'B')),
      order: ['body', 'A', 'B'],
    },
    {
      name: 'a last control hidden by display: none',
      content: h(Fragment, null, h('button', null, 'Visible'), cssHidden('Hidden')),
      order: ['body', 'Visible'],
    },
    {
      name: 'a control hidden by visibility: hidden in the middle',
      content: h(
        Fragment,
        null,
        h('button', null, 'A'),
        cssHidden('Hidden', { visibility: 'hidden' }),
        h('button', null, 'B'),
      ),
      order: ['body', 'A', 'B'],
    },
    {
      name: 'a last control inside content-visibility: hidden',
      content: h(
        Fragment,
        null,
        h('button', null, 'Visible'),
        h('div', { style: { contentVisibility: 'hidden' } }, cssHidden('Hidden', {})),
      ),
      order: ['body', 'Visible'],
    },
    {
      name: 'positive tabindex first, in tabindex order',
      content: h(
        Fragment,
        null,
        h('button', null, 'A'),
        h('button', { tabIndex: 2 }, 'Two'),
        h('button', { tabIndex: 1 }, 'One'),
      ),
      order: ['body', 'A', 'One', 'Two'],
      ends: ['One', 'A'],
    },
    {
      name: 'a radio group with a checked radio is one stop',
      content: h(Fragment, null, radio('First'), radio('Second', true), h('button', null, 'After')),
      order: ['body', 'Second', 'After'],
    },
    {
      name: 'a radio group with none checked enters at the end it is reached from',
      content: h(Fragment, null, radio('First'), radio('Second'), h('button', null, 'After')),
      order: ['body', 'First', 'After'],
      back: ['After', 'Second', 'body'],
    },
  ])('$name', ({ content, order, back = [...order].reverse(), ends }) => {
    render(h(Modal, { open: true, onClose: () => undefined, title: 'T', children: content }));
    expect(where()).toBe('Close');
    const seen = (shiftKey: boolean, count: number) =>
      Array.from({ length: count }, () => {
        const prevented = key('Tab', { shiftKey }).defaultPrevented;
        return prevented ? where() : `${where()} (browser)`;
      });
    expect(seen(false, order.length + 1)).toEqual([...order, 'Close']);
    expect(seen(true, back.length + 1)).toEqual([...back, 'Close']);
    // Focus outside the layer: Tab and Shift+Tab pull it back in.
    const [first, last] = ends ?? ['Close', back[0] ?? 'Close'];
    const blur = () => {
      act(() => {
        (document.activeElement as HTMLElement).blur();
      });
    };
    blur();
    key('Tab');
    expect(where()).toBe(first);
    blur();
    key('Tab', { shiftKey: true });
    expect(where()).toBe(last);
  });

  it('moves from an element outside the tab order to the stop past it', () => {
    const content = h(
      Fragment,
      null,
      h('button', null, 'A'),
      h('button', { tabIndex: -1 }, 'Skipped'),
      h('button', null, 'B'),
    );
    render(h(Modal, { open: true, onClose: () => undefined, title: 'T', children: content }));
    for (const [shiftKey, expected] of [
      [false, 'B'],
      [true, 'A'],
    ] as const) {
      act(() => {
        (top().querySelector('[tabindex="-1"]') as HTMLElement).focus();
      });
      expect(key('Tab', { shiftKey }).defaultPrevented).toBe(true);
      expect(where()).toBe(expected);
    }
  });

  it('leaves Tab to an IME composition and to modified Tab', () => {
    render(h(Modal, { open: true, onClose: () => undefined, title: 'T', children: 'x' }));
    for (const init of [
      { isComposing: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      expect(key('Tab', init).defaultPrevented).toBe(false);
      expect(where()).toBe('Close');
    }
  });
});
