// @vitest-environment happy-dom
import { act } from 'react';
import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it, vi } from 'vitest';
import { createBoardData } from '../src/board/data.ts';
import { boardColumns, sortRows, type ColumnSort } from '../src/board/model.ts';
import { focusRing } from '../src/ds/index.ts';
import { parsed } from './board-fixtures.ts';
import { config, daemon, envelope, failure, row, ROWS, status, taskGet } from './board-fixtures.ts';
import {
  all,
  goOffline,
  mount,
  mountEachTest,
  one,
  press,
  remount,
  settle,
} from './board-harness.ts';

mountEachTest();

const button = (text: string) => {
  const found = all('button').find((item) => item.textContent.includes(text));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${text}`);
  return found;
};
const trigger = () => one('button[aria-controls]');
/** Disclosure buttons in the board area; the sort letters' menu triggers are not. */
const disclosures = () => all('main button[aria-controls]:not([aria-haspopup])');
const type = (value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      one('input'),
      value,
    );
    one('input').dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('unknown board columns', () => {
  it('boardColumns retains only configured groups in config order', () => {
    const columns = boardColumns(parsed().columns, parsed().rows);
    expect(columns.map(({ id, rows }) => [id, rows.length])).toEqual([
      ['todo', 0],
      ['dev', 2],
      ['review', 0],
      ['done', 7],
    ]);
  });
  it('counts unmatched rows once and discloses their keys, titles and original columns', async () => {
    const d = daemon();
    d.routes['status.get'] = () =>
      Promise.resolve(
        envelope(status([...ROWS, row('UNKNOWN-2', 'product-review', { ticket: null })])),
      );
    mount(d);
    await settle();
    const marker = button('2 tasks in unknown columns');
    expect(disclosures()).toEqual([marker]);
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    const list = one(`ul[id="${marker.getAttribute('aria-controls') ?? ''}"]`);
    expect(list.hidden).toBe(true);
    expect([...list.querySelectorAll('a')].every((link) => link.closest('[hidden]') !== null)).toBe(
      true,
    );
    press(marker.firstElementChild ?? marker, 'click');
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('a')].map((link) => [link.title, link.textContent])).toEqual([
      ['ex/repo#99', '#99Title ex/repo#99qa'],
      ['UNKNOWN-2', 'UNKNOWN-2product-review'],
    ]);
    type('UNKNOWN-2');
    expect(marker.textContent).toBe('2 tasks in unknown columns');
    expect(list.querySelector('[title="ex/repo#99"]')?.hasAttribute('data-dimmed')).toBe(true);
    expect(list.querySelector('[title="UNKNOWN-2"]')?.hasAttribute('data-dimmed')).toBe(false);
    press(marker, 'click');
    expect(list.hidden).toBe(true);
  });

  it.each([{ rows: [] }, { rows: ROWS.filter((task) => task.column !== 'qa') }])(
    'omits the unknown surface at zero: $rows.length rows',
    async ({ rows }) => {
      const d = daemon();
      d.routes['status.get'] = () => Promise.resolve(envelope(status(rows)));
      mount(d);
      await settle();
      expect(disclosures()).toHaveLength(0);
      expect(one('main').textContent).not.toContain('unknown columns');
    },
  );

  it('keeps an all-unmatched task discoverable through the existing task view', async () => {
    const d = daemon();
    const reads: Record<string, unknown>[] = [];
    d.routes['task.get'] = (input) => {
      reads.push(input);
      return Promise.resolve(
        envelope(taskGet({ task: { ...taskGet().task, key: 'ex/repo#99', column: 'qa' } })),
      );
    };
    d.routes['status.get'] = () => Promise.resolve(envelope(status([row('ex/repo#99', 'qa')])));
    mount(d);
    await settle();
    const marker = button('1 task in unknown columns');
    press(marker, 'click');
    const link = one('main a[title="ex/repo#99"]');
    act(() => {
      link.focus();
    });
    press(link, 'click');
    await settle();
    expect(location.search).toBe('?open=ex%2Frepo%2399');
    expect(reads).toContainEqual({ task: 'ex/repo#99', why: true, detail: true });
    const close = document.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (close === null) throw new Error('no task close button');
    press(close, 'click');
    await settle();
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(link);
  });

  it('recomputes unknown rows on status/config refresh and resets disclosure on project change', async () => {
    const d = daemon();
    mount(d);
    await settle();
    press(button('1 task in unknown columns'), 'click');
    d.routes['status.get'] = () => Promise.resolve(envelope(status([row('NEW-1', 'qa')])));
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(all('main a').map((link) => link.title)).toEqual(['NEW-1']);
    expect(button('1 task in unknown columns').getAttribute('aria-expanded')).toBe('true');
    press(trigger(), 'click');
    press(button('b · dispatcher'), 'click');
    await settle();
    expect(button('1 task in unknown columns').getAttribute('aria-expanded')).toBe('false');
    d.routes['config.get'] = () =>
      Promise.resolve(
        envelope({
          ...config,
          projects: config.projects.map((project) => ({
            ...project,
            columns: [...project.columns, { ...project.columns[0], id: 'qa' }],
          })),
        }),
      );
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(disclosures()).toHaveLength(0);
    expect(all('main a').map((link) => link.title)).toEqual(['NEW-1']);
  });

  it.each([false, true])(
    'retains expanded unknown rows through offline/read failure: %s',
    async (readFailed) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const d = daemon();
      mount(d);
      await settle();
      const marker = button('1 task in unknown columns');
      press(marker, 'click');
      const list = one(`ul[id="${marker.getAttribute('aria-controls') ?? ''}"]`);
      const text = list.textContent;
      if (readFailed) d.routes['status.get'] = failure;
      await goOffline(d);
      expect(marker.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
      expect(list.textContent).toBe(text);
      expect(marker.textContent).toBe('1 task in unknown columns');
      expect(marker.parentElement?.hasAttribute('data-stale')).toBe(true);
      expect(all('main section').every((section) => section.hasAttribute('data-stale'))).toBe(true);
    },
  );
});

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const at = (minutesBefore: number) => new Date(T0 - minutesBefore * 60_000).toISOString();
const typed = (rows: unknown[]) => browserOperations['status.get'].output.parse(status(rows)).tasks;
const section = (id: string) => {
  const found = all('main section').find((item) => item.querySelector('h2')?.textContent === id);
  if (!found) throw new Error(`no column ${id}`);
  return found;
};
const sortButtons = (id: string) => [...section(id).querySelectorAll('[role="group"] button')];
const sortText = (id: string) => sortButtons(id).map((item) => item.textContent);
const keys = (id: string) =>
  [...section(id).querySelectorAll<HTMLAnchorElement>('a[href^="?open="]')].map((a) => a.title);
const click = (id: string, index: number) => {
  const target = sortButtons(id)[index];
  if (!target) throw new Error(`no sort button ${String(index)} in ${id}`);
  press(target, 'click');
};
/** Opens the sort menu of column `id` from its letter and chooses `label`. */
const choose = (id: string, label: string) => {
  const [letter] = sortButtons(id);
  if (!letter) throw new Error(`no sort letter in ${id}`);
  press(letter, 'click');
  const item = [...section(id).querySelectorAll('[role="menuitemradio"]')].find(
    (option) => option.textContent === label,
  );
  if (!item) throw new Error(`no ${label} in the sort menu of ${id}`);
  press(item, 'click');
};
const named = (target: Element) => [
  target.textContent,
  target.getAttribute('aria-label'),
  target.getAttribute('title'),
];

describe('column sort', () => {
  it('keeps frozen-time server visit order by default while alternate key sorting wins', () => {
    const visits = typed(
      ['ex/repo#3', 'ex/repo#4', 'ex/repo#2', 'ex/repo#1'].map((key) =>
        row(key, 'ready-for-dev', { columnEnteredAt: at(5) }),
      ),
    );
    expect(sortRows(visits, 'entered-asc').map((item) => item.key)).toEqual([
      'ex/repo#3',
      'ex/repo#4',
      'ex/repo#2',
      'ex/repo#1',
    ]);
    expect(sortRows(visits, 'key-asc').map((item) => item.key)).toEqual([
      'ex/repo#1',
      'ex/repo#2',
      'ex/repo#3',
      'ex/repo#4',
    ]);
  });
  const rows = [
    row('ex/repo#10', 'dev', { columnEnteredAt: at(30) }),
    row('ex/repo#9', 'dev', { columnEnteredAt: at(90) }),
    row('ex/repo#100', 'dev'),
  ];
  it.each<[ColumnSort, string[]]>([
    ['entered-asc', ['ex/repo#9', 'ex/repo#10', 'ex/repo#100']],
    ['entered-desc', ['ex/repo#10', 'ex/repo#9', 'ex/repo#100']],
    ['key-asc', ['ex/repo#9', 'ex/repo#10', 'ex/repo#100']],
    ['key-desc', ['ex/repo#100', 'ex/repo#10', 'ex/repo#9']],
  ])('sortRows %s', (sort, expected) => {
    const input = typed(rows);
    expect(sortRows(input, sort).map((item) => item.key)).toEqual(expected);
    expect(input.map((item) => item.key)).toEqual(['ex/repo#10', 'ex/repo#9', 'ex/repo#100']);
  });
  it('sortRows manual follows position and puts rows without one last in status order', () => {
    const placed = typed([
      row('ex/repo#1', 'todo', { position: 3 }),
      row('ex/repo#2', 'todo'),
      row('ex/repo#3', 'todo', { position: 1 }),
      row('ex/repo#4', 'todo'),
      row('ex/repo#5', 'todo', { position: 2 }),
    ]);
    expect(sortRows(placed, 'manual').map((item) => item.key)).toEqual([
      'ex/repo#3',
      'ex/repo#5',
      'ex/repo#1',
      'ex/repo#2',
      'ex/repo#4',
    ]);
  });

  it('sortRows compares Jira keys as numbers and keeps ties in input order', () => {
    const jira = typed([row('ABC-10', 'dev'), row('ABC-9', 'dev')]);
    expect(sortRows(jira, 'key-asc').map((item) => item.key)).toEqual(['ABC-9', 'ABC-10']);
    const tied = typed(
      ['A-2', 'A-1', 'A-3'].map((key) => row(key, 'dev', { columnEnteredAt: at(5) })),
    );
    for (const sort of ['entered-asc', 'entered-desc'] as const)
      expect(sortRows(tied, sort).map((item) => item.key)).toEqual(['A-2', 'A-1', 'A-3']);
  });

  it('renders the sort group on non-empty columns: a letter menu and the direction for T and K', async () => {
    mount(daemon());
    await settle();
    expect(
      all('[role="group"][aria-label^="Sort "]').map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Sort dev', 'Sort done']);
    expect(all('main section[title] button')).toHaveLength(0);
    const [letter, direction] = sortButtons('dev');
    if (!letter || !direction) throw new Error('no dev sort buttons');
    expect(letter.getAttribute('aria-haspopup')).toBe('menu');
    expect([named(letter), named(direction)]).toEqual([
      ['T', 'Sorted by time in the column', null],
      ['↑', 'Longest in the column first', 'Longest in the column first. Click to reverse.'],
    ]);
    press(letter, 'click');
    expect(letter.getAttribute('aria-expanded')).toBe('true');
    const items = () => [...section('dev').querySelectorAll('[role="menuitemradio"]')];
    expect(items().map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Time', 'true'],
      ['Key', 'false'],
      ['Manual', 'false'],
    ]);
    const key = items()[1];
    if (!key) throw new Error('no Key item');
    press(key, 'click');
    expect(letter.getAttribute('aria-expanded')).toBe('false');
    expect([named(letter), named(direction)]).toEqual([
      ['K', 'Sorted by key', null],
      ['↑', 'Lowest key first', 'Lowest key first. Click to reverse.'],
    ]);
    press(direction, 'click');
    expect(named(direction)).toEqual([
      '↓',
      'Highest key first',
      'Highest key first. Click to reverse.',
    ]);
    choose('dev', 'Time');
    expect([named(letter), named(direction)]).toEqual([
      ['T', 'Sorted by time in the column', null],
      ['↓', 'Newest in the column first', 'Newest in the column first. Click to reverse.'],
    ]);
    choose('dev', 'Manual');
    // Manual has no direction; Time or Key from Manual starts ascending.
    expect(sortText('dev')).toEqual(['M']);
    expect(named(letter)).toEqual(['M', 'Sorted by manual order', null]);
    choose('dev', 'Key');
    expect(sortText('dev')).toEqual(['K', '↑']);
    // The head is not remounted, so the letter keeps its place and focus.
    expect(sortButtons('dev')[0]).toBe(letter);
  });

  it('puts the letter and direction after the heading and before the rows, with the ds focus ring', async () => {
    mount(daemon());
    await settle();
    const dev = section('dev');
    const [letter, direction] = sortButtons('dev');
    const actor = dev.querySelector('button[aria-haspopup="dialog"]');
    expect([...dev.querySelectorAll('button, a[href]')]).toEqual([
      actor,
      letter,
      direction,
      ...dev.querySelectorAll('a[href]'),
    ]);
    const heading = dev.querySelector('h2');
    if (!heading || !letter) throw new Error('no heading');
    expect(heading.compareDocumentPosition(letter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The letter is the ds HoverMenu trigger, which draws the ds ring itself.
    expect([actor, direction].every((item) => item?.classList.contains(focusRing))).toBe(true);
  });

  it('reorders one column, stores its order and restores it per project and column', async () => {
    const d = daemon();
    d.routes['status.get'] = () => Promise.resolve(envelope(status([...ROWS, ...rows])));
    const stored = mount(d);
    await settle();
    expect(keys('dev')).toEqual(['ex/repo#9', 'ex/repo#10', 'ex/repo#7', 'ABC-3', 'ex/repo#100']);
    click('dev', 1);
    expect(keys('dev')).toEqual(['ex/repo#10', 'ex/repo#9', 'ex/repo#7', 'ABC-3', 'ex/repo#100']);
    expect(
      Object.fromEntries([...stored].filter(([key]) => key.startsWith('board-sort:'))),
    ).toEqual({ 'board-sort:a:dev': 'entered-desc' });
    remount();
    mount(d, { 'board-sort:a:dev': 'key-asc', 'board-sort:a:done': 'bogus' });
    await settle();
    expect(sortText('dev')).toEqual(['K', '↑']);
    expect(keys('dev')).toEqual(['ABC-3', 'ex/repo#7', 'ex/repo#9', 'ex/repo#10', 'ex/repo#100']);
    expect(sortText('done')).toEqual(['T', '↑']);
    remount();
    mount(d, { 'board-sort:a:done': 'key-desc' });
    await settle();
    expect(sortText('done')).toEqual(['K', '↓']);
    remount();
    const manual = mount(d, { 'board-sort:a:done': 'key-desc' });
    await settle();
    choose('dev', 'Manual');
    expect(manual.get('board-sort:a:dev')).toBe('manual');
    remount();
    mount(d, { 'board-sort:a:dev': 'manual', 'board-sort:a:done': 'key-desc' });
    await settle();
    expect(sortText('dev')).toEqual(['M']);
    press(trigger(), 'click');
    press(button('b · dispatcher'), 'click');
    await settle();
    expect(sortText('done')).toEqual(['T', '↑']);
  });

  it('falls back to T up when storage throws', () => {
    const broken = createBoardData({
      fetch: daemon().fetcher,
      storage: () => ({
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      }),
      now: () => 0,
    });
    expect(broken.columnSort('a', 'dev')).toBe('entered-asc');
    expect(() => {
      broken.setColumnSort('a', 'dev', 'key-asc');
    }).not.toThrow();
  });

  it('shows the time in the column after the key and last in a Done row', async () => {
    const d = daemon();
    d.routes['status.get'] = () =>
      Promise.resolve(
        envelope(
          status([
            row('ex/repo#7', 'dev', { columnEnteredAt: at(90) }),
            row('ex/repo#20', 'done', { columnEnteredAt: at(90) }),
            row('ex/repo#21', 'done'),
          ]),
        ),
      );
    mount(d, {}, () => T0);
    await settle();
    const keyRow = section('dev').querySelector('a')?.firstElementChild;
    expect(
      [...(keyRow?.children ?? [])].map((item) => [item.textContent, item.getAttribute('title')]),
    ).toEqual([
      ['#7', null],
      ['1h 30m', 'Time in this column'],
    ]);
    const [timed, untimed] = section('done').querySelectorAll('a');
    expect(timed?.lastElementChild?.textContent).toBe('1h 30m');
    expect(untimed?.textContent).toBe('#21Title ex/repo#21');
  });

  it('keeps the unknown list in status order and lets the filter dim without reordering', async () => {
    const d = daemon();
    // ROWS already holds ex/repo#99 in qa.
    const unknown = [row('ABC-1', 'qa'), row('ex/repo#5', 'qa')];
    d.routes['status.get'] = () => Promise.resolve(envelope(status([...ROWS, ...unknown])));
    mount(d, { 'board-sort:a:dev': 'key-desc', 'board-sort:a:qa': 'key-asc' });
    await settle();
    press(trigger(), 'click');
    expect(all('main ul[id] a').map((link) => link.title)).toEqual([
      'ex/repo#99',
      'ABC-1',
      'ex/repo#5',
    ]);
    expect(keys('dev')).toEqual(['ex/repo#7', 'ABC-3']);
    type('ABC');
    expect(keys('dev')).toEqual(['ex/repo#7', 'ABC-3']);
    expect(
      [...section('dev').querySelectorAll('[data-dimmed]')].map(
        (item) => item.querySelector('a')?.title,
      ),
    ).toEqual(['ex/repo#7']);
  });

  it('calls no daemon route on a sort click', async () => {
    const d = daemon();
    mount(d);
    await settle();
    const calls: string[] = [];
    for (const name of Object.keys(d.routes) as (keyof typeof d.routes)[]) {
      const route = d.routes[name];
      d.routes[name] = (input) => {
        calls.push(name);
        return route(input);
      };
    }
    for (const id of ['dev', 'done']) {
      choose(id, 'Key');
      click(id, 1);
      choose(id, 'Manual');
      choose(id, 'Time');
    }
    await settle();
    expect(calls).toEqual([]);
  });
});
