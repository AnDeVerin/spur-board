// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { block, comment, daemon, deferred, envelope, problem, taskGet } from './board-fixtures.ts';
import taskStyles from '../src/board/TaskView.module.css';
import { goOffline, mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();
const answered = () => block({ state: 'unblocked', outcome: 'done', answeredVia: 'web' });
const theAnswer = comment({ block: 'B12', text: 'the answer' });
const more = comment({ id: 'C9', block: 'B12', text: 'more' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Opens task ex/repo#7 on a fake daemon and records every `block.followup` request. */
async function open(
  extra: Record<string, unknown> = { blocks: [answered()], comments: [theAnswer] },
) {
  const d = daemon();
  const writes: { key: string; input: unknown }[] = [];
  const setTask = (next: Record<string, unknown>) => {
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet(next)));
  };
  setTask(extra);
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  mount({
    ...d,
    fetcher: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path.endsWith('/block.followup'))
        writes.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as never);
      return d.fetcher(url, init);
    },
  });
  await settle();
  // An answered block with a reply starts folded; its band unfolds it.
  const band = item().querySelector(':scope > button[aria-expanded="false"]');
  if (band) press(band, 'click');
  return { d, writes, setTask, accepted: d.routes['block.followup'] };
}
function item() {
  const found = document.querySelector<HTMLElement>('[role="dialog"] article');
  if (!found) throw new Error('no block in task dialog');
  return found;
}
function button(text: string) {
  const found = [...item().querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`no ${text} button`);
  return found;
}
const followUp = () => button('Follow up');
const field = () => item().querySelector('textarea');
const cancel = () => item().querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
function pressCancel() {
  const close = cancel();
  if (!close) throw new Error('no Cancel');
  press(close, 'click');
}
const send = () => item().querySelector<HTMLButtonElement>('button[type="submit"]');
const replies = () =>
  [...item().querySelectorAll(`.${taskStyles.reply ?? ''} > p`)].map((p) => p.textContent);
const statuses = () => [...item().querySelectorAll('[role="status"]')].map((p) => p.textContent);
function type(text: string) {
  const input = field();
  if (!input) throw new Error('no follow-up field');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function submit() {
  act(() => {
    item()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('follow-up on an answered block', () => {
  it('Follow up opens the answer input and sends block.followup once', async () => {
    const { d, writes, setTask, accepted } = await open();
    press(followUp(), 'click');
    expect(item().querySelector('label')?.textContent).toBe('Follow-up on B12');
    expect(field()?.value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(send()?.textContent).toBe('Send follow-up');
    expect(cancel()).not.toBeNull();
    type('more');
    const held = deferred();
    d.routes['block.followup'] = () => held.promise;
    setTask({ blocks: [answered()], comments: [theAnswer, more] });
    send()?.focus();
    submit();
    submit();
    await settle();
    expect(document.activeElement).toBe(send());
    expect(send()?.getAttribute('aria-busy')).toBe('true');
    held.resolve(await accepted({}));
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ input: { block: 'B12', text: 'more' } });
    expect(writes[0]?.key).toMatch(UUID);
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(followUp());
    expect(statuses()).toEqual(['Follow-up sent.']);
    expect(replies()).toEqual(['the answer', 'more']);
  });

  it('cancel restores the button and sends nothing', async () => {
    const { writes } = await open();
    press(followUp(), 'click');
    type('more');
    pressCancel();
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(followUp());
    await settle();
    expect(writes).toHaveLength(0);
    press(followUp(), 'click');
    expect(field()?.value).toBe('');
  });

  it('cancel after a failed follow-up keeps the text and its key', async () => {
    const { d, writes, setTask, accepted } = await open();
    d.routes['block.followup'] = () => problem('outcome_unknown', 500);
    press(followUp(), 'click');
    type('more');
    submit();
    await settle();
    pressCancel();
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(followUp());
    expect(writes).toHaveLength(1);
    press(followUp(), 'click');
    expect(field()?.value).toBe('more');
    expect(item().querySelector('[role="alert"]')?.textContent).toContain('outcome_unknown');
    d.routes['block.followup'] = accepted;
    setTask({ blocks: [answered()], comments: [theAnswer, more] });
    submit();
    await settle();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.key).toBe(writes[0]?.key);
  });

  it('a failed follow-up keeps the text and an unchanged retry reuses its key', async () => {
    const { d, writes } = await open();
    d.routes['block.followup'] = () => problem('outcome_unknown', 500);
    press(followUp(), 'click');
    type('more');
    submit();
    await settle();
    submit();
    await settle();
    expect(item().querySelector('[role="alert"]')?.textContent).toContain('outcome_unknown');
    expect(field()?.value).toBe('more');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.key).toBe(writes[0]?.key);
    type('more, edited');
    submit();
    await settle();
    expect(writes).toHaveLength(3);
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });

  it('offline disables the follow-up field with its reason and keeps the draft', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d, writes } = await open();
    press(followUp(), 'click');
    type('more');
    await goOffline(d);
    const form = item().querySelector('form');
    expect(field()?.disabled).toBe(true);
    expect(send()?.disabled).toBe(true);
    expect(form?.textContent).toContain('Live updates are lost.');
    expect(cancel()?.disabled).toBe(false);
    expect(document.activeElement).toBe(cancel());
    expect(field()?.value).toBe('more');
    submit();
    await settle();
    expect(writes).toHaveLength(0);
  });

  it('an archived task keeps Follow up but disables its send', async () => {
    const { writes } = await open({
      task: { ...taskGet().task, membership: 'archived' },
      blocks: [answered()],
      comments: [theAnswer],
    });
    expect(followUp().disabled).toBe(false);
    press(followUp(), 'click');
    expect(field()?.disabled).toBe(true);
    expect(send()?.disabled).toBe(true);
    expect(item().querySelector('form')?.textContent).toContain('This task is archived.');
    expect(cancel()?.disabled).toBe(false);
    expect(document.activeElement).toBe(cancel());
    submit();
    await settle();
    expect(writes).toHaveLength(0);
    pressCancel();
    expect(document.activeElement).toBe(followUp());
  });

  it('a failed reread keeps the follow-up open until Refresh task succeeds', async () => {
    const { d, writes, setTask } = await open();
    press(followUp(), 'click');
    type('more');
    d.routes['task.get'] = () => problem('unexpected', 500);
    send()?.focus();
    submit();
    await settle();
    expect(field()).not.toBeNull();
    expect(statuses()).toEqual(['Follow-up sent. Could not refresh the task.']);
    const refresh = button('Refresh task');
    expect(item().querySelector('form')?.contains(refresh)).toBe(true);
    setTask({ blocks: [answered()], comments: [theAnswer, more] });
    press(refresh, 'click');
    await settle();
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(followUp());
    expect(statuses()).toEqual(['Follow-up sent.']);
    expect(writes).toHaveLength(1);
  });

  it('answering then following up leaves one status', async () => {
    const { writes, setTask } = await open({ blocks: [block()], comments: [] });
    type('the answer');
    setTask({ blocks: [answered()], comments: [theAnswer] });
    submit();
    await settle();
    expect(statuses()).toEqual(['Answer sent.']);
    press(followUp(), 'click');
    expect(item().textContent).not.toContain('Answer sent.');
    type('more');
    setTask({ blocks: [answered()], comments: [theAnswer, more] });
    submit();
    await settle();
    expect(statuses()).toEqual(['Follow-up sent.']);
    expect(writes).toHaveLength(1);
  });
});
