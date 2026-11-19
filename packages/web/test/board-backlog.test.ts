// @vitest-environment happy-dom
import { act } from 'react';
import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { createBoardData } from '../src/board/data.ts';
import { boardColumns, boardLayout } from '../src/board/model.ts';
import { config, daemon, envelope, failure, row, taskGet, type Daemon } from './board-fixtures.ts';
import {
  all,
  container,
  goOffline,
  mount,
  mountEachTest,
  one,
  press,
  remount,
  serve,
  settle,
} from './board-harness.ts';

mountEachTest();

/** The selector of a `Columns.module.css` class. */
const css = (name: string) => {
  const value = styles[name];
  if (value === undefined) throw new Error(`no class ${name}`);
  return `.${value}`;
};

/** A config column; Todo-group columns carry `group: 'todo'` as `config.get` sets it. */
const column = (id: string, grouped = false, kind = 'dispatcher') => ({
  id,
  executor: { kind, name: null },
  ...(grouped ? { group: 'todo' } : {}),
});
const [projectA, projectB] = config.projects;
if (!projectA || !projectB) throw new Error('fixture config has two projects');
const withColumns = (a: ReturnType<typeof column>[], b = a) => ({
  ...config,
  projects: [
    { ...projectA, columns: a },
    { ...projectB, columns: b },
  ],
});
const TWO = withColumns([
  column('todo', true),
  column('ready-for-dev', true),
  column('dev', false, 'worker'),
  column('done'),
]);
const THREE = withColumns([
  column('todo', true),
  column('triage', true),
  column('ready-for-dev', true),
  column('dev', false, 'worker'),
  column('done'),
]);
const ALONE = withColumns([
  column('todo', true),
  column('dev', false, 'worker'),
  column('review'),
  column('done'),
]);
const ROWS = [
  row('T-1', 'todo'),
  row('T-2', 'todo'),
  row('R-1', 'ready-for-dev'),
  row('D-1', 'dev'),
  row('X-1', 'done'),
];

const board = async (withConfig: unknown, rows: unknown[] = ROWS, storage = {}) => {
  const d = daemon();
  serve(d, rows, withConfig);
  const stored = mount(d, storage);
  await settle();
  return { d, stored };
};
const button = (label: string) => {
  const found = all('button').find((item) => item.textContent.includes(label));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${label}`);
  return found;
};
const group = () => one('main section[aria-labelledby]');
const toggle = () => {
  const found = group().querySelector('h2 button');
  if (!(found instanceof HTMLButtonElement)) throw new Error('no fold toggle');
  return found;
};
const band = () => one(`main ${css('groupHead')}`);
const text = (elements: Iterable<Element>) => [...elements].map((item) => item.textContent);
const sortGroups = () =>
  all('main [role="group"][aria-label^="Sort "]').map((item) => item.getAttribute('aria-label'));
const stack = () => group().querySelectorAll(css('stack'));
const sections = () => [...group().querySelectorAll(`section${css('groupSection')}`)];
const parts = () => group().querySelector(css('parts'));

describe('boardLayout', () => {
  const layout = (columns: ReturnType<typeof column>[]) =>
    boardLayout(
      boardColumns(
        browserOperations['config.get'].output.parse(withColumns(columns)).projects[0]?.columns ??
          [],
        [],
      ),
    ).map((item) => (item.kind === 'group' ? item.parts.map((part) => part.id) : item.column.id));

  it('groups a run of two or more adjacent columns of one group, and nothing else', () => {
    expect(layout([column('todo', true), column('dev')])).toEqual(['todo', 'dev']);
    expect(
      layout([
        column('todo', true),
        column('triage', true),
        column('ready-for-dev', true),
        column('dev'),
      ]),
    ).toEqual([['todo', 'triage', 'ready-for-dev'], 'dev']);
    expect(layout([column('todo', true), column('dev'), column('triage', true)])).toEqual([
      'todo',
      'dev',
      'triage',
    ]);
  });
});

describe('Backlog group', () => {
  it('two parts: one Backlog band over both parts with their total', async () => {
    await board(TWO);
    expect(all(`main ${css('groupHead')}`)).toHaveLength(1);
    expect(text(group().querySelectorAll('h2'))).toEqual(['Backlog']);
    expect(group().getAttribute('aria-labelledby')).toBe(group().querySelector('h2')?.id);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().hasAttribute('aria-controls')).toBe(false);
    expect(band().querySelector(css('count'))?.textContent).toBe('3');
    expect(text(group().querySelectorAll('h3'))).toEqual(['todo', 'ready-for-dev']);
    expect(text(all('main h2'))).toEqual(['Backlog', 'dev', 'done']);
  });

  it('three parts: the band totals all three in config order', async () => {
    await board(THREE);
    expect(text(group().querySelectorAll('h3'))).toEqual(['todo', 'triage', 'ready-for-dev']);
    expect(band().querySelector(css('count'))?.textContent).toBe('3');
  });

  it('todo alone: no band, a plain column or spine as before', async () => {
    await board(ALONE, [row('D-1', 'dev')]);
    expect(all('main section[aria-labelledby]')).toHaveLength(0);
    expect(all('main h3')).toHaveLength(0);
    expect(text(all('main h2'))).toEqual(['todo', 'dev', 'review', 'done']);
    expect(one('main section[title^="todo"]').title).toBe('todo: empty · dispatcher');
    remount();
    await board(ALONE);
    expect(text(all('main h2'))).toEqual(['todo', 'dev', 'review', 'done']);
    expect(sortGroups()).toEqual(['Sort todo', 'Sort dev', 'Sort done']);
  });

  it('unfolded parts: ordinary columns with their own sort, and an empty part is a spine', async () => {
    await board(THREE);
    expect(sortGroups()).toEqual(['Sort todo', 'Sort ready-for-dev', 'Sort dev', 'Sort done']);
    const spine = one('main section[title^="triage"]');
    expect(spine.title).toBe('triage: empty · manual');
    expect(spine.querySelector('h3')?.textContent).toBe('triage');
    expect(spine.textContent).toBe('0triage');
    expect(group().querySelectorAll('h2')).toHaveLength(1);
    const lines = [...group().querySelectorAll(css('execText'))];
    expect(text(lines)).toEqual(['manual', 'manual']);
    expect(text(all(`main ${css('execText')}`))).toEqual([
      'manual',
      'manual',
      'worker',
      'dispatcher',
    ]);
  });

  it('folded: one stack of a section per part, empty parts say so, cards still open and dim', async () => {
    await board(THREE);
    press(toggle(), 'click');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(group().hasAttribute('data-folded')).toBe(true);
    expect(stack()).toHaveLength(1);
    expect(parts()).toBeNull();
    expect(sections().map((section) => section.querySelector('h3')?.textContent)).toEqual([
      'todo',
      'triage',
      'ready-for-dev',
    ]);
    const [todo, triage] = sections();
    expect(triage?.textContent).toContain('empty');
    expect(triage?.querySelector('[role="group"]')).toBeNull();
    expect(sortGroups()).toEqual(['Sort todo', 'Sort ready-for-dev', 'Sort dev', 'Sort done']);
    expect(
      [...(todo?.querySelectorAll<HTMLAnchorElement>('a[href^="?open="]') ?? [])].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['?open=T-1', '?open=T-2']);
    act(() => {
      const input = one('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'T-2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(todo?.querySelectorAll('[data-dimmed]')).toHaveLength(1);
    expect(todo?.querySelector('[data-dimmed] a')?.getAttribute('title')).toBe('T-1');
    press(toggle(), 'click');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(stack()).toHaveLength(0);
    expect(parts()).not.toBeNull();
    expect(text(group().querySelectorAll('h3'))).toEqual(['todo', 'triage', 'ready-for-dev']);
  });

  it('all parts empty: the band shows 0 and still folds', async () => {
    await board(THREE, [row('D-1', 'dev'), row('X-1', 'done')]);
    expect(band().querySelector(css('count'))?.textContent).toBe('0');
    expect(group().querySelectorAll('section[title]')).toHaveLength(3);
    expect(sortGroups()).toEqual(['Sort dev', 'Sort done']);
    press(toggle(), 'click');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(sections().map((section) => section.querySelector('p')?.textContent)).toEqual([
      'empty',
      'empty',
      'empty',
    ]);
    expect(sortGroups()).toEqual(['Sort dev', 'Sort done']);
    press(toggle(), 'click');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('fold kept across reloads, per project, with no daemon call', async () => {
    const { d, stored } = await board(TWO);
    const calls: string[] = [];
    for (const name of Object.keys(d.routes) as (keyof Daemon['routes'])[]) {
      const route = d.routes[name];
      d.routes[name] = (input) => {
        calls.push(name);
        return route(input);
      };
    }
    press(toggle(), 'click');
    await settle();
    expect(calls).toEqual([]);
    expect(stored.get('board-fold:a:todo')).toBe('folded');
    remount();
    const reloaded = await board(TWO, ROWS, { 'board-fold:a:todo': 'folded' });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    const switcher = one('button[aria-controls]');
    expect(switcher.textContent).toBe('a');
    press(switcher, 'click');
    press(button('b · dispatcher'), 'click');
    await settle();
    expect(one('button[aria-controls]').textContent).toBe('b');
    expect(reloaded.stored.get('board-project')).toBe('b');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    remount();
    const again = await board(TWO, ROWS, { 'board-fold:a:todo': 'folded' });
    press(toggle(), 'click');
    expect(again.stored.get('board-fold:a:todo')).toBe('unfolded');
    remount();
    await board(TWO, ROWS, { 'board-fold:a:todo': 'bogus' });
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('falls back to unfolded when storage throws', () => {
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
    expect(broken.columnFold('a', 'todo')).toBe(false);
    expect(() => {
      broken.setColumnFold('a', 'todo', true);
    }).not.toThrow();
  });

  it('focus stays on the toggle across a fold and an unfold', async () => {
    await board(TWO);
    const target = toggle();
    act(() => {
      target.focus();
    });
    press(target, 'click');
    expect(document.activeElement).toBe(target);
    expect(target.isConnected).toBe(true);
    expect(target.getAttribute('aria-expanded')).toBe('false');
    press(target, 'click');
    expect(document.activeElement).toBe(target);
    expect(toggle()).toBe(target);
    expect(target.getAttribute('aria-expanded')).toBe('true');
  });

  it('folded card returns focus after the task view closes', async () => {
    const d = daemon();
    serve(d, ROWS, TWO);
    d.routes['task.get'] = () =>
      Promise.resolve(
        envelope(taskGet({ task: { ...taskGet().task, key: 'T-1', column: 'todo' } })),
      );
    mount(d);
    await settle();
    press(toggle(), 'click');
    const link = one(`main section${css('groupSection')} a[href^="?open="]`);
    act(() => {
      link.focus();
    });
    press(link, 'click');
    await settle();
    expect(location.search.startsWith('?open=')).toBe(true);
    const close = document.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (close === null) throw new Error('no task close button');
    press(close, 'click');
    await settle();
    expect(document.activeElement).toBe(link);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  // On a grouped config the group section carries no data-stale, so the `every main section is
  // stale` check of the plain-column tests does not hold here: the carriers are listed instead.
  it('stale in both modes: band head and every part dim once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d } = await board(THREE);
    d.routes['status.get'] = failure;
    await goOffline(d);
    const check = (expected: Element[]) => {
      const carriers = all('main [data-stale]');
      expect(new Set(carriers)).toEqual(new Set(expected));
      expect(carriers).toHaveLength(expected.length);
      expect(group().hasAttribute('data-stale')).toBe(false);
      for (const carrier of carriers) expect(carrier.querySelector('[data-stale]')).toBeNull();
    };
    const plain = () =>
      [...container().querySelectorAll('main > section')].filter((item) => item !== group());
    check([band(), ...(parts()?.children ?? []), ...plain()]);
    press(toggle(), 'click');
    expect(stack()[0]?.hasAttribute('data-stale')).toBe(false);
    check([band(), ...sections(), ...plain()]);
  });
});
