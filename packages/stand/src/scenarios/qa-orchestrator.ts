// The QA column with a stub orchestrator: all ten columns on, Review, Product Review and QA bound
// to stand-qa, whose role session stands in for the QA orchestrator. Issues 1-3 pass Dev, Review,
// Product Review and External Review on their own heads, and each waits in QA on an untaken turn
// rung to the stub.
import { REPO, STEP_MS, submit, take } from './dispatcher.ts';
import { issueKey, openIssues, sendsTo, settledUnless, turnOn } from './helpers.ts';
import type { Scenario } from './index.ts';

const NUMBERS = [1, 2, 3] as const;
/** The head of PR #n: its digit 40 times. */
const head = (number: number): string => String(number).repeat(40);
const RING_MS = 20_000;

export const qaStubOrchestrator: Scenario = {
  name: 'qa-stub-orchestrator',
  summary: `${issueKey(1)}, #2 and #3 each wait in QA on an untaken turn rung to the stand-qa role session, the stub QA orchestrator, with all ten columns on.`,
  config: {
    stand: {
      columns: [
        { id: 'todo' },
        { id: 'triage' },
        { id: 'ready-for-dev' },
        { id: 'dev' },
        { id: 'review', orchestrator: 'stand-qa' },
        { id: 'product-review', orchestrator: 'stand-qa' },
        { id: 'external-review' },
        { id: 'qa', orchestrator: 'stand-qa' },
        { id: 'ready-to-merge', orchestrator: 'operator' },
        { id: 'done' },
      ],
      dispatcher: { mode: 'on' },
    },
  },
  async seed(board, fakes) {
    const stub = board.roles.orchestrator;
    await fakes.spur('session', { id: stub, state: 'waiting' });
    await openIssues(fakes, NUMBERS.length);
    await board.poll();
    for (const number of NUMBERS)
      await board.call('operator', 'link.add', {
        mode: 'session',
        task: issueKey(number),
        session: board.roles.worker,
        reason: 'Stand QA stub orchestrator',
      });
    await board.poll();
    const dev: string[] = [];
    for (const number of NUMBERS) {
      const turn = await turnOn(board, 'worker', number, 'dev: no_pr', STEP_MS);
      await take(board, 'worker', turn);
      dev.push(turn);
    }
    for (const number of NUMBERS) {
      await fakes.github('create', { repo: REPO, number, seed: { headRefOid: head(number) } });
      await fakes.github('ci-green', { repo: REPO, number });
    }
    await board.poll();
    for (const [i, number] of NUMBERS.entries())
      await submit(board, 'worker', dev[i] ?? '', head(number));
    for (const column of ['review', 'product-review'])
      for (const number of NUMBERS) {
        const turn = await turnOn(
          board,
          'orchestrator',
          number,
          `${column}: no_review_on_head`,
          STEP_MS,
        );
        await take(board, 'orchestrator', turn);
        await submit(board, 'orchestrator', turn, head(number));
      }
    for (const number of NUMBERS)
      await fakes.github('review', { repo: REPO, number, state: 'APPROVED' });
    await board.poll();
    for (const number of NUMBERS) {
      const turn = await turnOn(board, 'orchestrator', number, 'qa: no_submit_on_head', STEP_MS);
      await board.until(
        `QA turn ${turn} rung`,
        RING_MS,
        async () => (await sendsTo(fakes, stub, `turn ${turn}:`)).length > 0,
      );
    }
    return {
      tasks: Object.fromEntries(NUMBERS.map((number) => [`qa${String(number)}`, issueKey(number)])),
      prs: Object.fromEntries(
        NUMBERS.map((number) => [String(number), `${REPO}#${String(number)}`]),
      ),
      sessions: { worker: board.roles.worker, orchestrator: stub },
    };
  },
  async settled({ board }) {
    const problems: string[] = [];
    const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
    const { turns } = await board.call('orchestrator', 'inbox.get', {});
    for (const number of NUMBERS) {
      const key = issueKey(number);
      const at = tasks.find((task) => task.key === key)?.column;
      if (at !== 'qa') problems.push(`${key} in ${at ?? 'nothing'}, not qa`);
      const turn = turns.find((entry) => entry.task === key);
      if (turn?.column !== 'qa' || turn.taken !== null || turn.head !== head(number))
        problems.push(
          `${key}: stub turn ${JSON.stringify(turn)}, not an untaken QA turn on its head`,
        );
    }
    if (turns.length !== NUMBERS.length)
      problems.push(
        `stub inbox lists ${String(turns.length)} turns, not ${String(NUMBERS.length)}`,
      );
    return settledUnless(problems);
  },
};
