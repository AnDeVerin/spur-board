import { issueKey, issueRef, openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const LINKED = ['done-1', 'done-2', 'done-3', 'killed-4'] as const;
const RESTARTED = '"msg":"spur restarted"';

/**
 * The shape the live board saw when the spur source stopped advancing (#275): ended linked
 * sessions, a stopped session of another project, a retained completed one, then a Spur restart
 * the board logs. Spur is refused only after that, so the source turns stale.
 */
export const spurSourceSilent: Scenario = {
  name: 'spur-source-silent',
  summary: 'The #275 Spur shape and a restart, then Spur refused until the source turns stale.',
  // Stale after 3 intervals (6 s for Spur); Jira, which fails against the network guard, polls
  // too rarely to turn stale while the scenario runs.
  config: { thresholds: { staleMultiplier: 3 }, adapters: { jira: { intervalMs: 600_000 } } },
  async seed(board, fakes) {
    await openIssues(fakes, LINKED.length);
    await board.poll();
    await fakes.spur('session', {
      id: 'other-1',
      project: 'other-project',
      branch: 'fix/issue-1',
      status: 'stopped',
      state: 'stale',
      stopReason: 'stale_timeout',
    });
    await fakes.spur('session', {
      id: 'retained-1',
      project: 'retained-project',
      branch: 'retained-1',
      status: 'completed',
      state: 'stopped',
      retain: true,
    });
    for (const id of LINKED)
      await fakes.spur('session', {
        id,
        project: 'stand-worker',
        branch: `work-${id}`,
        status: 'running',
        state: 'working',
      });
    const tasks: Record<string, string> = {};
    for (const [index, session] of LINKED.entries()) {
      tasks[session] = issueKey(index + 1);
      await board.call('operator', 'link.add', {
        mode: 'session',
        task: issueRef(index + 1),
        session,
        reason: 'Stand scenario spur-source-silent',
      });
    }
    await board.poll();
    for (const id of LINKED)
      await fakes.spur(
        'session',
        id.startsWith('killed')
          ? { id, status: 'killed', state: 'killed' }
          : { id, status: 'completed', state: 'stopped' },
      );
    const outcomes = await board.poll();
    if (outcomes['spur'] !== 'delivered')
      throw new Error(
        `The spur poll after the sessions ended was ${outcomes['spur'] ?? 'missing'}.`,
      );
    // A poll would start a new runner whose adapter has never seen an instance id, and never
    // report the restart: the scheduled poll of the current runner must see it.
    const before = board.logCount(RESTARTED);
    await fakes.spur('restart');
    await board.until('spur restarted logged', 20_000, () => board.logCount(RESTARTED) > before);
    await fakes.spur('fail', { mode: 'refuse', route: 'all' });
    return {
      tasks,
      sessions: Object.fromEntries(['other-1', 'retained-1', ...LINKED].map((id) => [id, id])),
      sources: { silent: 'spur' },
      items: { silent: 'source:spur' },
    };
  },
  async settled({ board, entities }) {
    const source = entities.sources?.['silent'] ?? 'spur';
    const item = entities.items?.['silent'] ?? `source:${source}`;
    const { sources, items } = await board.call('operator', 'status.get', {});
    const state = sources.find((candidate) => candidate.source === source);
    return settledUnless([
      ...(state?.blindReason === 'stale'
        ? []
        : [`${source} is blind for ${state?.blindReason ?? 'nothing'}`]),
      ...(items.some(({ key }) => key === item) ? [] : [`no item ${item}`]),
    ]);
  },
};
