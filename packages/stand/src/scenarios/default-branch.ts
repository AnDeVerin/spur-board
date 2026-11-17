import { settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const REPO = 'stand-org/board';
const SOURCE = `github:stand:${REPO}`;
const ITEM = `default-branch:${SOURCE}`;

/** The stand repo's default-branch head fails its push run, so the board raises one failure. */
export const defaultBranchRed: Scenario = {
  name: 'default-branch-red',
  summary: `${REPO}'s main head fails its push build; ${ITEM} is raised as a failure under _board.`,
  async seed(board, fakes) {
    await fakes.github('branch', { repo: REPO, state: 'red' });
    await board.poll();
    return { sources: { red: SOURCE }, items: { red: ITEM } };
  },
  async settled({ board, entities }) {
    const source = entities.sources?.['red'] ?? SOURCE;
    const item = entities.items?.['red'] ?? ITEM;
    const { sources, items } = await board.call('operator', 'status.get', {});
    const state = sources.find((candidate) => candidate.source === source)?.defaultBranch;
    return settledUnless([
      ...(state?.state === 'red'
        ? []
        : [`${source} default branch is ${state?.state ?? 'unread'}`]),
      ...(items.some(({ key }) => key === item) ? [] : [`no item ${item}`]),
    ]);
  },
};
