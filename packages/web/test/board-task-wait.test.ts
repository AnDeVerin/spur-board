// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import styles from '../src/board/TaskWait.module.css';
import { never, orchestratorTaskGet, problem } from './board-fixtures.ts';
import { mountEachTest } from './board-harness.ts';
import { AT, click, dialog, open, reread, send, text } from './board-turn-harness.ts';

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
    expect(found.previousElementSibling?.querySelector('a[href]')).not.toBeNull();
    expect(found.nextElementSibling?.textContent).toContain('Why it is here');
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
