// Unresolved review threads on PR #1 send the flow task from Ready to Merge back to Dev, and the
// worker's Dev turn lists each thread.
import {
  awaitTurn,
  check,
  entities,
  flow,
  REPO,
  STEP_MS,
  take,
  submit,
  toReadyToMerge,
  toReview,
  turnOf,
} from './dispatcher.ts';
import { issueKey, settledUnless } from './helpers.ts';
import type { Board, Scenario } from './index.ts';

const ISSUE = issueKey(1);
const A = 'a'.repeat(40);
const REASON = 'dev: unresolved_threads, no_submit_on_head';

/** The flow board with External Review, held for an external approval, before Ready to Merge. */
const withExternalReview = () => {
  const { stand } = flow();
  return {
    stand: {
      ...stand,
      columns: [
        ...stand.columns.filter((column) => column.id !== 'ready-to-merge' && column.id !== 'done'),
        { id: 'external-review' as const },
        ...stand.columns.filter((column) => column.id === 'ready-to-merge' || column.id === 'done'),
      ],
    },
  };
};

/** The task back in Dev on the worker's untaken turn, listing `count` threads with links. */
async function threadsListed(board: Board, count: number): Promise<string[]> {
  const problems = await check(board, { column: 'dev', role: 'worker', reason: REASON });
  const threads = (await turnOf(board, 'worker'))?.threads ?? [];
  if (threads.length !== count || !threads.every(({ url }) => url.includes('#discussion_r')))
    problems.push(`the turn lists ${JSON.stringify(threads)}, not ${String(count)} linked threads`);
  return problems;
}

export const dispatchUnresolvedThread: Scenario = {
  name: 'dispatch-unresolved-thread',
  summary: `A comment review with one inline note in Ready to Merge sends ${ISSUE} to Dev; the worker's turn lists the thread.`,
  config: flow(),
  async seed(board, fakes) {
    await toReadyToMerge(board, fakes);
    await fakes.github('review', {
      repo: REPO,
      number: 1,
      state: 'COMMENTED',
      author: 'stand-agent',
      threads: 1,
    });
    await board.poll();
    await awaitTurn(board, 'worker', REASON);
    return entities(board);
  },
  settled: async ({ board }) => settledUnless(await threadsListed(board, 1)),
};

export const dispatchApprovalWithNotes: Scenario = {
  name: 'dispatch-approval-with-notes',
  summary: `An approval with two inline notes passes External Review; Ready to Merge sends ${ISSUE} to Dev with both threads listed.`,
  config: withExternalReview(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await submit(board, 'orchestrator', review.id, A);
    await board.until('External Review', STEP_MS, async () => {
      return (await check(board, { column: 'external-review' })).length === 0;
    });
    await fakes.github('review', { repo: REPO, number: 1, state: 'APPROVED', threads: 2 });
    await board.poll();
    await awaitTurn(board, 'worker', REASON);
    return entities(board);
  },
  settled: async ({ board }) => settledUnless(await threadsListed(board, 2)),
};
