// Shared by the move tests, board-move.test.ts and board-move-drop.test.ts, and the mirror tests in
// board-mirror.test.ts. A Backlog of three parts with #1 in todo and #2 in triage; ready-for-dev
// is empty, or holds #4 when mirrored.
import { act } from 'react';
import { config, daemon, row, type Daemon } from './board-fixtures.ts';
import { all, container, mount, one, serve, settle } from './board-harness.ts';

/** A config column; Todo-group columns carry `group: 'todo'` as `config.get` sets it. */
export const configColumn = (id: string, grouped = false, kind = 'dispatcher') => ({
  id,
  executor: { kind, name: null },
  ...(grouped ? { group: 'todo' } : {}),
});
/** The fixture config with project `a` on columns `a` and project `b` on `b`. */
const configWith = (a: (ReturnType<typeof configColumn> & { source?: unknown })[], b = a) => ({
  ...config,
  projects: config.projects.map((entry, index) => ({ ...entry, columns: index === 0 ? a : b })),
});
export const KEY = 'ex/repo#1';
/**
 * A `config.get` column source of a part mirrored from GitHub Project `ex/1` (title Roadmap),
 * healthy and last read at 13:42 18/11/26; `extra` sets health, readAt or error.
 */
const mirrorSource = (extra: Record<string, unknown> = {}) => ({
  kind: 'mirror',
  tracker: 'github-project',
  name: 'Roadmap',
  project: 'ex/1',
  field: 'Status',
  value: 'Ready',
  health: 'healthy',
  readAt: '2026-11-18T13:42:00.000Z',
  ...extra,
});
export const THREE = configWith([
  configColumn('todo', true),
  configColumn('triage', true),
  configColumn('ready-for-dev', true),
  configColumn('dev', false, 'worker'),
  configColumn('done'),
]);
/** `THREE` with ready-for-dev mirrored from GitHub Project Roadmap; `extra` sets its state. */
export const mirrored = (extra: Record<string, unknown> = {}) =>
  configWith([
    configColumn('todo', true),
    configColumn('triage', true),
    { ...configColumn('ready-for-dev', true), source: mirrorSource(extra) },
    configColumn('dev', false, 'worker'),
    configColumn('done'),
  ]);
export const MIRRORED = mirrored();
/** The refusal of a move into or out of the mirrored ready-for-dev, with Project ref and field. */
export const REFUSAL =
  'ready-for-dev mirrors GitHub Project "Roadmap" (ex/1, field Status). Change the task status there instead.';
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
/** `ROWS` with #4 in the mirrored ready-for-dev. */
export const MIRRORED_ROWS = [...ROWS, row('ex/repo#4', 'ready-for-dev')];
interface MoveBody {
  input: Record<string, unknown>;
  key: string;
}

/**
 * Mounts the board on `withConfig` and `rows`, recording each `task.move` and `task.order`
 * request body; `setup` changes routes before the first read; `storage` seeds stored view state,
 * such as a column's sort.
 */
export async function board(
  withConfig: unknown = THREE,
  rows: unknown[] = ROWS,
  setup: (d: Daemon) => void = () => undefined,
  storage: Record<string, string> = {},
) {
  const d: Daemon = daemon(rows);
  serve(d, rows, withConfig);
  setup(d);
  const moves: MoveBody[] = [];
  const orders: MoveBody[] = [];
  const stored = mount(
    {
      ...d,
      fetcher: (url, init) => {
        const path = url instanceof Request ? url.url : url.toString();
        const body = () =>
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as MoveBody;
        if (path.endsWith('/task.move')) moves.push(body());
        if (path.endsWith('/task.order')) orders.push(body());
        return d.fetcher(url, init);
      },
    },
    storage,
  );
  await settle();
  return { d, moves, orders, stored };
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
  const found = all('main section').find((section) =>
    [...section.querySelectorAll('h3')].some(
      (title) => title.textContent === id && title.closest('section') === section,
    ),
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
