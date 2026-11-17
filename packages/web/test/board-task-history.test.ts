// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { quiet } from '../src/ds/index.ts';
import {
  daemon,
  deferred,
  envelope,
  historyEvent,
  problem,
  T,
  taskHistory,
  type Daemon,
} from './board-fixtures.ts';
import { goOffline, mount, mountEachTest, settle } from './board-harness.ts';

mountEachTest();

let calls: { path: string; input: unknown }[] = [];
/** Mounts the board on `d`, recording every operation call. */
function start(d: Daemon) {
  calls = [];
  mount({
    ...d,
    fetcher: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path !== '/v1/events') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          input?: unknown;
        };
        calls.push({ path, input: body.input });
      }
      return d.fetcher(url, init);
    },
  });
}
const historyCalls = () => calls.filter(({ path }) => path === '/v1/ops/task.history');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (selector: string) => {
  const found = dialog()?.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector} in the dialog`);
  return found;
};
const panel = () => inDialog('[role="tabpanel"] [role="region"][aria-label="History"]');
const click = (target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
};
const button = (text: string) => {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`no ${text} button`);
  return found;
};
/** Opens `key` from the address and selects History. */
async function openHistory(d: Daemon, key = 'ex%2Frepo%237') {
  history.replaceState(null, '', `/?open=${key}`);
  start(d);
  await settle();
  click(inDialog('[role="tab"]:not([aria-selected="true"])'));
  await settle();
}
const cells = () =>
  [...panel().querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent),
  );

describe('task history tab', () => {
  it('lists events newest first; the only new request is task.history', async () => {
    history.replaceState(null, '', '/?open=ex%2Frepo%237');
    start(daemon());
    await settle();
    const before = calls.length;
    click(inDialog('[role="tab"]:not([aria-selected="true"])'));
    await settle();
    expect(calls.slice(before)).toEqual([
      { path: '/v1/ops/task.history', input: { task: 'ex/repo#7' } },
    ]);
    expect(inDialog('table').getAttribute('aria-label')).toBe('Task history');
    expect(cells()).toEqual([
      ['15:00 15/11/26', 'Raised a flag. · system', 'flag_raised'],
      ['15:00 15/11/26', 'Moved to Review. · system', 'task_moved'],
      ['14:55 15/11/26', 'Answered B12. · operator (slack)', 'block_unblocked'],
      ['14:50 15/11/26', 'Commented. · operator (web)', 'comment_added'],
      ['14:45 15/11/26', 'Closed the turn. · web-7', 'turn_closed'],
      ['14:42 15/11/26', 'Took the turn. · web-7', 'turn_taken'],
      ['14:41 15/11/26', 'Opened a worker turn in Dev. · system', 'turn_opened'],
      ['14:40 15/11/26', 'Added to Dev. · operator', 'task_added'],
    ]);
  });

  it('every row is quiet', async () => {
    await openHistory(daemon());
    const rows = [...panel().querySelectorAll('tr')];
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.classList.contains(quiet)).toBe(true);
  });

  it('an unknown kind renders with its raw kind and summary next to the others', async () => {
    const d = daemon();
    d.routes['task.history'] = () =>
      Promise.resolve(
        envelope(
          taskHistory([
            historyEvent(T, 'task_added', 'operator', 'Added to Dev.'),
            historyEvent(T, 'future_kind', 'system', 'Something new.'),
          ]),
        ),
      );
    await openHistory(d);
    expect(cells()).toEqual([
      ['14:40 15/11/26', 'Something new. · system', 'future_kind'],
      ['14:40 15/11/26', 'Added to Dev. · operator', 'task_added'],
    ]);
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
  });

  it('zero events show the empty note', async () => {
    const d = daemon();
    d.routes['task.history'] = () => Promise.resolve(envelope(taskHistory([])));
    await openHistory(d);
    expect(panel().textContent).toBe('No journal events for this task.');
  });

  it('a not_found history shows "Task not found."', async () => {
    const d = daemon();
    d.routes['task.history'] = () => problem('not_found');
    await openHistory(d);
    expect(panel().textContent).toBe('Task not found.');
  });

  it('a key that is not a task key shows "Task not found." and reads no history', async () => {
    await openHistory(daemon(), '509');
    expect(panel().textContent).toBe('Task not found.');
    expect(historyCalls()).toHaveLength(0);
  });

  it('a failure with no rows shows only the banner; Retry sends one read and stays busy', async () => {
    const d = daemon();
    d.routes['task.history'] = () => problem('unexpected', 500);
    await openHistory(d);
    expect(inDialog('[role="alert"]').textContent).toContain('Could not load the history.');
    expect(panel().querySelector('table')).toBeNull();
    expect(panel().querySelector('div[aria-hidden="true"]')).toBeNull();
    expect(panel().textContent).not.toContain('No journal events');
    const held = deferred();
    d.routes['task.history'] = () => held.promise;
    const count = historyCalls().length;
    click(button('Retry'));
    await settle();
    expect(historyCalls()).toHaveLength(count + 1);
    const busy = button('Retrying');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(panel().querySelector('div[aria-hidden="true"]')).not.toBeNull();
    click(busy);
    await settle();
    expect(historyCalls()).toHaveLength(count + 1);
    held.resolve(envelope(taskHistory()));
    await settle();
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    expect(panel().querySelectorAll('tr')).toHaveLength(8);
  });

  it('a failed re-read keeps the rows under the banner; offline shows no banner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    await openHistory(d);
    d.routes['task.history'] = () => problem('unexpected', 500);
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(inDialog('[role="alert"]').textContent).toContain('Could not load the history.');
    expect(panel().querySelectorAll('tr')).toHaveLength(8);
    await goOffline(d);
    expect(document.querySelector('header')?.textContent).toContain('offline');
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    expect(panel().querySelectorAll('tr')).toHaveLength(8);
  });

  it('a re-read in flight keeps the rows and shows no skeleton', async () => {
    const d = daemon();
    await openHistory(d);
    const held = deferred();
    d.routes['task.history'] = () => held.promise;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(panel().querySelectorAll('tr')).toHaveLength(8);
    expect(panel().querySelector('div[aria-hidden="true"]')).toBeNull();
    held.resolve(await problem('not_found'));
    await settle();
    expect(panel().textContent).toBe('Task not found.');
  });

  it('ArrowRight from Now selects History; the modal body is a tab stop for scrolling', async () => {
    history.replaceState(null, '', '/?open=ex%2Frepo%237');
    start(daemon());
    await settle();
    const now = inDialog('[role="tab"][aria-selected="true"]');
    act(() => {
      now.focus();
    });
    act(() => {
      now.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' }),
      );
    });
    await settle();
    expect(document.activeElement?.textContent).toBe('History');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    expect(panel().querySelectorAll('tr')).toHaveLength(8);
    expect(inDialog('[role="tabpanel"]').parentElement?.getAttribute('tabindex')).toBe('0');
    expect(historyCalls()).toHaveLength(1);
  });
});
