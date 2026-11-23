// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import taskStyles from '../src/board/TaskView.module.css';
import { quiet } from '../src/ds/index.ts';
import {
  blockGet,
  comment,
  config,
  daemon,
  deferred,
  envelope,
  failure,
  hello,
  inbox,
  never,
  problem,
  type Daemon,
} from './board-fixtures.ts';
import { goOffline, mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();
const NOW = Date.parse('2026-11-15T14:30:00.000Z');
const RESET = 'event: reset\ndata: {}\n\n';
const invalidate = (projects: string[]) =>
  `event: invalidate\ndata: ${JSON.stringify({ projects, tasks: [] })}\n\n`;

const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
function panel() {
  const found = dialogs().at(-1);
  if (!found) throw new Error('no dialog');
  return found;
}
function closeOf(dialog: HTMLElement) {
  const found = dialog.querySelector<HTMLElement>('[aria-label="Close"]');
  if (!found) throw new Error('no Close');
  return found;
}
function row(id: string) {
  const found = document.querySelector<HTMLElement>(`[data-inbox-id="${id}"]`);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}
const label = () => document.getElementById(panel().getAttribute('aria-labelledby') ?? '');
const box = () => panel().querySelector<HTMLElement>(`div.${quiet}`);
const note = () => panel().querySelector(`p.${taskStyles.note ?? ''}`)?.textContent;
const buttonIn = (text: string) =>
  [...panel().querySelectorAll('button')].find((button) => button.textContent === text);
const typeText = (input: HTMLTextAreaElement, text: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = (input: HTMLTextAreaElement) => {
  act(() => {
    input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Records every op request of the fake daemon by op id. */
function recorded(d: Daemon) {
  const calls: { op: string; input: unknown }[] = [];
  const fetcher: typeof fetch = (url, init) => {
    const path = url instanceof Request ? url.url : url.toString();
    if (path.startsWith('/v1/ops/')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        input?: unknown;
      };
      calls.push({ op: path.slice('/v1/ops/'.length), input: body.input });
    }
    return d.fetcher(url, init);
  };
  const of = (op: string) => calls.filter((call) => call.op === op);
  return { d: { ...d, fetcher }, of };
}

/** Mounts the board on `?open=inbox` and opens row B1 with a plain click. */
async function fromInbox(d: Daemon) {
  history.replaceState(null, '', '/?open=inbox');
  const { d: watched, of } = recorded(d);
  const storage = mount(watched, {}, () => NOW);
  await settle();
  press(row('B1'), 'click');
  await settle();
  return { of, storage };
}

describe('block panel', () => {
  it('opens the block panel over the inbox from a block row', async () => {
    const { of } = await fromInbox(daemon());
    expect(location.search).toBe('?open=block%3AB1');
    expect(history.state).toEqual({ inbox: true, project: 'a' });
    expect(dialogs()).toHaveLength(2);
    expect(label()?.textContent).toBe('Block B1');
    expect(label()?.nextElementSibling?.textContent).toBe('a');
    expect(of('block.get')).toEqual([{ op: 'block.get', input: { block: 'B1' } }]);
    expect(of('task.get')).toHaveLength(0);
    const header = box()?.textContent ?? '';
    expect(header).toContain('Raised by');
    expect(header).toContain('a / w1');
    expect(header).toContain('To');
    expect(header).toContain('you');
    expect(header).toContain('Since');
    expect(header).toContain('14:00 15/11/26');
    expect(header).not.toContain('Task');
    expect(header).not.toContain('B1');
    // The band below carries the age; the box does not repeat it.
    expect(panel().querySelector('article')?.textContent).toContain('30m');
    expect(header).not.toContain('30m');
    expect(header).not.toContain('ago');
  });

  it('shows the task of a task block in the box', async () => {
    const d = daemon();
    d.routes['block.get'] = () =>
      Promise.resolve(envelope(blockGet({ task: 'ex/repo#7', project: undefined })));
    await fromInbox(d);
    const task = [...(box()?.querySelectorAll('span[title]') ?? [])].find(
      (span) => span.getAttribute('title') === 'ex/repo#7',
    );
    expect(task?.textContent).toBe('#7');
    expect(box()?.textContent).toContain('Task');
  });

  it('shows a Skeleton with Close focused while the first read is pending', async () => {
    const d = daemon();
    d.routes['block.get'] = never;
    await fromInbox(d);
    expect(dialogs()).toHaveLength(2);
    expect(panel().querySelector('div[aria-hidden="true"] > span')).not.toBeNull();
    expect(document.activeElement).toBe(closeOf(panel()));
    expect(label()?.textContent).toBe('Block B1');
  });

  it('opens from its address alone', async () => {
    history.replaceState(null, '', '/?open=block:B1');
    const { d, of } = recorded(daemon());
    mount(d, {}, () => NOW);
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(label()?.textContent).toBe('Block B1');
    expect(of('block.get')).toHaveLength(1);
    expect(of('task.get')).toHaveLength(0);
  });

  it('never reads an id that is not a block id', async () => {
    history.replaceState(null, '', '/?open=block:x');
    const base = daemon();
    const { d, of } = recorded(base);
    mount(d, {}, () => NOW);
    await settle();
    expect(note()).toBe('Block not found.');
    expect(of('block.get')).toHaveLength(0);
    base.send(hello);
    base.send(RESET);
    await settle();
    expect(note()).toBe('Block not found.');
    expect(of('block.get')).toHaveLength(0);
    expect(panel().textContent).not.toContain('Could not load the block.');
    expect(of('task.get')).toHaveLength(0);
  });

  it('closes back to the inbox and follows Back and Forward', async () => {
    await fromInbox(daemon());
    press(closeOf(panel()), 'click');
    await settle();
    expect(location.search).toBe('?open=inbox');
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(row('B1'));
    press(row('B1'), 'click');
    await settle();
    expect(dialogs()).toHaveLength(2);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    expect(location.search).toBe('?open=inbox');
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(row('B1'));
    act(() => {
      history.replaceState({ inbox: true, project: 'a' }, '', '/?open=block%3AB1');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(dialogs()).toHaveLength(2);
    expect(label()?.textContent).toBe('Block B1');
    act(() => {
      history.replaceState(null, '', '/?open=inbox');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(dialogs()).toHaveLength(1);
  });

  it('keeps focus in the panel when its row moves to handled, then closes to the inbox Close', async () => {
    const d = daemon();
    await fromInbox(d);
    expect(document.activeElement).toBe(closeOf(panel()));
    const [first, second] = inbox(2).items;
    d.routes['inbox.operator'] = () =>
      Promise.resolve(envelope({ items: [second], handled: [{ ...first, handledAt: first?.at }] }));
    d.send(RESET);
    await settle();
    expect(row('B1').dataset['handled']).toBe('true');
    expect(document.activeElement).toBe(closeOf(panel()));
    expect(dialogs()[0]?.contains(document.activeElement)).toBe(false);
    press(closeOf(panel()), 'click');
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(closeOf(panel()));
  });

  it('closes a directly opened panel to a URL without open', async () => {
    history.replaceState(null, '', '/?open=block%3AB1&theme=dark');
    mount(daemon(), {}, () => NOW);
    await settle();
    press(closeOf(panel()), 'click');
    await settle();
    expect(location.search).toBe('?theme=dark');
    expect(dialogs()).toHaveLength(0);
  });

  it('answers through the block thread and re-reads the block', async () => {
    const d = daemon();
    const { of } = await fromInbox(d);
    const field = panel().querySelector('textarea');
    if (!field) throw new Error('no answer field');
    expect(field.getAttribute('aria-label') ?? panel().textContent).toContain('Answer B1');
    const read = deferred();
    d.routes['block.get'] = () => read.promise;
    const [first, second] = inbox(2).items;
    d.routes['inbox.operator'] = () =>
      Promise.resolve(envelope({ items: [second], handled: [{ ...first, handledAt: first?.at }] }));
    typeText(field, 'Take the left one');
    submit(field);
    await settle();
    expect(of('block.answer').map((call) => call.input)).toEqual([
      { block: 'B1', text: 'Take the left one' },
    ]);
    expect(of('block.get')).toHaveLength(2);
    expect(panel().querySelector('[role="status"]')?.textContent).toBe(
      'Answer sent. Refreshing block…',
    );
    read.resolve(
      envelope(
        blockGet(
          { state: 'unblocked', outcome: 'done', answeredVia: 'web' },
          { comments: [comment({ task: null, block: 'B1', text: 'Take the left one' })] },
        ),
      ),
    );
    d.send(RESET);
    await settle();
    expect(panel().querySelector('textarea')).toBeNull();
    expect(buttonIn('Follow up')).toBeDefined();
    expect(dialogs()[0]?.contains(document.activeElement)).toBe(false);
  });

  it('shows a failed re-read after an answer with Refresh block', async () => {
    const d = daemon();
    const { of } = await fromInbox(d);
    const field = panel().querySelector('textarea');
    if (!field) throw new Error('no answer field');
    d.routes['block.get'] = failure;
    typeText(field, 'Left');
    submit(field);
    await settle();
    expect(panel().querySelector('[role="status"]')?.textContent).toBe(
      'Answer sent. Could not refresh the block.',
    );
    const refresh = buttonIn('Refresh block');
    if (!refresh) throw new Error('no Refresh block');
    const before = of('block.get').length;
    d.routes['block.get'] = () => Promise.resolve(envelope(blockGet()));
    press(refresh, 'click');
    await settle();
    expect(of('block.get')).toHaveLength(before + 1);
    expect(buttonIn('Refresh block')).toBeUndefined();
  });

  it('follows up an answered block', async () => {
    const d = daemon();
    d.routes['block.get'] = () =>
      Promise.resolve(envelope(blockGet({ state: 'unblocked', outcome: 'done' })));
    const { of } = await fromInbox(d);
    const follow = buttonIn('Follow up');
    if (!follow) throw new Error('no Follow up');
    press(follow, 'click');
    await settle();
    const field = panel().querySelector('textarea');
    if (!field) throw new Error('no follow-up field');
    typeText(field, 'One more thing');
    submit(field);
    await settle();
    expect(of('block.followup').map((call) => call.input)).toEqual([
      { block: 'B1', text: 'One more thing' },
    ]);
    expect(panel().querySelector('[role="status"]')?.textContent).toContain('Follow-up sent.');
  });

  it('disables Send offline with the reason and keeps the text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const { of } = await fromInbox(d);
    const field = panel().querySelector('textarea');
    if (!field) throw new Error('no answer field');
    typeText(field, 'Left');
    await goOffline(d);
    expect(field.disabled).toBe(true);
    expect(panel().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(panel().textContent).toContain(
      'Live updates are lost. Answers and comments cannot be sent.',
    );
    expect(panel().textContent).not.toContain('Could not load the block.');
    submit(field);
    await settle();
    expect(of('block.answer')).toHaveLength(0);
    expect(field.value).toBe('Left');
  });

  it.each([
    {
      extra: { addressee: 'curator', state: 'open' },
      to: 'curator',
      fields: 0,
      follow: false,
      text: 'Addressed to curator. Only blocks addressed to you take an answer or follow-up here.',
    },
    {
      extra: { addressee: 'curator', state: 'unblocked', outcome: 'done' },
      to: 'curator',
      fields: 0,
      follow: false,
      text: 'Addressed to curator. Only blocks addressed to you take an answer or follow-up here.',
    },
    {
      extra: { state: 'unblocked', outcome: 'withdrawn' },
      to: 'you',
      fields: 0,
      follow: false,
      text: 'Closed as withdrawn. A closed block takes no answer.',
    },
    {
      extra: { state: 'unblocked', outcome: 'done' },
      to: 'you',
      fields: 0,
      follow: true,
      text: undefined,
    },
    {
      extra: { task: 'ex/repo#7', project: undefined },
      to: 'you',
      fields: 0,
      follow: false,
      text: 'On task #7. Answer and follow up in its task view.',
    },
    {
      extra: { type: 'code', state: 'open' },
      to: 'you',
      fields: 0,
      follow: false,
      text: 'Not a question. Only a question takes an answer here.',
    },
  ])('read-only rules for $extra', async ({ extra, to, fields, follow, text }) => {
    const d = daemon();
    d.routes['block.get'] = () => Promise.resolve(envelope(blockGet(extra)));
    await fromInbox(d);
    expect(panel().querySelectorAll('textarea')).toHaveLength(fields);
    expect(buttonIn('Follow up') !== undefined).toBe(follow);
    const toRow = [...(box()?.querySelectorAll('div') ?? [])].find((div) =>
      div.firstElementChild?.textContent.startsWith('To'),
    );
    expect(toRow?.lastElementChild?.textContent).toBe(to);
    expect(note()).toBe(text);
  });

  it.each(['stay', 'close'])(
    'selects the project of a row opened while config is pending (%s)',
    async (next) => {
      const d = daemon();
      const held = deferred();
      d.routes['config.get'] = () => held.promise;
      d.routes['inbox.operator'] = () =>
        Promise.resolve(envelope({ items: [{ ...inbox(1).items[0], project: 'b' }], handled: [] }));
      d.routes['block.get'] = () =>
        Promise.resolve(envelope(blockGet({ project: 'b' }, { project: 'b' })));
      const { storage } = await fromInbox(d);
      expect(dialogs()).toHaveLength(2);
      expect(history.state).toEqual({ inbox: true, project: 'b' });
      if (next === 'close') {
        press(closeOf(panel()), 'click');
        await settle();
      }
      held.resolve(envelope(config));
      await settle();
      expect(storage.get('board-project')).toBe(next === 'stay' ? 'b' : undefined);
      const switcher = document.querySelector('header button[aria-controls]');
      expect(switcher?.textContent).toBe(next === 'stay' ? 'b' : 'a');
    },
  );

  it("rereads on its project's changes", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const { of } = await fromInbox(d);
    d.send(hello);
    await settle();
    const count = of('block.get').length;
    d.send(invalidate(['a']));
    await tick(400);
    await settle();
    expect(of('block.get')).toHaveLength(count + 1);
    d.send(invalidate(['b']));
    await tick(400);
    await settle();
    expect(of('block.get')).toHaveLength(count + 1);
    d.send(RESET);
    await settle();
    expect(of('block.get')).toHaveLength(count + 2);
    d.routes['block.get'] = failure;
    d.send(RESET);
    await settle();
    expect(panel().textContent).toContain('Could not load the block.');
    expect(box()?.textContent).toContain('a / w1');
    const retry = buttonIn('Retry');
    if (!retry) throw new Error('no Retry');
    d.routes['block.get'] = () => Promise.resolve(envelope(blockGet()));
    press(retry, 'click');
    await settle();
    expect(panel().textContent).not.toContain('Could not load the block.');
  });

  it('rereads a block the daemon does not know only on a full re-read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    d.routes['block.get'] = () => problem('not_found');
    const { of } = await fromInbox(d);
    expect(note()).toBe('Block not found.');
    expect(of('block.get')).toHaveLength(1);
    d.send(invalidate(['a']));
    await tick(400);
    await settle();
    expect(of('block.get')).toHaveLength(1);
    d.send(RESET);
    await settle();
    expect(of('block.get')).toHaveLength(2);
    expect(note()).toBe('Block not found.');
  });
});
