import { jiraKey, openIssues, openJiraIssues, settledUnless } from './helpers.ts';
import type { Scenario, ScenarioFakes } from './index.ts';

/** `system` answers 401 after one good poll, so `source` turns blind for auth. */
function sourceBlindScenario(options: {
  name: string;
  summary: string;
  source: string;
  system: 'github' | 'jira';
  open: (fakes: ScenarioFakes, count: number) => Promise<void>;
}): Scenario {
  const { source: blind, system } = options;
  return {
    name: options.name,
    summary: options.summary,
    async seed(board, fakes) {
      await options.open(fakes, 1);
      await board.poll();
      await fakes[system]('fail', { mode: 'auth' });
      await board.poll();
      return { sources: { blind }, items: { blind: `source:${blind}` } };
    },
    async settled({ board, entities }) {
      const source = entities.sources?.['blind'] ?? blind;
      const item = entities.items?.['blind'] ?? `source:${blind}`;
      const { sources, items } = await board.call('operator', 'status.get', {});
      const state = sources.find((candidate) => candidate.source === source);
      return settledUnless([
        ...(state?.blindReason === 'auth'
          ? []
          : [`${source} is blind for ${state?.blindReason ?? 'nothing'}`]),
        ...(items.some(({ key }) => key === item) ? [] : [`no item ${item}`]),
      ]);
    },
  };
}

const SOURCE = 'github-issues:stand:stand-org/board';
const JIRA_SOURCE = 'jira:stand-jira';

/** Every GitHub source goes blind with the issues tracker; only the tracker is named. */
export const sourceBlind = sourceBlindScenario({
  name: 'source-blind',
  summary: `GitHub answers 401; ${SOURCE} is blind for auth with its item raised.`,
  source: SOURCE,
  system: 'github',
  open: openIssues,
});

export const sourceBlindJira = sourceBlindScenario({
  name: 'source-blind-jira',
  summary: `Jira answers 401 after ${jiraKey(1)} was polled; ${JIRA_SOURCE} is blind for auth with its item raised.`,
  source: JIRA_SOURCE,
  system: 'jira',
  open: openJiraIssues,
});
