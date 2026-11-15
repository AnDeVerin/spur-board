import { flow, REPO } from './dispatcher.ts';
import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

/** Final and closed linked PRs plus an unlinked merged discovery at the cursor tie. */
export const prFinality: Scenario = {
  name: 'pr-finality',
  summary:
    'One merged Done task, two closed PRs and an unlinked merged discovery, ready for request-level polling checks.',
  config: {
    ...flow(),
    adapters: {
      github: { intervalMs: 1_800_000 },
      githubIssues: { intervalMs: 1_800_000 },
      jira: { intervalMs: 1_800_000 },
      spur: { intervalMs: 1_800_000 },
    },
  },
  async seed(board, fakes) {
    await openIssues(fakes, 3);
    await board.poll();
    for (const number of [1, 2, 3, 4]) {
      await fakes.github('create', {
        repo: REPO,
        number,
        seed: {
          headRefName: number === 4 ? 'unlinked' : `stand-${String(number)}`,
          ...(number === 2 ? { author: { login: 'another-author' } } : {}),
        },
      });
    }
    await board.poll();
    await board.call('operator', 'link.add', {
      mode: 'pr',
      task: issueKey(2),
      pr: `https://github.com/${REPO}/pull/2`,
      reason: 'Track work by another author.',
    });
    await fakes.github('merge', { repo: REPO, number: 1 });
    await fakes.github('merge', { repo: REPO, number: 4 });
    await fakes.github('close', { repo: REPO, number: 2 });
    await fakes.github('close', { repo: REPO, number: 3 });
    await fakes.github('issue-close', { repo: REPO, number: 1 });
    // Fake verbs can move updatedAt a millisecond ahead when a fixed clock is injected.
    await board.shiftClock(10);
    await board.poll();
    return {
      tasks: { merged: issueKey(1), closed: issueKey(2), discovered: issueKey(3) },
      prs: {
        merged: `${REPO}#1`,
        closed: `${REPO}#2`,
        discovered: `${REPO}#3`,
        unlinked: `${REPO}#4`,
      },
    };
  },
  async settled({ board }) {
    const problems: string[] = [];
    for (const [number, state] of [
      [1, 'merged'],
      [2, 'closed'],
      [3, 'closed'],
    ] as const) {
      const task = await board.call('operator', 'task.get', { task: issueKey(number) });
      if (
        !task.links.some(
          (link) =>
            link.kind === 'pr' && link.ref === `${REPO}#${String(number)}` && link.state === state,
        )
      )
        problems.push(`PR ${String(number)} is not ${state}`);
      if (number === 1 && task.task.column !== 'done') problems.push('Merged task is not Done');
    }
    return settledUnless(problems);
  },
};
