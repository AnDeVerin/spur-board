// @vitest-environment happy-dom
// The Turn section around the read after a write: who it names as holder, and when it sends.
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
import { mountEachTest, settle } from './board-harness.ts';
import {
  AT,
  closedTurn,
  open,
  turnSection,
  buttons,
  text,
  summary,
  send,
  click,
} from './board-turn-harness.ts';

mountEachTest();

describe('Turn section after a write', () => {
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
    write:
      'take ok, close refused' | 'take refused' | 'take unanswered' | 'close ok' | 'turn_closed';
    /** How the read after the write goes, for the title. */
    read: string;
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
    /** The header once `answer` arrived. */
    answered?: string;
    /** A read issued before the write, held, and answering after the keyed read's deadline. */
    older?: ReturnType<typeof orchestratorTaskGet>;
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
      read: 'stalls, then an older read shows the old holder',
      after: 'pending',
      older: orchestratorTaskGet({ taken: { by: 'agent:rev/rev-1', at: AT } }),
      header: 'T5 · could not refresh',
      holder: false,
      hold: false,
      plain: STALE,
      sendOff: true,
      answer: held,
      answered: 'T5 · you hold it',
    },
    {
      write: 'take unanswered',
      read: 'is pending',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: held,
      answered: 'T5 · you hold it',
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
    async ({
      write,
      after,
      shows,
      header,
      holder,
      hold,
      plain,
      sendOff,
      answer,
      answered,
      older,
    }) => {
      const { d } = await open();
      if (write === 'take refused') d.routes['inbox.ack'] = () => problem('forbidden', 403);
      if (write === 'take ok, close refused')
        d.routes['task.submit'] = () => problem('head_mismatch', 409);
      if (write === 'turn_closed') d.routes['task.submit'] = () => problem('turn_closed', 409);
      // The ack may have landed, but its answer never arrived.
      if (write === 'take unanswered')
        d.routes['inbox.ack'] = () => Promise.reject(new TypeError('Failed to fetch'));
      // An event read issued before the write; the keyed re-read queues behind it.
      const earlier = deferred();
      if (older !== undefined) {
        d.routes['task.get'] = () => earlier.promise;
        d.send('event: reset\ndata: {}\n\n');
        await settle();
      }
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
      const stalls = after === 'stall' || older !== undefined;
      if (stalls) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await send();
      if (stalls) {
        // The keyed re-read has not answered: past its deadline the section gives up on it.
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        await settle();
      }
      if (older !== undefined) {
        // The older read answers now; it says nothing about the write, so nothing unlocks.
        earlier.resolve(envelope(older));
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
        if (answered !== undefined) expect(summary()).toBe(answered);
      }
    },
  );
});
