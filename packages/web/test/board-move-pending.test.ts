// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import styles from '../src/board/Columns.module.css';
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
import { all, mountEachTest, one, press, settle } from './board-harness.ts';
import {
  board,
  field,
  KEY,
  link,
  part,
  forms,
  keysIn,
  ROWS,
  send,
  submit,
  THREE,
  type,
} from './board-move-helpers.ts';

mountEachTest();

const PENDING = 'This task is already being moved. Wait until the Board shows it.';
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
/** Opens the card menu of `name` and chooses `label`. */
const choose = (name: string, label: string) => {
  press(one(`main button[aria-label="Move ${name}"]`), 'click');
  const item = all('main [role="menuitem"]').find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`no menu item ${label}`);
  press(item, 'click');
};
const drag = (target: Element, kind: string) => {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: new DataTransfer() });
  act(() => {
    target.dispatchEvent(event);
  });
};
const fold = () => {
  press(one('main section[aria-labelledby] h2 button'), 'click');
};
/** Sends `reason` from the form the board shows under #1's card. */
const sendOnCard = (reason: string) => {
  type(field(one('main')), reason);
  submit(one('main'));
};
/** Opens #1's task view by its card and sends `reason` to triage there. */
const sendInView = async (reason: string) => {
  press(link(KEY), 'click');
  await settle();
  press(buttonIn(dialog(), 'triage…'), 'click');
  type(field(dialog()), reason);
  submit(dialog());
  await settle();
};
const viewOf = (task: Record<string, unknown> = {}) =>
  envelope(taskGet({ task: { ...taskGet().task, key: KEY, column: 'todo', ...task } }));
const withTask = (d: Daemon, task: Record<string, unknown> = {}) => {
  d.routes['task.get'] = () => Promise.resolve(viewOf(task));
};
/** Chooses `part` in the open task view and sends `reason`. */
const sendFromView = async (to: string, reason: string) => {
  press(buttonIn(dialog(), `${to}…`), 'click');
  type(field(dialog()), reason);
  submit(dialog());
  await settle();
};
const viewAlert = () => dialog().querySelector('[role="alert"]')?.textContent;
const openView = async () => {
  press(link(KEY), 'click');
  await settle();
};
const MOVED = ROWS.map((task) =>
  task.key === KEY ? row(KEY, 'triage', { columnEnteredAt: '2026-11-15T14:00:00.000Z' }) : task,
);

/**
 * The hold's lifecycle: each row starts from a mounted board and returns the recorded bodies'
 * keys it expects, in order.
 */
const LIFECYCLE: Record<string, () => Promise<{ keys: string[]; expected: string[] }>> = {
  'a retry after a failure holds the task again': async () => {
    const { d, moves } = await board(THREE, ROWS, withTask);
    d.routes['task.move'] = failure;
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    d.routes['task.move'] = () => deferred().promise;
    submit(one('main'));
    await settle();
    await openView();
    await sendFromView('triage', 'Other');
    expect(viewAlert()).toBe(PENDING);
    const keys = moves.map((body) => body.key);
    return { keys, expected: [keys[0] ?? 'card', keys[0] ?? 'card'] };
  },
  'a waiting form sends once the hold is free': async () => {
    const held = deferred();
    const { d, moves } = await board(THREE, ROWS, (daemon) => {
      withTask(daemon);
      daemon.routes['task.move'] = () => held.promise;
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    await openView();
    await sendFromView('triage', 'Other');
    expect(viewAlert()).toBe(PENDING);
    d.routes['task.move'] = failure;
    held.resolve(Response.json({ broken: true }, { status: 500 }));
    await settle();
    submit(dialog());
    await settle();
    expect(moves.map((body) => body.input['reason'])).toEqual(['Groomed', 'Other']);
    const keys = moves.map((body) => body.key);
    return { keys: [...new Set(keys)], expected: keys };
  },
  'a status read alone keeps the hold while the open view is stale': async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    const { d, moves } = await board(THREE, ROWS, withTask);
    const read = deferred();
    d.routes['status.get'] = () => read.promise;
    d.routes['task.get'] = () => deferred().promise;
    await sendFromView('triage', 'Groomed');
    // The status read lands after the accept; the open view still reads the task in todo.
    read.resolve(envelope(status(MOVED)));
    await settle();
    expect(keysIn('triage')).toContain(KEY);
    press(buttonIn(dialog(), 'Cancel'), 'click');
    await sendFromView('triage', 'Groomed');
    const keys = moves.map((body) => body.key);
    return { keys, expected: [keys[0] ?? 'view'] };
  },
  'a move back in one view, before the board row follows, still settles': async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    // The daemon moves the task and reads it where it is; the board row stays in todo.
    let column = 'todo';
    const { moves } = await board(THREE, ROWS, (daemon) => {
      daemon.routes['task.get'] = () => Promise.resolve(viewOf({ column }));
      daemon.routes['task.move'] = (input) => {
        const from = column;
        column = String(input['column']);
        return Promise.resolve(
          envelope({
            task: { ...taskGet().task, key: KEY, column },
            from,
            to: column,
            column,
            settled: [],
          }),
        );
      };
    });
    await sendFromView('triage', 'Groomed');
    await sendFromView('todo', 'Back');
    await sendFromView('ready-for-dev', 'Next');
    expect(viewAlert()).toBeUndefined();
    expect(moves.map((body) => body.input['column'])).toEqual(['triage', 'todo', 'ready-for-dev']);
    const keys = moves.map((body) => body.key);
    return { keys: [...new Set(keys)], expected: keys };
  },
  'a move to the part the task is already in frees the task': async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    // A stale view reads todo; the task is in triage, so the daemon's new visit leaves triage.
    let column = 'todo';
    const { moves } = await board(THREE, ROWS, (daemon) => {
      daemon.routes['task.get'] = () => Promise.resolve(viewOf({ column }));
      daemon.routes['task.move'] = (input) => {
        column = String(input['column']);
        return Promise.resolve(
          envelope({
            task: { ...taskGet().task, key: KEY, column },
            from: column,
            to: column,
            column,
            settled: [],
          }),
        );
      };
    });
    await sendFromView('triage', 'Groomed');
    await sendFromView('ready-for-dev', 'Next');
    expect(viewAlert()).toBeUndefined();
    expect(moves.map((body) => body.input['column'])).toEqual(['triage', 'ready-for-dev']);
    const keys = moves.map((body) => body.key);
    return { keys: [...new Set(keys)], expected: keys };
  },
  'a task of another project settles on its task view': async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    const { d, moves } = await board(
      THREE,
      ROWS.filter((task) => task.key !== KEY),
      (daemon) => {
        withTask(daemon, { project: 'b' });
      },
    );
    withTask(d, { project: 'b', column: 'triage' });
    await sendFromView('triage', 'Groomed');
    expect(forms(dialog())).toHaveLength(0);
    await sendFromView('ready-for-dev', 'Next');
    expect(viewAlert()).toBeUndefined();
    expect(moves.map((body) => body.input['column'])).toEqual(['triage', 'ready-for-dev']);
    const keys = moves.map((body) => body.key);
    return { keys: [...new Set(keys)], expected: keys };
  },
};

/**
 * `task.get` for the task view (with `why`) answers the view's column; the board's own read of
 * the task after a send (no `why`) answers `held`, or never.
 */
const reads = (d: Daemon, view = 'todo', held: string | null = null) => {
  d.routes['task.get'] = (input) =>
    input['why'] === true || held !== null
      ? Promise.resolve(viewOf({ column: input['why'] === true ? view : held }))
      : deferred().promise;
};
const lost = () => Promise.resolve(Response.json({ broken: true }, { status: 500 }));
const closeView = async () => {
  const close = dialog().querySelector('button[aria-label="Close"]');
  if (!close) throw new Error('no Close');
  press(close, 'click');
  await settle();
};

/** Moves whose outcome is not known yet; each row returns the bodies and whether a new key may follow. */
const UNKNOWN: Record<string, () => Promise<{ keys: string[]; fresh: boolean }>> = {
  'a lost reply, then a retry from the same card form': async () => {
    const { moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon);
      daemon.routes['task.move'] = lost;
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    submit(one('main'));
    await settle();
    expect(moves).toHaveLength(2);
    return { keys: moves.map((body) => body.key), fresh: false };
  },
  'a lost reply, then a retry from the task view': async () => {
    const { moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon);
      daemon.routes['task.move'] = lost;
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    await sendInView('Groomed');
    expect(moves).toHaveLength(2);
    await sendFromViewAgain('Other');
    expect(viewAlert()).toBe(PENDING);
    expect(moves).toHaveLength(2);
    return { keys: moves.map((body) => body.key), fresh: false };
  },
  'a lost reply, then a retry from a reopened card form': async () => {
    const { moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon);
      daemon.routes['task.move'] = lost;
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    press(buttonIn(one('main'), 'Cancel'), 'click');
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    expect(moves).toHaveLength(2);
    return { keys: moves.map((body) => body.key), fresh: false };
  },
  'a daemon 500 problem, then a retry from a reopened card form': async () => {
    const { moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon);
      daemon.routes['task.move'] = () => problem('unexpected', 500, 'Retry the same request.');
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    press(buttonIn(one('main'), 'Cancel'), 'click');
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    expect(moves).toHaveLength(2);
    return { keys: moves.map((body) => body.key), fresh: false };
  },
  'a reopened task view reads the source while the board row shows the target': async () => {
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    const { d, moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon, 'todo', 'todo');
    });
    const read = deferred();
    d.routes['status.get'] = () => read.promise;
    await sendFromView('triage', 'Groomed');
    // Closed during the move; the board row then shows the target before the view reopens.
    await closeView();
    read.resolve(envelope(status(MOVED)));
    await settle();
    expect(keysIn('triage')).toContain(KEY);
    await openView();
    await sendFromView('triage', 'Groomed');
    expect(moves).toHaveLength(1);
    return { keys: moves.map((body) => body.key), fresh: false };
  },
  'a lost reply whose task read shows the source frees the task': async () => {
    const { moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon, 'todo', 'todo');
      daemon.routes['task.move'] = lost;
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    await sendInView('Other');
    expect(viewAlert()).not.toBe(PENDING);
    expect(moves).toHaveLength(2);
    return { keys: moves.map((body) => body.key), fresh: true };
  },
  'a definite refusal frees the task at once': async () => {
    const { moves } = await board(THREE, ROWS, (daemon) => {
      reads(daemon);
      daemon.routes['task.move'] = () => problem('work_started', 409, 'Resolve it.');
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    await sendInView('Other');
    expect(moves).toHaveLength(2);
    return { keys: moves.map((body) => body.key), fresh: true };
  },
};
/** In the open task view, Cancel the form and send `reason` to triage again. */
const sendFromViewAgain = async (reason: string) => {
  press(buttonIn(dialog(), 'Cancel'), 'click');
  await sendFromView('triage', reason);
};

const FIRST: Record<string, () => void> = {
  'card menu': () => {
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
  },
  drop: () => {
    drag(link(KEY), 'dragstart');
    const body = part('triage').querySelector(`.${styles['body'] ?? ''}`);
    if (!body) throw new Error('no triage body');
    drag(body, 'dragover');
    drag(body, 'drop');
    drag(link(KEY), 'dragend');
    sendOnCard('Groomed');
  },
  'card form after a fold': () => {
    choose('#1', 'Move to triage…');
    type(field(one('main')), 'Groomed');
    fold();
    fold();
    submit(one('main'));
  },
};

describe('move between Backlog parts: the hold of a move', () => {
  it.each(Object.keys(LIFECYCLE))('%s', async (name) => {
    const result = await LIFECYCLE[name]?.();
    expect(result?.keys).toEqual(result?.expected);
  });
});

describe('move between Backlog parts: a move whose outcome is not known yet', () => {
  it.each(Object.keys(UNKNOWN))('%s', async (name) => {
    const result = await UNKNOWN[name]?.();
    expect(new Set(result?.keys).size).toBe(result?.fresh === true ? 2 : 1);
  });
});

describe('move between Backlog parts: one move per task in flight', () => {
  it.each(Object.keys(FIRST))(
    'a move held from the %s is not sent again from the task view',
    async (entry) => {
      const held = deferred();
      const { moves } = await board(THREE, ROWS, (d) => {
        withTask(d);
        d.routes['task.move'] = () => held.promise;
      });
      FIRST[entry]?.();
      await settle();
      expect(moves).toHaveLength(1);
      expect(send(one('main')).textContent).toBe('Moving');
      await sendInView('Groomed');
      expect(moves).toHaveLength(1);
      expect(send(dialog()).textContent).toBe('Moving');
      // Another reason for the same task is refused, not sent with a new key.
      press(buttonIn(dialog(), 'Cancel'), 'click');
      press(buttonIn(dialog(), 'triage…'), 'click');
      type(field(dialog()), 'Groomed twice');
      submit(dialog());
      await settle();
      expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(PENDING);
      expect(moves).toHaveLength(1);
    },
  );

  it('a move held from the task view is not sent again from the card', async () => {
    const held = deferred();
    history.replaceState(null, '', `/?open=${encodeURIComponent(KEY)}`);
    const { moves } = await board(THREE, ROWS, (d) => {
      withTask(d);
      d.routes['task.move'] = () => held.promise;
    });
    press(buttonIn(dialog(), 'triage…'), 'click');
    type(field(dialog()), 'Groomed');
    submit(dialog());
    await settle();
    expect(moves).toHaveLength(1);
    const close = dialog().querySelector('button[aria-label="Close"]');
    if (!close) throw new Error('no Close');
    press(close, 'click');
    await settle();
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    expect(moves).toHaveLength(1);
    expect(send(one('main')).textContent).toBe('Moving');
  });

  it('another task is not blocked, and a failed send releases the task', async () => {
    const held = deferred();
    const { d, moves } = await board(THREE, ROWS, (daemon) => {
      daemon.routes['task.move'] = () => held.promise;
    });
    choose('#1', 'Move to triage…');
    sendOnCard('Groomed');
    await settle();
    d.routes['task.move'] = () => Promise.resolve(Response.json({ broken: true }, { status: 500 }));
    choose('#2', 'Move to todo…');
    type(field(one('main')), 'Back');
    submit(one('main'));
    await settle();
    expect(moves).toHaveLength(2);
    expect(moves[1]?.input['task']).toBe('ex/repo#2');
    expect(moves[1]?.key).not.toBe(moves[0]?.key);
    held.resolve(Response.json({ broken: true }, { status: 500 }));
    await settle();
    choose('#1', 'Move to ready-for-dev…');
    sendOnCard('Ready');
    await settle();
    expect(moves).toHaveLength(3);
    expect(moves[2]?.input).toMatchObject({ task: KEY, column: 'ready-for-dev' });
  });
});
