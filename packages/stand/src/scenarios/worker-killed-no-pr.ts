import { issueKey, jiraKey, openIssues, openJiraIssues } from './helpers.ts';
import type { Board, Scenario, ScenarioFakes } from './index.ts';

const SESSION = 'stand-killed';

/**
 * A worker linked to ticket 1 of `project` is killed with no PR (#272). The task row is not
 * asserted: the scenario reproduces the shape, not the fix. The session lives in Spur project
 * stand-worker either way.
 */
function workerKilledScenario(options: {
  name: string;
  summary: string;
  project: string;
  key: (number: number) => string;
  open: (fakes: ScenarioFakes, count: number) => Promise<void>;
}): Scenario {
  const { project } = options;
  const task = options.key(1);
  const summary = `${task}: worker ended (killed), no PR (${SESSION})`;
  async function itemKey(board: Board): Promise<string | undefined> {
    const { items } = await board.call('operator', 'status.get', { project });
    return items.find((item) => item.summary === summary)?.key;
  }
  return {
    name: options.name,
    summary: options.summary,
    async seed(board, fakes) {
      await options.open(fakes, 1);
      await board.poll();
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
        reason: `Stand scenario ${options.name}`,
      });
      await board.poll();
      await fakes.spur('session', { id: SESSION, status: 'killed', state: 'killed' });
      await board.poll();
      // Sources poll concurrently; "no PR" counts only from a GitHub poll begun after the kill.
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
        : { ok: false, diagnostics: `no item ${summary}` };
    },
  };
}

export const workerKilledNoPr = workerKilledScenario({
  name: 'worker-killed-no-pr',
  summary: 'Session stand-killed, linked to issue 1, killed with no PR; its item is raised.',
  project: 'stand',
  key: issueKey,
  open: openIssues,
});

export const workerKilledNoPrJira = workerKilledScenario({
  name: 'worker-killed-no-pr-jira',
  summary: `Session ${SESSION}, linked to Jira ticket ${jiraKey(1)}, killed with no PR; its item is raised.`,
  project: 'stand-jira',
  key: jiraKey,
  open: openJiraIssues,
});
