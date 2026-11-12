import { openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const SOURCE = 'github-issues:stand:stand-org/board';

/**
 * GitHub answers 401 after one good poll, so the issues tracker turns blind for auth. Every
 * GitHub source goes blind with it; only the tracker is named.
 */
export const sourceBlind: Scenario = {
  name: 'source-blind',
  summary: `GitHub answers 401; ${SOURCE} is blind for auth with its item raised.`,
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    await board.poll();
    await fakes.github('fail', { mode: 'auth' });
    await board.poll();
    return { sources: { blind: SOURCE }, items: { blind: `source:${SOURCE}` } };
  },
  async settled({ board, entities }) {
    const source = entities.sources?.['blind'] ?? SOURCE;
    const item = entities.items?.['blind'] ?? `source:${SOURCE}`;
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
