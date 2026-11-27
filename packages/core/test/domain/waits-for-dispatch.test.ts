import { describe, expect, it } from 'vitest';
import { dispatch, dispatchHolds } from '../../src/domain/dispatch.ts';
import { evaluateGate, HOLD_ONLY, type TaskGateFacts } from '../../src/domain/gates.ts';
import { gateWaitsFor, waitsFor } from '../../src/domain/waits-for.ts';
import { facts, project, SHA, type Read } from './waits-for-fixtures.ts';

describe('the ladder follows dispatch()', () => {
  type Input = Parameters<typeof dispatch>[0];
  const NEXT = 'the next dispatcher pass to move it to done';
  const FRESH = 'fresh polls of Spur and every GitHub repository since the last change';
  const REVIEW_TURN = 'Review turn T2 (orchestrator:review)';
  const reviewed = (state: 'open' | 'closed' | 'merged'): NonNullable<TaskGateFacts['pr']> => ({
    repo: 'o/r',
    state,
    draft: false,
    mergeable: 'mergeable',
    headSha: SHA,
    requiredChecks: [{ name: 'ci', state: 'success', completedAt: null }],
    checks: [{ name: 'ci', state: 'success', completedAt: null }],
  });
  /** A task in Review of the minimal board, Review run by `rev`, with `changes` over it. */
  function input(changes: Partial<Omit<Input, 'facts'>> & { pr?: TaskGateFacts['pr'] }): Input {
    const { pr = reviewed('open'), ...rest } = changes;
    const base = project();
    return {
      column: 'review',
      project: {
        ...base,
        columns: base.columns.map((c) => (c.id === 'review' ? { ...c, orchestrator: 'rev' } : c)),
      },
      facts: {
        pr,
        externalReviewApproved: false,
        commentHistory: 'complete',
        unhandledExternalComments: 0,
        unresolvedThreads: 0,
        marks: [{ kind: 'submit', column: 'dev', headSha: SHA }],
      },
      reopened: false,
      ticketDone: true,
      hasOpenLinkedPr: pr?.state === 'open',
      allGithubReposReady: true,
      spurReady: true,
      openPr: pr?.state === 'open',
      githubBlind: false,
      spurBlind: false,
      liveWorker: false,
      cycleHeld: false,
      submitPending: false,
      submitFailed: false,
      turn: { visit: 'none', open: false, operatorUntaken: false, headMoved: false },
      ...rest,
    };
  }
  const reviewTurn = {
    turn: { visit: 'unclosed', open: true, operatorUntaken: false, headMoved: false },
  } as const;
  /** The ladder's facts as `why()` reads them from the same dispatcher input. */
  const ladder = (state: Input): Read => {
    const gate = evaluateGate(state.column, state.facts, state.project);
    return facts({
      project: state.project,
      column: state.column,
      gate,
      // The hold-only facts `why()` lists in `waiting`.
      waiting: gate.ok
        ? []
        : gate.reasons
            .filter((reason) => HOLD_ONLY.has(reason))
            .map((reason) => ({ reason, head: SHA })),
      holds: dispatchHolds(state),
      pendingSha: state.submitPending ? SHA : undefined,
      pr: state.facts.pr === null ? null : { repo: 'o/r', number: 7, state: state.facts.pr.state },
      work: state,
      turn:
        state.turn.visit === 'unclosed'
          ? { id: 'T2', column: state.column, addressee: 'orchestrator:review', byOperator: false }
          : null,
    });
  };

  it.each([
    [
      'GitHub blind after a recorded merge, ticket done',
      input({ ...reviewTurn, pr: reviewed('merged'), githubBlind: true }),
      'GitHub to be readable',
      'GitHub to be readable',
    ],
    [
      'a pending submit after a merge, ticket done',
      input({ ...reviewTurn, pr: reviewed('merged'), submitPending: true }),
      'confirmation of submit 0123456',
      'confirmation of submit 0123456',
    ],
    [
      'Review turn, ticket done, PR open, worker live',
      input({ ...reviewTurn, liveWorker: true }),
      REVIEW_TURN,
      'merge of o/r#7',
    ],
    [
      'Review turn, ticket done, PR open, no worker',
      input(reviewTurn),
      REVIEW_TURN,
      'merge of o/r#7 or close it unmerged',
    ],
    [
      'Review turn, PR merged, ticket done',
      input({ ...reviewTurn, pr: reviewed('merged') }),
      NEXT,
      NEXT,
    ],
    [
      'Review turn, PR merged, ticket open',
      input({ ...reviewTurn, pr: reviewed('merged'), ticketDone: false }),
      NEXT,
      NEXT,
    ],
    [
      'Review passed, CI rerun, ticket done, PR open, worker live',
      input({
        pr: {
          ...reviewed('open'),
          requiredChecks: [{ name: 'ci', state: 'pending', completedAt: null }],
        },
        liveWorker: true,
      }),
      'CI on 01234567',
      'merge of o/r#7',
    ],
    [
      'ticket done, PR closed, another linked PR open',
      input({ pr: reviewed('closed'), hasOpenLinkedPr: true }),
      'an open linked PR to merge or close',
      'an open linked PR to merge or close',
    ],
    [
      'ticket done, no PR, worker live',
      input({ pr: null, liveWorker: true }),
      'the worker session to end, with no open PR',
      'the worker session to end, with no open PR',
    ],
    [
      'ticket done, no PR, Spur blind',
      input({ pr: null, spurBlind: true }),
      'Spur to be readable',
      FRESH,
    ],
    [
      'ticket done, no PR, GitHub polls stale',
      input({ pr: null, allGithubReposReady: false }),
      FRESH,
      FRESH,
    ],
    [
      'ticket done, no PR, Spur polls stale',
      input({ pr: null, spurReady: false }),
      'Spur to be readable',
      FRESH,
    ],
    ['ticket done, no PR, polls fresh', input({ pr: null }), NEXT, NEXT],
  ] as const)('%s', (_name, state, lead, gate) => {
    const movesToDone = dispatch(state).moves.some((move) => move.to === 'done');
    const read = ladder(state);
    const leadText = waitsFor(read).text.replace(/ \(a human\)$/, '');
    const doneGate = gateWaitsFor({ column: 'done', enabled: true }, read);
    expect([leadText, doneGate]).toEqual([lead, gate]);
    // Only a pass that really moves the task to Done is promised, by the lead and the Done gate.
    expect(leadText === NEXT).toBe(movesToDone);
    expect(doneGate === NEXT).toBe(movesToDone);
  });
});
