import { settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

/** A stand that has polled every source once and holds nothing else. */
export const empty: Scenario = {
  name: 'empty',
  summary: 'Every source polled once; no tasks, no items.',
  async seed(board) {
    await board.poll();
    return {};
  },
  async settled({ board }) {
    const polled = await board.check('sources-polled');
    if (!polled.ok) return polled;
    const { tasks, items } = await board.call('operator', 'status.get', {});
    return settledUnless([
      ...tasks.map((task) => `task ${task.key} exists`),
      ...items.map((item) => `item ${item.key} exists`),
    ]);
  },
};
