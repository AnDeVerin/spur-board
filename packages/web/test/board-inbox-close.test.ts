// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { quiet } from '../src/ds/index.ts';
import {
  daemon,
  deferred,
  envelope,
  failure,
  hello,
  inbox,
  problem,
  type Daemon,
} from './board-fixtures.ts';
import { all, goOffline, mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();

type Entry = ReturnType<typeof inbox>['items'][number] & Record<string, unknown>;
const base = inbox(1).items[0];
if (base === undefined) throw new Error('no inbox fixture');
/** A board-wide item raised `minutes` after 14:00, so a later one sorts first. */
const item = (id: string, minutes = 0, extra: Record<string, unknown> = {}): Entry => ({
  ...base,
  id,
  project: '_board',
  kind: 'board_observation',
  text: `Item ${id}`,
  at: `2026-11-15T14:${String(minutes).padStart(2, '0')}:00.000Z`,
  ...extra,
});
const layerAll = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const layerOne = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
};
const control = (text: string) => layerAll('button').find((b) => b.textContent === text);
const activeIds = () =>
  [
    ...layerOne('[role="dialog"] [role="tabpanel"] > div').querySelectorAll<HTMLElement>(
      '[data-inbox-id]',
    ),
  ].map((row) => row.dataset['inboxId']);
const handledIds = () =>
  [
    ...layerOne('section[aria-label="Recently handled"]').querySelectorAll<HTMLElement>(
      '[data-inbox-id]',
    ),
  ].map((row) => row.dataset['inboxId']);
const serveInbox = (d: Daemon, items: Entry[], handled: unknown[] = []) => {
  d.routes['inbox.operator'] = () => Promise.resolve(envelope({ items, handled }));
};
/** Records each `item.close` request body; the route still answers. */
const recordCloses = (d: Daemon) => {
  const bodies: { input: unknown; key: unknown }[] = [];
  const inner = d.fetcher;
  d.fetcher = (url, init) => {
    const path = url instanceof Request ? url.url : url.toString();
    if (path.endsWith('/item.close'))
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as never);
    return inner(url, init);
  };
  return bodies;
};
const openInbox = async (d: Daemon) => {
  mount(d);
  await settle();
  const open = all('button').find((b) => b.textContent.includes('inbox'));
  if (!open) throw new Error('no inbox button');
  press(open, 'click');
  await settle();
};
const activate = (text: string) => {
  const found = control(text);
  if (!found) throw new Error(`no button ${text}`);
  act(() => {
    found.focus();
  });
  press(found, 'click');
  return found;
};

describe('inbox Close', () => {
  it('shows Close only on active item entries', async () => {
    const d = daemon();
    const task = item('I3', 1, { project: 'a', kind: 'worker_ended', task: 'ex/repo#7' });
    const turn = item('T2', 2, { project: 'a', kind: 'turn', column: 'dev' });
    const handled = [{ ...item('I9'), handledAt: '2026-11-15T14:30:00.000Z' }];
    serveInbox(d, [item('I1', 3), task, { ...base, id: 'B1' }, turn], handled);
    await openInbox(d);
    expect(activeIds()).toEqual(['I1', 'T2', 'I3', 'B1']);
    for (const id of ['I1', 'I3']) {
      const row = layerOne(`[data-inbox-id="${id}"]`);
      const button = control(`Close ${id}`);
      expect(row.parentElement?.contains(button ?? null)).toBe(true);
      expect(row.contains(button ?? null)).toBe(false);
      expect(row.parentElement?.className).toContain(quiet);
    }
    const closes = layerAll('button').filter((b) => b.textContent.startsWith('Close '));
    expect(closes.map((b) => b.textContent)).toEqual(['Close I1', 'Close I3']);
  });

  it('closes once with one fresh key while busy', async () => {
    const d = daemon();
    serveInbox(d, [item('I1', 2), item('I3', 1)]);
    const bodies = recordCloses(d);
    const held = deferred();
    d.routes['item.close'] = () => held.promise;
    await openInbox(d);
    const button = activate('Close I1');
    press(button, 'click');
    await settle();
    expect(bodies).toEqual([{ input: { item: 'I1' }, key: expect.any(String) as unknown }]);
    expect(button.textContent).toBe('Closing I1');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(button);
    activate('Close I3');
    await settle();
    expect(bodies.map((body) => body.input)).toEqual([{ item: 'I1' }, { item: 'I3' }]);
    expect(bodies[1]?.key).not.toBe(bodies[0]?.key);
  });

  it('shows the confirmed status and moves the entry to handled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const entry = item('I1');
    serveInbox(d, [entry]);
    const held = deferred();
    d.routes['item.close'] = () => held.promise;
    await openInbox(d);
    d.send(hello);
    await settle();
    activate('Close I1');
    await settle();
    d.routes['inbox.operator'] = failure;
    held.resolve(envelope({ item: { id: 'I1', task: null, at: entry.at, summary: 'x' } }));
    await settle();
    expect(layerOne('[role="dialog"] [role="status"]').textContent).toBe(
      'Closed I1, waiting for the board.',
    );
    expect(control('Close I1') ?? control('Closing I1')).toBeUndefined();
    expect(activeIds()).toEqual(['I1']);
    serveInbox(d, [], [{ ...entry, handledAt: '2026-11-15T14:30:00.000Z' }]);
    d.send('event: invalidate\ndata: {"projects":[],"tasks":[]}\n\n');
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(activeIds()).toEqual([]);
    expect(handledIds()).toEqual(['I1']);
  });

  it('moves focus to a neighbouring row after removal', async () => {
    const d = daemon();
    const [first, middle, last] = [item('I1', 3), item('I3', 2), item('I5', 1)];
    serveInbox(d, [first, middle, last]);
    await openInbox(d);
    serveInbox(d, [first, last]);
    activate('Close I3');
    await settle();
    expect(activeIds()).toEqual(['I1', 'I5']);
    expect(document.activeElement).toBe(layerOne('[data-inbox-id="I5"]'));
    serveInbox(d, [first]);
    activate('Close I5');
    await settle();
    expect(document.activeElement).toBe(layerOne('[data-inbox-id="I1"]'));
    serveInbox(d, []);
    activate('Close I1');
    await settle();
    expect(activeIds()).toEqual([]);
    expect(document.activeElement).toBe(layerOne('[role="dialog"] [aria-label="Close"]'));
  });

  it('keeps the entry and shows the error line on failure', async () => {
    const d = daemon();
    serveInbox(d, [item('I1')]);
    const bodies = recordCloses(d);
    const held = deferred();
    const answers = [() => problem('not_found'), () => held.promise];
    d.routes['item.close'] = () => answers.shift()?.() ?? failure();
    await openInbox(d);
    activate('Close I1');
    await settle();
    expect(activeIds()).toEqual(['I1']);
    expect(layerOne('[role="dialog"] [role="alert"]').textContent).toBe(
      'Could not close I1: not_found',
    );
    const retry = control('Close I1');
    expect(retry?.getAttribute('aria-busy')).toBeNull();
    activate('Close I1');
    await settle();
    expect(layerAll('[role="dialog"] [role="alert"]')).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.key).toBe(bodies[0]?.key);
  });

  it('hides a raw parse error behind the plain fallback', async () => {
    const d = daemon();
    serveInbox(d, [item('I1')]);
    d.routes['item.close'] = () =>
      Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }));
    await openInbox(d);
    activate('Close I1');
    await settle();
    expect(activeIds()).toEqual(['I1']);
    expect(layerOne('[role="dialog"] [role="alert"]').textContent).toBe(
      'Could not close I1: the request failed.',
    );
  });

  it('refuses a close while the board is unavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    serveInbox(d, [item('I1')]);
    const bodies = recordCloses(d);
    await openInbox(d);
    await goOffline(d);
    activate('Close I1');
    await settle();
    expect(layerOne('[role="dialog"] [role="alert"]').textContent).toBe(
      'Could not close I1: the board is unavailable.',
    );
    expect(activeIds()).toEqual(['I1']);
    expect(bodies).toEqual([]);
  });
});
