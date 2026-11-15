// Scenarios around a turn and the PR head: a submit while CI runs, a new head while the
// conductor holds a turn right of Dev, and a submit the board confirms on a later poll. They
// reuse the flow helpers of `dispatcher.ts`.
import {
  awaitTurn,
  begin,
  check,
  entities,
  flow,
  openPr,
  submit,
  take,
  toReview,
  turnOf,
  type Turn,
} from './dispatcher.ts';
import { issueKey, settledUnless } from './helpers.ts';
import type { Board, Scenario, ScenarioFakes } from './index.ts';

const REPO = 'stand-org/board';
const ISSUE = issueKey(1);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
/** How long a seed waits for a ring the outbox sends on its own tick. */
const RING_MS = 20_000;

/**
 * As `flow()`, but the stand-qa conductor also runs Product Review and Ready to Merge, so it holds
 * a turn in every column right of Dev.
 */
const flowAgents = () => ({
  stand: {
    columns: [
      { id: 'todo' },
      { id: 'dev' },
      { id: 'review', orchestrator: 'stand-qa' },
      { id: 'product-review', orchestrator: 'stand-qa' },
      { id: 'ready-to-merge', orchestrator: 'stand-qa' },
      { id: 'done' },
    ],
    dispatcher: { mode: 'on' as const },
  },
});

interface SpurLog {
  requests: { route: string; path: string }[];
  sends: { session: string }[];
}

/** What the fake Spur saw: every send request, failed ones included, and every accepted send. */
const spurLog = async (fakes: ScenarioFakes) => (await fakes.spur('inspect')) as SpurLog;

/** Whether the fake Spur got a send request for the conductor, accepted or not. */
const conductorAsked = (log: SpurLog, board: Board) =>
  log.requests.some(
    ({ route, path }) =>
      route === 'send' && path.endsWith(`/sessions/${board.roles.orchestrator}/send`),
  );

/** Whether the fake Spur accepted a send to the conductor. */
const conductorRung = (log: SpurLog, board: Board) =>
  log.sends.some(({ session }) => session === board.roles.orchestrator);

/** The conductor's session waits, so the board rings it. */
const conductorWaits = (board: Board, fakes: ScenarioFakes) =>
  fakes.spur('session', { id: board.roles.orchestrator, state: 'waiting' });

export const dispatchCiPendingAfterSubmit: Scenario = {
  name: 'dispatch-ci-pending-after-submit',
  summary: `The worker submits ${ISSUE} while CI runs: no Review turn and no ring to the waiting conductor until CI turns green.`,
  config: flow(),
  async seed(board, fakes) {
    await conductorWaits(board, fakes);
    const dev = await begin(board, fakes);
    await take(board, 'worker', dev.id);
    await openPr(board, fakes, { green: false });
    const submitted = await submit(board, 'worker', dev.id, A);
    if (submitted.task.column !== 'dev')
      throw new Error(`an early submit moved the task to ${submitted.task.column}`);
    if ((await turnOf(board, 'worker')) !== undefined) throw new Error('an early submit turned');
    await board.poll();
    await board.wait('outbox-drained');
    if (conductorAsked(await spurLog(fakes), board))
      throw new Error('the conductor was rung while CI runs');
    const { why } = await board.call('operator', 'task.get', { task: ISSUE, why: true });
    const expected = [{ reason: 'checks_pending', head: A, text: `waiting for CI on ${A}` }];
    if (JSON.stringify(why?.waiting) !== JSON.stringify(expected))
      throw new Error(`why.waiting is ${JSON.stringify(why?.waiting)}`);
    await fakes.github('ci-green', { repo: REPO, number: 1 });
    await board.poll();
    await awaitTurn(board, 'orchestrator', 'review: no_review_on_head');
    await board.until('conductor rung', RING_MS, async () =>
      conductorRung(await spurLog(fakes), board),
    );
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, {
      column: 'review',
      role: 'orchestrator',
      reason: 'review: no_review_on_head',
      taken: false,
    });
    const turn = await turnOf(board, 'orchestrator');
    if (turn !== undefined && turn.head !== A)
      problems.push(`review turn on ${turn.head ?? 'no head'}`);
    const { why } = await board.call('operator', 'task.get', { task: ISSUE, why: true });
    if (why?.waiting !== undefined) problems.push(`waiting ${JSON.stringify(why.waiting)}`);
    return settledUnless(problems);
  },
};

/** Throws unless the worker's submit of A on `turn` was accepted pending. */
async function submitPending(board: Board, turn: string): Promise<void> {
  const submitted = await submit(board, 'worker', turn, A);
  if (submitted.status !== 'pending')
    throw new Error(`the submit is ${submitted.status}, not pending`);
}

/**
 * The worker took the Dev turn, opened PR #1 at A with green CI while GitHub refuses the board,
 * and submitted A pending. Refused before the PR exists, so the runner's own timer cannot link it
 * first; the caller clears the failure.
 */
async function submitBeforePoll(board: Board, fakes: ScenarioFakes): Promise<void> {
  const dev = await begin(board, fakes);
  await take(board, 'worker', dev.id);
  await fakes.github('fail', { mode: 'refuse' });
  await fakes.github('create', { repo: REPO, number: 1, seed: { headRefOid: A } });
  await fakes.github('ci-green', { repo: REPO, number: 1 });
  await submitPending(board, dev.id);
}

export const dispatchSubmitBeforePrLinked: Scenario = {
  name: 'dispatch-submit-before-pr-linked',
  summary: `The worker submits ${ISSUE} at A before any poll sees PR #1: the submit is pending, and the next poll links the PR at A and moves the task to Review with no worker action.`,
  config: flow(),
  async seed(board, fakes) {
    await submitBeforePoll(board, fakes);
    await fakes.github('fail', { mode: 'clear' });
    await board.poll();
    await awaitTurn(board, 'orchestrator', 'review: no_review_on_head');
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, {
      column: 'review',
      role: 'orchestrator',
      reason: 'review: no_review_on_head',
      taken: false,
    });
    if ((await turnOf(board, 'worker')) !== undefined) problems.push('a worker turn');
    return settledUnless(problems);
  },
};

const HEAD_MOVED =
  'dev: checks_pending, no_submit_on_head (submit of aaaaaaa: head moved to bbbbbbb)';

export const dispatchSubmitHeadMoved: Scenario = {
  name: 'dispatch-submit-head-moved',
  summary: `The worker submits ${ISSUE} at A before any poll sees PR #1, then pushes B: the next poll hands the Dev turn back with "head moved".`,
  config: flow(),
  async seed(board, fakes) {
    await submitBeforePoll(board, fakes);
    await fakes.github('push', { repo: REPO, number: 1, sha: B });
    await fakes.github('fail', { mode: 'clear' });
    await board.poll();
    await awaitTurn(board, 'worker', HEAD_MOVED);
    return entities(board);
  },
  async settled({ board }) {
    return settledUnless(
      await check(board, { column: 'dev', role: 'worker', reason: HEAD_MOVED, taken: false }),
    );
  },
};

/** One second past the default `submitConfirmMs`. */
const PAST_BOUND_MS = 181_000;
const NO_PR_FOUND = 'dev: no_pr (submit of aaaaaaa: no PR found for stand-worker)';

export const dispatchSubmitNoPr: Scenario = {
  name: 'dispatch-submit-no-pr',
  summary: `The worker submits ${ISSUE} at A with no PR: once the bound passed, the first complete poll after it hands the Dev turn back with "no PR found for stand-worker".`,
  config: flow(),
  async seed(board, fakes) {
    const dev = await begin(board, fakes);
    await take(board, 'worker', dev.id);
    await submitPending(board, dev.id);
    await board.shiftClock(PAST_BOUND_MS);
    if ((await turnOf(board, 'worker')) !== undefined)
      throw new Error('a worker turn before a complete poll after the bound');
    await board.poll();
    await awaitTurn(board, 'worker', NO_PR_FOUND);
    return entities(board);
  },
  async settled({ board }) {
    return settledUnless(
      await check(board, { column: 'dev', role: 'worker', reason: NO_PR_FOUND, taken: false }),
    );
  },
};

/** Review and Product Review passed on A by the conductor, who now holds the Ready to Merge turn. */
async function conductorToReadyToMerge(board: Board, fakes: ScenarioFakes): Promise<Turn> {
  const review = await toReview(board, fakes);
  await take(board, 'orchestrator', review.id);
  await submit(board, 'orchestrator', review.id, A);
  const product = await awaitTurn(board, 'orchestrator', 'product-review: no_review_on_head');
  await take(board, 'orchestrator', product.id);
  await submit(board, 'orchestrator', product.id, A);
  return awaitTurn(board, 'orchestrator', 'ready-to-merge: not_merged');
}

export const dispatchNewHeadInReadyToMerge: Scenario = {
  name: 'dispatch-new-head-in-ready-to-merge',
  summary: `PR #1 gets head B while the conductor holds the Ready to Merge turn of ${ISSUE}: the turn closes, Dev takes B, and Review opens a fresh turn on B.`,
  config: flowAgents(),
  async seed(board, fakes) {
    const ready = await conductorToReadyToMerge(board, fakes);
    await take(board, 'orchestrator', ready.id);
    await fakes.github('push', { repo: REPO, number: 1, sha: B });
    await board.poll();
    const dev = await awaitTurn(board, 'worker', 'dev: checks_pending, no_submit_on_head');
    await fakes.github('ci-green', { repo: REPO, number: 1 });
    await board.poll();
    await take(board, 'worker', dev.id);
    await submit(board, 'worker', dev.id, B);
    const review = await awaitTurn(board, 'orchestrator', 'review: no_review_on_head');
    if (review.head !== B) throw new Error(`the Review turn is on ${review.head ?? 'no head'}`);
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, {
      column: 'review',
      role: 'orchestrator',
      reason: 'review: no_review_on_head',
      taken: false,
    });
    const turn = await turnOf(board, 'orchestrator');
    if (turn !== undefined && turn.head !== B)
      problems.push(`review turn on ${turn.head ?? 'no head'}`);
    return settledUnless(problems);
  },
};

export const dispatchCiRedNewHeadInProductReview: Scenario = {
  name: 'dispatch-ci-red-new-head-in-product-review',
  summary: `PR #1 gets head B with red CI while the conductor holds the Product Review turn of ${ISSUE}: the turn closes and Dev gets the worker's turn.`,
  config: flowAgents(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await submit(board, 'orchestrator', review.id, A);
    const product = await awaitTurn(board, 'orchestrator', 'product-review: no_review_on_head');
    await take(board, 'orchestrator', product.id);
    // Both before one poll: the Dev turn's reason is fixed when it opens.
    await fakes.github('push', { repo: REPO, number: 1, sha: B });
    await fakes.github('ci-red', { repo: REPO, number: 1 });
    await board.poll();
    await awaitTurn(board, 'worker', 'dev: checks_red, no_submit_on_head');
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, {
      column: 'dev',
      role: 'worker',
      reason: 'dev: checks_red, no_submit_on_head',
      taken: false,
    });
    if ((await turnOf(board, 'orchestrator')) !== undefined) problems.push('a conductor turn');
    return settledUnless(problems);
  },
};

export const dispatchRingClosedTurn: Scenario = {
  name: 'dispatch-ring-closed-turn',
  summary: `Spur fails the ring for the conductor's Review turn of ${ISSUE}; head B closes the turn, and the retried ring dies unsent.`,
  config: flow(),
  async seed(board, fakes) {
    await conductorWaits(board, fakes);
    await fakes.spur('fail', { mode: '5xx', route: 'send' });
    await toReview(board, fakes);
    await board.until('a failed ring to the conductor', RING_MS, async () =>
      conductorAsked(await spurLog(fakes), board),
    );
    await fakes.github('push', { repo: REPO, number: 1, sha: B });
    await board.poll();
    await awaitTurn(board, 'worker', 'dev: checks_pending, no_submit_on_head');
    await fakes.spur('clear');
    await board.wait('outbox-drained', 60_000);
    if (conductorRung(await spurLog(fakes), board))
      throw new Error('the ring for the closed turn was sent');
    return entities(board);
  },
  async settled({ board, fakes }) {
    const problems = await check(board, {
      column: 'dev',
      role: 'worker',
      reason: 'dev: checks_pending, no_submit_on_head',
    });
    if ((await turnOf(board, 'orchestrator')) !== undefined) problems.push('a conductor turn');
    const drained = await board.check('outbox-drained');
    if (!drained.ok) problems.push('the outbox is not drained');
    if (conductorRung(await spurLog(fakes), board)) problems.push('the conductor was rung');
    return settledUnless(problems);
  },
};
