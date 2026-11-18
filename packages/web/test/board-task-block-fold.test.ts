// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chip, type ChipTone } from '../src/ds/index.ts';
import taskStyles from '../src/board/TaskView.module.css';
import { block, comment, daemon, envelope, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();
afterEach(() => {
  vi.restoreAllMocks();
});

/** Opens task ex/repo#7 with these blocks and comments; `setTask` changes the next read. */
async function open(extra: Record<string, unknown>) {
  const d = daemon();
  const setTask = (next: Record<string, unknown>) => {
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet(next)));
  };
  setTask(extra);
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  mount(d);
  await settle();
  const refetch = async () => {
    d.send('event: reset\ndata: {}\n\n');
    await settle();
  };
  return { d, setTask, refetch };
}
const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no task dialog');
  return found;
};
function article(id: string) {
  const found = [...dialog().querySelectorAll<HTMLElement>('article')].find(
    (candidate) => candidate.querySelector('strong')?.textContent === id,
  );
  if (!found) throw new Error(`no block ${id}`);
  return found;
}
function band(id: string) {
  const found = article(id).firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error(`no band on ${id}`);
  return found;
}
const bandButton = (id: string) =>
  article(id).querySelector<HTMLButtonElement>(':scope > button[aria-expanded]');
const body = (id: string) => {
  const found = band(id).nextElementSibling;
  if (!(found instanceof HTMLElement)) throw new Error(`no body on ${id}`);
  return found;
};
const reasonText = (id: string) => {
  const found = body(id).firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error(`no reason on ${id}`);
  return found;
};
const region = (id: string) => {
  const found = article(id).querySelector<HTMLElement>(`.${taskStyles.rest ?? ''}`);
  if (!found) throw new Error(`no region on ${id}`);
  return found;
};
const buttons = (id: string, text: string) =>
  [...article(id).querySelectorAll<HTMLButtonElement>('button')].filter((candidate) =>
    candidate.textContent.startsWith(text),
  );
const showAll = (id: string) => buttons(id, '… Show all')[0];
const collapse = (id: string) => buttons(id, `Collapse ${id}`)[0];
const foot = (id: string) => article(id).querySelector(`.${taskStyles.foot ?? ''}`);
const chip = (id: string) => band(id).lastElementChild?.firstElementChild;
/** The class a `Chip` of this tone renders. */
const chipClass = (tone: ChipTone) =>
  /class="([^"]*)"/.exec(renderToStaticMarkup(createElement(Chip, { tone, children: 'x' })))?.[1];
const click = (target: Element | null | undefined) => {
  if (!target) throw new Error('nothing to click');
  press(target, 'click');
};
// The `key` helper of board-task-view.test.ts: a keydown on the focused element.
const key = (name: string, init: KeyboardEventInit = {}) => {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name, ...init }),
    );
  });
};
function type(input: HTMLTextAreaElement | null, text: string) {
  if (!input) throw new Error('no field');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const folded = (id: string) => {
  expect(bandButton(id)?.getAttribute('aria-expanded')).toBe('false');
  expect(region(id).hidden).toBe(true);
};
const unfolded = (id: string) => {
  expect(bandButton(id)?.getAttribute('aria-expanded')).toBe('true');
  expect(region(id).hidden).toBe(false);
};
const answered = (id: string, extra: Record<string, unknown> = {}) =>
  block({ id, state: 'unblocked', outcome: 'done', answeredVia: 'web', ...extra });
const withdrawn = (id: string, extra: Record<string, unknown> = {}) =>
  block({ id, state: 'unblocked', outcome: 'withdrawn', ...extra });
const twoReplies = [
  comment({ id: 'C1', block: 'B10', text: 'old reply' }),
  comment({ id: 'C2', block: 'B10', text: 'latest reply' }),
];

describe('task view blocks', () => {
  it('open blocks are whole with their tone', async () => {
    await open({
      blocks: [block(), block({ id: 'B13', addressee: 'worker' })],
      comments: [
        comment({ id: 'C1', block: 'B12', text: 'a reply' }),
        comment({ id: 'C2', block: 'B13', text: 'another reply' }),
      ],
    });
    for (const [id, tone, toneClass] of [
      ['B12', 'you', taskStyles.mine],
      ['B13', 'warn', taskStyles.agent],
    ] as const) {
      expect(article(id).className).toContain(toneClass);
      expect(article(id).querySelector('button[aria-expanded]')).toBeNull();
      expect(reasonText(id).className).toBe(taskStyles.text);
      expect(band(id).firstElementChild?.tagName).toBe('STRONG');
      expect(band(id).firstElementChild?.className).toBe(taskStyles.id);
      expect(band(id).querySelector('svg')).toBeNull();
      expect(chip(id)?.className).toBe(chipClass(tone));
      expect(region(id).hidden).toBe(false);
    }
    expect(dialog().querySelector(`.${taskStyles.blocks ?? ''}`)?.children).toHaveLength(2);
    expect(foot('B13')).toBeNull();
  });

  it('a closed block starts folded and names what it hides', async () => {
    await open({
      blocks: [
        answered('B10'),
        withdrawn('B14', { outcomeReason: 'Not needed now.' }),
        withdrawn('B15', { outcomeReason: 'Moved to B16.' }),
      ],
      comments: [...twoReplies, comment({ id: 'C3', block: 'B15', text: 'a reply' })],
    });
    for (const [id, label] of [
      ['B10', '… Show all · 2 replies'],
      ['B14', '… Show all · outcome'],
      ['B15', '… Show all · 1 reply · outcome'],
    ] as const) {
      folded(id);
      const controls = bandButton(id)?.getAttribute('aria-controls');
      expect(controls).toBe(region(id).id);
      expect(document.getElementById(controls ?? '')?.hidden).toBe(true);
      expect(reasonText(id).className).not.toBe(taskStyles.text);
      expect(showAll(id)?.textContent).toBe(label);
      expect(showAll(id)?.getAttribute('aria-expanded')).toBe('false');
      expect(collapse(id)).toBeUndefined();
    }
  });

  it('unfold by text, toggle and band; a selection does not unfold; fold by band and Collapse', async () => {
    await open({
      blocks: [answered('B10'), withdrawn('B14', { outcomeReason: 'Not needed now.' })],
      comments: twoReplies,
    });
    const selection = document.getSelection();
    act(() => {
      selection?.selectAllChildren(reasonText('B10'));
    });
    click(reasonText('B10'));
    folded('B10');
    act(() => {
      selection?.removeAllRanges();
    });
    click(reasonText('B10'));
    unfolded('B10');
    const footChildren = [...(foot('B10')?.children ?? [])];
    expect(footChildren.at(-1)).toBe(collapse('B10'));
    expect(footChildren[0]?.textContent).toContain('Follow up');
    expect(collapse('B10')?.getAttribute('aria-expanded')).toBe('true');
    click(collapse('B10'));
    folded('B10');
    expect(document.activeElement).toBe(bandButton('B10'));
    click(bandButton('B10'));
    unfolded('B10');
    click(bandButton('B10'));
    folded('B10');
    click(showAll('B10'));
    unfolded('B10');
    expect(document.activeElement).toBe(bandButton('B10'));
    click(showAll('B14'));
    expect([...(foot('B14')?.children ?? [])]).toEqual([collapse('B14')]);
  });

  it('a short closed block with nothing hidden has no control', async () => {
    await open({
      blocks: [answered('B16'), block({ id: 'B18', state: 'unblocked', outcome: 'archived' })],
    });
    for (const id of ['B16', 'B18']) {
      expect(bandButton(id)).toBeNull();
      // The answered chip's check is an svg too; the caret is the fold control's.
      expect(band(id).querySelector(`.${taskStyles.caret ?? ''}`)).toBeNull();
      expect(showAll(id)).toBeUndefined();
      expect(collapse(id)).toBeUndefined();
      expect(region(id).hidden).toBe(false);
    }
    expect(buttons('B16', 'Follow up')[0]?.closest('[hidden]')).toBeNull();
    expect(foot('B18')).toBeNull();
  });

  it('a reason that runs past the fold folds with a plain Show all', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(36);
    await open({ blocks: [block({ id: 'B18', state: 'unblocked', outcome: 'archived' })] });
    folded('B18');
    expect(showAll('B18')?.textContent).toBe('… Show all');
  });

  it('an answered chip has the ready tint and a check', async () => {
    await open({ blocks: [answered('B16')] });
    expect(chip('B16')?.className).toBe(chipClass('ready'));
    expect(chip('B16')?.querySelector('svg')).not.toBeNull();
    expect(chip('B16')?.textContent).toBe('answered via web');
  });

  it('a held write area keeps the block unfolded', async () => {
    const reply = comment({ id: 'C1', block: 'B12', text: 'a reply' });
    const draft = await open({ blocks: [block()], comments: [reply] });
    type(article('B12').querySelector('textarea'), 'my answer');
    draft.setTask({ blocks: [withdrawn('B12')], comments: [reply] });
    await draft.refetch();
    const retained = [...article('B12').querySelectorAll('strong')].find(
      (strong) => strong.textContent === 'Unsent answer draft',
    );
    expect(retained?.closest('[hidden]')).toBeNull();
    expect(bandButton('B12')).toBeNull();
    expect(collapse('B12')).toBeUndefined();
  });

  it('an open follow-up form keeps the block unfolded, and it stays unfolded after Cancel', async () => {
    await open({ blocks: [answered('B12')], comments: [comment({ block: 'B12' })] });
    click(bandButton('B12'));
    click(buttons('B12', 'Follow up')[0]);
    expect(bandButton('B12')).toBeNull();
    expect(collapse('B12')).toBeUndefined();
    expect(article('B12').querySelector('textarea')?.closest('[hidden]')).toBeNull();
    click(article('B12').querySelector('button[aria-label="Cancel"]'));
    unfolded('B12');
    expect(collapse('B12')).toBeDefined();
  });

  it('an open block with no draft that closes by refetch starts folded', async () => {
    const reply = comment({ id: 'C1', block: 'B12', text: 'a reply' });
    const task = await open({ blocks: [block()], comments: [reply] });
    task.setTask({ blocks: [answered('B12')], comments: [reply] });
    await task.refetch();
    folded('B12');
  });

  it('the fold state survives History and a refetch', async () => {
    const task = await open({
      blocks: [answered('B10'), withdrawn('B14', { outcomeReason: 'Not needed now.' })],
      comments: twoReplies,
    });
    click(showAll('B10'));
    const tab = (label: string) =>
      [...dialog().querySelectorAll('[role="tab"]')].find((each) => each.textContent === label);
    click(tab('History'));
    await settle();
    click(tab('Now'));
    await task.refetch();
    unfolded('B10');
    folded('B14');
  });

  it('Tab reaches the band and both toggles; focus after a fold change', async () => {
    await open({ blocks: [answered('B10')], comments: twoReplies });
    act(() => {
      bandButton('B10')?.focus();
    });
    key('Tab');
    expect(document.activeElement).toBe(showAll('B10'));
    expect(showAll('B10')?.hasAttribute('aria-expanded')).toBe(true);
    click(reasonText('B10'));
    expect(document.activeElement).toBe(bandButton('B10'));
    key('Tab');
    expect(document.activeElement).toBe(buttons('B10', 'Follow up')[0]);
    key('Tab');
    expect(document.activeElement).toBe(collapse('B10'));
    expect(collapse('B10')?.getAttribute('aria-expanded')).toBe('true');
    expect(bandButton('B10')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('focus falls back to the block when its band stops being a button', async () => {
    const task = await open({ blocks: [block()] });
    const field = article('B12').querySelector('textarea');
    type(field, 'draft');
    type(field, '');
    task.setTask({ blocks: [block({ state: 'unblocked', outcome: 'archived' })] });
    await task.refetch();
    expect(collapse('B12')).toBeDefined();
    click(collapse('B12'));
    expect(bandButton('B12')).toBeNull();
    expect(band('B12').tagName).toBe('DIV');
    expect(document.activeElement).toBe(article('B12'));
    expect(article('B12').getAttribute('tabindex')).toBe('-1');
    key('Tab');
    const comments = [...dialog().querySelectorAll('section')].find((section) =>
      section.textContent.startsWith('Comments'),
    );
    expect(document.activeElement).toBe(comments?.querySelector('button[aria-expanded]'));
    expect(article('B12').hasAttribute('tabindex')).toBe(false);
  });
});
