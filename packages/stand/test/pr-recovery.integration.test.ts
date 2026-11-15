import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type PrFacts } from '@spur-board/contracts';
import { createFakeAdapter } from '@spur-board/adapters/testing';
import { createObservationCore, createOperationRegistry, openStore } from '@spur-board/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startRunner, type AdapterRunner } from '../../adapters/src/runner/runner.ts';
import { dispatchOperation } from '../../core/src/app/operations.ts';

const initial = Date.parse('2026-01-01T00:00:00.000Z');
const source = 'github:board:o/r';
const ref = { kind: 'pr' as const, repo: 'o/r', number: 7 };
const other = { ...ref, number: 8 };
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const facts: PrFacts = {
  repo: 'o/r',
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  title: 'Work',
  author: 'worker',
  headSha: 'a'.repeat(40),
  headBranch: 'work',
  state: 'open',
  draft: false,
  mergeable: 'unknown',
  mergeState: 'unknown',
  requiredChecks: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  reviewRequests: [],
  ticketKeys: [],
  updatedAt: new Date(initial).toISOString(),
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(initial);
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['task refresh', 'manual-link refresh'] as const)(
  '%s resets persisted and live misses before a later incomplete no_access poll',
  async (route) => {
    const home = mkdtempSync(join(tmpdir(), 'board-pr-recovery-'));
    const store = openStore(join(home, 'board.db'));
    const clock = { now: () => Date.now() };
    const core = createObservationCore({ store, config, clock });
    let regular = 0;
    const adapter = createFakeAdapter({
      id: source,
      intervalMs: 1000,
      poll: () =>
        Promise.resolve({
          source,
          observedAt: new Date().toISOString(),
          complete: regular++ < 3,
          items: [],
          entities: [ref, other].map((ref) => ({
            ref,
            status: regular <= 3 ? ('not_found' as const) : ('no_access' as const),
          })),
        }),
      pollPr: () =>
        Promise.resolve({
          source,
          observedAt: new Date().toISOString(),
          complete: false,
          items: [{ kind: 'pr', facts }],
          entities: [{ ref, status: 'ok' }],
        }),
    });
    let runner: AdapterRunner | undefined;
    const registry = createOperationRegistry({
      config,
      clock,
      completeSince: core.completeSince,
      prPoller: () => runner?.pollPr?.bind(runner),
    });
    const dispatch = { store, config, clock, registry };
    try {
      await dispatchOperation(dispatch, 'task.add', { task: 'o/r#9' }, 'operator', 'add');
      const task = await store.db
        .selectFrom('task')
        .select('id')
        .where('key', '=', 'o/r#9')
        .executeTakeFirstOrThrow();
      await dispatchOperation(dispatch, 'task.add', { task: 'o/r#10' }, 'operator', 'add-other');
      const otherTask = await store.db
        .selectFrom('task')
        .select('id')
        .where('key', '=', 'o/r#10')
        .executeTakeFirstOrThrow();
      for (const number of [7, 8])
        await store.db
          .insertInto('link')
          .values({
            task_id: number === 7 ? task.id : otherTask.id,
            entity: 'pr',
            repo: 'o/r',
            number,
            pr_state: 'active',
            pr_open: 0,
            source: 'manual',
            created_at: new Date().toISOString(),
          })
          .execute();
      runner = startRunner({ entries: [{ adapter }], core, config, now: clock.now });
      await vi.advanceTimersByTimeAsync(2000);
      const misses = () =>
        store.db
          .selectFrom('source_miss')
          .selectAll()
          .where('source', '=', source)
          .orderBy('ref_key')
          .execute();
      expect(await misses()).toMatchObject([
        { misses: 3, gone: 1 },
        { misses: 3, gone: 1 },
      ]);
      const warning = () =>
        store.db
          .selectFrom('operator_item')
          .selectAll()
          .where('item_key', '=', `pr-outcome:${String(task.id)}:o/r#7`)
          .where('cleared_at', 'is', null)
          .execute();
      expect(await warning()).toHaveLength(1);
      const before = await store.db
        .selectFrom('source_state')
        .selectAll()
        .where('source', '=', source)
        .executeTakeFirstOrThrow();
      if (route === 'task refresh')
        await dispatchOperation(dispatch, 'task.get', { task: 'o/r#9', refresh: true }, 'operator');
      else
        await dispatchOperation(
          dispatch,
          'link.add',
          { mode: 'pr', task: 'o/r#9', pr: facts.url, reason: 'Recover work.' },
          'operator',
          'refresh',
        );
      expect(adapter.prRequests).toHaveLength(1);
      expect(await misses()).toMatchObject([{ ref_key: 'pr:o/r#8', misses: 3, gone: 1 }]);
      expect(await warning()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(regular).toBe(4);
      expect(await misses()).toMatchObject([
        { ref_key: 'pr:o/r#7', misses: 0, gone: 0 },
        { ref_key: 'pr:o/r#8', misses: 3, gone: 1 },
      ]);
      expect(await warning()).toEqual([]);
      const after = await store.db
        .selectFrom('source_state')
        .selectAll()
        .where('source', '=', source)
        .executeTakeFirstOrThrow();
      expect(after.last_complete_at).toBe(before.last_complete_at);
      expect(after.cursor).toBe(before.cursor);
      expect(JSON.parse(after.gone)).toEqual([other]);
    } finally {
      await runner?.stop();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
