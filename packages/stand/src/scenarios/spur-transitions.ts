import { begin, flow, ISSUE, take, toReview } from './dispatcher.ts';
import { issueKey, openIssues, settledUnless, STAND_SPUR_PROJECTS } from './helpers.ts';
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

/** Review is held by an unhealthy conductor while the curator remains able to read. */
export const spurTurnStall: Scenario = {
  name: 'spur-turn-stall',
  summary: 'A stalled review executor raises one curator question and withdraws it on recovery.',
  config: flow({}, [...STAND_SPUR_PROJECTS, { name: 'stand-curator', role: 'curator' }]),
  async seed(board, fakes) {
    const turn = await toReview(board, fakes);
    await take(board, 'orchestrator', turn.id);
    await fakes.spur('session', { id: board.roles.curator, state: 'waiting' });
    await fakes.spur('session', { id: board.roles.orchestrator, state: 'needs_input' });
    await board.poll();
    // Poll restarts the adapter and its observed health clock; tick without restarting it.
    await board.shiftClock(600_000);
    let block: string | undefined;
    await board.until('the stalled-turn question', 20_000, async () => {
      const task = await board.call('operator', 'task.get', { task: ISSUE });
      block = task.blocks.find(
        (entry) => entry.state === 'open' && entry.reason.includes('remains needs_input'),
      )?.id;
      return block !== undefined;
    });
    if (block === undefined) throw new Error('Missing stalled-turn question');
    const blockId = block;
    await board.until('the curator stall ring', 20_000, async () => {
      const sent = (await fakes.spur('inspect')) as {
        sends: { session: string; message: string }[];
      };
      return sent.sends.some(
        (send) =>
          send.session === board.roles.curator && send.message.includes(`block ${blockId}:`),
      );
    });
    return {
      tasks: { stall: ISSUE },
      blocks: { stall: block },
      sessions: { executor: board.roles.orchestrator, curator: board.roles.curator },
    };
  },
  async settled({ board }) {
    const task = await board.call('operator', 'task.get', { task: ISSUE });
    const current = task.blocks.find(
      (block) => block.state === 'open' && block.reason.includes('remains needs_input'),
    );
    const inbox = await board.call('curator', 'inbox.get', {});
    return settledUnless(
      current !== undefined && inbox.blocks.some((block) => block.id === current.id)
        ? []
        : ['curator inbox missing stall block'],
    );
  },
};
