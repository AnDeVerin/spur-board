// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { focusRing } from '../src/ds/index.ts';
import {
  allMet,
  condition,
  gate,
  orchestratorTaskGet,
  problem,
  taskGet,
} from './board-fixtures.ts';
import { mountEachTest, press, settle } from './board-harness.ts';
import {
  HEAD,
  SOURCE,
  AT,
  closedTurn,
  open,
  setTask,
  reread,
  dialog,
  section,
  turnSection,
  buttons,
  button,
  text,
  summary,
  commit,
  source,
  reason,
  type,
  send,
  choose,
  click,
  confirmation,
} from './board-turn-harness.ts';

mountEachTest();

const REEVALUATE = "This closes T5 in your name and the board re-evaluates the task's gates.";
const UNMET =
  ' Some exit conditions do not hold now, so the task may wait, or move back to a column whose gate fails.';

describe('Turn section', () => {
  it('shows an open orchestrator turn with its taker and both actions', async () => {
    await open(orchestratorTaskGet({ taken: { by: 'agent:rev/rev-1', at: AT } }));
    expect(text()).toContain('T5');
    expect(text()).toContain('review · orchestrator rev-bot · taken by rev / rev-1 · 0m');
    expect(buttons().map((entry) => entry.textContent)).toEqual(
      expect.arrayContaining(['Submit…', 'Return to dev…']),
    );
    expect(text()).toContain('You can close this turn yourself when the orchestrator is down');
    expect(summary()).toBe('T5 · taken by rev-1');
  });

  it('shows no Turn section for a worker turn and no Return for a non-returnable column', async () => {
    const { d } = await open(taskGet());
    expect(section()).toBeUndefined();
    await reread(
      d,
      orchestratorTaskGet(
        { column: 'dev', addressee: 'orchestrator:dev' },
        { task: taskGet().task },
      ),
    );
    expect(text()).toContain('not taken');
    expect(buttons().map((entry) => entry.textContent)).not.toContain('Return to dev…');
    expect(button('Submit…').disabled).toBe(false);
  });

  it.each(['tested', 'carried', 'skipped'])(
    'submits a %s basis after taking the turn',
    async (basis) => {
      const { writes } = await open();
      await click('Submit…');
      expect(commit().value).toBe(HEAD);
      expect(dialog().querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(0);
      if (basis === 'tested') expect(text()).toContain('Tested on the commit above.');
      else await choose(basis === 'carried' ? 'Carried' : 'Skipped');
      if (basis === 'carried') type(source(), SOURCE);
      if (basis !== 'tested') type(reason(), 'Verified elsewhere.');
      const { primary, line } = confirmation();
      expect(primary?.textContent).toBe('Submit');
      // The fixture's Dev gate has checks_green failed: the line warns the task may go back.
      expect(line).toBe(
        `${REEVALUATE} If they hold, the task moves to qa.${UNMET} It cannot be undone.`,
      );
      await send();
      expect(writes().map(({ op, input }) => ({ op, input }))).toEqual([
        { op: 'inbox.ack', input: { entries: [{ id: 'T5' }] } },
        {
          op: 'task.submit',
          input: {
            turn: 'T5',
            sha: HEAD,
            basis,
            ...(basis === 'carried' ? { from: SOURCE } : {}),
            ...(basis === 'tested' ? {} : { reason: 'Verified elsewhere.' }),
          },
        },
      ]);
      expect(text()).toContain('T5 submitted.');
    },
  );

  it('starts Commit from the head the turn opened on when the task has no status row', async () => {
    const opened = {
      id: 'T5',
      task: 'ex/repo#7',
      column: 'review',
      addressee: 'orchestrator:review',
      reason: 'Review',
      handed: [],
      head: SOURCE,
      at: AT,
      taken: null,
    };
    // A task of another project: the chosen project's status has no row for it.
    await open(orchestratorTaskGet({}, { why: { ...taskGet().why, turn: opened } }), undefined, []);
    await click('Submit…');
    expect(commit().value).toBe(SOURCE);
  });

  it('requires the fields of each basis before sending', async () => {
    const { writes } = await open();
    await click('Submit…');
    type(commit(), '');
    await send();
    expect(text()).toContain('Enter the commit you tested.');
    type(commit(), HEAD.toUpperCase());
    await send();
    expect(text()).toContain('Enter the full lowercase commit SHA');
    type(commit(), HEAD);
    await choose('Carried');
    await send();
    expect(text()).toContain('Enter the commit the tested work comes from.');
    expect(text()).toContain('Enter a reason.');
    type(source(), SOURCE);
    type(reason(), '   ');
    await send();
    expect(text()).toContain('Enter a reason.');
    await choose('Skipped');
    type(reason(), 'x'.repeat(2001));
    await send();
    expect(text()).toContain('The reason must be 2,000 characters or fewer.');
    expect(writes()).toEqual([]);
  });

  it('returns the turn with a reason', async () => {
    const { writes } = await open();
    await click('Return to dev…');
    await send();
    expect(text()).toContain('Enter a reason.');
    expect(writes()).toEqual([]);
    type(reason(), 'Handle the empty list.');
    const { primary, line } = confirmation();
    expect(primary?.textContent).toBe('Return to dev');
    expect(line).toBe(
      'This closes T5 in your name and returns the task to dev. It cannot be undone, and it counts toward the cycle limit.',
    );
    await send();
    expect(writes().map(({ op, input }) => ({ op, input }))).toEqual([
      { op: 'inbox.ack', input: { entries: [{ id: 'T5' }] } },
      { op: 'task.return', input: { turn: 'T5', reason: 'Handle the empty list.' } },
    ]);
    expect(text()).toContain('T5 returned to dev.');
    expect(summary()).toBe('T5 returned');
  });

  it.each([
    [
      'qa',
      `${REEVALUATE} If they hold, the task stays in qa until it completes: its pull request merges, or its ticket is done with no open pull request and no live worker.${UNMET} It cannot be undone.`,
    ],
    ['done', 'This closes T5 in your name; the task stays in done. It cannot be undone.'],
  ])('promises no move when %s has no next column but done', async (column, expected) => {
    await open(orchestratorTaskGet({ column, addressee: `orchestrator:${column}` }));
    await click('Submit…');
    const { primary, line } = confirmation();
    expect(primary?.textContent).toBe('Submit');
    expect(line).toBe(expected);
  });

  it.each([
    [
      'an earlier gate fails',
      [gate('dev', [condition('checks_green', 'failed', 'checks_red')])],
      true,
    ],
    [
      'only the review on the head waits',
      [allMet, gate('review', [condition('review_on_head', 'waiting')])],
      false,
    ],
  ])('warns about unmet exit conditions of any gate when %s', async (_, gates, warns) => {
    await open(orchestratorTaskGet({}, { why: { ...taskGet().why, column: 'review', gates } }));
    await click('Submit…');
    expect(confirmation().line).toBe(
      `${REEVALUATE} If they hold, the task moves to qa.${warns ? UNMET : ''} It cannot be undone.`,
    );
  });
});

/** The latest submission of the submit that closed T5 at `AT`. */
const submission = {
  column: 'review',
  sha: HEAD,
  at: AT,
  basis: 'tested',
  from: null,
  testedOrigin: null,
  reason: null,
  pending: false,
  voided: false,
};

describe('Turn section when the turn closes elsewhere', () => {
  it('disables the form when another viewer closes the turn while it is open', async () => {
    const { d, writes } = await open();
    await click('Submit…');
    type(commit(), HEAD);
    await reread(
      d,
      orchestratorTaskGet({}, { turn: null, turns: [closedTurn('submitted')], submission }),
    );
    expect(text()).toContain('T5 was closed by qa / qa-1');
    expect(text()).toContain('Submitted tested, aaaaaaa, 0m ago.');
    expect(confirmation().primary?.disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
    expect(button('Submit…').disabled).toBe(true);
    expect(summary()).toBe('T5 closed by qa-1');
    await send();
    expect(writes()).toEqual([]);
    await click('Cancel');
    expect(turnSection().querySelector('form')).toBeNull();
    expect(text()).toContain('T5 was closed by qa / qa-1');
    // The opening action is disabled now, so focus goes to the closed notice, with the ring.
    expect(document.activeElement?.textContent).toContain('T5 was closed by qa / qa-1');
    expect(document.activeElement?.classList.contains(focusRing)).toBe(true);
  });

  it.each(['turn_closed from submit', 'not_found from ack'])(
    'shows the same notice for %s',
    async (name) => {
      const { d } = await open();
      if (name.startsWith('turn_closed'))
        d.routes['task.submit'] = () => problem('turn_closed', 409);
      else d.routes['inbox.ack'] = () => problem('not_found', 404);
      await click('Submit…');
      setTask(d, orchestratorTaskGet({}, { turn: null, turns: [closedTurn('submitted')] }));
      await send();
      await settle();
      expect(text()).toContain('T5 was closed by qa / qa-1');
      expect(turnSection().querySelector('[role="alert"]')).toBeNull();
      expect(confirmation().primary?.disabled).toBe(true);
    },
  );

  it('names no basis or SHA from a latest submission made outside the closed turn', async () => {
    const { d } = await open();
    await click('Submit…');
    const later = {
      ...submission,
      sha: SOURCE,
      basis: 'skipped',
      at: '2026-11-15T13:30:00.000Z',
    };
    await reread(
      d,
      orchestratorTaskGet(
        { id: 'T6', at: AT },
        { turns: [closedTurn('submitted')], submission: later },
      ),
    );
    expect(text()).toContain('T5 was closed by qa / qa-1');
    expect(text()).toContain('Submitted 0m ago.');
    expect(text()).not.toContain('skipped');
    expect(text()).not.toContain(SOURCE.slice(0, 7));
  });

  it.each(['moved', 'corrected', 'archived'])('names no closer for a %s close', async (outcome) => {
    const { d } = await open();
    await click('Submit…');
    await reread(
      d,
      orchestratorTaskGet({}, { turn: null, turns: [closedTurn(outcome, 'operator')] }),
    );
    const words = {
      moved: 'the task was moved',
      corrected: 'the column was corrected',
      archived: 'the task was archived',
    }[outcome];
    expect(text()).toContain(`T5 was closed: ${String(words)}`);
    expect(text()).not.toContain('closed by');
    expect(summary()).toBe(`T5 closed: ${String(words)}`);
  });

  it('shows the T5 notice and the new T6 turn when one read closes T5 and opens T6', async () => {
    const { d, writes } = await open();
    await click('Submit…');
    await reread(
      d,
      orchestratorTaskGet({ id: 'T6', at: AT }, { turns: [closedTurn('submitted')] }),
    );
    expect(text()).toContain('T5 was closed by qa / qa-1');
    const body = turnSection().querySelector('[id$="-body"]')?.textContent ?? '';
    expect(body.indexOf('T5 was closed')).toBeLessThan(body.indexOf('T6'));
    expect(summary()).toBe('T5 closed by qa-1; T6 · not taken');
    const submits = () => buttons().filter((entry) => entry.textContent === 'Submit…');
    expect(submits().map((entry) => entry.disabled)).toEqual([true, true]);
    await send();
    expect(writes()).toEqual([]);
    await click('Cancel');
    expect(submits().at(-1)?.disabled).toBe(false);
    // T5's Submit… is disabled, so focus goes to the first action of T6.
    expect(document.activeElement).toBe(submits().at(-1));
    press(submits().at(-1) ?? document.body, 'click');
    await settle();
    expect(text()).not.toContain('T5 was closed');
    await send();
    expect(writes().map(({ input }) => input['turn'] ?? input['entries'])).toEqual([
      [{ id: 'T6' }],
      'T6',
    ]);
  });
});

describe('Turn section summary and availability', () => {
  it('names only the cut session in the summary so a long closer leaves the title room', async () => {
    const { d } = await open();
    await click('Submit…');
    const by = 'agent:stand-qa/stand-qa-5393a300271cfebf9c4bf472';
    await reread(d, orchestratorTaskGet({}, { turn: null, turns: [closedTurn('submitted', by)] }));
    expect(summary()).toBe('T5 closed by stand-qa-5393a3…');
    expect(text()).toContain('T5 was closed by stand-qa / stand-qa-5393a300271cfebf9c4bf472');
  });

  it('summarises the folded section truthfully', async () => {
    const { d } = await open();
    expect(summary()).toBe('T5 · not taken');
    await reread(d, orchestratorTaskGet({ taken: { by: 'operator', at: AT } }));
    expect(summary()).toBe('T5 · you hold it');
    d.routes['task.submit'] = () => problem('github_unavailable', 503);
    await click('Submit…');
    await send();
    expect(summary()).toBe('T5 · refused, you hold it');
    await reread(d, orchestratorTaskGet({}, { turn: null, turns: [closedTurn('returned')] }));
    expect(summary()).toBe('T5 closed by qa-1');
    expect(text()).toContain('Returned to dev 0m ago.');
  });

  it('disables the actions on an archived task', async () => {
    await open(orchestratorTaskGet({}, { task: { ...taskGet().task, membership: 'archived' } }));
    expect(button('Submit…').disabled).toBe(true);
    expect(text()).toContain('This task is archived. The turn cannot be closed.');
  });
});
