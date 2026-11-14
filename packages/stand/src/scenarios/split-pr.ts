// The split-PR scenarios: a merged PR whose issue stays open, and an issue closed after the merge.
import { settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';
import { awaitTurn, check, entities, flow, ISSUE, PR, REPO, toReadyToMerge } from './dispatcher.ts';

const SPLIT_NOTE = `dev: no_pr (PR ${PR} merged, ticket still open)`;
const SPLIT = { column: 'dev', role: 'worker', reason: SPLIT_NOTE, taken: false } as const;
const WRAP_UP = { column: 'done', role: 'worker', reason: 'done: wrap up' } as const;
const CLOSES = { closingIssuesReferences: [{ number: 1, repository: { nameWithOwner: REPO } }] };

export const dispatchSplitPr: Scenario = {
  name: 'dispatch-split-pr',
  summary: `PR #1 of ${ISSUE} merged while the issue stays open: back in Dev with the worker's turn naming the merged PR.`,
  config: flow(),
  async seed(board, fakes) {
    await toReadyToMerge(board, fakes);
    await fakes.github('merge', { repo: REPO, number: 1 });
    await board.poll();
    // The issue counts as open once a tracker poll sees it one interval (5 s here) after the merge.
    await board.shiftClock(5_000);
    await board.poll();
    await awaitTurn(board, 'worker', SPLIT_NOTE);
    return entities(board);
  },
  settled: async ({ board }) => settledUnless(await check(board, SPLIT)),
};

export const dispatchCloseAfterMerge: Scenario = {
  name: 'dispatch-close-after-merge',
  summary: `PR #1 closes ${ISSUE}; the close is seen one poll after the merge: Done with the wrap-up turn, no Dev visit.`,
  // 60 s tracker interval: no scheduled poll on the real clock confirms the issue open pre-close.
  config: { ...flow(), adapters: { githubIssues: { intervalMs: 60_000 } } },
  async seed(board, fakes) {
    await toReadyToMerge(board, fakes, CLOSES);
    await fakes.github('merge', { repo: REPO, number: 1 });
    await board.poll();
    const held = await check(board, { column: 'ready-to-merge' });
    const { why } = await board.call('operator', 'task.get', { task: ISSUE, why: true });
    if (why?.holds.includes('ticket_unconfirmed') !== true)
      held.push(`holds ${why?.holds.join(', ') ?? 'none'}, not ticket_unconfirmed`);
    if (held.length > 0) throw new Error(`after the merge: ${held.join('; ')}`);
    await fakes.github('issue-close', { repo: REPO, number: 1 });
    await board.poll();
    await awaitTurn(board, 'worker', 'done: wrap up');
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, WRAP_UP);
    const { why } = await board.call('operator', 'task.get', { task: ISSUE, why: true });
    const last = why?.moves.at(-1);
    const move = `${last?.from ?? ''} -> ${last?.to ?? ''} (${last?.reason ?? ''})`;
    if (move !== 'ready-to-merge -> done (merged)') problems.push(`last move ${move}`);
    return settledUnless(problems);
  },
};
