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
  button,
  buttons,
  confirmation,
  choose,
  commit,
  reason,
  type,
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
  const UNSETTLED = 'The earlier send may still land; send it again to settle it, or Cancel.';
  /** The text of the task view's "Why it is here" section. */
  const why = () =>
    [...(document.querySelector('[role="dialog"]')?.querySelectorAll('section') ?? [])].find(
      (section) => section.querySelector('[id$="-title"]')?.textContent === 'Why it is here',
    )?.textContent ?? '';
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
      | 'take ok, close refused'
      | 'take refused'
      | 'take unanswered'
      | 'take stalls'
      | 'submit stalls'
      | 'return stalls'
      | 'close ok'
      | 'turn_closed';
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
    /** Answer the read without Cancel, then send again: the take asks with the same key. */
    resend?: true;
    /** After the answered resend the read opens T6, whose new form must start editable. */
    reopen?: true;
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
      write: 'take stalls',
      read: 'is pending',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: held,
      answered: 'T5 · refused, you hold it',
      resend: true,
    },
    {
      write: 'submit stalls',
      read: 'is pending',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: held,
      answered: 'T5 · refused, you hold it',
      resend: true,
    },
    {
      write: 'submit stalls',
      read: 'is pending, then the resend opens T6',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: held,
      answered: 'T5 · refused, you hold it',
      resend: true,
      reopen: true,
    },
    {
      write: 'return stalls',
      read: 'is pending',
      after: 'pending',
      header: 'T5 · refreshing',
      holder: false,
      hold: false,
      plain: REFRESHING,
      sendOff: true,
      answer: held,
      answered: 'T5 · refused, you hold it',
      resend: true,
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
      resend,
      reopen,
    }) => {
      const { d, writes } = await open();
      // The write that may have landed but never answers, and the first request's signal: the
      // deadline must abort it, not only stop waiting.
      const stalled = (
        {
          'take stalls': 'inbox.ack',
          'submit stalls': 'task.submit',
          'return stalls': 'task.return',
        } as const
      )[write as 'take stalls' | 'submit stalls' | 'return stalls'] as
        'inbox.ack' | 'task.submit' | 'task.return' | undefined;
      const answering = stalled === undefined ? undefined : d.routes[stalled];
      let stalledSignal: AbortSignal | undefined;
      if (stalled !== undefined) {
        d.routes[stalled] = never;
        const fetcher = d.fetcher;
        d.fetcher = (url, init) => {
          const path = url instanceof Request ? url.url : url.toString();
          if (path.endsWith(`/${stalled}`)) stalledSignal ??= init?.signal ?? undefined;
          return fetcher(url, init);
        };
      }
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
      if (write === 'return stalls') {
        await click('Return to dev…');
        type(reason(), 'Handle the empty list.');
      } else await click('Submit…');
      const stalls = after === 'stall' || older !== undefined || stalled !== undefined;
      if (stalls) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await send();
      if (stalls) {
        if (stalled !== undefined) {
          // Just before the deadline the stalled request still runs.
          await act(() => vi.advanceTimersByTimeAsync(14_999));
          expect(stalledSignal?.aborted).toBe(false);
        }
        // The keyed re-read has not answered: past its deadline the section gives up on it.
        await act(() => vi.advanceTimersByTimeAsync(stalled === undefined ? 15_000 : 1));
        await settle();
        if (stalled !== undefined) expect(stalledSignal?.aborted).toBe(true);
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
      // Nothing is in flight any more: an open form's Cancel works.
      if (primary !== null) expect(button('Cancel').disabled).toBe(false);
      // While the re-read has not answered, Why names no holder either.
      if (plain !== undefined) expect(why()).toContain('holder unknown');
      if (resend === true && answer !== undefined) {
        late.resolve(envelope(answer));
        await settle();
        expect(summary()).toBe(answered);
        expect(why()).not.toContain('holder unknown');
        const closeStalled = stalled === 'task.submit' || stalled === 'task.return';
        if (closeStalled) {
          // The close may still land: the form keeps its input, read-only, until it settles.
          expect(text()).toContain(UNSETTLED);
          expect((stalled === 'task.submit' ? commit() : reason()).disabled).toBe(true);
          if (stalled === 'task.submit') {
            await choose('Skipped');
            expect(
              turnSection().querySelector('[role="tab"][aria-selected="true"]')?.textContent,
            ).toBe('Tested');
          }
        }
        if (stalled !== undefined && answering !== undefined) d.routes[stalled] = answering;
        if (reopen === true)
          d.routes['task.get'] = () =>
            Promise.resolve(
              envelope(
                orchestratorTaskGet(
                  { id: 'T6', at: AT },
                  { turns: [closedTurn('submitted', 'operator')] },
                ),
              ),
            );
        await send();
        // The stalled write is asked again with the same body and key: a replay if it had landed.
        const asked = writes().filter((call) => call.op === stalled);
        expect(asked).toHaveLength(2);
        expect(asked[1]?.key).toBe(asked[0]?.key);
        expect(asked[1]?.input).toEqual(asked[0]?.input);
        if (closeStalled)
          expect(text()).toContain(
            stalled === 'task.submit' ? 'T5 submitted.' : 'T5 returned to dev.',
          );
        if (reopen === true) {
          // The settled close left no lock behind: T6's new form is editable.
          await click('Submit…');
          expect(commit().disabled).toBe(false);
          expect(text()).not.toContain(UNSETTLED);
          expect(confirmation().primary?.disabled).toBe(false);
        }
        return;
      }
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
        expect(why()).not.toContain('holder unknown');
      }
    },
  );
});
