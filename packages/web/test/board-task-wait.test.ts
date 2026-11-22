// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import styles from '../src/board/TaskWait.module.css';
import { REREAD_LIMIT_MS } from '../src/board/turn-model.ts';
import { failure, never, orchestratorTaskGet, problem } from './board-fixtures.ts';
import { mountEachTest, press, settle } from './board-harness.ts';
import { AT, click, dialog, open, reread, send, setTask, text } from './board-turn-harness.ts';

mountEachTest();

const WAKES = '2026-11-15T13:30:00.000Z';
const minutesBefore = (minutes: number) => () => Date.parse(WAKES) - minutes * 60_000;
const wait = { reason: 'a free stand', since: AT, wakesAt: WAKES };
const taken = { by: 'agent:rev/rev-1', at: AT };
const TEXT = 'waiting: a free stand · wakes 13:30';

const strip = () => dialog().querySelector<HTMLElement>('[role="img"][aria-label^="waiting:"]');
const shown = () => {
  const found = strip();
  if (!found) throw new Error('no wait strip');
  return found;
};

describe('wait strip', () => {
  it('shows the active wait under the chips and above Why, named in full', async () => {
    await open(orchestratorTaskGet({ taken, wait }), undefined, minutesBefore(20));
    const found = shown();
    expect(found.getAttribute('role')).toBe('img');
    expect(found.getAttribute('aria-label')).toBe(`${TEXT} (in 20m)`);
    expect(found.textContent).toBe(`${TEXT} (in 20m)`);
    expect(found.querySelector('p')?.getAttribute('aria-hidden')).toBe('true');
    expect(found.querySelectorAll(':scope > :not([aria-hidden="true"])')).toHaveLength(0);
    expect(found.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const box = found.closest(`.${styles.wait ?? ''}`);
    expect(box?.previousElementSibling?.querySelector('a[href]')).not.toBeNull();
    expect(box?.nextElementSibling?.textContent).toContain('Why it is here');
  });

  it('reads (now) for a wake at or before now and follows the now prop', async () => {
    let now = Date.parse(WAKES) - 65 * 60_000;
    const { d } = await open(orchestratorTaskGet({ taken, wait }), undefined, () => now);
    expect(shown().getAttribute('aria-label')).toBe(`${TEXT} (in 1h 5m)`);
    now = Date.parse(WAKES) + 60_000;
    await reread(d, orchestratorTaskGet({ taken, wait }));
    expect(shown().getAttribute('aria-label')).toBe(`${TEXT} (now)`);
    expect(shown().textContent).toContain('(now)');
  });

  it('is absent without a wait, on an untaken turn and once the wait ends', async () => {
    const { d } = await open(orchestratorTaskGet({ taken }));
    expect(strip()).toBeNull();
    await reread(d, orchestratorTaskGet({ wait }));
    expect(strip()).toBeNull();
    await reread(d, orchestratorTaskGet({ taken, wait }));
    expect(strip()).not.toBeNull();
    await reread(d, orchestratorTaskGet({ taken }));
    expect(strip()).toBeNull();
  });

  it('is absent on an operator turn, as the card shows no wait there', async () => {
    await open(
      orchestratorTaskGet({ addressee: 'operator', taken: { by: 'operator', at: AT }, wait }),
    );
    expect(strip()).toBeNull();
  });

  it('wraps a long unbroken reason and keeps it whole in the name', async () => {
    const reason = 'x'.repeat(200);
    await open(
      orchestratorTaskGet({ taken, wait: { ...wait, reason } }),
      undefined,
      minutesBefore(20),
    );
    const found = shown();
    expect(found.getAttribute('aria-label')).toBe(`waiting: ${reason} · wakes 13:30 (in 20m)`);
    const line = found.querySelector('p');
    expect(line?.className).toBe(styles.text);
    expect(line?.textContent).toContain(reason);
  });

  it('is hidden while the re-read after a write is pending', async () => {
    const { d } = await open(orchestratorTaskGet({ taken: { by: 'operator', at: AT }, wait }));
    expect(strip()).not.toBeNull();
    d.routes['task.submit'] = () => problem('head_mismatch', 409);
    d.routes['task.get'] = never;
    await click('Submit…');
    await send();
    expect(text()).toContain('Refreshing the turn…');
    expect(strip()).toBeNull();
  });
});

describe('End wait', () => {
  /** The link, idle (`End wait`) or busy (`Ending wait`). */
  const endWait = () =>
    [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent.startsWith('End'),
    );
  const control = () => {
    const found = endWait();
    if (!found) throw new Error('no End wait link');
    return found;
  };
  const whyToggle = () =>
    [...dialog().querySelectorAll('section')]
      .find((candidate) => candidate.textContent.includes('Why it is here'))
      ?.querySelector('button');
  const alert = () =>
    shown()
      .closest(`.${styles.wait ?? ''}`)
      ?.querySelector('[role="alert"]');
  const ends = (calls: { op: string }[]) => calls.filter((call) => call.op === 'task.wait');
  const end = async () => {
    press(control(), 'click');
    await settle();
  };

  it("follows the image inside the strip on an agent's wait, named for the turn", async () => {
    await open(orchestratorTaskGet({ taken, wait }), undefined, minutesBefore(20));
    const link = control();
    expect(link.tagName).toBe('BUTTON');
    expect(link.textContent).toBe('End wait for T5');
    expect(link.querySelector(`.${styles.hidden ?? ''}`)?.textContent).toBe(' for T5');
    expect(link.classList.contains(styles.end ?? '')).toBe(true);
    expect(link.previousElementSibling).toBe(shown());
    expect(link.parentElement?.className).toBe(styles.strip);
    expect(shown().contains(link)).toBe(false);
  });

  it('has no link on a wait the operator holds', async () => {
    await open(orchestratorTaskGet({ taken: { by: 'operator', at: AT }, wait }));
    expect(strip()).not.toBeNull();
    expect(endWait()).toBeUndefined();
  });

  it('sends one keyed end, busy while it runs, then hands focus to Why once the strip goes', async () => {
    const { d, writes } = await open(orchestratorTaskGet({ taken, wait }));
    d.routes['task.wait'] = never;
    control().focus();
    await end();
    expect(writes()).toEqual([
      { op: 'task.wait', input: { turn: 'T5', end: true }, key: expect.any(String) as unknown },
    ]);
    expect(writes()[0]?.key?.trim()).not.toBe('');
    expect(control().getAttribute('aria-busy')).toBe('true');
    expect(control().textContent).toBe('Ending wait for T5');
    expect(dialog().querySelector('[role="alertdialog"]')).toBeNull();

    const { d: next } = await open(orchestratorTaskGet({ taken, wait }));
    setTask(next, orchestratorTaskGet({ taken }));
    control().focus();
    await end();
    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(whyToggle());
  });

  it('leaves focus where it was when the link did not hold it', async () => {
    const { d } = await open(orchestratorTaskGet({ taken, wait }));
    setTask(d, orchestratorTaskGet({ taken }));
    const close = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === 'Close',
    );
    if (!close) throw new Error('no Close button');
    close.focus();
    await end();
    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(close);
  });

  it('shows a refusal after the strip and retries with the same key', async () => {
    const { d, calls } = await open(orchestratorTaskGet({ taken, wait }));
    d.routes['task.wait'] = () => problem('no_active_wait', 409);
    await end();
    expect(strip()).not.toBeNull();
    expect(control().getAttribute('aria-busy')).toBeNull();
    expect(control().textContent).toBe('End wait for T5');
    const line = alert();
    expect(line?.tagName).toBe('P');
    expect(line?.previousElementSibling?.className).toBe(styles.strip);
    expect(line?.textContent).toBe('Could not end the wait: no_active_wait');
    await end();
    const [first, second] = ends(calls);
    expect(second?.key).toBe(first?.key);
  });

  it('settles a failed re-read with a line, and the next click only re-reads', async () => {
    const { d, calls } = await open(orchestratorTaskGet({ taken, wait }));
    d.routes['task.get'] = failure;
    await end();
    expect(control().getAttribute('aria-busy')).toBeNull();
    expect(control().textContent).toBe('End wait for T5');
    expect(alert()?.textContent).toBe('The wait ended, but the task could not be re-read.');
    setTask(d, orchestratorTaskGet({ taken }));
    await end();
    expect(ends(calls)).toHaveLength(1);
    expect(strip()).toBeNull();
  });

  it('settles a re-read that outlasts the limit with a line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d, calls } = await open(orchestratorTaskGet({ taken, wait }));
    d.routes['task.get'] = never;
    await end();
    expect(control().getAttribute('aria-busy')).toBe('true');
    await act(() => vi.advanceTimersByTimeAsync(REREAD_LIMIT_MS - 1));
    expect(control().getAttribute('aria-busy')).toBe('true');
    await act(() => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(control().getAttribute('aria-busy')).toBeNull();
    expect(alert()?.textContent).toBe('The wait ended, but the task could not be re-read.');
    setTask(d, orchestratorTaskGet({ taken }));
    await end();
    expect(ends(calls)).toHaveLength(1);
  });

  it('refuses while the board is unavailable and drops the line once it is back', async () => {
    const { d, calls } = await open(orchestratorTaskGet({ taken, wait }));
    const statusGet = d.routes['status.get'];
    d.routes['status.get'] = failure;
    await reread(d, orchestratorTaskGet({ taken, wait }));
    await end();
    expect(ends(calls)).toEqual([]);
    expect(alert()?.textContent).toBe('Could not end the wait: the board is unavailable.');
    d.routes['status.get'] = statusGet;
    await reread(d, orchestratorTaskGet({ taken, wait }));
    expect(strip()).not.toBeNull();
    expect(alert()).toBeNull();
  });
});
