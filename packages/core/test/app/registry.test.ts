import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import { createOperationRegistry, createQuery, openStore, type Store } from '../../src/index.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'first',
      tracker: { type: 'github-issues', repo: 'o/first', label: 'board' },
      repos: ['o/first'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'first-worker', role: 'worker' }],
    },
    {
      id: 'second',
      tracker: { type: 'github-issues', repo: 'o/second', label: 'board' },
      repos: ['o/second'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'second-worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

it('registers status and limits an agent to its configured project', async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-registry-')), 'board.db'));
  stores.push(store);
  await store.transaction(async (trx) => {
    for (const [project, key] of [
      ['first', 'o/first#1'],
      ['second', 'o/second#2'],
    ] as const) {
      await trx
        .insertInto('task')
        .values({
          project,
          tracker_kind: 'github-issues',
          tracker_id: key,
          key,
          membership: 'active',
          archive_reason: null,
          column: 'todo',
          shadow_column: null,
          created_at: new Date(clock.now()).toISOString(),
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
    }
  });
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const status = registry['status.get'];
  if (status === undefined) throw new Error('Status handler was not registered');
  const query = createQuery({ store, config, clock });
  const agent = 'agent:first-worker/session-1' as const;
  const visible = await query(status, {}, agent);
  expect(visible.tasks.map((task) => task.key)).toEqual(['o/first#1']);
  expect(visible.sources.every((source) => !source.source.includes('second'))).toBe(true);
  await expect(query(status, { project: 'second' }, agent)).rejects.toMatchObject({
    code: 'forbidden',
  });
  const operator = await query(status, {}, 'operator');
  expect(operator.tasks.map((task) => task.key).sort()).toEqual(['o/first#1', 'o/second#2']);
});
