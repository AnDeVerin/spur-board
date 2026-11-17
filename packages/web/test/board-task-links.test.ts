// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { focusRing, quiet } from '../src/ds/index.ts';
import cardStyles from '../src/board/Card.module.css';
import taskStyles from '../src/board/TaskView.module.css';
import { config, daemon, envelope, problem, status, row, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, one, press, settle } from './board-harness.ts';

mountEachTest();
it.each([
  [120, '2h'],
  [106, '1h 46m'],
  [3, '3m'],
  [null, null],
] as const)(
  'header separates key, uppercase column and lowercase duration (%s minutes)',
  async (minutes, duration) => {
    const d = daemon();
    const now = Date.parse('2026-11-15T14:00:00.000Z');
    const why = taskGet().why;
    d.routes['task.get'] = () =>
      Promise.resolve(
        envelope(
          taskGet({
            why: {
              ...why,
              moves:
                minutes === null
                  ? []
                  : [{ ...why.moves[0], at: new Date(now - minutes * 60_000).toISOString() }],
            },
          }),
        ),
      );
    mount(d, {}, () => now);
    await settle();
    press(one('main a[title="ex/repo#7"]'), 'click');
    await settle();
    const title = document.querySelector('[role="dialog"] [title="ex/repo#7"]');
    if (!title) throw new Error('missing header key');
    expect(title.textContent).toBe('#7');
    expect(document.querySelector(`.${taskStyles.columnName ?? ''}`)?.textContent).toBe('DEV');
    expect(title.parentElement?.nextElementSibling?.textContent).toBe(
      duration === null ? ' · DEV' : ` · DEV · ${duration}`,
    );
    expect(document.querySelector(`.${taskStyles.duration ?? ''}`)?.textContent ?? null).toBe(
      duration,
    );
  },
);
it('header retains the key tooltip without orphan separators when details are unavailable', async () => {
  const d = daemon();
  d.routes['task.get'] = () => problem('not_found');
  mount(d);
  await settle();
  press(one('main a[title="ex/repo#7"]'), 'click');
  await settle();
  const title = document.querySelector('[role="dialog"] [title="ex/repo#7"]');
  if (!title) throw new Error('missing header key');
  expect(title.textContent).toBe('#7');
  expect(title.parentElement?.nextElementSibling?.textContent).toBe('NowHistory');
});
it.each([true, false])(
  'renders ordered shared icon cells and full long labels; session linked %s',
  async (linked) => {
    const d = daemon();
    d.routes['config.get'] = () =>
      Promise.resolve(
        envelope({
          ...config,
          web: { ...config.web, spurUiOrigin: linked ? 'https://spur.example' : null },
        }),
      );
    const long = `session-${'long-'.repeat(60)}`;
    d.routes['status.get'] = () =>
      Promise.resolve(
        envelope(
          status([
            row('ex/repo#7', 'dev', {
              links: { ticket: 'https://observed.test/issues/7', prs: [], sessions: [] },
            }),
          ]),
        ),
      );
    d.routes['task.get'] = () =>
      Promise.resolve(
        envelope(
          taskGet({
            links: [
              { kind: 'session', ref: long, role: 'worker' },
              { kind: 'pr', ref: 'ex/repo#7', role: null },
            ],
          }),
        ),
      );
    mount(d);
    await settle();
    press(one('main a[title="ex/repo#7"]'), 'click');
    await settle();
    const cells = [
      ...(document
        .querySelector('[role="dialog"]')
        ?.querySelectorAll(`.${cardStyles.cell ?? ''}`) ?? []),
    ];
    expect(cells.map((cell) => cell.textContent)).toEqual([
      'ticket #7',
      'PR #7',
      `session ${long}`,
    ]);
    expect(cells.every((cell) => cell.querySelector('svg'))).toBe(true);
    expect(cells[0]?.getAttribute('href')).toBe('https://observed.test/issues/7');
    for (const cell of cells.slice(0, linked ? 3 : 2)) {
      expect(cell.getAttribute('target')).toBe('_blank');
      expect(cell.getAttribute('rel')).toBe('noopener noreferrer');
      expect(cell.classList.contains(focusRing)).toBe(true);
    }
    expect(cells[0]?.parentElement?.parentElement?.classList.contains(quiet)).toBe(true);
    expect(cells[2]?.tagName).toBe(linked ? 'A' : 'SPAN');
    if (linked) {
      expect(cells[2]?.getAttribute('aria-label')).toBe(`session ${long}, Spur session`);
      expect(cells[2]?.getAttribute('href')).toBe(`https://spur.example/sessions/${long}`);
    }
    expect(cells[2]?.getAttribute('tabindex')).toBeNull();
    expect(cells[2]?.getAttribute('title')).toBe(`session ${long}`);
  },
);
