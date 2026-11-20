import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const REPO = 'stand-org/board';
const PROJECT = 'stand-org/1';
const SOURCE = `github-project:stand:${PROJECT}`;
/** Each seeded task by its scenario name, with the column the mirror places it in. */
const EXPECTED = { ready: 'ready-for-dev', backlog: 'todo', outside: 'todo' } as const;

/** Ready for Dev mirrors the fake GitHub Project's Status, so the Project places the tasks. */
export const readyMirror: Scenario = {
  name: 'ready-mirror',
  summary: `Ready for Dev mirrors Status = Ready of GitHub Project ${PROJECT} through ${SOURCE}: issue 1 is Ready, issue 2 Backlog and issue 3 outside the Project.`,
  config: {
    stand: {
      columns: [
        { id: 'todo' },
        { id: 'triage' },
        {
          id: 'ready-for-dev',
          source: { type: 'tracker', project: PROJECT, field: 'Status', value: 'Ready' },
        },
        { id: 'dev' },
        { id: 'done' },
      ],
    },
  },
  async seed(board, fakes) {
    await openIssues(fakes, 3);
    await fakes.github('issue-project-status', { repo: REPO, number: 1, status: 'Ready' });
    await fakes.github('issue-project-status', { repo: REPO, number: 2, status: 'Backlog' });
    // The tracker and the mirror poll side by side: the second poll reads the Project after the
    // first one created the tasks.
    await board.poll();
    await board.poll();
    return {
      tasks: { ready: issueKey(1), backlog: issueKey(2), outside: issueKey(3) },
      sources: { mirror: SOURCE },
    };
  },
  async settled({ board, entities }) {
    const source = entities.sources?.['mirror'] ?? SOURCE;
    const { tasks, sources } = await board.call('operator', 'status.get', { project: 'stand' });
    const columnOf = new Map(tasks.map((task) => [task.key, task.column]));
    const mirror = sources.find((candidate) => candidate.source === source);
    return settledUnless([
      ...Object.entries(EXPECTED).flatMap(([name, column]) => {
        const task = entities.tasks?.[name] ?? '';
        const actual = columnOf.get(task);
        return actual === column ? [] : [`${task} is in ${actual ?? 'no column'}, not ${column}`];
      }),
      ...(mirror === undefined
        ? [`no source ${source}`]
        : [
            ...(mirror.lastCompleteAt === null ? [`${source} has no complete read`] : []),
            ...(mirror.failure
              ? [`${source} failed ${mirror.failure.code}: ${mirror.failure.message}`]
              : []),
          ]),
    ]);
  },
};
