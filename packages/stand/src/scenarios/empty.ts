import type { Scenario } from './index.ts';

/** A stand that has polled every source once and holds nothing else. */
export const empty: Scenario = {
  name: 'empty',
  summary: 'Every source polled once; no tasks, no items.',
  async seed(board) {
    await board.poll();
    return {};
  },
  settled: ({ board }) => board.check('sources-polled'),
};
