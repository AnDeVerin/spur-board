// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { focusRing } from '../src/ds/index.ts';
import {
  deferred,
  envelope,
  failure,
  never,
  orchestratorTaskGet,
  problem,
  taskGet,
} from './board-fixtures.ts';
import { mountEachTest, press, settle } from './board-harness.ts';
import {
  AT,
  HEAD,
  closedTurn,
  open,
  setTask,
  reread,
  turnSection,
  button,
  buttons,
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
    expect(document.activeElement?.textContent).toBe('T5 submitted. The task is in review.');
    expect(document.activeElement?.getAttribute('role')).toBe('status');
    // Focused by the section, the status line shows the design system's one focus ring.
    expect(document.activeElement?.classList.contains(focusRing)).toBe(true);
  });

  it('keeps the own-close result after task.get answers turn null', async () => {
    const { d } = await open();
    await click('Submit…');
    const afterSubmit = orchestratorTaskGet(
      {},
      { turn: null, turns: [closedTurn('submitted', 'operator')] },
    );
    setTask(d, afterSubmit);
    await send();
    await reread(d, afterSubmit);
    const status = turnSection().querySelector('[role="status"]');
    expect(status?.textContent).toBe('T5 submitted. The task is in review.');
    expect(document.activeElement).toBe(status);
    expect(text()).not.toContain('was closed by');
    expect(summary()).toBe('T5 submitted');
    // The line states the task's column from the latest read, and predicts nothing.
    await reread(
      d,
      orchestratorTaskGet(
        {},
        {
          task: { ...taskGet().task, column: 'qa' },
          turn: null,
          turns: [closedTurn('submitted', 'operator')],
        },
      ),
    );
    expect(turnSection().querySelector('[role="status"]')?.textContent).toBe(
      'T5 submitted. The task is in qa.',
    );
  });

  // The submit's answer has the task in Review, the return's in Dev. A read that still shows T5 open
  // is older than the close, so the line names the answer's column; a read that shows T5 closed
  // names its own.
  const openRead = (column: string) =>
    orchestratorTaskGet({}, { task: { ...taskGet().task, column } });
  const closedRead = (column: string) =>
    orchestratorTaskGet(
      {},
      {
        task: { ...taskGet().task, column },
        turn: null,
        turns: [closedTurn('submitted', 'operator')],
      },
    );
  it.each([
    ['submit', 'no read follows the write', undefined, 'never', 'review'],
    [
      'submit',
      'a read during the send still shows the turn open',
      openRead('dev'),
      'never',
      'review',
    ],
    [
      'submit',
      'a read during the send already shows the close in QA',
      closedRead('qa'),
      'never',
      'qa',
    ],
    ['submit', 'the read after the write fails', undefined, 'fail', 'review'],
    ['submit', 'the read after the write shows the close in QA', undefined, closedRead('qa'), 'qa'],
    // The open read says Review and the answer Dev, so only the answer can name Dev here.
    ['return', 'the read after the write fails', undefined, 'fail', 'dev'],
  ] as const)('names the column of the own %s when %s', async (kind, _, during, after, column) => {
    const { d } = await open();
    const write = deferred();
    const route = kind === 'submit' ? 'task.submit' : 'task.return';
    const answer = d.routes[route];
    d.routes[route] = () => write.promise;
    if (kind === 'submit') await click('Submit…');
    else {
      await click('Return to dev…');
      type(reason(), 'Handle the empty list.');
    }
    await send();
    if (during !== undefined) await reread(d, during);
    d.routes['task.get'] =
      after === 'never'
        ? never
        : after === 'fail'
          ? failure
          : () => Promise.resolve(envelope(after));
    write.resolve(
      await answer(
        kind === 'submit'
          ? { turn: 'T5', sha: HEAD }
          : { turn: 'T5', reason: 'Handle the empty list.' },
      ),
    );
    await settle();
    expect(turnSection().querySelector('[role="status"]')?.textContent).toBe(
      `T5 ${kind === 'submit' ? 'submitted' : 'returned to dev'}. The task is in ${column}.`,
    );
  });

  const HOLD =
    'You hold T5; the orchestrator cannot submit or return it until you finish or it takes the turn back.';
  const STALE = 'Could not refresh the turn. Reload to see who holds it.';
  const REFRESHING = 'Refreshing the turn…';
  const held = orchestratorTaskGet({ taken: { by: 'operator', at: AT } });
  const closedBy = (column: string) =>
    orchestratorTaskGet(
      {},
      {
        task: { ...taskGet().task, column },
        turn: null,
        turns: [closedTurn('submitted')],
      },
    );
  // Write outcome x the read after it. While that read is pending or after it failed, the section
  // names no holder, shows one plain line and sends nothing; Cancel then focuses that line. A
  // refused take writes nothing, so no read follows it.
  type Row = {
    write: 'take ok, close refused' | 'take refused' | 'close ok' | 'turn_closed';
    read:
      'answers' | 'fails' | 'is pending' | 'is pending, then opens T6' | 'stalls past the deadline';
    after: ReturnType<typeof orchestratorTaskGet> | 'fail' | 'pending' | 'stall';
    shows?: string;
    header: string;
    holder: boolean;
    hold: boolean;
    plain?: string;
    /** Whether the form's send is disabled; null once the form closed. */
    sendOff: boolean | null;
    /** What a pending read answers after Cancel; focus then lands on the last Submit…. */
    answer?: ReturnType<typeof orchestratorTaskGet>;
  };
  it.each<Row>([
    {
      write: 'take ok, close refused',
      read: 'answers',
      after: held,
      shows: 'taken by you',
      header: 'T5 · refused, you hold it',
      holder: true,
      hold: true,
      sendOff: false,
    },
    {
      write: 'take ok, close refused',
      read: 'is pending',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: held,
    },
    {
      write: 'take ok, close refused',
      read: 'is pending, then opens T6',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: orchestratorTaskGet({ id: 'T6', at: AT }, { turns: [closedTurn('submitted')] }),
    },
    {
      write: 'take ok, close refused',
      read: 'stalls past the deadline',
      after: 'stall',
      header: 'T5 · could not refresh',
      holder: false,
      hold: false,
      plain: STALE,
      sendOff: true,
    },
    {
      write: 'take ok, close refused',
      read: 'fails',
      after: 'fail',
      header: 'T5 · could not refresh',
      holder: false,
      hold: false,
      plain: STALE,
      sendOff: true,
    },
    {
      write: 'take refused',
      read: 'answers',
      after: held,
      shows: 'not taken',
      header: 'T5 · refused',
      holder: false,
      hold: false,
      sendOff: false,
    },
    {
      write: 'take refused',
      read: 'fails',
      after: 'fail',
      shows: 'not taken',
      header: 'T5 · refused',
      holder: false,
      hold: false,
      sendOff: false,
    },
    {
      write: 'close ok',
      read: 'answers',
      after: closedBy('qa'),
      shows: 'T5 submitted. The task is in qa.',
      header: 'T5 submitted',
      holder: false,
      hold: false,
      sendOff: null,
    },
    {
      write: 'close ok',
      read: 'fails',
      after: 'fail',
      shows: 'T5 submitted. The task is in review.',
      header: 'T5 submitted',
      holder: false,
      hold: false,
      sendOff: null,
    },
    {
      write: 'turn_closed',
      read: 'answers',
      after: closedBy('qa'),
      shows: 'T5 was closed by qa / qa-1',
      header: 'T5 closed by qa-1',
      holder: false,
      hold: false,
      sendOff: true,
    },
    {
      write: 'turn_closed',
      read: 'fails',
      after: 'fail',
      shows: 'T5 was closed',
      header: 'T5 closed',
      holder: false,
      hold: false,
      sendOff: true,
    },
  ])(
    'after $write and a read that $read, claims the holder only from a read',
    async ({ write, after, shows, header, holder, hold, plain, sendOff, answer }) => {
      const { d } = await open();
      if (write === 'take refused') d.routes['inbox.ack'] = () => problem('forbidden', 403);
      if (write === 'take ok, close refused')
        d.routes['task.submit'] = () => problem('head_mismatch', 409);
      if (write === 'turn_closed') d.routes['task.submit'] = () => problem('turn_closed', 409);
      const late = deferred();
      d.routes['task.get'] =
        after === 'fail'
          ? failure
          : after === 'pending'
            ? () => late.promise
            : after === 'stall'
              ? never
              : () => Promise.resolve(envelope(after));
      await click('Submit…');
      if (after === 'stall') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await send();
      if (after === 'stall') {
        // The keyed re-read never answers: past its deadline the section gives up on it.
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        await settle();
      }
      if (shows !== undefined) expect(text()).toContain(shows);
      expect(summary()).toBe(header);
      expect(text().includes('taken by you')).toBe(holder);
      expect(text().includes(HOLD)).toBe(hold);
      expect(text().includes(STALE)).toBe(plain === STALE);
      expect(text().includes(REFRESHING)).toBe(plain === REFRESHING);
      const primary = turnSection().querySelector<HTMLButtonElement>('form button[type="submit"]');
      expect(primary === null ? null : primary.disabled).toBe(sendOff);
      if (plain !== undefined) {
        // Both opening actions are off then, so Cancel focuses the plain line, with the ring.
        await click('Cancel');
        expect(document.activeElement?.textContent).toBe(plain);
        expect(document.activeElement?.classList.contains(focusRing)).toBe(true);
      }
      if (answer !== undefined) {
        // The read answers and the focused line goes: focus moves to the first enabled action,
        // the newer turn's when the read closed T5 and opened T6.
        late.resolve(envelope(answer));
        await settle();
        const submits = buttons().filter((entry) => entry.textContent === 'Submit…');
        expect(document.activeElement).toBe(submits.at(-1));
        expect(submits.at(-1)?.disabled).toBe(false);
      }
    },
  );

  it('re-reads no other task when a close lands after another task opened', async () => {
    const { d } = await open();
    const write = deferred();
    const returned = d.routes['task.return'];
    d.routes['task.return'] = () => write.promise;
    await click('Return to dev…');
    type(reason(), 'Handle the empty list.');
    await send();
    // The operator opens task ABC-3 while the return of ex/repo#7 still runs.
    history.pushState(null, '', '/?open=ABC-3');
    act(() => {
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    const reads: unknown[] = [];
    d.routes['task.get'] = (input) => {
      reads.push(input['task']);
      return Promise.resolve(envelope(taskGet()));
    };
    write.resolve(await returned({ turn: 'T5', reason: 'Handle the empty list.' }));
    await settle();
    expect(reads).toEqual([]);
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
