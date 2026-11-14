// The open-turn view of `board task`: the worker's Dev turn is open and not acked yet.
import { begin, entities, flow } from './dispatcher.ts';
import { issueKey, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const ISSUE = issueKey(1);

export const dispatchTurnView: Scenario = {
  name: 'dispatch-turn-view',
  summary: `${ISSUE} waits in Dev on the worker's turn T1, open and not acked, as board task shows it.`,
  config: flow(),
  async seed(board, fakes) {
    await begin(board, fakes);
    return entities(board);
  },
  async settled({ board }) {
    const { turn } = await board.call('operator', 'task.get', { task: ISSUE });
    const problems: string[] = [];
    if (turn?.column !== 'dev' || turn.addressee !== 'worker')
      problems.push(`open turn ${turn === null ? 'none' : `${turn.column} ${turn.addressee}`}`);
    else if (turn.taken !== null) problems.push(`turn ${turn.id} acked by ${turn.taken.by}`);
    return settledUnless(problems);
  },
};
