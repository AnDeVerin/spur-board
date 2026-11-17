// Shared by the happy-dom board screen tests: board.test.ts, board-card.test.ts and
// board-task-history.test.ts. A test file calls mountEachTest() once, then mounts a Board on a
// fake daemon with mount().
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';
import { Board } from '../src/board/Board.tsx';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import {
  config,
  DONE,
  envelope,
  hello,
  prLink,
  row,
  ROWS,
  status,
  type Daemon,
} from './board-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: Root | undefined;
const started: BoardData[] = [];

/** The element the board renders into; a fresh one for each test. */
export const container = (): HTMLDivElement => {
  if (!host) throw new Error('no container: call mountEachTest() in the test file');
  return host;
};
const unmount = () => {
  act(() => {
    root?.unmount();
  });
};

/** Gives each test a fresh React root and stops its boards, timers and address after it. */
export function mountEachTest(): void {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    unmount();
    host?.remove();
    for (const data of started.splice(0)) data.stop();
    vi.useRealTimers();
    history.replaceState(null, '', '/');
  });
}

/** Unmounts the board and gives the test a fresh React root in the same container. */
export function remount(): void {
  unmount();
  root = createRoot(container());
}

/** Mounts a Board on the fake daemon; the stored values the board writes are returned. */
export function mount(d: Daemon, storage: Record<string, string> = {}, now = () => 0) {
  const values = new Map(Object.entries(storage));
  const data = createBoardData({
    fetch: d.fetcher,
    storage: () => ({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    }),
    now,
  });
  started.push(data);
  act(() => {
    root?.render(createElement(Board, { data }));
    data.start();
  });
  return values;
}
/** Body reads and parsing cross a few macrotasks; fake timers leave setImmediate real. */
export async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
/** Five failed connections: 0.5, 1, 2 and 4 s of backoff, then offline. */
export async function goOffline(d: Daemon) {
  d.send(hello);
  await settle();
  d.failStream();
  d.endStream();
  await settle();
  for (const delay of [500, 1000, 2000, 4000]) {
    await act(() => vi.advanceTimersByTimeAsync(delay));
    await settle();
  }
}
export const all = (selector: string) => [...container().querySelectorAll<HTMLElement>(selector)];
export const one = (selector: string) => {
  const found = container().querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};
export const press = (target: Element, type: string, init: Record<string, unknown> = {}) => {
  act(() => {
    target.dispatchEvent(
      type === 'keydown'
        ? new KeyboardEvent(type, { bubbles: true, ...init })
        : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
};
export const SPUR = 'https://spur.example.test';
/** The fixture config with a Spur UI origin, so cards link sessions. */
export const withSpur = { ...config, web: { publicOrigin: null, spurUiOrigin: SPUR } };
/** Card #7 with ticket, PR 4 and session sess-9 links, card ABC-3 with none, then done rows. */
export const linkedRows = () => [
  row('ex/repo#7', 'dev', {
    links: {
      ticket: 'https://example.test/ticket',
      prs: [prLink(4)],
      sessions: [{ id: 'sess-9' }],
    },
  }),
  row('ABC-3', 'dev', { ticket: null }),
  ...ROWS.filter((task) => DONE.includes(task.key)),
];
/** The daemon answers `config.get` with `withConfig` and `status.get` with `rows`. */
export const serve = (d: Daemon, rows: unknown[], withConfig: unknown = config) => {
  d.routes['config.get'] = () => Promise.resolve(envelope(withConfig));
  d.routes['status.get'] = () => Promise.resolve(envelope(status(rows)));
};
