// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { focusRing, quiet } from '../src/ds/index.ts';
import cardStyles from '../src/board/Card.module.css';
import taskStyles from '../src/board/TaskView.module.css';
import { config, daemon, envelope, problem, status, row, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, one, press, settle } from './board-harness.ts';

mountEachTest();
const NOW = Date.parse('2026-11-15T14:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
/** A why.moves entry into `to` as `task.get` returns it. */
const moveView = (to: string, at: string, kind = 'task_moved') => ({
  at,
  kind,
  actor: 'system',
  from: 'todo',
  to,
  reason: kind === 'task_corrected' ? 'corrected' : 'gate_passed',
  gate: [],
  text: kind === 'task_corrected' ? 'Operator correction' : null,
});
/** Opens `ex/repo#7` with the given why.moves and status row entry; returns the header facts. */
async function header(moves: unknown[], columnEnteredAt: string | null) {
  const d = daemon();
  d.routes['status.get'] = () =>
    Promise.resolve(envelope(status([row('ex/repo#7', 'dev', { columnEnteredAt })])));
  d.routes['task.get'] = () =>
    Promise.resolve(envelope(taskGet({ why: { ...taskGet().why, moves } })));
  mount(d, {}, () => NOW);
  await settle();
  press(one('main a[title="ex/repo#7"]'), 'click');
  await settle();
  const title = document.querySelector('[role="dialog"] [title="ex/repo#7"]');
  if (!title) throw new Error('missing header key');
  return {
    title,
    detail: title.parentElement?.nextElementSibling?.textContent,
    duration: document.querySelector(`.${taskStyles.duration ?? ''}`)?.textContent ?? null,
  };
}
it.each([
  { entered: 120, moves: [moveView('dev', ago(120))], duration: '2h' },
  {
    entered: 106,
    moves: [moveView('dev', ago(106)), moveView('dev', ago(3), 'task_corrected')],
    duration: '1h 46m',
  },
  { entered: 3, moves: [moveView('dev', ago(3))], duration: '3m' },
  { entered: null, moves: [moveView('dev', ago(120))], duration: null },
])(
  'header separates key, uppercase column and lowercase duration ($entered minutes in the row)',
  async ({ entered, moves, duration }) => {
    const facts = await header(moves, entered === null ? null : ago(entered));
    expect(facts.title.textContent).toBe('#7');
    expect(document.querySelector(`.${taskStyles.columnName ?? ''}`)?.textContent).toBe('DEV');
    expect(facts.detail).toBe(duration === null ? ' · DEV' : ` · DEV · ${duration}`);
    expect(facts.duration).toBe(duration);
  },
);
// The same 8 shapes as core's registry.test.ts column-entry table: why.moves as task.get
// returns it, the row with the entry status.get reports; the header follows the row in each.
const T = (hour: number) => ago((6 - hour) * 60);
it.each([
  { name: 'original add', moves: [], entered: 0, duration: '6h' },
  {
    name: 'two real moves',
    moves: [moveView('review', T(1)), moveView('dev', T(2))],
    entered: 2,
    duration: '4h',
  },
  {
    name: 'later shadow move',
    moves: [moveView('dev', T(1)), moveView('dev', T(2), 'task_shadow_moved')],
    entered: 1,
    duration: '5h',
  },
  {
    name: 'exit and return',
    moves: [moveView('dev', T(1)), moveView('review', T(2)), moveView('dev', T(3))],
    entered: 3,
    duration: '3h',
  },
  {
    name: 'real correction',
    moves: [moveView('dev', T(1)), moveView('dev', T(2), 'task_corrected')],
    entered: 2,
    duration: '4h',
  },
  {
    name: 'shadow correction',
    moves: [moveView('dev', T(1)), moveView('dev', T(2), 'task_corrected')],
    entered: 1,
    duration: '5h',
  },
  {
    name: 'journal order over timestamp',
    moves: [moveView('dev', T(3)), moveView('dev', T(1))],
    entered: 1,
    duration: '5h',
  },
  { name: 'reactivation preserves original add', moves: [], entered: 0, duration: '6h' },
])(
  'header time follows status columnEnteredAt for core entry shape: $name',
  async ({ moves, entered, duration }) => {
    const facts = await header(moves, T(entered));
    expect(facts.duration).toBe(duration);
    expect(facts.detail).toBe(` · DEV · ${duration}`);
  },
);
it('header and card count time in column to the status read, not to the clock at open', async () => {
  const d = daemon();
  d.routes['status.get'] = () =>
    Promise.resolve(envelope(status([row('ex/repo#7', 'dev', { columnEnteredAt: ago(106) })])));
  let clock = NOW;
  mount(d, {}, () => clock);
  await settle();
  // The status read answered at NOW; the task opens 10 minutes later with no new status read.
  clock = NOW + 10 * 60_000;
  press(one('main a[title="ex/repo#7"]'), 'click');
  await settle();
  const card = one(`main a[title="ex/repo#7"] .${cardStyles.entered ?? ''}`).textContent;
  const duration = document.querySelector(`.${taskStyles.duration ?? ''}`)?.textContent;
  expect(card).toBe('1h 46m');
  expect(duration).toBe(card);
});
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
    expect(cells.map((cell) => cell.getAttribute('data-kind'))).toEqual([
      'ticket',
      'pr',
      'session',
    ]);
    expect(cells.every((cell) => cell.classList.contains(taskStyles.link ?? ''))).toBe(true);
    expect(document.querySelector(`main .${taskStyles.link ?? ''}`)).toBeNull();
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
it('keeps semantic kinds on plain ticket, PR and session cells', async () => {
  const d = daemon();
  d.routes['task.get'] = () =>
    Promise.resolve(
      envelope(
        taskGet({
          links: [
            { kind: 'session', ref: 's1', role: 'worker' },
            { kind: 'pr', ref: 'repo#8', role: null },
            { kind: 'ticket', ref: 'ABC-3', role: null },
          ],
        }),
      ),
    );
  mount(d);
  await settle();
  press(one('main a[title="ex/repo#7"]'), 'click');
  await settle();
  const cells = [...document.querySelectorAll(`.${taskStyles.link ?? ''}`)];
  expect(
    cells.map((cell) => [cell.tagName, cell.getAttribute('data-kind'), cell.textContent]),
  ).toEqual([
    ['SPAN', 'ticket', 'ticket #7'],
    ['SPAN', 'ticket', 'ticket ABC-3'],
    ['SPAN', 'pr', 'PR repo#8'],
    ['SPAN', 'session', 'session s1'],
  ]);
  for (const cell of cells) {
    expect(cell.getAttribute('href')).toBeNull();
    expect(cell.getAttribute('tabindex')).toBeNull();
    expect(cell.getAttribute('title')).toBe(cell.textContent);
    expect(cell.classList.contains(focusRing)).toBe(false);
    expect(cell.querySelector('svg')).not.toBeNull();
  }
});
