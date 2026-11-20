// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { deferred, envelope, taskGet, type Daemon } from './board-fixtures.ts';
import { all, mountEachTest, one, press, settle } from './board-harness.ts';
import {
  board,
  field,
  KEY,
  link,
  part,
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
const withTask = (d: Daemon) => {
  d.routes['task.get'] = () =>
    Promise.resolve(envelope(taskGet({ task: { ...taskGet().task, key: KEY, column: 'todo' } })));
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
