// @vitest-environment happy-dom
// An active no-session inbox row opens its column's help on Who, choosing the row's project
// first when another one is shown; a column with no head opens the oldest waiting turn's task.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import {
  config,
  daemon,
  deferred,
  envelope,
  failure,
  never,
  policy,
  policyColumn,
  row,
  status,
  type Daemon,
} from './board-fixtures.ts';
import { all, mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();

// The Popover places itself from its anchor's box and hides when the anchor is out of view;
// happy-dom lays nothing out, so every box is one column head in a 1024x768 window.
beforeEach(() => {
  for (const [name, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const)
    Object.defineProperty(document.documentElement, name, { configurable: true, get: () => value });
  const box = { left: 100, right: 340, top: 20, bottom: 60, x: 100, y: 20, width: 240, height: 40 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...box,
    toJSON: () => box,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = Date.parse('2026-11-18T14:42:00.000Z');
const TASK = 'ex/repo#7';
const TASK_SEARCH = '?open=ex%2Frepo%237';
const ACTION =
  'start a session in Spur project orbit-qa, or take over its turns with board inbox ack';
const TEXT =
  'a qa: turns wait for a live session of Spur project orbit-qa; ' +
  'oldest T524 since 2026-11-18T13:06:00.000Z; 2 waiting, no live session for 14 min';
const ITEM = {
  id: 'I7',
  project: 'a',
  kind: 'board_observation',
  severity: 'attention',
  text: `${TEXT}: ${ACTION}`,
  action: ACTION,
  at: '2026-11-18T14:30:00.000Z',
  task: TASK,
};

const [projectA, projectB] = config.projects;
if (!projectA || !projectB) throw new Error('fixture config has two projects');
const column = (id: string, kind: string, name: string | null = null) => ({
  id,
  executor: { kind, name },
});
const CONFIG = {
  ...config,
  projects: [
    {
      ...projectA,
      columns: [
        column('todo', 'dispatcher'),
        column('dev', 'worker', 'stand-worker'),
        column('qa', 'orchestrator', 'orbit-qa'),
        column('done', 'dispatcher'),
      ],
    },
    projectB,
  ],
};
/** Project a's rows: #7 waits in QA, unless `qa` is false and QA is an empty spine. */
const rowsA = (qa = true) => [row('D-1', 'dev'), ...(qa ? [row(TASK, 'qa')] : [])];
const ROWS_B = [row('B-1', 'todo', { project: 'b' })];
const ANSWER = policy('a', [
  policyColumn('todo'),
  policyColumn('dev'),
  policyColumn('qa', {
    executor: {
      kind: 'orchestrator',
      project: 'orbit-qa',
      role: 'orchestrator',
      displayName: 'orbit-qa',
      session: null,
      text: 'A session of orbit-qa takes the turn.',
    },
  }),
  policyColumn('done'),
]);

type Route = Daemon['routes']['status.get'];
/** Serves the config, the inbox item, each project's rows and project a's column rules. */
const board = (a: Route = () => Promise.resolve(envelope(status(rowsA())))) => {
  const d = daemon();
  d.routes['config.get'] = () => Promise.resolve(envelope(CONFIG));
  d.routes['inbox.operator'] = () => Promise.resolve(envelope({ items: [ITEM], handled: [] }));
  d.routes['status.get'] = (input) =>
    input['project'] === 'b' ? Promise.resolve(envelope(status(ROWS_B))) : a(input);
  const describe = vi.fn((input: Record<string, unknown>) =>
    Promise.resolve(envelope(input['project'] === 'a' ? ANSWER : { projects: [] })),
  );
  d.routes['columns.describe'] = describe;
  return { d, describe };
};
/** Mounts with `shown` chosen and opens the inbox. */
const openInbox = async (d: Daemon, shown: 'a' | 'b' = 'a') => {
  mount(d, { 'board-project': shown }, () => NOW);
  await settle();
  const button = all('header button').find((b) => b.textContent.includes('inbox'));
  if (!button) throw new Error('no inbox button');
  press(button, 'click');
  await settle();
};
const clickRow = async () => {
  const found = document.querySelector('[data-inbox-id="I7"]');
  if (!found) throw new Error('no row I7');
  press(found, 'click');
  await settle();
};
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const label = (dialog: Element) =>
  document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent;
const labels = () => dialogs().map(label);
const help = () => {
  const found = dialogs().find((dialog) => label(dialog) === 'qa');
  if (!found) throw new Error('no qa help');
  return found;
};
const head = `.${styles.head ?? 'missing'}`;
const trigger = (id: string) => {
  const found = all('main button[aria-haspopup="dialog"]').find(
    (button) => button.closest(head)?.querySelector('h2, h3')?.textContent === id,
  );
  if (!found) throw new Error(`no trigger ${id}`);
  return found;
};
const oldestLink = () =>
  [...help().querySelectorAll('a')].find((link) =>
    link.textContent.startsWith('Oldest waiting turn'),
  );
const shownProject = () => document.querySelector('header button[aria-controls]')?.textContent;
const back = async (url: string) => {
  act(() => {
    history.replaceState(null, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await settle();
};

describe('inbox no-session row column help', () => {
  it('same project: the row opens qa help on Who', async () => {
    const { d, describe } = board();
    await openInbox(d);
    const reads = describe.mock.calls.length;
    await clickRow();
    expect(labels()).toEqual(['qa']);
    const who = help().querySelector('[role="tab"][aria-selected="true"]');
    expect(who?.textContent).toBe('Who');
    expect(help().textContent).toContain('No live session');
    expect(trigger('qa').getAttribute('aria-expanded')).toBe('true');
    expect(describe.mock.calls.length).toBe(reads + 1);
  });

  it('other project: switches to a, then opens qa help', async () => {
    const held = deferred();
    const { d } = board(() => held.promise);
    await openInbox(d, 'b');
    expect(shownProject()).toBe('b');
    await clickRow();
    expect(shownProject()).toBe('a');
    expect(dialogs()).toHaveLength(0);
    held.resolve(envelope(status(rowsA())));
    await settle();
    expect(labels()).toEqual(['qa']);
    expect(help().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Who');
    expect(trigger('qa').getAttribute('aria-expanded')).toBe('true');
  });

  it('scrolls the head into view', async () => {
    const { d } = board();
    await openInbox(d);
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    await clickRow();
    const qaHead = trigger('qa').closest(head);
    const calls = scroll.mock.contexts
      .map((context, index) => [context, scroll.mock.calls[index]] as const)
      .filter(([context]) => context === qaHead);
    expect(calls.map(([, args]) => args)).toEqual([[{ block: 'nearest', inline: 'nearest' }]]);
  });

  it.each([
    ['pending', never],
    ['failed', failure],
    ['ready', undefined],
  ])('Who links the oldest waiting task while the rules read is %s', async (state, read) => {
    const { d, describe } = board();
    await openInbox(d);
    if (read) describe.mockImplementation(read);
    await clickRow();
    const link = oldestLink();
    expect(link?.getAttribute('href')).toBe(TASK_SEARCH);
    expect(link?.textContent).toBe('Oldest waiting turn T524 on #7');
    // The link comes first in the Who tab, above the body in any state.
    const body = link?.parentElement?.nextElementSibling;
    expect(body?.textContent).toContain(
      state === 'failed'
        ? 'Could not read the column rules.'
        : state === 'ready'
          ? 'No live session'
          : '',
    );
    expect(body?.getAttribute('aria-busy')).toBe(state === 'pending' ? 'true' : null);
  });

  it('a plain click on the oldest link opens its task', async () => {
    const { d } = board();
    await openInbox(d);
    await clickRow();
    const link = oldestLink();
    if (!link) throw new Error('no oldest link');
    press(link, 'click');
    await settle();
    expect(location.search).toBe(TASK_SEARCH);
    expect(dialogs().at(-1)?.textContent).toContain('#7');
  });

  it('a later open from the trigger shows no oldest link', async () => {
    const { d } = board();
    await openInbox(d);
    await clickRow();
    expect(oldestLink()).toBeDefined();
    press(trigger('qa'), 'click');
    await settle();
    expect(dialogs()).toHaveLength(0);
    press(trigger('qa'), 'click');
    await settle();
    expect(labels()).toEqual(['qa']);
    expect(oldestLink()).toBeUndefined();
  });

  it('focus lands on Close and the panel stays', async () => {
    const { d } = board();
    await openInbox(d);
    await clickRow();
    await settle();
    await settle();
    expect(labels()).toEqual(['qa']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    expect(help().contains(document.activeElement)).toBe(true);
    expect(location.search).toBe('');
    expect(history.state).toBeNull();
  });

  it('spine in the shown project keeps the inbox and opens the task', async () => {
    const { d } = board(() => Promise.resolve(envelope(status(rowsA(false)))));
    await openInbox(d);
    await clickRow();
    expect(labels()).toEqual(['Inbox', expect.anything()]);
    expect(dialogs().at(-1)?.textContent).toContain('#7');
    expect(location.search).toBe(TASK_SEARCH);
    expect(history.state).toEqual({ inbox: true, project: 'a' });
  });

  it('spine after a switch opens the task from the board', async () => {
    const { d } = board(() => Promise.resolve(envelope(status(rowsA(false)))));
    await openInbox(d, 'b');
    await clickRow();
    expect(shownProject()).toBe('a');
    expect(dialogs()).toHaveLength(1);
    expect(labels()).not.toContain('Inbox');
    expect(dialogs()[0]?.textContent).toContain('#7');
    expect(location.search).toBe(TASK_SEARCH);
    expect(history.state).toBeNull();
  });

  it('a failed view after a switch drops the request', async () => {
    const { d } = board(failure);
    await openInbox(d, 'b');
    await clickRow();
    expect(shownProject()).toBe('a');
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).toContain('The board daemon does not answer.');
    d.routes['status.get'] = () => Promise.resolve(envelope(status(rowsA())));
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(trigger('qa').getAttribute('aria-expanded')).toBe('false');
    expect(dialogs()).toHaveLength(0);
  });

  it('Back reopens the inbox without help; Forward closes it', async () => {
    const { d } = board();
    await openInbox(d);
    await clickRow();
    expect(labels()).toEqual(['qa']);
    await back('/?open=inbox');
    expect(labels()).toEqual(['Inbox']);
    expect(trigger('qa').getAttribute('aria-expanded')).toBe('false');
    await back('/');
    expect(dialogs()).toHaveLength(0);
  });
});
