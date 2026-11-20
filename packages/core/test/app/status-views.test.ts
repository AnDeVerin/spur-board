import { Kysely, SqliteDialect, type CompiledQuery } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { readStatusColumnEntries } from '../../src/app/status-views.ts';
import type { Store, Tables } from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { openTempStore, rawDatabase } from '../support/store.ts';

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 8, minute)).toISOString();

it("reads one task's column entry through the task's own events", async () => {
  const { store, file } = openTempStore('board-column-entries-');
  stores.push(store);
  for (const id of [1, 2])
    await store.db
      .insertInto('task')
      .values({
        ...sampleRows.task,
        id,
        key: `o/r#${String(id)}`,
        tracker_id: String(id),
        membership: 'active',
        column: 'dev',
        created_at: at(0),
      })
      .execute();
  const entry = (id: number, taskId: number, minute: number) => ({
    ...sampleRows.event,
    id,
    at: at(minute),
    task_id: taskId,
    kind: 'task_moved',
    payload: JSON.stringify({ from: 'todo', to: 'dev', reason: 'gate_passed' }),
  });
  // The other task entered Dev later: a project-wide pick of the latest entry would take its row.
  await store.db
    .insertInto('event')
    .values([entry(1, 1, 1), entry(2, 2, 5)])
    .execute();

  const all = await readStatusColumnEntries(store.db, new Set(['proj']));
  expect(all.map((row) => [row.task_id, row.at])).toEqual([
    [1, at(1)],
    [2, at(5)],
  ]);
  const one = await readStatusColumnEntries(store.db, new Set(['proj']), 1);
  expect(one).toEqual(all.filter((row) => row.task_id === 1));

  // The scoped query reads the event table through its `(task_id, id)` index.
  const database = rawDatabase(file);
  const queries: CompiledQuery[] = [];
  const logged = new Kysely<Tables>({
    dialect: new SqliteDialect({ database }),
    log: (event) => {
      queries.push(event.query);
    },
  });
  try {
    await readStatusColumnEntries(logged, new Set(['proj']), 1);
    const [query] = queries;
    if (query === undefined) throw new Error('no query');
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.parameters) as {
      detail: string;
    }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(
      /SEARCH entry USING (COVERING )?INDEX event_task_id \(task_id=\?\)/,
    );
  } finally {
    await logged.destroy();
  }
});
