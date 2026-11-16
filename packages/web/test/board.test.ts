// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../src/board/Board.tsx';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import { boardColumns } from '../src/board/model.ts';
import { Chip, focusRing, quiet } from '../src/ds/index.ts';
import {
  config,
  daemon,
  deferred,
  DONE,
  envelope,
  failure,
  hello,
  inbox,
  never,
  ROWS,
  source,
  status,
  parsed,
  type Daemon,
} from './board-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const started: BoardData[] = [];
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  for (const data of started.splice(0)) data.stop();
  vi.useRealTimers();
  history.replaceState(null, '', '/');
});

function mount(d: Daemon, storage: Record<string, string> = {}, now = () => 0) {
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
    root.render(createElement(Board, { data }));
    data.start();
  });
  return values;
}
/** Body reads and parsing cross a few macrotasks; fake timers leave setImmediate real. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
/** Five failed connections: 0.5, 1, 2 and 4 s of backoff, then offline. */
async function goOffline(d: Daemon) {
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
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const one = (selector: string) => {
  const found = container.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};
const button = (text: string) => {
  const found = all('button').find((b) => b.textContent.includes(text));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${text}`);
  return found;
};
const trigger = () => {
  const found = one('button[aria-controls]');
  if (!(found instanceof HTMLButtonElement)) throw new Error('no switcher');
  return found;
};
const indicator = () => one('[title="Live updates"]').textContent;
const banners = () => all('[role="alert"], [role="status"]');
const links = () => all('main a');
const press = (target: Element, type: string, init: Record<string, unknown> = {}) => {
  act(() => {
    target.dispatchEvent(
      type === 'keydown'
        ? new KeyboardEvent(type, { bubbles: true, ...init })
        : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
};
const type = (value: string) => {
  const input = one('input');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const dimmed = () =>
  links()
    .filter((link) => link.hasAttribute('data-dimmed'))
    .map((l) => l.title);

describe('board screen', () => {
  it('inbox shows its count, – while loading, keeps the last count on failure, opens ?open=inbox', async () => {
    const d = daemon();
    const held = deferred();
    d.routes['inbox.operator'] = () => held.promise;
    mount(d);
    await settle();
    expect(button('inbox').textContent).toBe('inbox–');
    held.resolve(envelope(inbox(2)));
    await settle();
    const you = renderToStaticMarkup(createElement(Chip, { tone: 'you', children: '2' }));
    expect(button('inbox').innerHTML).toContain(you);
    d.routes['inbox.operator'] = failure;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(button('inbox').innerHTML).toContain(you);
    press(button('inbox'), 'click');
    expect(location.search).toBe('?open=inbox');
  });

  it('switcher discloses projects', async () => {
    const d = daemon();
    const storage = mount(d);
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    press(trigger(), 'click');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const list = one(`[id="${String(trigger().getAttribute('aria-controls'))}"]`);
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'a · dispatcher on',
      'b · dispatcher shadow',
    ]);
    expect(one('[aria-label="current"]').closest('li')?.textContent).toContain('a ·');
    const item = button('b · dispatcher');
    item.focus();
    press(item, 'keydown', { key: 'Escape' });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());

    press(trigger(), 'click');
    press(document.body, 'pointerdown');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    d.routes['status.get'] = never;
    press(trigger(), 'click');
    press(button('b · dispatcher'), 'click');
    await settle();
    expect(trigger().textContent).toBe('b');
    expect(document.activeElement).toBe(trigger());
    expect(storage.get('board-project')).toBe('b');
    expect(all('[data-skeleton]').map((section) => section.textContent)).toEqual([
      'todo ',
      'done ',
    ]);
    expect(links()).toHaveLength(0);
  });

  it('columns follow config order and collapse empty ones', async () => {
    mount(daemon());
    await settle();
    expect(all('h2').map((heading) => heading.textContent)).toEqual([
      'todo',
      'dev',
      'review',
      'done',
    ]);
    expect(all('main section[title]').map((spine) => [spine.title, spine.textContent])).toEqual([
      ['todo: empty · dispatcher', '0todo'],
      ['review: empty · dispatcher', '0review'],
    ]);
    const dev = one('main section:not([title])');
    expect(dev.querySelector('h2')?.parentElement?.textContent).toBe('dev2');
    expect(dev.textContent).toContain('worker stand-worker');
    expect(all('main ul a').map((link) => link.title)).toEqual(DONE);
    expect(one('main').textContent).not.toContain('+');
    expect(links().map((link) => link.title)).not.toContain('ex/repo#99');
  });

  it('boardColumns drops a row whose column config lacks', () => {
    const columns = boardColumns(parsed().columns, parsed().rows);
    expect(columns.map(({ id, rows }) => [id, rows.length])).toEqual([
      ['todo', 0],
      ['dev', 2],
      ['review', 0],
      ['done', 7],
    ]);
  });

  it('cards are links to ?open=<key>', async () => {
    mount(daemon());
    await settle();
    const card = one('main a[title="ex/repo#7"]');
    expect(card.getAttribute('href')).toBe('?open=ex%2Frepo%237');
    expect(card.getAttribute('aria-label')).toBe('ex/repo#7 Fix login');
    expect(card.textContent).toBe('#7Fix login');
    const bare = one('main a[title="ABC-3"]');
    expect([bare.getAttribute('aria-label'), bare.textContent]).toEqual(['ABC-3', 'ABC-3']);
    press(card, 'click');
    expect(location.search).toBe('?open=ex%2Frepo%237');
  });

  it('loading shows four unnamed skeleton columns, connecting and –', async () => {
    const d = daemon();
    Object.assign(d.routes, { 'config.get': never, 'status.get': never, 'inbox.operator': never });
    mount(d);
    await settle();
    expect(all('[data-skeleton]')).toHaveLength(4);
    expect(all('h2')).toHaveLength(0);
    expect(one('main').getAttribute('aria-busy')).toBe('true');
    expect(indicator()).toBe('connecting');
    expect(button('inbox').textContent).toBe('inbox–');
    expect([trigger().disabled, trigger().textContent]).toEqual([true, '–']);
    expect(container.querySelector('[title="Dispatcher mode"]')).toBeNull();
  });

  it('first-load failure shows the banner without columns', async () => {
    const d = daemon();
    d.routes['status.get'] = failure;
    mount(d);
    await settle();
    expect(banners().map((banner) => banner.getAttribute('role'))).toEqual(['alert']);
    expect(banners()[0]?.textContent).toContain('does not answer');
    expect(banners()[0]?.textContent).toContain('No data yet');
    expect(all('main section, main [data-skeleton]')).toHaveLength(0);
  });

  it('empty project shows the message and no columns', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(status([])));
    mount(d);
    await settle();
    expect(one('main').textContent).toContain('No tasks in a yet');
    expect(one('main').textContent).toContain('Columns show up with the first task.');
    expect(all('main section')).toHaveLength(0);
  });

  it('reconnecting changes only the indicator', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    mount(d);
    await settle();
    d.send(hello);
    await settle();
    expect(indicator()).toBe('live');
    d.endStream();
    await settle();
    expect(indicator()).toBe('reconnecting');
    expect(banners()).toHaveLength(0);
    expect(all('[data-stale]')).toHaveLength(0);
  });

  it('banners stack error, warning, info', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const sources = [
      source('spur', {
        blindReason: 'stale',
        stale: true,
        lastCompleteAt: '2026-11-15T14:40:00.000Z',
      }),
      source('github:ex/repo', { stale: true, warmingUp: true }),
    ];
    d.routes['status.get'] = () => Promise.resolve(envelope(status(ROWS, sources)));
    mount(d, { 'board-project': 'b' });
    await settle();
    await goOffline(d);
    expect(indicator()).toBe('offline');
    expect(banners().map((banner) => banner.getAttribute('role'))).toEqual([
      'alert',
      'status',
      'status',
    ]);
    const [error, warning, info] = banners().map((banner) => banner.textContent);
    expect(error).toContain('Live updates are lost.');
    expect(warning).toBe(
      'Spur has not answered since 14:40 15/11/26.Session states may be out of date.',
    );
    expect(info).toBe('Shadow mode: the board computes columns and turns but does not act.');
  });

  it('stale banner shows the time of last good data', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = Date.UTC(2026, 10, 15, 14, 52);
    const down = daemon();
    mount(down, {}, () => now);
    await settle();
    now += 3_600_000;
    down.routes['status.get'] = failure;
    await goOffline(down);
    const alert = one('[role="alert"]').textContent;
    expect(alert).toContain('The board daemon does not answer.');
    expect(alert).toContain('The board shows data from 14:52 15/11/26.');
    expect(alert).toContain('Answers and comments cannot be sent');
    expect(button('Retry now').getAttribute('aria-busy')).toBeNull();
    expect(all('main section').every((section) => section.hasAttribute('data-stale'))).toBe(true);

    const lost = daemon();
    mount(lost, {}, () => Date.UTC(2026, 10, 15, 14, 52));
    await settle();
    await goOffline(lost);
    const offline = one('[role="alert"]').textContent;
    expect(offline).toContain('Live updates are lost.');
    expect(offline).toContain('14:52 15/11/26');
    expect(offline).not.toContain('Answers and comments cannot be sent');
  });

  it('Retry now is busy while its reads run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    mount(d);
    await settle();
    d.routes['status.get'] = failure;
    await goOffline(d);
    const reads = { config: deferred(), status: deferred(), inbox: deferred() };
    d.routes['config.get'] = () => reads.config.promise;
    d.routes['status.get'] = () => reads.status.promise;
    d.routes['inbox.operator'] = () => reads.inbox.promise;
    press(button('Retry now'), 'click');
    expect(button('Retrying').getAttribute('aria-busy')).toBe('true');
    reads.config.resolve(envelope(config));
    reads.inbox.resolve(envelope(inbox(1)));
    await settle();
    expect(button('Retrying').getAttribute('aria-busy')).toBe('true');
    reads.status.resolve(envelope(status()));
    await settle();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('quiet on column headers, spines and the done list', async () => {
    mount(daemon());
    await settle();
    expect([quiet, focusRing].every((name) => name !== '')).toBe(true);
    const heads = all('main section:not([title]) h2').map((h) => h.parentElement?.parentElement);
    expect(heads).toHaveLength(2);
    expect(heads.every((head) => head?.classList.contains(quiet))).toBe(true);
    expect(all('main section[title]').every((spine) => spine.classList.contains(quiet))).toBe(true);
    expect(one('main ul').classList.contains(quiet)).toBe(true);
    expect(links()).toHaveLength(9);
    for (const link of links()) {
      expect(link.classList.contains(quiet)).toBe(true);
      expect(link.classList.contains(focusRing)).toBe(true);
    }
  });

  it('tab order follows reading order', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    mount(d);
    await settle();
    await goOffline(d);
    const focusable = all('a[href], button:not([disabled]), input').filter(
      (element) => element.closest('[hidden]') === null,
    );
    expect(focusable).toEqual([
      trigger(),
      one('input'),
      button('inbox'),
      button('Retry now'),
      ...links(),
    ]);
    expect(links().map((link) => link.title)).toEqual(['ex/repo#7', 'ABC-3', ...DONE]);
  });

  it('filter dims and never removes cards', async () => {
    mount(daemon());
    await settle();
    const everyKey = links().map((link) => link.title);
    const others = (...keys: string[]) => everyKey.filter((key) => !keys.includes(key));
    for (const [text, matches] of [
      ['B12', ['ex/repo#7']],
      ['sess-9', ['ex/repo#21']],
      ['#7', ['ex/repo#7']],
      ['abc', ['ABC-3']],
      ['repo#2', DONE],
    ] as const) {
      type(text);
      expect(links()).toHaveLength(everyKey.length);
      expect(dimmed()).toEqual(others(...matches));
    }
    press(one('button[aria-label="Clear"]'), 'click');
    expect(dimmed()).toEqual([]);
  });
});
