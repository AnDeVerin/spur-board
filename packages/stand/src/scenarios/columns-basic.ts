import { COLUMN_IDS } from '@spur-board/contracts';
import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

/** One task in each of the nine columns, issue i in column i. */
export const columnsBasic: Scenario = {
  name: 'columns-basic',
  summary: 'Nine tasks from open issues 1-9, one in each column.',
  async seed(board, fakes) {
    await openIssues(fakes, COLUMN_IDS.length, (number) => COLUMN_IDS[number - 1] ?? '');
    await board.poll();
    const tasks = Object.fromEntries(COLUMN_IDS.map((column, i) => [column, issueKey(i + 1)]));
    await board.direct(
      'task.column set by hand: no operation moves a task before the dispatcher (#68)',
      async (db) => {
        for (const [i, column] of COLUMN_IDS.entries())
          await db
            .updateTable('task')
            .set({ column })
            .where('project', '=', 'stand')
            .where('key', '=', issueKey(i + 1))
            .executeTakeFirstOrThrow();
      },
    );
    return { tasks };
  },
  async settled({ board, entities }) {
    const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
    const columnOf = new Map(tasks.map((task) => [task.key, task.column]));
    return settledUnless(
      Object.entries(entities.tasks ?? {}).flatMap(([column, key]) =>
        columnOf.get(key) === column
          ? []
          : [`${key} is in ${columnOf.get(key) ?? 'no column'}, not ${column}`],
      ),
    );
  },
};
