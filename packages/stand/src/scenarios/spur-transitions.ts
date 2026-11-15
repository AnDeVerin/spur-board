import { begin, flow, ISSUE, take } from './dispatcher.ts';
import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const SESSION = 'transition-worker';
const TASK = issueKey(1);

export const spurTransitionsRapidRecovery: Scenario = {
  name: 'spur-transitions-rapid-recovery',
  summary: 'A rate limit and recovery between full lists are retained as ordered historical edges.',
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    await board.poll();
    await fakes.spur('session', {
      id: SESSION,
      project: 'stand-worker',
      links: [{ label: 'board-worker', url: 'https://github.com/stand-org/board/issues/1' }],
    });
    await board.poll();
    await fakes.spur('session', {
      id: SESSION,
      state: 'rate_limited',
      rateLimitResetAt: '2099-01-01T00:00:00.000Z',
    });
    await fakes.spur('session', { id: SESSION, state: 'working' });
    await board.poll();
    return { tasks: { transition: TASK }, sessions: { transition: SESSION } };
  },
  async settled({ board }) {
    const task = await board.call('operator', 'task.get', { task: TASK });
    return settledUnless(
      task.sessions?.some(
        (session) =>
          session.id === SESSION &&
          session.health === 'working' &&
          session.rateLimitResetAt === undefined,
      ) === true
        ? []
        : ['current session did not recover'],
    );
  },
};

export const spurTransitionsCursorExpired: Scenario = {
  name: 'spur-transitions-cursor-expired',
  summary:
    'An expired feed position resyncs the current list once and resumes from its new baseline.',
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    await board.poll();
    await fakes.spur('session', {
      id: SESSION,
      project: 'stand-worker',
      links: [{ label: 'board-worker', url: 'https://github.com/stand-org/board/issues/1' }],
    });
    await board.poll();
    await fakes.spur('session', { id: SESSION, state: 'waiting' });
    await fakes.spur('expire-transitions');
    await board.poll();
    await board.poll();
    return { tasks: { transition: TASK }, sessions: { transition: SESSION } };
  },
  async settled({ board }) {
    const task = await board.call('operator', 'task.get', { task: TASK });
    return settledUnless(
      task.sessions?.some((session) => session.id === SESSION) === true
        ? []
        : ['resync snapshot missing'],
    );
  },
};

export const spurTransitionsKilledHolder: Scenario = {
  name: 'spur-transitions-killed-holder',
  summary:
    'A linked open turn holder is killed and raises worker_lost in the next successful poll.',
  config: flow(),
  async seed(board, fakes) {
    const turn = await begin(board, fakes);
    await take(board, 'worker', turn.id);
    await fakes.spur('session', { id: board.roles.worker, status: 'killed', state: 'killed' });
    await board.poll();
    return { tasks: { killed: ISSUE }, sessions: { killed: board.roles.worker } };
  },
  async settled({ board }) {
    const task = await board.call('operator', 'task.get', { task: ISSUE });
    const status = await board.call('operator', 'status.get', {});
    return settledUnless([
      ...(task.sessions?.some(
        (session) => session.id === board.roles.worker && session.endReason === 'kill',
      ) === true
        ? []
        : ['killed snapshot missing']),
      ...(status.items.some((item) => item.summary.includes('worker ended during its open turn'))
        ? []
        : ['worker_lost missing']),
    ]);
  },
};
