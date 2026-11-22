// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { focusRing, quiet } from '../src/ds/index.ts';
import { daemon, envelope, hello, type Daemon } from './board-fixtures.ts';
import { all, mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();

// The row is built from the entry's `noSession` fields (core `noSessionFields`); its text is
// core's and is read only when the fields are absent.
const NOW = Date.parse('2026-11-18T14:42:00.000Z');
const ACTION =
  'start a session in Spur project orbit-qa, or take over its turns with board inbox ack';
const HEAD = 'a qa: turns wait for a live session of Spur project orbit-qa';
const OLDEST = 'oldest T524 since 2026-11-18T13:06:00.000Z';
const TEXT = `${HEAD}; ${OLDEST}; 2 waiting, no live session for 14 min`;
const TASK = 'ex/repo#7';
const CLEARS = 'It clears itself when a session appears.';
const FIRST = 'The qa orchestrator is the Spur project orbit-qa, and it has no live session.';
/** The first sentence of a handled row: the outage is over. */
const PAST = 'The qa orchestrator, the Spur project orbit-qa, had no live session.';
const HANDLED_AT = '2026-11-18T14:41:00.000Z';

type Entry = Record<string, unknown>;
type Fields = Record<string, unknown>;
/** The fields of a handled entry: no `waiting` or `oldestAt`. */
const past = (extra: Fields = {}): Fields => ({
  project: 'a',
  column: 'qa',
  spurProject: 'orbit-qa',
  oldestTask: TASK,
  since: '2026-11-18T14:28:00.000Z',
  ...extra,
});
/** The fields of an open entry: two waiting, the oldest T524 since 13:06, 14 min. */
const fields = (extra: Fields = {}): Fields =>
  past({ waiting: 2, oldestTurn: 'T524', oldestAt: '2026-11-18T13:06:00.000Z', ...extra });
const entry = (id: string, noSession: Fields | undefined, extra: Entry = {}): Entry => ({
  id,
  project: 'a',
  kind: 'board_observation',
  severity: 'attention',
  text: `${TEXT}: ${ACTION}`,
  action: ACTION,
  at: '2026-11-18T14:30:00.000Z',
  task: TASK,
  ...(noSession === undefined ? {} : { noSession }),
  ...extra,
});
const open = (id = 'I7', extra: Fields = {}) => entry(id, fields(extra));

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
      {},
      `${FIRST} 2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.`,
      '1h 36m',
    ],
    [
      'one turn and one minute',
      { waiting: 1, since: '2026-11-18T14:41:00.000Z' },
      `${FIRST} 1 turn waits; the oldest, T524, for 1h 36m; no live session for 1 min.`,
      '1h 36m',
    ],
    [
      'count and minutes without the oldest turn',
      { oldestTurn: undefined, oldestAt: undefined },
      `${FIRST} 2 turns wait; no live session for 14 min.`,
      '12m',
    ],
    [
      'count and minutes without the oldest ring time',
      { oldestAt: undefined },
      `${FIRST} 2 turns wait; no live session for 14 min.`,
      '12m',
    ],
    ['no count, without a tail', { waiting: undefined, oldestAt: undefined }, FIRST, '12m'],
    [
      'a start after now as 0 min',
      { since: '2026-11-18T14:50:00.000Z' },
      `${FIRST} 2 turns wait; the oldest, T524, for 1h 36m; no live session for 0 min.`,
      '1h 36m',
    ],
  ])('renders the column, Spur project and %s', async (_, extra, description, at) => {
    const d = daemon();
    serveInbox(d, [entry('I7', JSON.parse(JSON.stringify(fields(extra))) as Fields)]);
    await openInbox(d);
    expect(lines('I7')).toEqual([`No session to ring for qa`, description, ACTION, CLEARS]);
    expect(row('I7').querySelector('strong')?.textContent).toBe('orbit-qa');
    expect(meta('I7')).toEqual(['a', 'board observation · attention', '#7', at]);
    expect(row('I7').querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('builds the row from the fields, not the text', async () => {
    const d = daemon();
    serveInbox(d, [
      entry('I7', fields({ column: 'review', spurProject: 'first-orch' }), {
        text: 'something else happened: done',
        action: 'done',
      }),
    ]);
    await openInbox(d);
    expect(lines('I7')).toEqual([
      'No session to ring for review',
      'The review orchestrator is the Spur project first-orch, and it has no live session. 2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.',
      'done',
      CLEARS,
    ]);
  });

  // The fixture's project a has no qa column, so the row has no column help and stays a link.
  it('opens the oldest waiting turn task over the inbox when the column is not configured', async () => {
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
    expect(location.search).toBe('?open=ex%2Frepo%237');
    expect(history.state).toEqual({ inbox: true, project: 'a' });
  });

  it('leaves the active list when a stream re-read handles it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const other = entry('I2', undefined, { project: 'b', task: null, text: 'Other observation' });
    serveInbox(d, [open(), other]);
    await openInbox(d);
    d.send(hello);
    await settle();
    expect(activeIds()).toEqual(['I7', 'I2']);
    expect(allCount()).toBe('All 2');
    // Cleared: core keeps the turn it was raised for, without the count and ring time.
    serveInbox(
      d,
      [other],
      [
        entry('I7', past({ oldestTurn: 'T524' }), {
          text: `${HEAD}; ${OLDEST}: ${ACTION}`,
          handledAt: HANDLED_AT,
        }),
      ],
    );
    await invalidate(d);
    expect(activeIds()).toEqual(['I2']);
    expect(allCount()).toBe('All 1');
    expect(handledIds()).toEqual(['I7']);
    expect(meta('I7')).toContain('Handled');
    expect(meta('I7').at(-1)).toBe('12m');
    expect(lines('I7')).toEqual([
      'Had no session to ring for qa',
      `${PAST} The oldest turn was T524.`,
    ]);
  });

  it('leaves out the oldest turn on a handled row without one', async () => {
    const d = daemon();
    serveInbox(d, [], [entry('I7', past(), { handledAt: HANDLED_AT })]);
    await openInbox(d);
    expect(handledIds()).toEqual(['I7']);
    expect(lines('I7')).toEqual(['Had no session to ring for qa', PAST]);
    expect(row('I7').tagName).toBe('A');
    expect(row('I7').getAttribute('href')).toBe('?open=ex%2Frepo%237');
  });

  it('leaves out the Spur project sentence on an active row without a Spur project', async () => {
    const d = daemon();
    const unnamed = fields();
    delete unnamed['spurProject'];
    serveInbox(d, [entry('I7', unnamed)]);
    await openInbox(d);
    expect(lines('I7')).toEqual([
      'No session to ring for qa',
      '2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.',
      ACTION,
      CLEARS,
    ]);
    expect(row('I7').querySelector('strong')).toBeNull();
  });

  it('leaves out the Spur project sentence and the action on a handled row without a Spur project', async () => {
    const d = daemon();
    const unnamed = past();
    delete unnamed['spurProject'];
    serveInbox(
      d,
      [],
      [
        entry('I7', { ...unnamed, oldestTurn: 'T524' }, { handledAt: HANDLED_AT }),
        entry('I8', unnamed, { handledAt: HANDLED_AT }),
      ],
    );
    await openInbox(d);
    expect(lines('I7')).toEqual(['Had no session to ring for qa', 'The oldest turn was T524.']);
    expect(lines('I8')).toEqual(['Had no session to ring for qa']);
    expect(row('I7').querySelector('strong')).toBeNull();
  });

  // An entry stored or served without the fields: its text is not read.
  it('keeps the generic row with its action for an active entry without the fields', async () => {
    const d = daemon();
    serveInbox(d, [entry('I7', undefined)]);
    await openInbox(d);
    expect(lines('I7')).toEqual([TEXT, ACTION]);
    expect(meta('I7').at(-1)).toBe('12m');
    expect(row('I7').querySelector('strong')).toBeNull();
  });

  it('keeps the generic row with its action for a handled entry without the fields', async () => {
    const d = daemon();
    const text = `${HEAD}; ${OLDEST}`;
    serveInbox(
      d,
      [],
      [
        entry('I7', undefined, { text: `${text}: ${ACTION}`, handledAt: HANDLED_AT }),
        entry('I8', undefined, { text: 'a qa: something else happened', handledAt: HANDLED_AT }),
      ],
    );
    await openInbox(d);
    expect(lines('I7')).toEqual([text, ACTION]);
    expect(lines('I8')).toEqual(['a qa: something else happened', ACTION]);
  });

  it('shows only the re-raised item when the oldest turn changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    serveInbox(d, [open('I7')]);
    await openInbox(d);
    d.send(hello);
    await settle();
    expect(activeIds()).toEqual(['I7']);
    // Core keeps one row per key: the open I9 hides the cleared I7 from handled.
    serveInbox(
      d,
      [open('I9', { waiting: 1, oldestTurn: 'T530', oldestAt: '2026-11-18T14:12:00.000Z' })],
      [],
    );
    await invalidate(d);
    expect(activeIds()).toEqual(['I9']);
    expect(handledIds()).toEqual([]);
    expect(lines('I9')[1]).toBe(
      `${FIRST} 1 turn waits; the oldest, T530, for 30m; no live session for 14 min.`,
    );
    expect(meta('I9').at(-1)).toBe('30m');
  });

  it('shows only the clears-itself line without an action', async () => {
    const d = daemon();
    const bare = open();
    delete bare['action'];
    serveInbox(d, [{ ...bare, text: TEXT }]);
    await openInbox(d);
    expect(lines('I7')).toEqual([
      'No session to ring for qa',
      `${FIRST} 2 turns wait; the oldest, T524, for 1h 36m; no live session for 14 min.`,
      CLEARS,
    ]);
  });
});
