// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { formatDataTime } from '../src/board/model.ts';
import { Icon, quiet, StatusDot } from '../src/ds/index.ts';
import {
  daemon,
  envelope,
  failure,
  HEALTHY,
  hello,
  healthy,
  ISSUES,
  never,
  polled,
  PR,
  service,
  SLACK_UP,
  spurBlind,
  SPUR_DOWN_LINE,
  status,
  T,
  T_TEXT,
  type Daemon,
} from './board-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const time = formatDataTime;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

function mount(d: Daemon, path = '/') {
  history.replaceState(null, '', path);
  vi.stubGlobal('fetch', d.fetcher);
  act(() => {
    root.render(createElement(App));
  });
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
/** Five failed connections: 0.5, 1, 2 and 4 s of backoff, then offline. */
async function goOffline(d: Daemon) {
  d.failStream();
  d.endStream();
  await settle();
  for (const delay of [500, 1000, 2000, 4000]) {
    await act(() => vi.advanceTimersByTimeAsync(delay));
    await settle();
  }
}
const footer = () => {
  const found = container.querySelector<HTMLElement>('footer');
  if (!found) throw new Error('no footer');
  return found;
};
const barButton = (name: string) => {
  const found = [...footer().querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.getAttribute('aria-label')?.split(':')[0] === name,
  );
  if (!found) throw new Error(`no bar button ${name}`);
  return found;
};
const barLabels = () =>
  [...footer().querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const panel = () => {
  const found = dialog();
  if (!found) throw new Error('no panel');
  return found;
};
const box = (id: string) => {
  const found = panel().querySelector<HTMLElement>(`[data-box="${id}"]`);
  if (!found) throw new Error(`no box ${id}`);
  return found;
};
const boardWrapper = () => container.querySelector('header')?.parentElement as HTMLElement;
const press = (target: HTMLElement) => {
  act(() => {
    target.focus();
    target.click();
  });
};
const escape = () => {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
};
/** Row text as [key, value], read from a rendered box; a Meter reads as its value text. */
const rowsOf = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLElement>(':scope > div > div')].slice(1).map((row) => {
    const [key, value] = [...row.children] as HTMLElement[];
    const meter = value?.querySelector('[aria-valuetext], [role="img"]');
    const reading =
      meter?.getAttribute('aria-valuetext') ?? meter?.getAttribute('aria-label') ?? undefined;
    const rest = [...(value?.children ?? [])]
      .filter((child) => child !== meter)
      .map((child) => child.textContent)
      .join('');
    return [
      key?.textContent,
      reading === undefined ? (value?.textContent ?? '') : `${reading} ${rest}`.trim(),
    ];
  });
describe('status bar', () => {
  it('renders the panel from ?open=services with every box', async () => {
    const root = { mount: '/', totalBytes: 100, availableBytes: 8, usedPercent: 92 };
    const home = { mount: '/home', totalBytes: 100, availableBytes: 67, usedPercent: 33 };
    const d = daemon();
    d.routes['status.get'] = () =>
      Promise.resolve(
        envelope(
          status(undefined, [polled(PR), polled(ISSUES), polled('spur'), polled('jira:a')], {
            services: [...HEALTHY, service('jira', 'healthy')],
            transport: [SLACK_UP],
            host: {
              sampledAt: T,
              cpuPercent: 37.5,
              memory: null,
              disk: root,
              volumes: [root, home],
            },
            daemon: { version: '9.8.7-rc.1', startedAt: T, lastDispatchAt: null },
          }),
        ),
      );
    mount(d, '/?open=services');
    await settle();
    expect(panel().getAttribute('aria-labelledby')).toBeTruthy();
    expect(
      [...panel().querySelectorAll('[data-box]')].map((item) => item.getAttribute('data-box')),
    ).toEqual(['daemon', 'host', 'slack', 'spur', PR, ISSUES, 'jira:a']);
    // A one-project board still heads its sources with the project id.
    expect([...panel().querySelectorAll('h2')].map((item) => item.textContent)).toEqual(['a']);
    expect(rowsOf(box('daemon'))).toEqual([
      ['Version', '9.8.7-rc.1'],
      ['Started', T_TEXT],
      ['Last dispatch', '—'],
    ]);
    expect(rowsOf(box('host'))).toEqual([
      ['CPU', '37.5 / 100'],
      ['RAM', 'RAM: unknown / 100'],
      ['Disk /', '92 / 100 · error 8 B free'],
      ['Disk /home', '33 / 100 67 B free'],
    ]);
    expect(box('host').querySelector('[aria-valuetext*="free"]')).toBeNull();
    expect(rowsOf(box('slack'))).toEqual([]);
    expect(box(PR).textContent).toContain('github pull requests');
    expect(box(PR).textContent).toContain('polling');
  });

  it('no since for a healthy service', async () => {
    const d = daemon();
    const since = '2026-11-14T03:17:00.000Z';
    d.routes['status.get'] = () =>
      Promise.resolve(
        envelope(
          status(undefined, [polled(PR)], {
            services: HEALTHY.map((row) => ({ ...row, since })),
            transport: [SLACK_UP],
          }),
        ),
      );
    mount(d, '/?open=services');
    await settle();
    const text = panel().textContent;
    expect(text).not.toContain(time(Date.parse(since)));
    expect(text.toLowerCase()).not.toContain('last request');
    expect(footer().textContent.toLowerCase()).not.toContain('last request');
  });

  it('theme menu shows the choice and selects; the version comes from status.get', async () => {
    const d = daemon();
    let answer: (value: Response) => void = () => undefined;
    d.routes['status.get'] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    mount(d);
    await settle();
    expect(footer().textContent).not.toContain('board ');
    const icon = (name: 'sun' | 'moon' | 'auto') =>
      renderToStaticMarkup(createElement(Icon, { name }));
    const theme = () => barButton('Theme');
    expect(theme().innerHTML).toBe(icon('moon'));
    press(theme());
    const choices = [...footer().querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(choices.map((item) => item.textContent)).toEqual(['Light', 'Dark', 'Auto']);
    const [light] = choices;
    if (!light) throw new Error('no Light');
    press(light);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('board-theme')).toBe('light');
    expect(theme().innerHTML).toBe(icon('sun'));
    answer(
      envelope(
        status(undefined, [], {
          daemon: { version: '9.8.7-rc.1', startedAt: T, lastDispatchAt: null },
        }),
      ),
    );
    await settle();
    expect(footer().lastElementChild?.textContent).toBe('board 9.8.7-rc.1');
  });

  it('turns a dot red on the next status frame', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d);
    d.send(hello);
    await settle();
    const node = barButton('spur');
    expect(node.getAttribute('aria-label')).toBe('spur: polling');
    const message = 'sessions/<id> timed out after 5130 ms (timeout 5000 ms)';
    d.routes['status.get'] = () => Promise.resolve(envelope(spurBlind(message)));
    d.send('event: status\ndata: {}\n\n');
    await settle();
    expect(barButton('spur')).toBe(node);
    expect(node.getAttribute('aria-label')).toBe('spur: blind: stale');
    press(node);
    await settle();
    expect(rowsOf(box('spur'))).toContainEqual(['Blind', `stale · ${message}`]);
  });

  it('reads no status beyond the stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const d = daemon();
    const calls = vi.spyOn(d.routes, 'status.get');
    mount(d);
    d.send(hello);
    await settle();
    const before = calls.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    await settle();
    expect(calls).toHaveBeenCalledTimes(before);
  });

  it('opens from the bar and returns focus', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d);
    await settle();
    expect(dialog()).toBeNull();
    const github = barButton('github');
    press(github);
    expect(dialog()).not.toBeNull();
    expect(location.search).toContain('open=services');
    expect(barButton('services').getAttribute('aria-expanded')).toBe('true');
    escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(github);
    expect(location.search).toBe('');
    press(barButton('spur'));
    act(() => {
      (panel().querySelector('[aria-label="Close"]') as HTMLElement).click();
    });
    expect(dialog()).toBeNull();
    press(barButton('daemon'));
    act(() => {
      (panel().parentElement?.firstElementChild as HTMLElement).click();
    });
    expect(dialog()).toBeNull();
    act(() => {
      history.replaceState(null, '', '/?open=services');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(dialog()).not.toBeNull();
    act(() => {
      history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(dialog()).toBeNull();
  });

  it('closes the project switcher when services opens without a pointer', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d);
    await settle();
    const list = () => container.querySelector<HTMLElement>('ul[aria-label="Projects"]');
    const openList = () => {
      press(container.querySelector<HTMLElement>('header button[aria-controls]') as HTMLElement);
      expect(list()?.hidden).toBe(false);
    };
    // Back to an entry with ?open=services.
    openList();
    act(() => {
      history.replaceState(null, '', '/?open=services');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(dialog()).not.toBeNull();
    expect(list()?.hidden).toBe(true);
    escape();
    expect(dialog()).toBeNull();
    // Tab from the open list to the bar, then Enter on the services trigger.
    openList();
    act(() => {
      barButton('services').focus();
    });
    expect(list()?.hidden).toBe(true);
    press(barButton('services'));
    expect(dialog()).not.toBeNull();
    expect(list()?.hidden).toBe(true);
  });

  it('one Escape closes only the project switcher or the theme menu, whichever holds focus', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d);
    await settle();
    const switcher = () =>
      container.querySelector<HTMLButtonElement>('header button[aria-controls]') as HTMLElement;
    const list = () => container.querySelector<HTMLElement>('ul[aria-label="Projects"]');
    const theme = () => barButton('Theme');
    const menuOpen = () => theme().getAttribute('aria-expanded') === 'true';

    // Focus in the switcher list; the theme menu opens on mouse hover without taking focus.
    press(switcher());
    act(() => {
      list()?.querySelector('button')?.focus();
    });
    act(() => {
      theme().dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'mouse',
          relatedTarget: document.body,
        }),
      );
    });
    expect(list()?.hidden).toBe(false);
    expect(menuOpen()).toBe(true);
    escape();
    expect(list()?.hidden).toBe(true);
    expect(document.activeElement).toBe(switcher());
    expect(menuOpen()).toBe(true);
    escape();
    expect(menuOpen()).toBe(false);

    // Focus in the pinned theme menu; a click without focus opens the switcher.
    press(theme());
    expect(theme().closest('div')?.contains(document.activeElement)).toBe(true);
    act(() => {
      switcher().click();
    });
    expect(list()?.hidden).toBe(false);
    expect(menuOpen()).toBe(true);
    escape();
    expect(menuOpen()).toBe(false);
    expect(document.activeElement).toBe(theme());
    expect(list()?.hidden).toBe(false);
    // The switcher sees only keys from inside it, so its Escape needs focus there.
    act(() => {
      list()?.querySelector('button')?.focus();
    });
    escape();
    expect(list()?.hidden).toBe(true);
    expect(menuOpen()).toBe(false);
  });

  it('the bar stays live while the panel is open', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d);
    await settle();
    press(barButton('services'));
    expect(dialog()).not.toBeNull();
    expect(footer().closest('[inert]')).toBeNull();
    expect(boardWrapper().hasAttribute('inert')).toBe(true);
    const scrolled = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    press(barButton('spur'));
    expect(dialog()).not.toBeNull();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(box('spur'));
    press(barButton('services'));
    expect(dialog()).toBeNull();
    expect(boardWrapper().hasAttribute('inert')).toBe(false);
  });

  it('deep link keeps the bar live and falls back to the trigger', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d, '/?open=services');
    expect(dialog()).not.toBeNull();
    expect(footer().closest('[inert]')).toBeNull();
    expect(boardWrapper().hasAttribute('inert')).toBe(true);
    await settle();
    escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(barButton('services'));
  });

  it('a banner that appears while open is inert', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d, '/?open=services');
    d.send(hello);
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    d.routes['status.get'] = failure;
    d.send('event: status\ndata: {}\n\n');
    await settle();
    const banner = container.querySelector('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner?.closest('[inert]')).not.toBeNull();
  });

  it('daemon down marks the daemon red and the rest unknown', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d, '/?open=services');
    d.send(hello);
    await settle();
    d.routes['status.get'] = failure;
    d.send('event: status\ndata: {}\n\n');
    await settle();
    const [first, ...rest] = barLabels().slice(1, -1);
    expect(first).toMatch(/^daemon: no answer since \d\d:\d\d \d\d\/\d\d\/\d\d$/);
    expect(rest).toEqual(['slack: unknown', 'github: unknown', 'spur: unknown']);
    expect(rowsOf(box('daemon'))).toEqual([]);
    for (const id of ['host', 'slack', PR, ISSUES, 'spur'])
      expect(rowsOf(box(id)), id).toEqual([['Unknown while the daemon does not answer.', '']]);
    expect(box('spur').textContent).toContain('unknown');
  });

  it('quiet containers', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d, '/?open=services');
    await settle();
    expect(footer().classList.contains(quiet)).toBe(true);
    const boxes = [...panel().querySelectorAll('[data-box]')];
    expect(boxes.length).toBeGreaterThan(0);
    for (const item of boxes) expect(item.classList.contains(quiet)).toBe(true);
  });

  it('loading reads unknown and waits', async () => {
    const d = daemon();
    d.routes['status.get'] = never;
    mount(d, '/?open=services');
    await settle();
    const bar = barLabels().slice(1, -1);
    expect(bar).toHaveLength(3);
    for (const label of bar) expect(label).toMatch(/: unknown$/);
    expect(panel().textContent).toContain('Waiting for the first status from the daemon.');
  });

  it('offline with the panel open shows the data time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.parse(T) });
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d, '/?open=services');
    d.send(hello);
    await settle();
    expect(panel().textContent).not.toContain('Data from');
    await goOffline(d);
    expect(panel().textContent).toContain(`Data from ${T_TEXT}`);
    expect(rowsOf(box('daemon')).map(([key]) => key)).toEqual([
      'Version',
      'Started',
      'Last dispatch',
    ]);
    expect(rowsOf(box(PR)).length).toBeGreaterThan(0);
  });

  it('daemon down with the stream lost shows no data time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.parse(T) });
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(healthy()));
    mount(d, '/?open=services');
    d.send(hello);
    await settle();
    d.routes['status.get'] = failure;
    await goOffline(d);
    expect(barLabels()[1]).toBe(`daemon: no answer since ${T_TEXT}`);
    expect(panel().textContent).not.toContain('Data from');
    expect(rowsOf(box('host'))).toEqual([['Unknown while the daemon does not answer.', '']]);
  });

  it('source blind marks spur and its box', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(spurBlind()));
    mount(d, '/?open=services');
    await settle();
    const spur = barButton('spur');
    expect(spur.getAttribute('aria-label')).toBe('spur: blind: stale');
    expect(spur.innerHTML).toContain(
      renderToStaticMarkup(createElement(StatusDot, { tone: 'error', hollow: false })),
    );
    const head = box('spur').querySelector('[data-tone]');
    expect(head?.getAttribute('data-tone')).toBe('error');
    expect(head?.textContent).toBe('blind: stale');
    const rows = rowsOf(box('spur'));
    expect(rows).toContainEqual(['Blind', 'stale · Spur has not answered']);
    expect(rows.at(-1)?.[0]).toBe(SPUR_DOWN_LINE);
  });
});
