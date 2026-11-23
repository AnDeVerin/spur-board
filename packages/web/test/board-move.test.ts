// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  deferred,
  envelope,
  failure,
  problem,
  row,
  status,
  taskGet,
  type Daemon,
} from './board-fixtures.ts';
import { all, goOffline, mountEachTest, one, press, remount, settle } from './board-harness.ts';
import {
  ALONE,
  board,
  field,
  form,
  forms,
  KEY,
  keysIn,
  link,
  MIRRORED,
  MIRRORED_ROWS,
  REFUSAL,
  ROWS,
  send,
  submit,
  THREE,
  type,
  wrap,
} from './board-move-helpers.ts';

mountEachTest();

const trigger = () => one('main button[aria-label="Move #1"]');
const items = () => all('main [role="menuitem"]');
/** Opens #1's card menu by click and chooses the item `label`. */
const choose = (label: string) => {
  press(trigger(), 'click');
  const item = items().find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`no menu item ${label}`);
  press(item, 'click');
};
const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no task view');
  return found;
};
const buttonIn = (root: ParentNode, text: string) => {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) throw new Error(`no button ${text}`);
  return found;
};
/** The task view of #1 in todo, unless `task` says otherwise. */
const withTask = (d: Daemon, task: Record<string, unknown> = {}) => {
  d.routes['task.get'] = () =>
    Promise.resolve(
      envelope(taskGet({ task: { ...taskGet().task, key: KEY, column: 'todo', ...task } })),
    );
};
const openTask = async (task: Record<string, unknown> = {}) => {
  history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
  return board(THREE, ROWS, (d) => {
    withTask(d, task);
  });
};
/** `ROWS` with #1 moved to the end of triage: the newest entry there. */
const MOVED = ROWS.map((task) =>
  task.key === KEY ? row(KEY, 'triage', { columnEnteredAt: '2026-11-15T14:00:00.000Z' }) : task,
);

describe('move between Backlog parts: the card menu', () => {
  it('card menu lists the other parts and opens the form', async () => {
    const { moves } = await board();
    press(trigger(), 'click');
    expect(items().map((item) => item.textContent)).toEqual([
      'Move to triage…',
      'Move to ready-for-dev…',
    ]);
    expect(all('main [role="separator"]')).toHaveLength(0);
    choose('Move to triage…');
    const open = form();
    expect(open.querySelector('label')?.textContent).toBe('Move #1 to triage: reason');
    expect(wrap(KEY).contains(open)).toBe(true);
    expect(open.closest('a, [draggable="true"]')).toBeNull();
    expect(document.activeElement).toBe(field());
    expect(send().textContent).toBe('Move to triage');
    expect(moves).toEqual([]);
    // Another choice replaces the form; Cancel closes it.
    choose('Move to ready-for-dev…');
    expect(forms()).toHaveLength(1);
    expect(form().querySelector('label')?.textContent).toBe('Move #1 to ready-for-dev: reason');
    press(buttonIn(form(), 'Cancel'), 'click');
    expect(forms()).toHaveLength(0);
    expect(moves).toEqual([]);
  });

  it('a mirrored part: the menu lists moves into and out of it disabled with the cause', async () => {
    const { moves } = await board(MIRRORED, MIRRORED_ROWS);
    press(trigger(), 'click');
    const menu = () => one('main [role="menu"]');
    expect(items().map((item) => item.textContent)).toEqual([
      'Move to triage…',
      'Move to ready-for-dev…',
    ]);
    const [triage, ready] = items();
    expect(triage?.hasAttribute('aria-disabled')).toBe(false);
    expect(triage?.hasAttribute('aria-describedby')).toBe(false);
    expect(ready?.getAttribute('aria-disabled')).toBe('true');
    const cause = document.getElementById(ready?.getAttribute('aria-describedby') ?? '');
    expect(cause?.textContent).toBe(REFUSAL);
    expect(menu().textContent).toBe(`Move to triage…Move to ready-for-dev…${REFUSAL}`);
    if (ready) press(ready, 'click');
    expect(forms()).toHaveLength(0);
    expect(menu()).toBeDefined();
    press(document.body, 'keydown', { key: 'Escape' });
    // Out of the mirrored part: every move is disabled, each with the cause.
    press(one('main button[aria-label="Move #4"]'), 'click');
    const out = items();
    expect(out.map((item) => item.textContent)).toEqual(['Move to todo…', 'Move to triage…']);
    for (const item of out) {
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(
        document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toBe(REFUSAL);
      press(item, 'click');
    }
    expect(forms()).toHaveLength(0);
    expect(moves).toEqual([]);
    press(document.body, 'keydown', { key: 'Escape' });
    // todo and triage still move between each other.
    choose('Move to triage…');
    expect(form().querySelector('label')?.textContent).toBe('Move #1 to triage: reason');
  });

  it('todo alone and other columns: no menu and no draggable wrap', async () => {
    await board(ALONE, [row(KEY, 'todo'), row('ex/repo#3', 'dev')]);
    expect(all('main button[aria-label^="Move "]')).toHaveLength(0);
    expect(all('main [draggable="true"]')).toHaveLength(0);
    expect(link(KEY).parentElement?.hasAttribute('draggable')).toBe(false);
  });

  it('a card outside the band has no menu', async () => {
    await board();
    expect(all('main button[aria-label="Move #3"]')).toHaveLength(0);
    expect(all('main button[aria-label="Move #2"]')).toHaveLength(1);
  });
});

describe('move between Backlog parts: the reason', () => {
  it('empty reason cannot be sent', async () => {
    const { moves } = await board();
    choose('Move to triage…');
    expect(send().disabled).toBe(true);
    submit();
    type(field(), '   ');
    expect(send().disabled).toBe(true);
    submit();
    await settle();
    expect(moves).toEqual([]);
    type(field(), 'x'.repeat(20_001));
    expect(send().disabled).toBe(false);
    submit();
    await settle();
    expect(one('main [role="alert"]').textContent).toBe(
      'Reason must be 20,000 characters or fewer.',
    );
    expect(moves).toEqual([]);
  });

  it('unavailable disables the send and keeps both hint lines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d, moves } = await board();
    await goOffline(d);
    choose('Move to triage…');
    type(field(), 'Groomed');
    expect(send().disabled).toBe(true);
    const hint = form().querySelector(
      `#${CSS.escape(field().getAttribute('aria-describedby') ?? '')}`,
    );
    expect(hint?.textContent).toBe(
      'Required. It goes to the task history. Live updates are lost. Moves cannot be sent.',
    );
    submit();
    await settle();
    expect(moves).toEqual([]);
  });
});

describe('move between Backlog parts: sending', () => {
  it('success moves the card to the end of the target', async () => {
    const { d, moves } = await board();
    choose('Move to triage…');
    type(field(), 'Groomed');
    const read = deferred();
    d.routes['status.get'] = () => read.promise;
    submit();
    await settle();
    expect(moves).toEqual([
      {
        input: { mode: 'manual', task: KEY, column: 'triage', reason: 'Groomed' },
        key: expect.any(String) as string,
      },
    ]);
    // Accepted, not read yet: the card stays and the form waits.
    expect(keysIn('todo')).toEqual([KEY]);
    expect(wrap(KEY).contains(form())).toBe(true);
    expect(send().getAttribute('aria-busy')).toBe('true');
    expect(send().textContent).toBe('Moving');
    expect(buttonIn(form(), 'Cancel').disabled).toBe(false);
    submit();
    await settle();
    expect(moves).toHaveLength(1);
    read.resolve(envelope(status(MOVED)));
    await settle();
    expect(keysIn('triage')).toEqual(['ex/repo#2', KEY]);
    expect(forms()).toHaveLength(0);
    expect(document.activeElement).toBe(link(KEY));
  });

  it.each([
    ['work_started', 'Resolve the open pull request or live worker before moving idle work.'],
    ['move_outside_todo_group', 'Pick enabled Todo-group columns in project a.'],
    ['task_archived', 'Add the task again before changing it.'],
  ])('each refusal shows its hint: %s', async (code, hint) => {
    const { d, moves } = await board();
    d.routes['task.move'] = () => problem(code, 409, hint);
    choose('Move to triage…');
    type(field(), 'Groomed');
    submit();
    await settle();
    expect(moves).toHaveLength(1);
    expect(one('main [role="alert"]').textContent).toBe(hint);
    expect(field().value).toBe('Groomed');
    expect(send().textContent).toBe('Move to triage');
    expect(send().hasAttribute('aria-busy')).toBe(false);
    expect(keysIn('todo')).toEqual([KEY]);
  });

  it('a resend keeps its key; an edited reason gets a new one', async () => {
    const { d, moves } = await board();
    d.routes['task.move'] = failure;
    choose('Move to triage…');
    type(field(), 'Groomed');
    submit();
    await settle();
    expect(one('main [role="alert"]').textContent).toBe(
      'Could not move the task. Send again to retry.',
    );
    submit();
    await settle();
    expect(moves).toHaveLength(2);
    expect(moves[1]?.key).toBe(moves[0]?.key);
    const held = deferred();
    d.routes['task.move'] = () => held.promise;
    type(field(), 'Groomed again');
    submit();
    submit();
    await settle();
    expect(moves).toHaveLength(3);
    expect(moves[2]?.key).not.toBe(moves[0]?.key);
    expect(moves[2]?.input['reason']).toBe('Groomed again');
  });
});

describe('move between Backlog parts: a fold', () => {
  const fold = () => {
    press(one('main section[aria-labelledby] h2 button'), 'click');
  };
  it('folded, the card menu lists the parts closest to Dev first; unfolded, config order', async () => {
    const { moves } = await board();
    const listed = () => {
      press(trigger(), 'click');
      const shown = items().map((item) => item.textContent);
      press(document.body, 'keydown', { key: 'Escape' });
      return shown;
    };
    expect(listed()).toEqual(['Move to triage…', 'Move to ready-for-dev…']);
    fold();
    expect(listed()).toEqual(['Move to ready-for-dev…', 'Move to triage…']);
    press(trigger(), 'click');
    const [first] = items();
    if (first) press(first, 'click');
    expect(form().querySelector('label')?.textContent).toBe('Move #1 to ready-for-dev: reason');
    press(buttonIn(form(), 'Cancel'), 'click');
    fold();
    expect(listed()).toEqual(['Move to triage…', 'Move to ready-for-dev…']);
    expect(moves).toEqual([]);
  });
  it('a fold keeps the reason, the pending send and the key', async () => {
    const { d, moves } = await board();
    d.routes['task.move'] = failure;
    choose('Move to triage…');
    type(field(), 'Groomed');
    submit();
    await settle();
    const held = deferred();
    d.routes['task.move'] = () => held.promise;
    fold();
    fold();
    expect(field().value).toBe('Groomed');
    submit();
    await settle();
    expect(send().textContent).toBe('Moving');
    fold();
    expect(field().value).toBe('Groomed');
    expect(send().textContent).toBe('Moving');
    expect(send().getAttribute('aria-busy')).toBe('true');
    submit();
    await settle();
    expect(moves).toHaveLength(2);
    // The held send fails after the fold: the folded form shows it and resends with the key.
    held.resolve(Response.json({ broken: true }, { status: 500 }));
    await settle();
    expect(one('main [role="alert"]').textContent).toBe(
      'Could not move the task. Send again to retry.',
    );
    d.routes['task.move'] = failure;
    submit();
    await settle();
    expect(moves).toHaveLength(3);
    expect(new Set(moves.map((body) => body.key)).size).toBe(1);
    expect(moves.map((body) => body.input['reason'])).toEqual(['Groomed', 'Groomed', 'Groomed']);
  });
});

describe('move between Backlog parts: the task view', () => {
  it('task view offers the move and moves the task', async () => {
    const { d, moves } = await openTask();
    const row = [...dialog().querySelectorAll('div')].find(
      (item) => item.firstElementChild?.textContent === 'Move to',
    );
    if (!row) throw new Error('no Move to row');
    expect([...row.querySelectorAll('button')].map((item) => item.textContent)).toEqual([
      'triage…',
      'ready-for-dev…',
    ]);
    press(buttonIn(row, 'triage…'), 'click');
    await settle();
    expect(form(dialog()).querySelector('label')?.textContent).toBe('Move #1 to triage: reason');
    expect(document.activeElement).toBe(field(dialog()));
    type(field(dialog()), 'Groomed');
    const read = deferred();
    d.routes['task.get'] = () => read.promise;
    submit(dialog());
    await settle();
    expect(moves.map((body) => body.input)).toEqual([
      { mode: 'manual', task: KEY, column: 'triage', reason: 'Groomed' },
    ]);
    expect(send(dialog()).textContent).toBe('Moving');
    expect(send(dialog()).getAttribute('aria-busy')).toBe('true');
    read.resolve(envelope(taskGet({ task: { ...taskGet().task, key: KEY, column: 'triage' } })));
    await settle();
    expect(forms(dialog())).toHaveLength(0);
    expect([...row.querySelectorAll('button')].map((item) => item.textContent)).toEqual([
      'todo…',
      'ready-for-dev…',
    ]);
    expect(document.activeElement).toBe(buttonIn(row, 'todo…'));
  });

  it.each([
    ['outside the group', { column: 'dev' }],
    ['archived', { membership: 'archived' }],
  ])('task view shows no move for a task %s', async (_name, task) => {
    await openTask(task);
    expect(dialog().textContent).not.toContain('Move to');
  });

  it('task view: mirrored part buttons disabled with the cause', async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    // ready-for-dev first, so the first part button after a move is a disabled one.
    const first = {
      ...MIRRORED,
      projects: MIRRORED.projects.map((entry) => ({
        ...entry,
        columns: [
          ...entry.columns.filter(({ id }) => id === 'ready-for-dev'),
          ...entry.columns.filter(({ id }) => id !== 'ready-for-dev'),
        ],
      })),
    };
    const { d, moves } = await board(first, MIRRORED_ROWS, (daemon) => {
      withTask(daemon);
    });
    const row = [...dialog().querySelectorAll('div')].find(
      (item) => item.firstElementChild?.textContent === 'Move to',
    );
    if (!row) throw new Error('no Move to row');
    const buttons = () => [...row.querySelectorAll('button')];
    expect(buttons().map((item) => [item.textContent, item.disabled])).toEqual([
      ['ready-for-dev…', true],
      ['triage…', false],
    ]);
    expect(row.lastElementChild?.textContent).toBe(REFUSAL);
    expect(row.lastElementChild?.tagName).toBe('SPAN');
    press(buttonIn(row, 'ready-for-dev…'), 'click');
    await settle();
    expect(forms(dialog())).toHaveLength(0);
    press(buttonIn(row, 'triage…'), 'click');
    await settle();
    type(field(dialog()), 'Groomed');
    const read = deferred();
    d.routes['task.get'] = () => read.promise;
    submit(dialog());
    await settle();
    expect(moves.map((body) => body.input)).toEqual([
      { mode: 'manual', task: KEY, column: 'triage', reason: 'Groomed' },
    ]);
    read.resolve(envelope(taskGet({ task: { ...taskGet().task, key: KEY, column: 'triage' } })));
    await settle();
    expect(buttons().map((item) => [item.textContent, item.disabled])).toEqual([
      ['ready-for-dev…', true],
      ['todo…', false],
    ]);
    expect(document.activeElement).toBe(buttonIn(row, 'todo…'));
    // A task in the mirrored part: every button disabled with the cause.
    remount();
    await board(MIRRORED, MIRRORED_ROWS, (daemon) => {
      withTask(daemon, { key: 'ex/repo#4', column: 'ready-for-dev' });
    });
    const out = [...dialog().querySelectorAll('div')].find(
      (item) => item.firstElementChild?.textContent === 'Move to',
    );
    expect(
      [...(out?.querySelectorAll('button') ?? [])].map((item) => [item.textContent, item.disabled]),
    ).toEqual([
      ['todo…', true],
      ['triage…', true],
    ]);
    expect(out?.lastElementChild?.textContent).toBe(REFUSAL);
  });

  it('task view shows no move with todo alone', async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    await board(ALONE, [row(KEY, 'todo')], (d) => {
      withTask(d);
    });
    expect(dialog().textContent).not.toContain('Move to');
  });
});

describe('move between Backlog parts: focus', () => {
  it('the reason field takes focus after the menu returns it to the trigger', async () => {
    await board();
    act(() => {
      trigger().focus();
    });
    choose('Move to ready-for-dev…');
    expect(document.activeElement).toBe(field());
  });
});
