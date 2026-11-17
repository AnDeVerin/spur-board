// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../src/board/Board.tsx';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import {
  config,
  daemon,
  deferred,
  envelope,
  hello,
  problem,
  status,
  taskGet,
  taskHistory,
  type Daemon,
} from './board-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-15T14:00:00.000Z');
let container: HTMLDivElement;
let root: Root;
const started: BoardData[] = [];
let calls: { path: string; input: unknown }[] = [];
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
  calls = [];
  vi.useRealTimers();
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
});

/** `appOrder`: the board's effects run before `start`, as in `App`, where the child effect
 * runs first. */
function mount(d: Daemon, appOrder = false) {
  const data = createBoardData({
    fetch: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        input?: unknown;
      };
      calls.push({ path, input: body.input });
      return d.fetcher(url, init);
    },
    storage: () => ({ getItem: () => null, setItem: () => undefined }),
    now: () => NOW,
  });
  started.push(data);
  act(() => {
    root.render(createElement(Board, { data }));
    if (!appOrder) data.start();
  });
  if (appOrder)
    act(() => {
      data.start();
    });
  return data;
}
/** Body reads and parsing cross a few macrotasks; fake timers leave setImmediate real. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
const taskCalls = () => calls.filter(({ path }) => path === '/v1/ops/task.get');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (selector: string) => {
  const found = dialog()?.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector} in the dialog`);
  return found;
};
const card = (key = 'ex/repo#7') => {
  const found = document.querySelector<HTMLElement>(`main a[title="${key}"]`);
  if (!found) throw new Error(`no card ${key}`);
  return found;
};
const click = (target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
};
const key = (name: string, init: KeyboardEventInit = {}) => {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name, ...init }),
    );
  });
};
const close = () => inDialog('button[aria-label="Close"]');
const scrim = () => {
  const found = dialog()?.previousElementSibling;
  if (!found) throw new Error('no scrim');
  return found;
};

describe('task view', () => {
  it('Enter on a focused card opens the task: key, title, column and age, chips and why', async () => {
    mount(daemon());
    await settle();
    act(() => {
      card().focus();
    });
    // Enter on a focused link is a plain click.
    click(card());
    await settle();
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(inDialog('[title="ex/repo#7"]').textContent).toBe('#7');
    expect(dialog()?.textContent).toContain('dev · 2h');
    expect(inDialog('h2').textContent).toBe('Fix login');
    const pr = inDialog(
      'a[aria-label="PR #7, ex/repo"][rel="noopener noreferrer"][target="_blank"]',
    );
    expect(pr.textContent).toBe('PR #7');
    expect(pr.getAttribute('href')).toBe('https://github.com/ex/repo/pull/7');
    expect(pr.getAttribute('aria-label')?.startsWith(pr.textContent)).toBe(true);
    const chips = [...(dialog()?.querySelectorAll('span') ?? [])];
    expect(chips.some((chip) => chip.textContent === 'session s1')).toBe(true);
    // web.spurUiOrigin is null: the session chip stays plain.
    expect(dialog()?.querySelectorAll('a')).toHaveLength(1);
    const section = inDialog('section');
    expect(section.textContent).toContain('Why it is here');
    expect(section.textContent).toContain('1 failed');
    expect(section.textContent).toContain('Checks green');
    expect(section.textContent).toContain('checks red');
    expect(section.textContent).toContain('worker · not taken · 1h');
    expect(section.textContent).not.toContain('When dev');
    expect(document.activeElement).toBe(close().querySelector('button') ?? close());
    const tabs = [...(dialog()?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Now', 'History']);
    click(tabs[1] ?? close());
    await settle();
    expect(inDialog('[role="tabpanel"] table').querySelectorAll('tr')).toHaveLength(
      taskHistory().events.length,
    );
  });

  it('links the session chip to the Spur UI when web.spurUiOrigin is set', async () => {
    const d = daemon();
    d.routes['config.get'] = () =>
      Promise.resolve(
        envelope({ ...config, web: { publicOrigin: null, spurUiOrigin: 'https://spur.example' } }),
      );
    mount(d);
    await settle();
    click(card());
    await settle();
    const session = inDialog(
      'a[aria-label="session s1, Spur session"][rel="noopener noreferrer"][target="_blank"]',
    );
    expect(session.textContent).toBe('session s1');
    expect(session.getAttribute('href')).toBe('https://spur.example/sessions/s1');
    expect(dialog()?.querySelectorAll('a')).toHaveLength(2);
  });

  it('a click on an unfocused card opens it; Escape closes, drops open and focuses the card', async () => {
    mount(daemon());
    await settle();
    click(card());
    await settle();
    expect(location.search).toBe('?open=ex%2Frepo%237');
    expect(dialog()).not.toBeNull();
    key('Escape');
    await settle();
    expect(dialog()).toBeNull();
    expect(location.search).toBe('');
    expect(document.activeElement).toBe(card());
  });

  it('a clicked card is the opener focus returns to, not only the card the loaded key names', async () => {
    const d = daemon();
    d.routes['task.get'] = () =>
      Promise.resolve(envelope(taskGet({ task: { ...taskGet().task, key: 'ex/repo#8' } })));
    mount(d);
    await settle();
    click(card());
    await settle();
    key('Escape');
    await settle();
    expect(document.activeElement).toBe(card());
  });

  it('a scrim click and Close close it and focus the card; Back reopens it', async () => {
    mount(daemon());
    await settle();
    click(card());
    await settle();
    click(scrim());
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(card());
    click(card());
    await settle();
    click(close());
    await settle();
    expect(dialog()).toBeNull();
    expect(location.search).toBe('');
    expect(document.activeElement).toBe(card());
    act(() => {
      history.replaceState(null, '', '/?open=ex%2Frepo%237');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(dialog()).not.toBeNull();
  });

  it('keeps other params and the hash on close', async () => {
    history.replaceState(null, '', '/?theme=light&open=ex%2Frepo%237#top');
    mount(daemon());
    await settle();
    key('Escape');
    await settle();
    expect(`${location.search}${location.hash}`).toBe('?theme=light#top');
  });

  it.each([
    ['full', '/?open=ex%2Frepo%237'],
    ['short', '/?open=repo%237'],
  ])('a %s deep link opens on load; close focuses the card of the loaded key', async (_, url) => {
    history.replaceState(null, '', url);
    mount(daemon());
    await settle();
    expect(dialog()).not.toBeNull();
    expect(taskCalls().map(({ input }) => input)).toEqual([
      { task: decodeURIComponent(url.slice('/?open='.length)), why: true },
    ]);
    key('Escape');
    await settle();
    expect(document.activeElement).toBe(card());
  });

  it('a deep link read before start issues one task.get', async () => {
    history.replaceState(null, '', '/?open=ex%2Frepo%237');
    mount(daemon(), true);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(taskCalls().map(({ input }) => input)).toEqual([{ task: 'ex/repo#7', why: true }]);
  });

  it('an unknown key and a non-task key show "Task not found."; close leaves focus on body', async () => {
    const d = daemon();
    d.routes['task.get'] = () => problem('not_found');
    history.replaceState(null, '', '/?open=ex%2Frepo%23999');
    mount(d);
    await settle();
    expect(inDialog('[role="tabpanel"]').textContent).toBe('Task not found.');
    key('Escape');
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    act(() => {
      history.replaceState(null, '', '/?open=509');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(inDialog('[role="tabpanel"]').textContent).toBe('Task not found.');
    expect(taskCalls()).toHaveLength(1);
  });

  it.each(['inbox', 'services', ''])('?open=%s opens no task view', async (value) => {
    history.replaceState(null, '', `/?open=${value}`);
    mount(daemon());
    await settle();
    expect(dialog()).toBeNull();
    expect(taskCalls()).toHaveLength(0);
  });

  it('with a task open the only new request is task.get with why', async () => {
    mount(daemon());
    await settle();
    const before = calls.length;
    click(card());
    await settle();
    expect(calls.slice(before)).toEqual([
      { path: '/v1/ops/task.get', input: { task: 'ex/repo#7', why: true } },
    ]);
  });

  it('Tab from Close visits the body, the panel, the PR link, the chevron and the Now tab', async () => {
    mount(daemon());
    await settle();
    click(card());
    await settle();
    const surface = dialog();
    if (!surface) throw new Error('no dialog');
    const panel = inDialog('[role="tabpanel"]');
    const body = panel.parentElement;
    expect(body?.getAttribute('tabindex')).toBe('0');
    const order = [
      body,
      panel,
      inDialog('a[aria-label="PR #7, ex/repo"]'),
      inDialog('button[aria-expanded]'),
      inDialog('[role="tab"][aria-selected="true"]'),
      close().querySelector('button') ?? close(),
    ];
    for (const stop of order) {
      key('Tab');
      expect(document.activeElement).toBe(stop);
      expect(surface.contains(document.activeElement)).toBe(true);
    }
    for (const stop of [...order].reverse().slice(1)) {
      key('Tab', { shiftKey: true });
      expect(document.activeElement).toBe(stop);
    }
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(close().querySelector('button') ?? close());
  });

  it('shows a title skeleton until status.get answers, then the title', async () => {
    const d = daemon();
    const held = deferred();
    d.routes['status.get'] = () => held.promise;
    history.replaceState(null, '', '/?open=ex%2Frepo%237');
    mount(d);
    await settle();
    expect(dialog()?.querySelector('h2')).toBeNull();
    expect(inDialog('[aria-hidden="true"] [style*="width: 60%"]')).toBeDefined();
    held.resolve(envelope(status()));
    await settle();
    expect(inDialog('h2').textContent).toBe('Fix login');
  });

  it('shows no title line for a task without a held row', async () => {
    const d = daemon();
    d.routes['task.get'] = () =>
      Promise.resolve(envelope(taskGet({ task: { ...taskGet().task, key: 'ex/repo#8' } })));
    history.replaceState(null, '', '/?open=ex%2Frepo%238');
    mount(d);
    await settle();
    expect(dialog()?.querySelector('h2')).toBeNull();
    expect(inDialog('section').textContent).toContain('Why it is here');
  });

  it('a failed read shows the error banner; Retry reads task.get again', async () => {
    const d = daemon();
    d.routes['task.get'] = () => problem('unexpected', 500);
    mount(d);
    await settle();
    click(card());
    await settle();
    expect(inDialog('[role="alert"]').textContent).toContain('Could not load the task.');
    const count = taskCalls().length;
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet()));
    const retry = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Retry',
    );
    if (!retry) throw new Error('no Retry');
    click(retry);
    await settle();
    expect(taskCalls()).toHaveLength(count + 1);
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    expect(inDialog('section').textContent).toContain('Why it is here');
  });

  it('a failed re-read keeps the loaded task and shows the error banner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    mount(d);
    await settle();
    d.send(hello);
    await settle();
    click(card());
    await settle();
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    const count = taskCalls().length;
    d.routes['task.get'] = () => problem('unexpected', 500);
    d.send('event: invalidate\ndata: {"projects":[],"tasks":["ex/repo#7"]}\n\n');
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(taskCalls()).toHaveLength(count + 1);
    expect(inDialog('[role="alert"]').textContent).toContain('Could not load the task.');
    expect(inDialog('a[aria-label="PR #7, ex/repo"]').textContent).toBe('PR #7');
    expect(inDialog('section').textContent).toContain('Why it is here');
  });

  it('offline with kept data shows no modal banner and keeps the data', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    mount(d);
    await settle();
    click(card());
    await settle();
    d.routes['task.get'] = () => problem('unexpected', 500);
    d.send(hello);
    await settle();
    d.failStream();
    d.endStream();
    await settle();
    for (const delay of [500, 1000, 2000, 4000]) {
      await act(() => vi.advanceTimersByTimeAsync(delay));
      await settle();
    }
    expect(document.querySelector('header')?.textContent).toContain('offline');
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    expect(inDialog('a[aria-label="PR #7, ex/repo"]')).toBeDefined();
    expect(inDialog('section').textContent).toContain('Why it is here');
  });

  it('re-reads the open task when the stream names it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    mount(d);
    await settle();
    d.send(hello);
    await settle();
    click(card());
    await settle();
    const count = taskCalls().length;
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ turn: null, blocks: [] })));
    d.send('event: invalidate\ndata: {"projects":[],"tasks":["ex/repo#7"]}\n\n');
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(taskCalls()).toHaveLength(count + 1);
    expect(inDialog('section').textContent).toContain('Open turnnone');
  });
});
