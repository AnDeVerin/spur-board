// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { focusRing, quiet } from '../src/ds/index.ts';
import { daemon, envelope, hello, type Daemon } from './board-fixtures.ts';
import { all, mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();

// The texts follow core `turnsWithoutSession` and `noSessionText`; the two shapes core pins in
// doorbell.test.ts and operator-inbox-actions.test.ts are reused verbatim below.
const NOW = Date.parse('2026-11-18T14:42:00.000Z');
const ACTION =
  'start a session in Spur project orbit-qa, or take over its turns with board inbox ack';
const HEAD = 'a qa: turns wait for a live session of Spur project orbit-qa';
const OLDEST = 'oldest T524 since 2026-11-18T13:06:00.000Z';
const TASK = 'ex/repo#7';
const CLEARS = 'It clears itself when a session appears.';
const FIRST = 'The qa orchestrator is the Spur project orbit-qa, and it has no live session.';

type Entry = Record<string, unknown>;
const entry = (id: string, text: string, extra: Entry = {}): Entry => ({
  id,
  project: 'a',
  kind: 'board_observation',
  severity: 'attention',
  text: `${text}: ${ACTION}`,
  action: ACTION,
  at: '2026-11-18T14:30:00.000Z',
  task: TASK,
  ...extra,
});
/** Core's action when the column's config names its Spur project. */
const named = (spur: string) =>
  `start a session in Spur project ${spur}, or take over its turns with board inbox ack`;
const waiting = (count: number, minutes = 14) =>
  `${String(count)} waiting, no live session for ${String(minutes)} min`;
const open = (id = 'I7', count = 2, oldest = OLDEST) =>
  entry(id, `${HEAD}; ${oldest}; ${waiting(count)}`);

const serveInbox = (d: Daemon, items: Entry[], handled: Entry[] = []) => {
  d.routes['inbox.operator'] = () => Promise.resolve(envelope({ items, handled }));
};
const openInbox = async (d: Daemon) => {
  mount(d, {}, () => NOW);
  await settle();
  const button = all('button').find((b) => b.textContent.includes('inbox'));
  if (!button) throw new Error('no inbox button');
  press(button, 'click');
  await settle();
};
const row = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-inbox-id="${id}"]`);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
/** The meta line's parts, then each line of the row below it, by text. */
const meta = (id: string) =>
  [...(row(id).firstElementChild?.children ?? [])].map((part) => part.textContent);
const lines = (id: string) => [...row(id).children].slice(1).map((line) => line.textContent);
const ids = (selector: string) =>
  [...(document.querySelector(selector)?.querySelectorAll<HTMLElement>('[data-inbox-id]') ?? [])]
    .map((element) => element.dataset['inboxId'])
    .filter((id) => id !== undefined);
const activeIds = () => ids('[role="dialog"] [role="tabpanel"] > div');
const handledIds = () => ids('section[aria-label="Recently handled"]');
const allCount = () =>
  document.querySelector('[role="tab"][aria-label^="All "]')?.getAttribute('aria-label');
const invalidate = async (d: Daemon) => {
  d.send('event: invalidate\ndata: {"projects":["a"],"tasks":[]}\n\n');
  await settle();
  await vi.advanceTimersByTimeAsync(400);
  await settle();
};

describe('inbox no-session item', () => {
  it.each([
    [
      'count, oldest and minutes',
      `${HEAD}; ${OLDEST}; ${waiting(2)}`,
      `${FIRST} 2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.`,
      '1h 36m',
    ],
    [
      'one turn and one minute',
      `${HEAD}; ${OLDEST}; ${waiting(1, 1)}`,
      `${FIRST} 1 turn waits; the oldest, T524, for 1h 36m; no live session for 1 min.`,
      '1h 36m',
    ],
    [
      'count and minutes',
      `${HEAD}; ${waiting(2)}`,
      `${FIRST} 2 turns wait; no live session for 14 min.`,
      '12m',
    ],
    [
      'oldest only',
      `${HEAD}; ${OLDEST}`,
      `${FIRST} The oldest turn, T524, waits for 1h 36m.`,
      '1h 36m',
    ],
    ['neither', HEAD, FIRST, '12m'],
  ])('renders the column, Spur project and %s', async (_, text, description, at) => {
    const d = daemon();
    serveInbox(d, [entry('I7', text)]);
    await openInbox(d);
    expect(lines('I7')).toEqual([`No session to ring for qa`, description, ACTION, CLEARS]);
    expect(row('I7').querySelector('strong')?.textContent).toBe('orbit-qa');
    expect(meta('I7')).toEqual(['a', 'board observation · attention', '#7', at]);
    expect(row('I7').querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('opens the oldest waiting turn task and keeps Close', async () => {
    const d = daemon();
    serveInbox(d, [open()]);
    await openInbox(d);
    const link = row('I7');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('?open=ex%2Frepo%237');
    expect(link.className).toContain(focusRing);
    expect(link.className).toContain(quiet);
    const closes = [...document.querySelectorAll('button')].map((b) => b.textContent);
    expect(closes).toContain('Close I7');
    press(link, 'click');
    await settle();
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    expect(dialogs).toHaveLength(2);
    expect(dialogs.at(-1)?.textContent).toContain('#7');
  });

  it('leaves the active list when a stream re-read handles it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const other = entry('I2', 'Other observation', { project: 'b', task: null });
    serveInbox(d, [open(), other]);
    await openInbox(d);
    d.send(hello);
    await settle();
    expect(activeIds()).toEqual(['I7', 'I2']);
    expect(allCount()).toBe('All 2');
    // Cleared: core keeps the stored text, with no waiting clause.
    serveInbox(
      d,
      [other],
      [{ ...entry('I7', `${HEAD}; ${OLDEST}`), handledAt: '2026-11-18T14:41:00.000Z' }],
    );
    await invalidate(d);
    expect(activeIds()).toEqual(['I2']);
    expect(allCount()).toBe('All 1');
    expect(handledIds()).toEqual(['I7']);
    expect(meta('I7')).toContain('Handled');
    expect(meta('I7').at(-1)).toBe('12m');
    expect(lines('I7')).toEqual([
      'No session to ring for qa',
      `${FIRST} The oldest turn was T524.`,
    ]);
  });

  it('leaves out the oldest turn on a handled row without an oldest clause', async () => {
    const d = daemon();
    serveInbox(d, [], [{ ...entry('I7', HEAD), handledAt: '2026-11-18T14:41:00.000Z' }]);
    await openInbox(d);
    expect(handledIds()).toEqual(['I7']);
    expect(lines('I7')).toEqual(['No session to ring for qa', FIRST]);
  });

  it('shows only the re-raised item when the oldest turn changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    serveInbox(d, [open('I7')]);
    await openInbox(d);
    d.send(hello);
    await settle();
    expect(activeIds()).toEqual(['I7']);
    const later = 'oldest T530 since 2026-11-18T14:12:00.000Z';
    // Core keeps one row per key: the open I9 hides the cleared I7 from handled.
    serveInbox(d, [open('I9', 1, later)], []);
    await invalidate(d);
    expect(activeIds()).toEqual(['I9']);
    expect(handledIds()).toEqual([]);
    expect(lines('I9')[1]).toBe(
      `${FIRST} 1 turn waits; the oldest, T530, for 30m; no live session for 14 min.`,
    );
    expect(meta('I9').at(-1)).toBe('30m');
  });

  it('leaves out clauses it does not know, after a known one', async () => {
    const d = daemon();
    serveInbox(d, [
      open('I7'),
      entry('I8', `${HEAD}; ${OLDEST}; future thing 3; ${waiting(2)}; future thing 3`),
    ]);
    await openInbox(d);
    expect(lines('I8')).toEqual(lines('I7'));
    expect(meta('I8')).toEqual(meta('I7'));
    expect(row('I8').textContent).not.toContain('future thing');
  });

  it('reads the core-pinned shapes: the operator-inbox text and the stored summary', async () => {
    const d = daemon();
    const first = 'first review: turns wait for a live session of Spur project first-orch';
    const action =
      'start a session in Spur project first-orch, or take over its turns with board inbox ack';
    serveInbox(d, [
      {
        ...entry('I1', `${first}; 2 waiting, no live session for 14 min`),
        project: 'first',
        text: `${first}; 2 waiting, no live session for 14 min: ${action}`,
        action,
      },
      {
        ...entry('I2', ''),
        project: 'proj',
        text: 'proj dev: turns wait for a live session of Spur project qa; oldest T1 since 2026-11-18T14:00:00.000Z',
        action: named('qa'),
      },
    ]);
    await openInbox(d);
    expect(lines('I1')).toEqual([
      'No session to ring for review',
      'The review orchestrator is the Spur project first-orch, and it has no live session. 2 turns wait; no live session for 14 min.',
      action,
      CLEARS,
    ]);
    expect(meta('I1').at(-1)).toBe('12m');
    // The entry's action does not end its text, so it stays a separate line.
    expect(lines('I2')).toEqual([
      'No session to ring for dev',
      'The dev orchestrator is the Spur project qa, and it has no live session. The oldest turn, T1, waits for 42m.',
      named('qa'),
      CLEARS,
    ]);
    expect(meta('I2').at(-1)).toBe('42m');
  });

  it.each([
    ['the head alone', HEAD, '12m'],
    ['an oldest clause that is not a date', `${HEAD}; oldest T5 since not-a-date`, '12m'],
  ])('reads %s without the missing sentences', async (_, text, at) => {
    const d = daemon();
    serveInbox(d, [entry('I7', text)]);
    await openInbox(d);
    expect(lines('I7')).toEqual(['No session to ring for qa', FIRST, ACTION, CLEARS]);
    expect(meta('I7').at(-1)).toBe(at);
  });

  it('shows only the clears-itself line without an action', async () => {
    const d = daemon();
    const bare = open();
    delete bare['action'];
    serveInbox(d, [{ ...bare, text: `${HEAD}; ${OLDEST}; ${waiting(2)}` }]);
    await openInbox(d);
    expect(lines('I7')).toEqual([
      'No session to ring for qa',
      `${FIRST} 2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.`,
      CLEARS,
    ]);
  });

  it.each([
    ['a project that is not the entry project', { project: 'b' }, `${HEAD}; ${OLDEST}`],
    ['another board observation', {}, 'a qa: something else happened'],
    ['another kind', { kind: 'worker_ended' }, `${HEAD}; ${OLDEST}`],
  ])('keeps the generic row for %s', async (_, extra, text) => {
    const d = daemon();
    serveInbox(d, [entry('I7', text, extra)]);
    await openInbox(d);
    expect(lines('I7')).toEqual([text, ACTION]);
    expect(meta('I7').at(-1)).toBe('12m');
  });

  const unnamed =
    'start a session in its Spur project, or take over its turns with board inbox ack';
  const next = '; future thing 3';
  const withOldest = 'QA; oldest T9 since 2026-11-18T13:06:00.000Z';
  const withWaiting = 'QA; 3 waiting, no live session for 5 min';
  // The name boundary: stored name, action, the name read (undefined: generic row), and a
  // clause put directly after the stored name, before the known ones.
  it.each([
    ['a plain name and a named action', 'orbit-qa', named('orbit-qa'), 'orbit-qa', ''],
    ['a plain name and an action naming no project', 'orbit-qa', unnamed, 'orbit-qa', ''],
    ['a plain name and no action', 'orbit-qa', undefined, 'orbit-qa', ''],
    ['a name holding "; " and a named action', 'QA; West', named('QA; West'), undefined, ''],
    ['a name holding "; " and an action naming no project', 'QA; West', unnamed, undefined, ''],
    ['a name holding "; " and no action', 'QA; West', undefined, undefined, ''],
    [
      'a name holding an oldest clause and a named action',
      withOldest,
      named(withOldest),
      undefined,
      '',
    ],
    ['a name holding an oldest clause and no action', withOldest, undefined, undefined, ''],
    [
      'a name holding an oldest clause and an action naming its prefix',
      withOldest,
      named('QA'),
      undefined,
      '',
    ],
    [
      'a name holding an oldest clause and an action naming no project',
      withOldest,
      unnamed,
      undefined,
      '',
    ],
    [
      'a name holding a waiting clause and a named action',
      withWaiting,
      named(withWaiting),
      undefined,
      '',
    ],
    // A renamed column: handled text from core never holds a waiting clause of its own.
    [
      'a name holding a waiting clause and an action naming its prefix',
      withWaiting,
      named('QA'),
      undefined,
      '',
    ],
    [
      'a name holding a waiting clause and an action naming no project',
      withWaiting,
      unnamed,
      undefined,
      '',
    ],
    ['a name holding a waiting clause and no action', withWaiting, undefined, undefined, ''],
    ['an action naming a prefix of the stored name', 'QA; West', named('QA'), undefined, ''],
    ['an action naming another project', 'orbit-qa', named('other'), undefined, ''],
    ['a named action and an unknown clause next', 'orbit-qa', named('orbit-qa'), undefined, next],
    ['no action and an unknown clause next', 'orbit-qa', undefined, undefined, next],
  ])('reads the Spur project with %s', async (_, spur, action, expects, after) => {
    const d = daemon();
    const head = `a qa: turns wait for a live session of Spur project ${spur}${after}`;
    const activeText = `${head}; ${OLDEST}; ${waiting(2)}`;
    const handledText = `${head}; ${OLDEST}`;
    const make = (id: string, text: string, extra: Entry = {}) => {
      const made: Entry = {
        ...entry(id, ''),
        text: action === undefined ? text : `${text}: ${action}`,
      };
      delete made['action'];
      return { ...made, ...(action === undefined ? {} : { action }), ...extra };
    };
    serveInbox(
      d,
      [make('I7', activeText)],
      [make('I8', handledText, { handledAt: '2026-11-18T14:41:00.000Z' })],
    );
    await openInbox(d);
    const first = `The qa orchestrator is the Spur project ${expects ?? ''}, and it has no live session.`;
    const actions = action === undefined ? [] : [action];
    const [active, handled] =
      expects === undefined
        ? [
            [activeText, ...actions],
            [handledText, ...actions],
          ]
        : [
            [
              'No session to ring for qa',
              `${first} 2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.`,
              ...actions,
              CLEARS,
            ],
            ['No session to ring for qa', `${first} The oldest turn was T524.`],
          ];
    expect(lines('I7')).toEqual(active);
    expect(lines('I8')).toEqual(handled);
    for (const id of ['I7', 'I8'])
      expect(row(id).querySelector('strong')?.textContent).toBe(expects);
  });
});
