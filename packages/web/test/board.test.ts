// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
} from './board-fixtures.ts';
import {
  all,
  container,
  goOffline,
  linkedRows,
  mount,
  mountEachTest,
  one,
  press,
  serve,
  settle,
  withSpur,
} from './board-harness.ts';

mountEachTest();

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
const type = (value: string) => {
  const input = one('input');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
/** Card links and done rows by task key; a dimmed card dims its wrapper. */
const tasks = () => all('main a[href^="?open="]');
// Layers are portalled beside the board root.
const layerAll = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const layerOne = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
};
const dimmed = () =>
  tasks()
    .filter((link) => link.closest('[data-dimmed]') !== null)
    .map((l) => l.title);

describe('board screen', () => {
  const retry = 'retry delivery';
  const failed = 'Delivery failed';
  const token = 'check token: Slack';
  it.each<[string, string | undefined, string]>([
    [`${failed}: ${retry}`, retry, failed],
    [`Slack: delivery failed: ${token}`, token, 'Slack: delivery failed'],
    [`${failed}: ${retry}`, undefined, `${failed}: ${retry}`],
    [`${failed}: inspect logs`, retry, `${failed}: inspect logs`],
    [`${retry}: still failed: ${retry}`, retry, `${retry}: still failed`],
  ])(
    'inbox text %s / action %s preserves description and separate action in active and handled rows',
    async (text, action, description) => {
      const d = daemon();
      const entry = { ...inbox(1).items[0], id: 'I1', kind: 'transport_health', text, action };
      const handled = [{ ...entry, id: 'I2', handledAt: '2026-11-15T14:00:00.000Z' }];
      d.routes['inbox.operator'] = () => Promise.resolve(envelope({ items: [entry], handled }));
      mount(d);
      await settle();
      press(button('inbox'), 'click');
      for (const id of ['I1', 'I2']) {
        const row = layerOne(`[data-inbox-id="${id}"]`);
        expect(row.children.item(1)?.textContent).toBe(description);
        expect(row.children.item(2)?.textContent).toBe(action);
        expect(row.children.length).toBe(action === undefined ? 2 : 3);
      }
    },
  );

  it('inbox filters active counts and both lists, orders failures first and preserves handled order', async () => {
    const all = layerAll;
    const one = layerOne;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const base = inbox(1).items[0];
    const items = [
      { ...base, id: 'B1', project: 'a', at: '2026-11-15T13:00:00.000Z' },
      { ...base, id: 'B2', project: 'b', severity: 'failure', at: '2026-11-15T12:00:00.000Z' },
      { ...base, id: 'T3', project: '_board', kind: 'turn', task: 'ex/repo#7', column: 'dev' },
      { ...base, id: 'B4', project: 'a', severity: 'failure' },
    ];
    const handled = [
      {
        ...base,
        id: 'B8',
        project: 'b',
        handledAt: '2026-11-15T14:00:00.000Z',
        answeredVia: 'slack',
      },
      {
        ...base,
        id: 'B7',
        project: 'a',
        at: '2026-11-15T10:00:00.000Z',
        handledAt: '2026-11-15T13:00:00.000Z',
      },
    ];
    d.routes['inbox.operator'] = () => Promise.resolve(envelope({ items, handled }));
    mount(d);
    await settle();
    d.send(hello);
    await settle();
    press(button('inbox'), 'click');
    const ids = () => all('[data-inbox-id]').map((row) => row.dataset.inboxId);
    expect(ids()).toEqual(['B4', 'B2', 'T3', 'B1', 'B8', 'B7']);
    expect(all('[role="tab"]').map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'All 4',
      'a 2',
      'b 1',
      'System 1',
    ]);
    expect(one('[data-inbox-id="T3"]').textContent).toContain('your turn T3 · attention#7dev');
    expect(one('[data-inbox-id="B8"]').textContent).toContain('Handled · answered via slack');
    expect(one('[data-inbox-id="B1"]').tabIndex).toBe(0);
    press(one('[aria-label="a 2"]'), 'click');
    expect(ids()).toEqual(['B4', 'B1', 'B7']);
    press(one('[aria-label="a 2"]'), 'keydown', { key: 'ArrowRight' });
    expect(ids()).toEqual(['B2', 'B8']);
    press(one('[aria-label="b 1"]'), 'keydown', { key: 'End' });
    expect(ids()).toEqual(['T3']);
    expect(button('inbox').textContent).toBe('inbox4');
    d.routes['inbox.operator'] = () => Promise.resolve(envelope({ items: [], handled }));
    d.send('event: invalidate\ndata: {"projects":["b"],"tasks":[]}\n\n');
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(400));
    await settle();
    press(one('[aria-label="All 0"]'), 'click');
    expect(ids()).toEqual(['B8', 'B7']);
    expect(one('[role="tabpanel"]').textContent).toContain('Nothing waits for you here.');
    d.routes['inbox.operator'] = failure;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(ids()).toEqual(['B8', 'B7']);
  });

  it('deep links, unknown first failure, collision-safe long project filters and removed projects', async () => {
    const all = layerAll;
    const one = layerOne;
    history.replaceState(null, '', '/?theme=light&open=inbox#top');
    const d = daemon();
    const long = 'project-'.repeat(40);
    const projects = ['all', 'system', long].map((id) => ({ ...config.projects[0], id }));
    d.routes['config.get'] = () => Promise.resolve(envelope({ ...config, projects }));
    d.routes['inbox.operator'] = failure;
    mount(d);
    await settle();
    expect(one('[role="dialog"]').textContent).toContain('Inbox data is not available yet.');
    expect(one('[role="dialog"]').textContent).not.toContain('Nothing waits');
    expect(button('inbox').textContent).toBe('inbox–');
    const base = inbox(1).items[0];
    d.routes['inbox.operator'] = () =>
      Promise.resolve(
        envelope({
          items: [
            { ...base, id: 'B1', project: 'all' },
            { ...base, id: 'B2', project: 'system' },
            { ...base, id: 'B3', project: long },
          ],
          handled: [],
        }),
      );
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    press(one('[aria-label="all 1"]'), 'click');
    expect(all('[data-inbox-id]').map((row) => row.dataset.inboxId)).toEqual(['B1']);
    press(one('[aria-label="all 1"]'), 'keydown', { key: 'ArrowRight' });
    expect(all('[data-inbox-id]').map((row) => row.dataset.inboxId)).toEqual(['B2']);
    press(one('[aria-label="system 1"]'), 'keydown', { key: 'ArrowRight' });
    expect(one('[aria-selected="true"]').textContent).toBe(`${long}1`);
    d.routes['config.get'] = () => Promise.resolve(envelope(config));
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(one('[aria-selected="true"]').getAttribute('aria-label')).toBe('All 3');
    press(one('[aria-label="Close"]'), 'click');
    expect(location.search + location.hash).toBe('?theme=light#top');
    expect(document.activeElement).toBe(button('inbox'));
    act(() => {
      history.replaceState(null, '', '/?open=inbox');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(one('[role="dialog"]').textContent).toContain('Inbox');
    act(() => {
      history.replaceState(null, '', '/?open=services');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(all('[role="dialog"]')).toHaveLength(0);
  });

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
    // The id sits alone in the span that truncates it; the trigger's text, its name, stays whole.
    const idSpan = (button: Element) => button.firstElementChild?.firstElementChild;
    expect(idSpan(trigger())?.outerHTML).toMatch(/^<span class="[^"]+">a<\/span>$/);
    expect(trigger().textContent).toBe('a');
    press(trigger(), 'click');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const list = one(`[id="${String(trigger().getAttribute('aria-controls'))}"]`);
    expect([...list.querySelectorAll('button')].map((item) => idSpan(item)?.textContent)).toEqual([
      'a',
      'b',
    ]);
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
    expect(all('main ul:not([hidden]) a').map((link) => link.title)).toEqual(DONE);
    expect(one('main').textContent).not.toContain('+');
    expect(button('1 task in unknown columns').getAttribute('aria-expanded')).toBe('false');
  });

  it('cards are links to ?open=<key>', async () => {
    mount(daemon());
    await settle();
    const card = one('main a[title="ex/repo#7"]');
    expect(card.getAttribute('href')).toBe('?open=ex%2Frepo%237');
    expect(card.getAttribute('aria-label')).toBe('ex/repo#7 Fix login');
    expect(card.textContent).toBe('#7Fix loginB12 → you');
    expect(card.querySelector('a, button, input, [tabindex]')).toBeNull();
    const bare = one('main a[title="ABC-3"]');
    expect([bare.getAttribute('aria-label'), bare.textContent]).toEqual(['ABC-3', 'ABC-3']);
    expect(bare.hasAttribute('aria-describedby')).toBe(false);
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
    expect(container().querySelector('[title="Dispatcher mode"]')).toBeNull();
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
    const marker = button('1 task in unknown columns');
    press(marker, 'click');
    d.send(hello);
    await settle();
    expect(indicator()).toBe('live');
    d.endStream();
    await settle();
    expect(indicator()).toBe('reconnecting');
    expect(banners()).toHaveLength(0);
    expect(all('[data-stale]')).toHaveLength(0);
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(one('main a[title="ex/repo#99"]').closest('[hidden]')).toBeNull();
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
    expect(container().querySelector('[aria-busy="true"]')).toBeNull();
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
    expect(links()).toHaveLength(10);
    for (const link of links()) expect(link.classList.contains(focusRing)).toBe(true);
    for (const link of all('main ul a')) expect(link.classList.contains(quiet)).toBe(true);
    const cards = all('main a[title="ex/repo#7"], main a[title="ABC-3"]');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.parentElement?.classList.contains(quiet)).toBe(true);
      expect(card.parentElement?.hasAttribute('data-turn')).toBe(true);
    }
    // The operator's block is the you chip, and nothing in the card overrides its colours.
    const you = all('main span').find((span) => span.textContent === 'B12 → you');
    const chip = renderToStaticMarkup(createElement(Chip, { tone: 'you', children: 'x' }));
    expect(you?.className).toBe(/class="([^"]+)"/.exec(chip)?.[1]);
  });

  it('tab order follows reading order', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    serve(d, linkedRows(), withSpur);
    mount(d);
    await settle();
    await goOffline(d);
    const focusable = all('a[href], button:not([disabled]), input, [tabindex]').filter(
      (element) => element.closest('[hidden]') === null,
    );
    expect(focusable).toEqual([
      trigger(),
      one('input'),
      button('inbox'),
      button('Retry now'),
      ...all('main section').flatMap((section) => [
        ...section.querySelectorAll('[role="group"] button'),
        ...section.querySelectorAll('a'),
      ]),
    ]);
    expect(links().map((link) => link.getAttribute('aria-label') ?? link.title)).toEqual([
      'ex/repo#7 Title ex/repo#7',
      'Ticket ex/repo#7, opens in a new tab',
      'PR #4, opens in a new tab',
      'Spur session sess-9, opens in a new tab',
      'ABC-3',
      ...DONE.map((key) => `${key} Title ${key}`),
    ]);
  });

  it('filter dims and never removes cards', async () => {
    mount(daemon());
    await settle();
    const everyKey = tasks().map((link) => link.title);
    const others = (...keys: string[]) => everyKey.filter((key) => !keys.includes(key));
    for (const [text, matches] of [
      ['B12', ['ex/repo#7']],
      ['sess-9', ['ex/repo#21']],
      ['#7', ['ex/repo#7']],
      ['abc', ['ABC-3']],
      ['repo#2', DONE],
    ] as const) {
      type(text);
      expect(tasks()).toHaveLength(everyKey.length);
      expect(dimmed()).toEqual(others(...matches));
    }
    press(one('button[aria-label="Clear"]'), 'click');
    expect(dimmed()).toEqual([]);
  });
});
