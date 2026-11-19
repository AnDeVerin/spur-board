// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { focusRing } from '../src/ds/index.ts';
import { envelope, orchestratorTaskGet, problem, taskGet, deferred } from './board-fixtures.ts';
import { mountEachTest, press, settle } from './board-harness.ts';
import { memorySession, versioned } from './board-update-fixtures.ts';
import {
  AT,
  closedTurn,
  open,
  setTask,
  reread,
  turnSection,
  button,
  form,
  text,
  summary,
  commit,
  reason,
  type,
  send,
  choose,
  click,
  confirmation,
} from './board-turn-harness.ts';

mountEachTest();

describe('Turn section sends', () => {
  it('reuses its keys on a resend after a refusal and takes new ones after an edit', async () => {
    const { d, writes } = await open();
    d.routes['task.submit'] = () => problem('github_unavailable', 503);
    await click('Submit…');
    await send();
    await send();
    const [ack, first, second] = writes();
    expect(ack?.key).toBeTruthy();
    expect(first?.key).toBeTruthy();
    expect(second?.key).toBe(first?.key);
    expect(writes().filter((call) => call.op === 'inbox.ack')).toHaveLength(1);
    type(commit(), 'c'.repeat(40));
    await send();
    const edited = writes().at(-1);
    expect(edited?.op).toBe('task.submit');
    expect(edited?.key).toBeTruthy();
    expect(edited?.key).not.toBe(first?.key);
  });

  it('acks again with a new key after not_turn_taker', async () => {
    const { d, writes } = await open();
    d.routes['task.submit'] = () => problem('not_turn_taker', 403);
    await click('Submit…');
    await send();
    expect(text()).toContain('not_turn_taker');
    await send();
    const acks = writes().filter((call) => call.op === 'inbox.ack');
    expect(acks).toHaveLength(2);
    expect(acks[1]?.key).toBeTruthy();
    expect(acks[1]?.key).not.toBe(acks[0]?.key);
  });

  it('shows the phase and disables the form while the ack and the write run', async () => {
    const { d } = await open();
    const ack = deferred();
    const submit = deferred();
    const answer = d.routes['inbox.ack'];
    const write = d.routes['task.submit'];
    d.routes['inbox.ack'] = (input) => {
      void answer(input).then(ack.resolve);
      return ack.promise;
    };
    let release = () => {};
    d.routes['task.submit'] = (input) => {
      release = () => {
        void write(input).then(submit.resolve);
      };
      return submit.promise;
    };
    await click('Submit…');
    act(() => {
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const check = (phase: string) => {
      const { primary } = confirmation();
      expect(primary?.textContent).toBe(phase);
      expect(primary?.getAttribute('aria-busy')).toBe('true');
      expect(form().querySelector('[role="status"]')?.textContent).toBe(`${phase}…`);
      expect(form().getAttribute('aria-busy')).toBe('true');
      expect(button('Cancel').disabled).toBe(true);
      expect(commit().disabled).toBe(true);
      expect(summary()).toBe('Closing T5…');
    };
    check('Taking the turn');
    await settle();
    check('Closing the turn');
    await choose('Skipped');
    expect(turnSection().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Tested',
    );
    release();
    await settle();
    expect(text()).toContain('T5 submitted.');
  });

  it('shows a refusal in an error banner, clears it on the next send and on Cancel, and shows the hold line after a taken turn', async () => {
    const { d } = await open();
    d.routes['task.submit'] = () => problem('head_mismatch', 409);
    setTask(d, orchestratorTaskGet({ taken: { by: 'operator', at: AT } }));
    await click('Submit…');
    await send();
    const alert = () => turnSection().querySelector('[role="alert"]');
    expect(alert()?.textContent).toContain('head_mismatch');
    const order = [...form().children].map((child) => child.getAttribute('role'));
    expect(order.indexOf('alert')).toBe(order.length - 3);
    expect(text()).toContain(
      'You hold T5; the orchestrator cannot submit or return it until you finish or it takes the turn back.',
    );
    expect(summary()).toBe('T5 · refused, you hold it');
    type(commit(), 'c'.repeat(40));
    expect(alert()).not.toBeNull();
    const held = deferred();
    d.routes['task.submit'] = () => held.promise;
    act(() => {
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(alert()).toBeNull();
    held.resolve(await problem('head_mismatch', 409));
    await settle();
    expect(alert()).not.toBeNull();
    await click('Cancel');
    expect(alert()).toBeNull();
    expect(summary()).toBe('T5 · you hold it');
  });
});

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

/** The latest submission of the own Review submit at `HEAD` that closed T5 at `AT`. */
const submittedRow = {
  column: 'review',
  sha: 'a'.repeat(40),
  at: AT,
  basis: 'tested',
  from: null,
  testedOrigin: null,
  reason: null,
  pending: false,
  voided: false,
};

describe('Turn section focus', () => {
  it.each([
    ['the browser blurs the disabled field', true],
    ['focus stays on the disabled field', false],
  ])('moves focus to Cancel when the turn closes elsewhere and %s', async (_, blurs) => {
    const { d } = await open();
    await click('Submit…');
    expect(document.activeElement).toBe(commit());
    let blurred = false;
    commit().addEventListener('blur', () => {
      blurred = true;
    });
    // Chrome blurs a focused control as it becomes disabled, with no related target, so focus
    // is on the body when React's effects run. happy-dom keeps focus on a disabled control and
    // refuses to blur one, so the field blurs here just before it is disabled.
    const field = commit();
    const setAttribute = field.setAttribute.bind(field);
    field.setAttribute = (name: string, value: string) => {
      if (name === 'disabled' && blurs) field.blur();
      setAttribute(name, value);
    };
    await reread(d, orchestratorTaskGet({}, { turn: null, turns: [closedTurn('submitted')] }));
    expect(blurred).toBe(blurs);
    expect(commit().disabled).toBe(true);
    expect(document.activeElement).toBe(button('Cancel'));
  });

  it('moves focus into a form, back on Cancel and to the status line on success', async () => {
    await open();
    await click('Submit…');
    expect(document.activeElement).toBe(commit());
    await click('Cancel');
    expect(document.activeElement).toBe(button('Submit…'));
    await click('Return to dev…');
    expect(document.activeElement).toBe(reason());
    await click('Cancel');
    expect(document.activeElement).toBe(button('Return to dev…'));
    await click('Submit…');
    await send();
    expect(document.activeElement?.textContent).toBe('T5 submitted.');
    expect(document.activeElement?.getAttribute('role')).toBe('status');
    // Focused by the section, the status line shows the design system's one focus ring.
    expect(document.activeElement?.classList.contains(focusRing)).toBe(true);
  });

  it('keeps the own-close result after task.get answers turn null', async () => {
    const { d } = await open();
    d.routes['task.submit'] = (input) =>
      Promise.resolve(
        envelope({
          task: taskGet().task,
          turn: input['turn'],
          sha: input['sha'],
          status: 'pending',
        }),
      );
    await click('Submit…');
    setTask(
      d,
      orchestratorTaskGet({}, { turn: null, turns: [closedTurn('submitted', 'operator')] }),
    );
    await send();
    await reread(
      d,
      orchestratorTaskGet({}, { turn: null, turns: [closedTurn('submitted', 'operator')] }),
    );
    const status = turnSection().querySelector('[role="status"]');
    expect(status?.textContent).toBe(
      'T5 submitted. The board confirms the head on its next polls.',
    );
    expect(document.activeElement).toBe(status);
    expect(text()).not.toContain('was closed by');
    expect(summary()).toBe('T5 submitted');
    // Once a read shows the submission confirmed, the line stops promising a confirmation.
    const confirmed = {
      column: 'review',
      sha: 'a'.repeat(40),
      at: AT,
      basis: 'tested',
      from: null,
      testedOrigin: null,
      reason: null,
      pending: false,
      voided: false,
    };
    await reread(
      d,
      orchestratorTaskGet(
        {},
        { turn: null, turns: [closedTurn('submitted', 'operator')], submission: confirmed },
      ),
    );
    expect(turnSection().querySelector('[role="status"]')?.textContent).toBe('T5 submitted.');
    // An older voided row with the same SHA in the same column is another submit: it neither
    // voids this one nor brings back the wait, and the confirmation already seen stays.
    await reread(
      d,
      orchestratorTaskGet(
        {},
        {
          turn: null,
          turns: [closedTurn('submitted', 'operator')],
          submission: { ...confirmed, voided: true, at: '2026-11-15T12:00:00.000Z' },
        },
      ),
    );
    expect(turnSection().querySelector('[role="status"]')?.textContent).toBe('T5 submitted.');
    // A voided submission no longer counts; nothing here says the work came back to Dev.
    const voided = { ...confirmed, voided: true };
    const line = () => turnSection().querySelector('[role="status"]')?.textContent;
    const VOIDED =
      'T5 submitted. The board voided this submission: it no longer counts for the gates.';
    await reread(
      d,
      orchestratorTaskGet(
        {},
        { turn: null, turns: [closedTurn('submitted', 'operator')], submission: voided },
      ),
    );
    expect(line()).toBe(VOIDED);
    // T6 then submits a replacement: T5's line keeps its settled state, it never waits again.
    const replacement = { ...confirmed, sha: 'c'.repeat(40), at: '2026-11-15T13:40:00.000Z' };
    await reread(
      d,
      orchestratorTaskGet(
        { id: 'T6', at: AT },
        { turns: [closedTurn('submitted', 'operator')], submission: replacement },
      ),
    );
    expect(line()).toBe(VOIDED);
  });

  it.each([
    [
      'the Board handed the work back to Dev',
      'dev',
      ' The work went back to Dev and needs another submit.',
    ],
    ['a merge at another head moved the task to Done', 'done', ''],
  ])('asks for another submit after a void only when %s', async (_, column, handback) => {
    const { d } = await open();
    d.routes['task.submit'] = (input) =>
      Promise.resolve(
        envelope({
          task: taskGet().task,
          turn: input['turn'],
          sha: input['sha'],
          status: 'pending',
        }),
      );
    await click('Submit…');
    await send();
    const voided = { ...submittedRow, voided: true };
    await reread(
      d,
      orchestratorTaskGet(
        {},
        {
          task: { ...taskGet().task, column },
          turn: null,
          turns: [closedTurn('submitted', 'operator')],
          submission: voided,
        },
      ),
    );
    expect(turnSection().querySelector('[role="status"]')?.textContent).toBe(
      `T5 submitted. The board voided this submission: it no longer counts for the gates.${handback}`,
    );
  });

  it('stops promising a confirmation once another submission replaced the own one', async () => {
    const { d } = await open();
    d.routes['task.submit'] = (input) =>
      Promise.resolve(
        envelope({
          task: taskGet().task,
          turn: input['turn'],
          sha: input['sha'],
          status: 'pending',
        }),
      );
    await click('Submit…');
    await send();
    expect(turnSection().querySelector('[role="status"]')?.textContent).toContain(
      'confirms the head',
    );
    const replacement = { ...submittedRow, sha: 'c'.repeat(40), at: '2026-11-15T13:40:00.000Z' };
    await reread(
      d,
      orchestratorTaskGet(
        { id: 'T6', at: AT },
        { turns: [closedTurn('submitted', 'operator')], submission: replacement },
      ),
    );
    expect(turnSection().querySelector('[role="status"]')?.textContent).toBe('T5 submitted.');
  });

  it('skips the success focus while folded', async () => {
    const { d } = await open();
    const held = deferred();
    const write = d.routes['task.submit'];
    let release = () => {};
    d.routes['task.submit'] = (input) => {
      release = () => {
        void write(input).then(held.resolve);
      };
      return held.promise;
    };
    await click('Submit…');
    await send();
    const chevron = turnSection().querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!chevron) throw new Error('no chevron');
    press(chevron, 'click');
    chevron.focus();
    expect(summary()).toBe('Closing T5…');
    release();
    await settle();
    expect(document.activeElement).toBe(chevron);
    expect(summary()).toBe('T5 submitted');
  });
});
