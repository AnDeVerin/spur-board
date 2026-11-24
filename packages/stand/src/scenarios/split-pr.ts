// The split-PR scenarios: a merged PR whose issue changes after it and stays open, and an issue
// closed after the merge; and an issue closed with no PR, wrapped up by a Done orchestrator.
import { openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';
import { awaitTurn, check, entities, flow, ISSUE, PR, REPO, toReadyToMerge } from './dispatcher.ts';

const SPLIT_NOTE = `dev: no_pr (PR ${PR} merged, ticket still open)`;
const SPLIT = { column: 'dev', role: 'worker', reason: SPLIT_NOTE, taken: false } as const;
const WRAP_UP = { column: 'done', role: 'worker', reason: 'done: wrap up' } as const;
const CLOSES = { closingIssuesReferences: [{ number: 1, repository: { nameWithOwner: REPO } }] };

export const dispatchTicketDoneNoPr: Scenario = {
  name: 'dispatch-ticket-done-no-pr',
  summary: `An open ${ISSUE} has no PR or linked worker; closing it reaches Done after fresh source confirmation.`,
  config: flow(),
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    await board.poll();
    return entities(board);
  },
  settled: async ({ board }) => settledUnless(await check(board, { column: 'todo' })),
};

const doneByOrchestrator = () => {
  const { stand } = flow();
  const columns = stand.columns.map((entry) =>
    entry.id === 'done' ? { id: 'done', orchestrator: 'stand-qa' } : entry,
  );
  return { stand: { ...stand, columns } };
};

export const dispatchDoneWrapUpNoPr: Scenario = {
  name: 'dispatch-done-wrap-up-no-pr',
  summary: `${ISSUE} closes with no PR or linked worker: Done with the stand-qa orchestrator's wrap-up turn, which it closes without a commit.`,
  config: doneByOrchestrator(),
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    await board.poll();
    await fakes.github('issue-close', { repo: REPO, number: 1 });
    // The close reaches Done after fresh source confirmation, within two polls.
    await board.poll();
    await board.poll();
    await awaitTurn(board, 'orchestrator', 'done: wrap up');
    return entities(board);
  },
  settled: async ({ board }) =>
    settledUnless(
      await check(board, {
        column: 'done',
        role: 'orchestrator',
        reason: 'done: wrap up',
        taken: false,
      }),
    ),
};

export const dispatchSplitPr: Scenario = {
  name: 'dispatch-split-pr',
  summary: `PR #1 of ${ISSUE} merged, then the issue changed while still open: back in Dev with the worker's turn naming the merged PR.`,
  config: flow(),
  async seed(board, fakes) {
    await toReadyToMerge(board, fakes);
    await fakes.github('merge', { repo: REPO, number: 1 });
    await board.poll();
    // The merged PR stops counting once the issue changed after the merge and is still open.
    await board.shiftClock(5_000);
    await fakes.github('issue-milestone', { repo: REPO, number: 1, milestone: 'split' });
    await board.poll();
    await awaitTurn(board, 'worker', SPLIT_NOTE);
    return entities(board);
  },
  settled: async ({ board }) => settledUnless(await check(board, SPLIT)),
};

export const dispatchCloseAfterMerge: Scenario = {
  name: 'dispatch-close-after-merge',
  summary: `PR #1 closes ${ISSUE}; the close is seen one poll after the merge: Done with the wrap-up turn, no Dev visit.`,
  // A 60 s tracker interval keeps scheduled tracker polls out of the seed, so its explicit polls
  // alone move the task; the stand test also reads it back as the written adapters override.
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
