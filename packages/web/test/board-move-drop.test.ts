// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { all, mountEachTest, one, press, remount } from './board-harness.ts';
import {
  board,
  form,
  forms,
  KEY,
  keysIn,
  link,
  MIRRORED,
  MIRRORED_ROWS,
  part,
  REFUSAL,
  ROWS,
  wrap,
} from './board-move-helpers.ts';

mountEachTest();

const css = (name: string) => {
  const value = styles[name];
  if (value === undefined) throw new Error(`no class ${name}`);
  return `.${value}`;
};
const NOTE = (to: string) => `Drop to move to ${to}. A reason is asked.`;
/** HTML5 drag events; happy-dom has no DragEvent, so a plain Event carries a DataTransfer. */
const drag = (target: Element, type: string, related?: EventTarget | null) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: new DataTransfer() });
  if (related !== undefined) Object.defineProperty(event, 'relatedTarget', { value: related });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const body = (id: string) => {
  const found = part(id).querySelector(css('body'));
  if (!found) throw new Error(`no body in ${id}`);
  return found;
};
const notes = () => all(`main ${css('dropNote')}`);
const marked = () => all('main [data-drop]');
const toggle = () => one('main section[aria-labelledby] h2 button');

describe('move between Backlog parts: a drop', () => {
  it('a drop on another part opens the form', async () => {
    const { moves } = await board();
    expect(marked()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    drag(link(KEY), 'dragstart');
    expect(wrap(KEY).hasAttribute('data-dragging')).toBe(true);
    expect(notes()).toHaveLength(0);
    const target = body('triage');
    expect(drag(target, 'dragover').defaultPrevented).toBe(true);
    expect(target.getAttribute('data-drop')).toBe('part');
    expect(target.firstElementChild?.textContent).toBe(NOTE('triage'));
    expect(marked()).toEqual([target]);
    expect(notes()).toHaveLength(1);
    // Onto a card of the zone: still over it; out of the zone: cleared, until the next dragover.
    drag(target, 'dragleave', link('ex/repo#2'));
    expect(target.getAttribute('data-drop')).toBe('part');
    drag(target, 'dragleave', document.body);
    expect(marked()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    drag(target, 'dragover');
    expect(target.getAttribute('data-drop')).toBe('part');
    drag(target, 'drop');
    expect(marked()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    expect(wrap(KEY).hasAttribute('data-dragging')).toBe(false);
    const open = form();
    expect(wrap(KEY).contains(open)).toBe(true);
    expect(open.querySelector('label')?.textContent).toBe('Move #1 to triage: reason');
    expect(open.closest('a, [draggable="true"]')).toBeNull();
    expect(document.activeElement).toBe(open.querySelector('textarea'));
    drag(link(KEY), 'dragend');
    expect(forms()).toHaveLength(1);
    expect(moves).toEqual([]);
    expect(keysIn('todo')).toEqual([KEY]);
  });

  it('folded and spine targets', async () => {
    const { moves } = await board();
    // Unfolded, the empty ready-for-dev part is a spine: outline and fill, no note.
    const spine = part('ready-for-dev');
    drag(link(KEY), 'dragstart');
    expect(drag(spine, 'dragover').defaultPrevented).toBe(true);
    expect(spine.getAttribute('data-drop')).toBe('part');
    expect(notes()).toHaveLength(0);
    drag(spine, 'drop');
    expect(form().querySelector('label')?.textContent).toBe('Move #1 to ready-for-dev: reason');
    drag(link(KEY), 'dragend');
    // Folded, each part is a section; the note is its first line under the head.
    press(toggle(), 'click');
    drag(link(KEY), 'dragstart');
    for (const id of ['triage', 'ready-for-dev']) {
      const section = part(id);
      expect(drag(section, 'dragover').defaultPrevented).toBe(true);
      expect(section.getAttribute('data-drop')).toBe('part');
      expect(section.children[1]?.textContent).toBe(NOTE(id));
      expect(marked()).toEqual([section]);
    }
    drag(part('triage'), 'drop');
    expect(marked()).toHaveLength(0);
    expect(forms()).toHaveLength(1);
    expect(form().querySelector('label')?.textContent).toBe('Move #1 to triage: reason');
    expect(form().closest('a, [draggable="true"]')).toBeNull();
    expect(moves).toEqual([]);
  });

  it('own part, non-group and foreign drags do nothing', async () => {
    const { moves } = await board();
    expect(drag(body('triage'), 'dragover').defaultPrevented).toBe(false);
    expect(marked()).toHaveLength(0);
    drag(body('triage'), 'drop');
    expect(forms()).toHaveLength(0);
    drag(link(KEY), 'dragstart');
    expect(drag(body('todo'), 'dragover').defaultPrevented).toBe(false);
    const dev = all('main section')
      .find((section) =>
        [...section.querySelectorAll('h2')].some(
          (title) => title.textContent === 'dev' && title.closest('section') === section,
        ),
      )
      ?.querySelector(css('body'));
    if (!dev) throw new Error('no dev body');
    expect(drag(dev, 'dragover').defaultPrevented).toBe(false);
    expect(marked()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    drag(body('todo'), 'drop');
    drag(dev, 'drop');
    expect(forms()).toHaveLength(0);
    expect(moves).toEqual([]);
  });

  it('a drag into or out of a mirrored part is refused and marked', async () => {
    const { moves } = await board(MIRRORED, MIRRORED_ROWS);
    // Into it: the zone is marked refused with the refusal as its note, and takes no drop.
    drag(link(KEY), 'dragstart');
    const target = body('ready-for-dev');
    expect(drag(target, 'dragover').defaultPrevented).toBe(false);
    expect(target.getAttribute('data-drop')).toBe('refused');
    expect(target.firstElementChild?.textContent).toBe(REFUSAL);
    expect(marked()).toEqual([target]);
    expect(drag(target, 'drop').defaultPrevented).toBe(false);
    expect(forms()).toHaveLength(0);
    // todo to triage still takes the drop.
    expect(drag(body('triage'), 'dragover').defaultPrevented).toBe(true);
    expect(body('triage').getAttribute('data-drop')).toBe('part');
    expect(marked()).toEqual([body('triage')]);
    drag(link(KEY), 'dragend');
    expect(marked()).toHaveLength(0);
    // Out of it: every other part refuses.
    drag(link('ex/repo#4'), 'dragstart');
    for (const id of ['todo', 'triage']) {
      expect(drag(body(id), 'dragover').defaultPrevented).toBe(false);
      expect(body(id).getAttribute('data-drop')).toBe('refused');
      expect(body(id).firstElementChild?.textContent).toBe(REFUSAL);
      drag(body(id), 'drop');
    }
    drag(link('ex/repo#4'), 'dragend');
    // Folded: the section is marked, its note under the head.
    press(toggle(), 'click');
    drag(link(KEY), 'dragstart');
    const section = part('ready-for-dev');
    expect(drag(section, 'dragover').defaultPrevented).toBe(false);
    expect(section.getAttribute('data-drop')).toBe('refused');
    expect(section.children[1]?.textContent).toBe(REFUSAL);
    drag(section, 'drop');
    drag(link(KEY), 'dragend');
    expect(forms()).toHaveLength(0);
    expect(moves).toEqual([]);
    expect(keysIn('ready-for-dev')).toEqual(['ex/repo#4']);
    // An empty mirrored part is a spine: the refusal is its title while the card is over it.
    remount();
    await board(MIRRORED, ROWS);
    const spine = part('ready-for-dev');
    expect(spine.title).toBe('ready-for-dev: empty · mirror · Roadmap');
    drag(link(KEY), 'dragstart');
    expect(drag(spine, 'dragover').defaultPrevented).toBe(false);
    expect(spine.getAttribute('data-drop')).toBe('refused');
    expect(spine.title).toBe(REFUSAL);
    drag(spine, 'drop');
    expect(forms()).toHaveLength(0);
  });

  it('the highlight clears on dragend with no drop', async () => {
    const { moves } = await board();
    drag(link(KEY), 'dragstart');
    drag(body('triage'), 'dragover');
    expect(marked()).toHaveLength(1);
    drag(link(KEY), 'dragend');
    expect(marked()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    expect(all('main [data-dragging]')).toHaveLength(0);
    expect(forms()).toHaveLength(0);
    expect(moves).toEqual([]);
  });
});
