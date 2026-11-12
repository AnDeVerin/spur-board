import { COLUMN_IDS } from '@spur-board/contracts';
import { issueKey, jiraKey, openIssues, openJiraIssues, settledUnless } from './helpers.ts';
import type { Scenario, ScenarioFakes } from './index.ts';

/** One task in each of the nine columns of `project`, ticket i in column i. */
function columnsScenario(options: {
  name: string;
  summary: string;
  project: string;
  key: (number: number) => string;
  open: (fakes: ScenarioFakes, count: number, title: (number: number) => string) => Promise<void>;
}): Scenario {
  const { project, key } = options;
  return {
    name: options.name,
    summary: options.summary,
    async seed(board, fakes) {
      await options.open(fakes, COLUMN_IDS.length, (number) => COLUMN_IDS[number - 1] ?? '');
      await board.poll();
      const tasks = Object.fromEntries(COLUMN_IDS.map((column, i) => [column, key(i + 1)]));
      await board.direct(
        'task.column set by hand: no operation moves a task before the dispatcher (#68)',
        async (db) => {
          for (const [i, column] of COLUMN_IDS.entries())
            await db
              .updateTable('task')
              .set({ column })
              .where('project', '=', project)
              .where('key', '=', key(i + 1))
              .executeTakeFirstOrThrow();
        },
      );
      return { tasks };
    },
    async settled({ board, entities }) {
      const { tasks } = await board.call('operator', 'status.get', { project });
      const columnOf = new Map(tasks.map((task) => [task.key, task.column]));
      return settledUnless(
        Object.entries(entities.tasks ?? {}).flatMap(([column, task]) =>
          columnOf.get(task) === column
            ? []
            : [`${task} is in ${columnOf.get(task) ?? 'no column'}, not ${column}`],
        ),
      );
    },
  };
}

export const columnsBasic = columnsScenario({
  name: 'columns-basic',
  summary: 'Nine tasks from open issues 1-9, one in each column.',
  project: 'stand',
  key: issueKey,
  open: openIssues,
});

export const columnsBasicJira = columnsScenario({
  name: 'columns-basic-jira',
  summary: 'Nine stand-jira tasks from Jira tickets STAND-1..9, one in each column.',
  project: 'stand-jira',
  key: jiraKey,
  open: openJiraIssues,
});
