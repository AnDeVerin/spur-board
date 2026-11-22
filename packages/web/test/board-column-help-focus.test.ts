// @vitest-environment happy-dom
// Column help closes when focus leaves its head and panel, so at most one panel is open on the
// board and none stays over the Inbox. One header surface is open at most: opening a column's
// sort menu closes column help and opening help closes a sort menu (#838). Split from
// board-column-help.test.ts for its size.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { daemon, envelope, hello, row, status, type Daemon } from './board-fixtures.ts';
import { all, mount, mountEachTest, press, serve, settle } from './board-harness.ts';

mountEachTest();

// The Popover places itself from its anchor's box and hides when the anchor is out of view;
// happy-dom lays nothing out, so every box is one column head in a 1024x768 window.
beforeEach(() => {
  for (const [name, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const)
    Object.defineProperty(document.documentElement, name, { configurable: true, get: () => value });
  const box = { left: 100, right: 340, top: 20, bottom: 60, x: 100, y: 20, width: 240, height: 40 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...box,
    toJSON: () => box,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const head = `.${styles.head ?? 'missing'}`;
const actor = (id: string) => {
  const found = all('main button[aria-haspopup="dialog"]').find(
    (button) => button.closest(head)?.querySelector('h2, h3')?.textContent === id,
  );
  if (!found) throw new Error(`no trigger ${id}`);
  return found;
};
/** The control before `element` in document order among buttons and links. */
const before = (element: HTMLElement) => {
  const controls = [...document.querySelectorAll<HTMLElement>('button, a[href]')];
  const found = controls[controls.indexOf(element) - 1];
  if (!found) throw new Error('no control before');
  return found;
};
const inboxButton = () => {
  const found = all('header button').find((button) => button.textContent.includes('inbox'));
  if (!found) throw new Error('no inbox button');
  return found;
};
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
/** The column ids of the open help panels: the dialogs labelled with a column id. */
const helpPanels = () =>
  dialogs()
    .map((dialog) => document.getElementById(dialog.getAttribute('aria-labelledby') ?? ''))
    .map((label) => label?.textContent)
    .filter((label) => label === 'dev' || label === 'review');
const expanded = () =>
  all('main button[aria-haspopup="dialog"][aria-expanded="true"]').map(
    (button) => button.closest(head)?.querySelector('h2, h3')?.textContent,
  );

describe('column help focus', () => {
  // Tab moves focus with no mousedown and Enter clicks with none: focus() then a click stand in.
  it.each([
    { path: 'Tab to the Inbox button, then Enter', to: inboxButton, enter: true, open: [] },
    {
      path: "Tab to another column's trigger, then Enter",
      to: () => actor('dev'),
      enter: true,
      open: ['dev'],
    },
    {
      path: 'Shift+Tab out of the trigger',
      to: () => before(actor('review')),
      enter: false,
      open: [],
    },
  ])('$path leaves at most that one panel open', async ({ to, enter, open }) => {
    const d = daemon();
    serve(d, [row('D-1', 'dev'), row('R-1', 'review')]);
    mount(d);
    await settle();
    act(() => {
      actor('review').focus();
    });
    press(actor('review'), 'click');
    await settle();
    expect(helpPanels()).toEqual(['review']);
    // Focus inside the panel, then back on its own trigger, keeps it open.
    expect(dialogs()[0]?.contains(document.activeElement)).toBe(true);
    act(() => {
      actor('review').focus();
    });
    expect(helpPanels()).toEqual(['review']);
    const target = to();
    act(() => {
      target.focus();
    });
    if (enter) press(target, 'click');
    await settle();
    expect(helpPanels()).toEqual(open);
    expect(expanded()).toEqual(open);
    // The Inbox or the other panel is the one dialog left; Shift+Tab out leaves none.
    expect(dialogs()).toHaveLength(enter ? 1 : 0);
  });
});

/** The sort letter of column `id`: the menu trigger in its head. */
const letter = (id: string) => {
  const found = all('main button[aria-haspopup="menu"]').find(
    (button) => button.closest(head)?.querySelector('h2, h3')?.textContent === id,
  );
  if (!found) throw new Error(`no sort letter ${id}`);
  return found;
};
const menus = () => all('main [role="menu"]');
const item = (label: string) => {
  const found = all('main [role="menuitemradio"]').find((one) => one.textContent === label);
  if (!found) throw new Error(`no item ${label}`);
  return found;
};
// React builds pointerenter from pointerover with a relatedTarget, as hover-menu.test.ts does.
const hover = (target: Element) => {
  act(() => {
    document.body.dispatchEvent(
      new PointerEvent('pointerout', {
        bubbles: true,
        pointerType: 'mouse',
        relatedTarget: target,
      }),
    );
    target.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        pointerType: 'mouse',
        relatedTarget: document.body,
      }),
    );
  });
};
/** A board with dev and review cards and review's help open from its trigger, focus on Close. */
async function reviewHelp() {
  const d = daemon();
  serve(d, [row('D-1', 'dev'), row('R-1', 'review')]);
  mount(d);
  await settle();
  act(() => {
    actor('review').focus();
  });
  press(actor('review'), 'click');
  await settle();
  expect(helpPanels()).toEqual(['review']);
  expect(dialogs()[0]?.contains(document.activeElement)).toBe(true);
}

describe('one header surface at a time', () => {
  it.each([
    {
      path: "a click on the column's sort letter",
      menu: 'review',
      open: () => {
        press(letter('review'), 'click', { detail: 1 });
      },
    },
    {
      path: "ArrowDown on the column's sort letter",
      menu: 'review',
      open: () => {
        act(() => {
          letter('review').focus();
        });
        press(letter('review'), 'keydown', { key: 'ArrowDown' });
      },
    },
    {
      path: "a hover on another column's sort letter",
      menu: 'dev',
      open: () => {
        hover(letter('dev'));
      },
    },
  ])('help, then the sort menu, closes help: $path', async ({ menu, open }) => {
    await reviewHelp();
    // Help sits one layer under the sort menu.
    expect(dialogs()[0]?.getAttribute('data-layer')).toBe('panel');
    open();
    await settle();
    expect(helpPanels()).toEqual([]);
    expect(expanded()).toEqual([]);
    expect(menus()).toHaveLength(1);
    expect(menus()[0]?.hasAttribute('data-layer')).toBe(false);
    expect(letter(menu).getAttribute('aria-expanded')).toBe('true');
    if (menu === 'dev') return;
    // Opened by click or key: focus on the checked item; Escape returns it to the letter.
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
    press(document.activeElement ?? document.body, 'keydown', { key: 'Escape' });
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(letter('review'));
    press(letter('review'), 'click', { detail: 1 });
    press(item('Key'), 'click', { detail: 1 });
    await settle();
    expect(menus()).toHaveLength(0);
    expect(letter('review').textContent).toBe('K');
    expect(document.activeElement).toBe(letter('review'));
  });

  it.each(['review', 'dev'])(
    'a hover open of %s moves focus from the help panel to its trigger',
    async (id) => {
      await reviewHelp();
      hover(letter(id));
      await settle();
      expect(document.activeElement).toBe(actor('review'));
      expect(dialogs()).toHaveLength(0);
      expect(letter(id).getAttribute('aria-expanded')).toBe('true');
    },
  );

  it.each(['review', 'dev'])(
    "ArrowDown on %s's letter keeps its menu open after help's focus handling",
    async (id) => {
      await reviewHelp();
      act(() => {
        letter(id).focus();
      });
      press(letter(id), 'keydown', { key: 'ArrowDown' });
      await settle();
      expect(letter(id).getAttribute('aria-expanded')).toBe('true');
      expect(menus()).toHaveLength(1);
      expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
      expect(dialogs()).toHaveLength(0);
      expect(expanded()).toEqual([]);
    },
  );

  it.each([
    {
      path: 'a click on the letter, then on the trigger',
      help: 'dev',
      open: () => {
        press(letter('dev'), 'click', { detail: 1 });
      },
    },
    {
      path: 'a hover-open menu, then Enter on a trigger',
      help: 'review',
      open: () => {
        hover(letter('dev'));
      },
    },
  ])('the sort menu, then help, closes the menu: $path', async ({ help, open }) => {
    const d = daemon();
    serve(d, [row('D-1', 'dev'), row('R-1', 'review')]);
    mount(d);
    await settle();
    open();
    await settle();
    expect(menus()).toHaveLength(1);
    act(() => {
      actor(help).focus();
    });
    // Enter arrives as a click with detail 0.
    press(actor(help), 'click', { detail: help === 'dev' ? 1 : 0 });
    await settle();
    expect(helpPanels()).toEqual([help]);
    expect(menus()).toHaveLength(0);
    // The letter again closes help, and an item applies.
    press(letter('dev'), 'click', { detail: 1 });
    await settle();
    expect(helpPanels()).toEqual([]);
    press(item('Manual'), 'click', { detail: 1 });
    await settle();
    expect(letter('dev').textContent).toBe('M');
  });

  it('a head that remounts opens neither surface by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d: Daemon = daemon();
    serve(d, [row('D-1', 'dev'), row('R-1', 'review')]);
    let rows = [row('D-1', 'dev'), row('R-1', 'review')];
    d.routes['status.get'] = () => Promise.resolve(envelope(status(rows)));
    mount(d);
    await settle();
    d.send(hello);
    await settle();
    press(actor('dev'), 'click', { detail: 1 });
    await settle();
    expect(helpPanels()).toEqual(['dev']);
    const invalidate = async () => {
      d.send(`event: invalidate\ndata: ${JSON.stringify({ projects: ['a'], tasks: [] })}\n\n`);
      await settle();
      await act(() => vi.advanceTimersByTimeAsync(400));
      await settle();
    };
    rows = [row('R-1', 'review')];
    await invalidate();
    expect(helpPanels()).toEqual([]);
    rows = [row('D-1', 'dev'), row('R-1', 'review')];
    await invalidate();
    expect(letter('dev').textContent).toBe('T');
    expect(dialogs()).toHaveLength(0);
    expect(menus()).toHaveLength(0);
  });
});
