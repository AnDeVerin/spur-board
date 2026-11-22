// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { envelope, hello, problem, row, status } from './board-fixtures.ts';
import { all, mountEachTest, one, press, settle } from './board-harness.ts';
import {
  board,
  form,
  forms,
  KEY,
  link,
  MIRRORED,
  MIRRORED_ROWS,
  part,
  REFUSAL,
  ROWS,
  THREE,
  wrap,
} from './board-move-helpers.ts';
import {
  A,
  B,
  buttonIn,
  C,
  cardCss,
  cause,
  column,
  css,
  drag,
  gate,
  HINT,
  item,
  keysOf,
  layout,
  list,
  manualBoard,
  menu,
  PENDING,
  placed,
  sortText,
  step,
} from './board-order-helpers.ts';

mountEachTest();

const keyed: unknown = expect.stringMatching(/.+/);
const lines = () => all(`main ${css('dropLine')}`);
const hint = () => all('main p[role="status"]').find((item) => item.textContent === HINT);
const banner = (id: string) => column(id).querySelector('[role="alert"]');

describe('manual order: drag', () => {
  it.each([
    ['onto the top', C, 10, 0, { mode: 'before', task: C, anchor: A }],
    ['onto the end', A, 290, 3, { mode: 'after', task: A, anchor: C }],
    ['at its own place', B, 110, 1, undefined],
  ])('a drop %s sends one reorder with the anchor of the gap', async (_, key, y, gap, input) => {
    const { orders } = await manualBoard();
    const body = list('todo');
    layout(body);
    expect(wrap(key).hasAttribute('data-manual')).toBe(true);
    expect(wrap(key).querySelector(`${cardCss('keyRow')} > ${cardCss('grip')} svg`)).not.toBeNull();
    drag(link(key), 'dragstart');
    expect(drag(body, 'dragover', y).defaultPrevented).toBe(true);
    expect(lines()).toHaveLength(1);
    // The line sits in the gap: after `gap` cards.
    const cardsBefore = [...body.children]
      .slice(0, [...body.children].indexOf(lines()[0] as Element))
      .filter((child) => child.hasAttribute('data-key'));
    expect(cardsBefore).toHaveLength(gap);
    drag(body, 'drop', y);
    drag(link(key), 'dragend');
    expect(lines()).toHaveLength(0);
    expect(orders).toEqual(input === undefined ? [] : [{ input, key: keyed }]);
    await settle();
    expect(keysOf('todo')).toEqual([A, B, C]);
  });

  it('a pending reorder dims the card and holds further gestures', async () => {
    const held = gate();
    const { orders, d, order } = await manualBoard();
    const answer = d.routes['task.order'];
    d.routes['task.order'] = (input) => held.opened.then(() => answer(input));
    step(A, 'ArrowDown');
    await settle();
    expect(orders).toEqual([{ input: { mode: 'after', task: A, anchor: B }, key: keyed }]);
    expect(wrap(A).hasAttribute('data-pending')).toBe(true);
    expect(wrap(B).hasAttribute('data-pending')).toBe(false);
    expect(list('todo').getAttribute('aria-busy')).toBe('true');
    for (const key of [A, B, C])
      for (const label of ['Move to top', 'Move to bottom']) {
        const option = item(key, label);
        expect(option.getAttribute('aria-disabled')).toBe('true');
        expect(cause(option)).toBe(PENDING);
      }
    step(B, 'ArrowDown');
    press(item(B, 'Move to top'), 'click');
    layout(list('todo'));
    drag(link(C), 'dragstart');
    expect(drag(list('todo'), 'dragover', 10).defaultPrevented).toBe(false);
    expect(lines()).toHaveLength(0);
    drag(list('todo'), 'drop', 10);
    drag(link(C), 'dragend');
    expect(orders).toHaveLength(1);
    order([B, A, C]);
    held.open();
    await settle();
    expect(keysOf('todo')).toEqual([B, A, C]);
    expect(all('main [data-pending]')).toHaveLength(0);
    expect(list('todo').hasAttribute('aria-busy')).toBe(false);
    expect(item(C, 'Move to top').hasAttribute('aria-disabled')).toBe(false);
    step(B, 'ArrowDown');
    expect(orders).toHaveLength(2);
  });
});

describe('manual order: keys and the card menu', () => {
  it('Alt+arrows step the focused card, which keeps focus after the re-read', async () => {
    const { orders, order } = await manualBoard();
    step(A, 'ArrowUp');
    step(C, 'ArrowDown');
    expect(orders).toEqual([]);
    link(C).focus();
    order([A, C, B]);
    step(C, 'ArrowUp');
    expect(orders).toEqual([{ input: { mode: 'before', task: C, anchor: B }, key: keyed }]);
    await settle();
    expect(keysOf('todo')).toEqual([A, C, B]);
    expect(document.activeElement).toBe(link(C));
    expect(column('todo').querySelector(`${css('hidden')}[role="status"]`)?.textContent).toBe(
      '#3 moved to 2 of 3',
    );
    step(A, 'ArrowDown');
    expect(orders.at(-1)).toEqual({ input: { mode: 'after', task: A, anchor: C }, key: keyed });
  });

  it('Alt+arrows send nothing in Time or Key', async () => {
    const { orders } = await manualBoard([A, B, C], {});
    step(B, 'ArrowUp');
    step(B, 'ArrowDown');
    step('ex/repo#9', 'ArrowUp');
    expect(orders).toEqual([]);
  });

  it('the card menu moves to top and bottom, its end items disabled', async () => {
    const { orders } = await manualBoard();
    expect(menu(A).map((option) => option.textContent)).toEqual(['Move to top', 'Move to bottom']);
    expect(column('todo').querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(item(A, 'Move to top').getAttribute('aria-disabled')).toBe('true');
    expect(cause(item(A, 'Move to top'))).toBeNull();
    expect(item(C, 'Move to bottom').getAttribute('aria-disabled')).toBe('true');
    press(item(A, 'Move to top'), 'click');
    expect(orders).toEqual([]);
    press(item(A, 'Move to bottom'), 'click');
    expect(orders).toEqual([{ input: { mode: 'bottom', task: A }, key: keyed }]);
    await settle();
    press(item(C, 'Move to top'), 'click');
    expect(orders.at(-1)).toEqual({ input: { mode: 'top', task: C }, key: keyed });
    // Done sorts by position too, with no grip, keys or menu.
    expect(
      all('main [data-manual]').every((item) => item.closest('section') === column('todo')),
    ).toBe(true);
  });
});

describe('manual order: Time and Key', () => {
  it('a drag in Time or Key moves nothing and offers Manual', async () => {
    const { orders, stored } = await manualBoard([C, B, A], {});
    expect(column('todo').querySelector(cardCss('grip'))).toBeNull();
    expect(wrap(A).hasAttribute('data-manual')).toBe(false);
    const before = keysOf('todo');
    expect(drag(link(B), 'dragstart').defaultPrevented).toBe(true);
    const line = hint();
    expect(line?.getAttribute('role')).toBe('status');
    expect(column('todo').contains(line ?? null)).toBe(true);
    expect(orders).toEqual([]);
    expect(keysOf('todo')).toEqual(before);
    press(buttonIn(column('todo'), 'switch to Manual'), 'click');
    expect(stored.get('board-sort:a:todo')).toBe('manual');
    expect(sortText('todo')).toEqual(['M']);
    expect(keysOf('todo')).toEqual([C, B, A]);
    expect(hint()).toBeUndefined();
    expect(document.activeElement).toBe(link(B));
  });

  it('the hint ends at the next drag start or a sort change', async () => {
    await manualBoard([A, B, C], {});
    drag(link(B), 'dragstart');
    expect(hint()).toBeDefined();
    drag(link('ex/repo#9'), 'dragstart');
    expect(all('main p[role="status"]').filter((item) => item.textContent === HINT)).toHaveLength(
      1,
    );
    expect(column('dev').contains(hint() ?? null)).toBe(true);
    press(one('[aria-label="Sort dev"] button[aria-label^="Longest"]'), 'click');
    expect(hint()).toBeUndefined();
  });

  it('a Backlog card in Time keeps its cross-part drag and shows the hint on its own part', async () => {
    const { orders, moves } = await board();
    const body = (id: string) => {
      const cards = part(id).querySelector(css('body'));
      if (!cards) throw new Error(`no part ${id}`);
      return cards;
    };
    expect(drag(link(KEY), 'dragstart').defaultPrevented).toBe(false);
    expect(drag(body('todo'), 'dragover').defaultPrevented).toBe(false);
    expect(hint()).toBeDefined();
    const triage = body('triage');
    expect(drag(triage, 'dragover').defaultPrevented).toBe(true);
    expect(triage.getAttribute('data-drop')).toBe('part');
    drag(link(KEY), 'dragend');
    expect(orders).toEqual([]);
    expect(moves).toEqual([]);
  });
});

describe('manual order: a refused reorder', () => {
  it('keeps the order and shows the cause until dismissed', async () => {
    const { d, orders } = await manualBoard([A, B, C], undefined, (fake) => {
      fake.routes['task.order'] = () => problem('order_anchor_invalid', 409);
    });
    d.send(hello);
    await settle();
    layout(list('todo'));
    drag(link(C), 'dragstart');
    drag(list('todo'), 'dragover', 10);
    drag(list('todo'), 'drop', 10);
    drag(link(C), 'dragend');
    await settle();
    expect(orders).toHaveLength(1);
    expect(keysOf('todo')).toEqual([A, B, C]);
    expect(all('main [data-pending]')).toHaveLength(0);
    const alert = banner('todo');
    expect(alert?.textContent).toContain('#3 not moved');
    expect(alert?.textContent).toContain(
      'The order changed on the board while you dragged. The card stays where it was.',
    );
    // Under the head, before the cards.
    expect(
      (alert?.compareDocumentPosition(list('todo')) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(banner('todo')).not.toBeNull();
    press(buttonIn(column('todo'), 'Dismiss'), 'click');
    expect(banner('todo')).toBeNull();
    expect(document.activeElement).toBe(link(C));
  });

  it('Dismiss focuses the sort letter once the card left the column', async () => {
    const { d } = await manualBoard([A, B, C], undefined, (fake) => {
      fake.routes['task.order'] = () => problem('order_anchor_invalid', 409);
    });
    d.send(hello);
    await settle();
    step(C, 'ArrowUp');
    await settle();
    expect(banner('todo')?.textContent).toContain('#3 not moved');
    d.routes['status.get'] = () =>
      Promise.resolve(envelope(status([...placed([A, B]), row(C, 'dev')])));
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(keysOf('todo')).toEqual([A, B]);
    press(buttonIn(column('todo'), 'Dismiss'), 'click');
    expect(document.activeElement).toBe(
      column('todo').querySelector('[aria-label^="Sort "] button'),
    );
  });
});

describe('Manual with Backlog parts', () => {
  const MANUAL_PARTS = { 'board-sort:a:todo': 'manual', 'board-sort:a:triage': 'manual' };
  const label = () => form().querySelector('label')?.textContent;

  it('the card menu lists order items, a rule, then the parts; a part item opens the form', async () => {
    const { orders, moves } = await board(THREE, ROWS, undefined, MANUAL_PARTS);
    expect(menu(KEY).map((option) => option.textContent)).toEqual([
      'Move to top',
      'Move to bottom',
      'Move to triage…',
      'Move to ready-for-dev…',
    ]);
    const open = one('main [role="menu"]');
    const rules = open.querySelectorAll('[role="separator"]');
    expect(rules).toHaveLength(1);
    const rule = rules[0] as Element;
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(item(KEY, 'Move to bottom'), rule)).toBe(true);
    expect(follows(rule, item(KEY, 'Move to triage…'))).toBe(true);
    press(item(KEY, 'Move to triage…'), 'click');
    expect(label()).toBe('Move #1 to triage: reason');
    expect(orders).toEqual([]);
    expect(moves).toEqual([]);
  });

  it('a cross-part drag in Manual goes to the band, unfolded and folded', async () => {
    const { orders, moves } = await board(THREE, ROWS, undefined, MANUAL_PARTS);
    for (const folded of [false, true]) {
      if (folded) press(one('main section[aria-labelledby] h2 button'), 'click');
      drag(link(KEY), 'dragstart');
      const target = part('triage').querySelector(css(folded ? 'groupCards' : 'body'));
      if (!target) throw new Error('no triage cards');
      const zone = folded ? part('triage') : target;
      expect(drag(target, 'dragover', 10).defaultPrevented).toBe(true);
      expect(zone.getAttribute('data-drop')).toBe('part');
      expect(part('triage').querySelector(css('dropLine'))).toBeNull();
      expect(hint()).toBeUndefined();
      drag(target, 'drop', 10);
      expect(label()).toBe('Move #1 to triage: reason');
      expect(orders).toEqual([]);
      expect(moves).toEqual([]);
      drag(link(KEY), 'dragend');
      press(buttonIn(form(), 'Cancel'), 'click');
      expect(forms()).toHaveLength(0);
    }
  });

  it('a mirrored part in Manual: order items enabled, part items refused', async () => {
    const { orders } = await board(
      MIRRORED,
      [...MIRRORED_ROWS, row('ex/repo#5', 'ready-for-dev')],
      undefined,
      { 'board-sort:a:ready-for-dev': 'manual' },
    );
    const four = 'ex/repo#4';
    expect(item(four, 'Move to top').getAttribute('aria-disabled')).toBe('true');
    expect(item(four, 'Move to bottom').hasAttribute('aria-disabled')).toBe(false);
    for (const to of ['Move to todo…', 'Move to triage…']) {
      expect(item(four, to).getAttribute('aria-disabled')).toBe('true');
      expect(cause(item(four, to))).toBe(REFUSAL);
    }
    press(item(four, 'Move to bottom'), 'click');
    expect(orders).toEqual([{ input: { mode: 'bottom', task: four }, key: keyed }]);
  });
});
