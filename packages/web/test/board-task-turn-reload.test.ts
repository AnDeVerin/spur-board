// @vitest-environment happy-dom
// The Turn section across a board update reload: drafts, kept fields and the reload hold.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { orchestratorTaskGet, deferred } from './board-fixtures.ts';
import { mountEachTest, press, settle } from './board-harness.ts';
import { memorySession, versioned } from './board-update-fixtures.ts';
import {
  SOURCE,
  open,
  reread,
  turnSection,
  form,
  text,
  commit,
  reason,
  type,
  send,
  choose,
  click,
  confirmation,
} from './board-turn-harness.ts';

mountEachTest();

describe('Turn section and the board update guard', () => {
  const draftId = (turn: string, form: string) => JSON.stringify(['turn', 'ex/repo#7', turn, form]);
  /**
   * The page runs 0.4.0; `daemon.version` is what the daemon's answers say. `kept` is the drafts a
   * reload after an update saved, as the reopened page finds them.
   */
  async function openVersioned(kept: Record<string, string> = {}) {
    const daemonVersion = { value: '0.4.0' };
    const session = memorySession({
      values: Object.keys(kept).length > 0 ? { 'board-drafts': JSON.stringify(kept) } : {},
    });
    const reload = vi.fn();
    const opened = await open(undefined, { version: '0.4.0', session: session.session, reload });
    const fetcher = versioned(opened.d.fetcher, () => daemonVersion.value);
    opened.d.fetcher = fetcher.fetch;
    return { ...opened, daemonVersion, session, reload };
  }

  it('holds a board update reload while the ack and the close run, then reloads', async () => {
    const { d, daemonVersion, reload } = await openVersioned();
    const ack = deferred();
    const answer = d.routes['inbox.ack'];
    d.routes['inbox.ack'] = () => {
      daemonVersion.value = '0.5.0';
      return ack.promise;
    };
    await click('Submit…');
    act(() => {
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // Another answer from the updated daemon arrives while the ack is still open.
    await reread(d, orchestratorTaskGet());
    expect(reload).not.toHaveBeenCalled();
    ack.resolve(await answer({ entries: [{ id: 'T5' }] }));
    await settle();
    expect(text()).toContain('T5 submitted.');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsent reason across a board update reload', async () => {
    const { d, daemonVersion, session, reload } = await openVersioned();
    await click('Return to dev…');
    type(reason(), 'Handle the empty list.');
    daemonVersion.value = '0.5.0';
    await reread(d, orchestratorTaskGet());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(session.values.get('board-drafts') ?? '{}')).toEqual({
      [draftId('T5', 'return')]: 'Handle the empty list.',
    });
  });
});

describe('Turn section after a reload', () => {
  it('restores a kept reason only into the same form of the same turn', async () => {
    const id = (turn: string, form: string) => JSON.stringify(['turn', 'ex/repo#7', turn, form]);
    const session = memorySession({
      values: {
        'board-drafts': JSON.stringify({
          [id('T5', 'return')]: 'Kept for returning T5.',
          [id('T4', 'submit')]: 'Kept for an older turn.',
        }),
      },
    });
    await open(undefined, { version: '0.4.0', session: session.session, reload: vi.fn() });
    await click('Submit…');
    await choose('Skipped');
    expect(reason().value).toBe('');
    await click('Cancel');
    await click('Return to dev…');
    expect(reason().value).toBe('Kept for returning T5.');
  });

  it.each([
    ['Skipped', { sha: 'c'.repeat(40), basis: 'skipped', from: '', reason: 'Checked by hand.' }],
    ['Carried', { sha: 'c'.repeat(40), basis: 'carried', from: SOURCE, reason: 'Same tree.' }],
  ])('restores a kept %s submit draft with its basis and fields', async (label, kept) => {
    const id = JSON.stringify(['turn', 'ex/repo#7', 'T5', 'submit']);
    const session = memorySession({
      values: { 'board-drafts': JSON.stringify({ [id]: JSON.stringify(kept) }) },
    });
    await open(undefined, { version: '0.4.0', session: session.session, reload: vi.fn() });
    await click('Submit…');
    expect(turnSection().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      label,
    );
    expect(commit().value).toBe(kept.sha);
    expect(reason().value).toBe(kept.reason);
    if (kept.basis === 'carried')
      expect(
        turnSection().querySelector<HTMLInputElement>('input[aria-label="Carried from"]')?.value,
      ).toBe(SOURCE);
  });

  it('saves a submit draft with its basis', async () => {
    const daemonVersion = { value: '0.4.0' };
    const session = memorySession();
    const reload = vi.fn();
    const { d } = await open(undefined, { version: '0.4.0', session: session.session, reload });
    d.fetcher = versioned(d.fetcher, () => daemonVersion.value).fetch;
    await click('Submit…');
    await choose('Skipped');
    type(reason(), 'Checked by hand.');
    daemonVersion.value = '0.5.0';
    await reread(d, orchestratorTaskGet());
    expect(reload).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(session.values.get('board-drafts') ?? '{}') as Record<string, string>;
    expect(
      JSON.parse(saved[JSON.stringify(['turn', 'ex/repo#7', 'T5', 'submit'])] ?? '{}'),
    ).toEqual({
      sha: 'a'.repeat(40),
      basis: 'skipped',
      from: '',
      reason: 'Checked by hand.',
    });
  });

  it.each([
    [
      'Skipped chosen before any reason',
      { sha: 'a'.repeat(40), basis: 'skipped', from: '', reason: '' },
    ],
    ['an edited commit on Tested', { sha: 'c'.repeat(40), basis: 'tested', from: '', reason: '' }],
  ])('keeps a submit draft with %s across a reload and restores it whole', async (_, kept) => {
    const daemonVersion = { value: '0.4.0' };
    const session = memorySession();
    const reload = vi.fn();
    const { d } = await open(undefined, { version: '0.4.0', session: session.session, reload });
    d.fetcher = versioned(d.fetcher, () => daemonVersion.value).fetch;
    await click('Submit…');
    if (kept.basis === 'skipped') await choose('Skipped');
    else type(commit(), kept.sha);
    daemonVersion.value = '0.5.0';
    await reread(d, orchestratorTaskGet());
    expect(reload).toHaveBeenCalledTimes(1);
    const id = JSON.stringify(['turn', 'ex/repo#7', 'T5', 'submit']);
    const saved = JSON.parse(session.values.get('board-drafts') ?? '{}') as Record<string, string>;
    expect(JSON.parse(saved[id] ?? '{}')).toEqual(kept);
  });

  it('reopens a kept Skipped draft without a reason as Skipped and still asks for the reason', async () => {
    const id = JSON.stringify(['turn', 'ex/repo#7', 'T5', 'submit']);
    const kept = { sha: 'a'.repeat(40), basis: 'skipped', from: '', reason: '' };
    const session = memorySession({
      values: { 'board-drafts': JSON.stringify({ [id]: JSON.stringify(kept) }) },
    });
    const { writes } = await open(undefined, {
      version: '0.4.0',
      session: session.session,
      reload: vi.fn(),
    });
    await click('Submit…');
    expect(turnSection().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Skipped',
    );
    await send();
    expect(text()).toContain('Enter a reason.');
    expect(writes()).toEqual([]);
  });

  it('blocks a second send of the turn from a reopened view while the first one runs', async () => {
    const daemonVersion = { value: '0.4.0' };
    const session = memorySession();
    const reload = vi.fn();
    const { d, writes } = await open(undefined, {
      version: '0.4.0',
      session: session.session,
      reload,
    });
    d.fetcher = versioned(d.fetcher, () => daemonVersion.value).fetch;
    const ack = deferred();
    const answer = d.routes['inbox.ack'];
    d.routes['inbox.ack'] = () => ack.promise;
    await click('Submit…');
    act(() => {
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const close = document.querySelector('[role="dialog"] [aria-label="Close"]');
    if (!close) throw new Error('no Close');
    press(close, 'click');
    await settle();
    const card = document.querySelector('main a[title="ex/repo#7"]');
    if (!card) throw new Error('no card');
    press(card, 'click');
    await settle();
    await click('Submit…');
    expect(confirmation().primary?.disabled).toBe(true);
    expect(text()).toContain('An earlier send of T5 is still running.');
    await send();
    expect(writes().filter((call) => call.op === 'inbox.ack')).toHaveLength(1);
    daemonVersion.value = '0.5.0';
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(reload).not.toHaveBeenCalled();
    ack.resolve(await answer({ entries: [{ id: 'T5' }] }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps holding the reload when the task view closes mid-send', async () => {
    const daemonVersion = { value: '0.4.0' };
    const session = memorySession();
    const reload = vi.fn();
    const { d } = await open(undefined, { version: '0.4.0', session: session.session, reload });
    d.fetcher = versioned(d.fetcher, () => daemonVersion.value).fetch;
    const ack = deferred();
    const answer = d.routes['inbox.ack'];
    d.routes['inbox.ack'] = () => ack.promise;
    await click('Submit…');
    act(() => {
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const close = document.querySelector('[role="dialog"] [aria-label="Close"]');
    if (!close) throw new Error('no Close');
    press(close, 'click');
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    daemonVersion.value = '0.5.0';
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(reload).not.toHaveBeenCalled();
    ack.resolve(await answer({ entries: [{ id: 'T5' }] }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
