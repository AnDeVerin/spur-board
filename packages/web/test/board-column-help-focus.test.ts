// @vitest-environment happy-dom
// Column help closes when focus leaves its head and panel, so at most one panel is open on the
// board and none stays over the Inbox. Split from board-column-help.test.ts for its size.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { daemon, row } from './board-fixtures.ts';
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
