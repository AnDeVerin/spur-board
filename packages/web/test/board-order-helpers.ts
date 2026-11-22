// Shared by the manual order tests: board-order.test.ts and board-order-stream.test.ts. Project `a`
// on the fixture config (todo, dev, review, done), its todo column in Manual holding #1, #2 and #3
// at positions 1, 2 and 3.
import { act } from 'react';
import cardStyles from '../src/board/Card.module.css';
import styles from '../src/board/Columns.module.css';
import { config, envelope, row, status, type Daemon } from './board-fixtures.ts';
import { all, container, press } from './board-harness.ts';
import { board, link } from './board-move-helpers.ts';

export const A = 'ex/repo#1';
export const B = 'ex/repo#2';
export const C = 'ex/repo#3';
export const PENDING = 'Wait until the Board shows the last reorder.';
export const HINT = 'Cards keep the chosen sort. To reorder by hand, switch to Manual.';
export const MANUAL = { 'board-sort:a:todo': 'manual' };

/** A class selector of `Columns.module.css`. */
export const css = (name: string) => {
  const value = styles[name];
  if (value === undefined) throw new Error(`no class ${name}`);
  return `.${value}`;
};
/** A class selector of `Card.module.css`. */
export const cardCss = (name: string) => {
  const value = cardStyles[name];
  if (value === undefined) throw new Error(`no class ${name}`);
  return `.${value}`;
};
/** Todo rows of `keys` in that manual order, plus #9 in dev. */
export const placed = (keys: readonly string[]) => [
  ...keys.map((key, index) => row(key, 'todo', { position: index + 1 })),
  row('ex/repo#9', 'dev'),
];

/**
 * The board on the fixture config with todo holding `keys` in that order, Manual unless
 * `storage` says otherwise; `order(keys)` makes later status reads answer that order.
 */
export async function manualBoard(
  keys: readonly string[] = [A, B, C],
  storage: Record<string, string> = MANUAL,
  setup: (d: Daemon) => void = () => undefined,
) {
  let current = placed(keys);
  const mounted = await board(
    config,
    current,
    (d) => {
      d.routes['status.get'] = () => Promise.resolve(envelope(status(current)));
      setup(d);
    },
    storage,
  );
  return {
    ...mounted,
    order: (next: readonly string[]) => {
      current = placed(next);
    },
  };
}

/** A board column, found by its `h2`. */
export const column = (id: string) => {
  const found = all('main section').find((item) => item.querySelector('h2')?.textContent === id);
  if (!found) throw new Error(`no column ${id}`);
  return found;
};
/** The card list of column `id`. */
export const list = (id: string) => {
  const found = column(id).querySelector<HTMLElement>(css('body'));
  if (!found) throw new Error(`no card list in ${id}`);
  return found;
};
/** Task keys of the cards in column `id`, top to bottom. */
export const keysOf = (id: string) =>
  [...column(id).querySelectorAll('[data-key]')].map((item) => item.getAttribute('data-key'));
/** The column's sort letter and, in Time or Key, its direction. */
export const sortText = (id: string) =>
  [...column(id).querySelectorAll('[aria-label^="Sort "] button')].map((item) => item.textContent);
/**
 * Lays the card wrappers of `root` out 100px apart, each 100px high, so a pointer at `y` is over
 * gap `Math.round(y / 100)`; happy-dom lays nothing out.
 */
export function layout(root: Element) {
  [...root.children]
    .filter((child) => child.hasAttribute('data-key'))
    .forEach((wrapper, index) => {
      Object.defineProperty(wrapper, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: index * 100, height: 100, bottom: index * 100 + 100 }),
      });
    });
}
/** HTML5 drag events; happy-dom has no DragEvent, so a plain Event carries a DataTransfer. */
export const drag = (target: Element, type: string, y = 0) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: new DataTransfer() });
  Object.defineProperty(event, 'clientY', { value: y });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
/** `Alt+ArrowUp` or `Alt+ArrowDown` on the card link of `key`. */
export const step = (key: string, direction: 'ArrowUp' | 'ArrowDown') => {
  press(link(key), 'keydown', { key: direction, altKey: true, cancelable: true });
};
/** Opens the `⋯` menu of card `key` and returns its items. */
export const menu = (key: string) => {
  const trigger = container().querySelector(
    `main button[aria-label="Move ${key.slice(key.indexOf('#'))}"]`,
  );
  if (!trigger) throw new Error(`no menu on ${key}`);
  if (trigger.getAttribute('aria-expanded') !== 'true') press(trigger, 'click');
  const id = trigger.getAttribute('aria-controls') ?? '';
  return [
    ...(document.getElementById(id)?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];
};
export const item = (key: string, label: string) => {
  const found = menu(key).find((option) => option.textContent === label);
  if (!found) throw new Error(`no ${label} on ${key}`);
  return found;
};
/** The cause line an item's `aria-describedby` names, or null. */
export const cause = (element: Element) =>
  document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? null;
/** A button by its text in `root`. */
export const buttonIn = (root: Element, text: string) => {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) throw new Error(`no button ${text}`);
  return found;
};
/** A route answer held until `open()`. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
