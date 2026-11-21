// Review and QA with no executor bound go to the operator, not the worker: the worker's Dev
// submit does not pass Review, which opens an operator turn instead.
import {
  begin,
  entities,
  items,
  openPr,
  operatorItem,
  submit,
  take,
  turnOf,
} from './dispatcher.ts';
import { issueKey, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const ISSUE = issueKey(1);
const A = 'a'.repeat(40);
const REASON = 'review: no_review_on_head';

export const dispatchUnboundReview: Scenario = {
  name: 'dispatch-unbound-review',
  summary: `${ISSUE} passes Dev on head A and waits in Review, unbound, on the operator's turn item; QA is unbound and Ready to Merge is the operator's.`,
  config: {
    stand: {
      columns: [
        { id: 'todo' },
        { id: 'dev' },
        { id: 'review' },
        { id: 'qa' },
        { id: 'ready-to-merge', orchestrator: 'operator' },
        { id: 'done' },
      ],
      dispatcher: { mode: 'on' },
    },
  },
  async seed(board, fakes) {
    const dev = await begin(board, fakes);
    await take(board, 'worker', dev.id);
    await openPr(board, fakes);
    await submit(board, 'worker', dev.id, A);
    const turn = await operatorItem(board, REASON);
    return entities(board, { items: { turn } });
  },
  async settled({ board, entities: named }) {
    const problems: string[] = [];
    const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
    const column = tasks.find(({ key }) => key === ISSUE)?.column;
    if (column !== 'review') problems.push(`task in ${column ?? 'nothing'}, not review`);
    const turn = named.items?.['turn'];
    const item = (await items(board)).find(({ key }) => key === turn);
    if (item?.summary.endsWith(`: ${REASON}`) !== true)
      problems.push(`no item ${turn ?? 'turn'} ${REASON}`);
    const worker = await turnOf(board, 'worker');
    if (worker !== undefined) problems.push(`worker turn ${worker.reason}`);
    return settledUnless(problems);
  },
};
