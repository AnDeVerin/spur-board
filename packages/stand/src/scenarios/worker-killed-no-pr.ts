import { issueKey, openIssues } from './helpers.ts';
import type { Board, Scenario } from './index.ts';

const SESSION = 'stand-killed';
const SUMMARY = `${issueKey(1)}: worker ended (killed), no PR (${SESSION})`;

async function itemKey(board: Board): Promise<string | undefined> {
  const { items } = await board.call('operator', 'status.get', { project: 'stand' });
  return items.find((item) => item.summary === SUMMARY)?.key;
}

/**
 * A worker linked to issue 1 is killed with no PR (#272). The task row is not asserted: the
 * scenario reproduces the shape, not the fix.
 */
export const workerKilledNoPr: Scenario = {
  name: 'worker-killed-no-pr',
  summary: 'Session stand-killed, linked to issue 1, killed with no PR; its item is raised.',
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    await board.poll();
    const task = issueKey(1);
    await fakes.spur('session', {
      id: SESSION,
      project: 'stand-worker',
      status: 'running',
      state: 'working',
    });
    await board.call('operator', 'link.add', {
      mode: 'session',
      task,
      session: SESSION,
      reason: 'Stand scenario worker-killed-no-pr',
    });
    await board.poll();
    await fakes.spur('session', { id: SESSION, status: 'killed', state: 'killed' });
    await board.poll();
    let key: string | undefined;
    await board.until('worker ended item raised', 10_000, async () => {
      key = await itemKey(board);
      return key !== undefined;
    });
    return {
      tasks: { killed: task },
      sessions: { killed: SESSION },
      ...(key === undefined ? {} : { items: { killed: key } }),
    };
  },
  async settled({ board, entities }) {
    const key = await itemKey(board);
    return key !== undefined && key === entities.items?.['killed']
      ? { ok: true }
      : { ok: false, diagnostics: `no item ${SUMMARY}` };
  },
};
