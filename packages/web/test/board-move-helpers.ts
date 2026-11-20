// Shared by the move tests: board-move.test.ts and board-move-drop.test.ts. A Backlog of three
// parts with #1 in todo and #2 in triage; ready-for-dev is empty.
import { act } from 'react';
import { configColumn, configWith, daemon, row, type Daemon } from './board-fixtures.ts';
import { all, container, mount, one, serve, settle } from './board-harness.ts';

export const KEY = 'ex/repo#1';
export const THREE = configWith([
  configColumn('todo', true),
  configColumn('triage', true),
  configColumn('ready-for-dev', true),
  configColumn('dev', false, 'worker'),
  configColumn('done'),
]);
export const ALONE = configWith([
  configColumn('todo', true),
  configColumn('dev', false, 'worker'),
  configColumn('done'),
]);
export const ROWS = [
  row('ex/repo#2', 'triage', { columnEnteredAt: '2026-11-15T10:00:00.000Z' }),
  row(KEY, 'todo', { columnEnteredAt: '2026-11-15T11:00:00.000Z' }),
  row('ex/repo#3', 'dev'),
];
interface MoveBody {
  input: Record<string, unknown>;
  key: string;
}

/**
 * Mounts the board on `withConfig` and `rows`, recording each `task.move` request body; `setup`
 * changes routes before the first read.
 */
export async function board(
  withConfig: unknown = THREE,
  rows: unknown[] = ROWS,
  setup: (d: Daemon) => void = () => undefined,
) {
  const d: Daemon = daemon(rows);
  serve(d, rows, withConfig);
  setup(d);
  const moves: MoveBody[] = [];
  mount({
    ...d,
    fetcher: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path.endsWith('/task.move'))
        moves.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as MoveBody);
      return d.fetcher(url, init);
    },
  });
  await settle();
  return { d, moves };
}

/** The card link of `key` on the board. */
export const link = (key: string) => one(`main a[href="?open=${encodeURIComponent(key)}"]`);
/** The card wrapper of `key`: the link's parent. */
export const wrap = (key: string) => {
  const parent = link(key).parentElement;
  if (!parent) throw new Error(`no wrap for ${key}`);
  return parent;
};
/** The section of Backlog part `id`, a column or a folded section, found by its `h3`. */
export const part = (id: string) => {
  const found = all('main section').find(
    (section) => section.querySelector(':scope > div > div > h3, :scope > h3')?.textContent === id,
  );
  if (!found) throw new Error(`no part ${id}`);
  return found;
};
/** Task keys of the cards in part `id`, top to bottom. */
export const keysIn = (id: string) =>
  [...part(id).querySelectorAll('a[href^="?open="]')].map((item) =>
    decodeURIComponent(item.getAttribute('href')?.slice('?open='.length) ?? ''),
  );
export function type(input: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** The open move form in `root`: the board's main area unless given. */
export const form = (root: ParentNode = container()) => {
  const found = [...root.querySelectorAll('form')].find((item) =>
    item.querySelector('label')?.textContent.startsWith('Move '),
  );
  if (!found) throw new Error('no move form');
  return found;
};
export const forms = (root: ParentNode = container()) =>
  [...root.querySelectorAll('form')].filter((item) =>
    item.querySelector('label')?.textContent.startsWith('Move '),
  );
export const field = (root?: ParentNode) => {
  const found = form(root).querySelector('textarea');
  if (!found) throw new Error('no reason field');
  return found;
};
export const send = (root?: ParentNode) => {
  const found = form(root).querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!found) throw new Error('no send button');
  return found;
};
export const submit = (root?: ParentNode) => {
  act(() => {
    form(root).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
