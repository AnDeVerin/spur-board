import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, batchSchema, type Batch } from '@spur-board/contracts';
import {
  createApply,
  createMembershipMutations,
  createObservationCore,
  openStore,
} from '@spur-board/core';
import { expect, it } from 'vitest';
import { createSpurAdapter } from '../../adapters/src/spur/spur.ts';
import { createFakeSpur } from '../src/fake-spur.ts';

it('commits bounded feed progress, survives recreation and journals a delayed lifecycle edge once', async () => {
  const config = configSchema.parse({
    projects: [
      {
        id: 'demo',
        tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: 'worker', role: 'worker' }],
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });
  let now = Date.parse('2026-11-01T12:00:00.000Z');
  const clock = { now: () => now };
  const file = join(mkdtempSync(join(tmpdir(), 'feed-restart-')), 'board.sqlite');
  let store = openStore(file);
  const fake = createFakeSpur({
    baseUrl: 'http://spur.stand.invalid',
    now: clock.now,
    log: () => undefined,
  });
  const source = () =>
    createSpurAdapter({
      baseUrl: 'http://spur.stand.invalid',
      now: clock.now,
      intervalMs: 15_000,
      flipSmoothingMs: 0,
      fetch: fake.fetch,
    });
  const update = (args: Record<string, unknown>) => {
    expect(fake.control('session', { id: 'worker-1', ...args }).status).toBe(200);
  };
  let core = createObservationCore({ store, config, clock });
  async function poll(): Promise<Batch> {
    const batch = await source().poll({
      ...(await core.context('spur')),
      signal: new AbortController().signal,
    });
    batchSchema.parse(batch);
    await core.observe('spur', {
      batch,
      effectiveComplete: true,
      state: { lastCompleteAt: batch.observedAt, gone: [] },
      outcomes: [],
    });
    return batch;
  }
  try {
    await createApply({ store, config, clock })(
      createMembershipMutations(config).add,
      { task: 'o/r#1' },
      'operator',
    );
    update({
      project: 'worker',
      links: [{ label: 'board-worker', url: 'https://github.com/o/r/issues/1' }],
    });
    await poll();
    for (let index = 0; index < 4000; index++)
      update({ state: index % 2 === 0 ? 'waiting' : 'working' });
    const eventAt = new Date(now).toISOString();
    update({ status: 'killed' });
    now += 15_000;
    const capped = await poll();
    expect(capped.sessionTransitions).toHaveLength(4000);
    expect(capped.items).toHaveLength(1);
    expect(capped.items[0]?.facts).toMatchObject({ lifecycle: 'killed', endReason: 'kill' });
    expect(capped.sessionTransitions?.some((edge) => edge.to === 'killed')).toBe(false);
    const before = await store.db
      .selectFrom('task')
      .select('last_change_at')
      .executeTakeFirstOrThrow();
    await store.close();
    store = openStore(file);
    core = createObservationCore({ store, config, clock });
    expect((await core.context('spur')).cursor).toBe(capped.cursor);
    now += 15_000;
    const delayed = await poll();
    expect(delayed.sessionTransitions).toHaveLength(1);
    expect(delayed.sessionTransitions?.[0]).toMatchObject({
      dimension: 'lifecycle',
      to: 'killed',
      at: eventAt,
    });
    expect(delayed.items).toEqual([]);
    expect(
      await store.db.selectFrom('task').select('last_change_at').executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      (await store.db.selectFrom('session_snapshot').selectAll().executeTakeFirstOrThrow())
        .end_reason,
    ).toBe('kill');
    expect((await poll()).sessionTransitions).toEqual([]);
    const rows = await store.db
      .selectFrom('event')
      .select('payload')
      .where('kind', '=', 'session_state_changed')
      .orderBy('id')
      .execute();
    const transitions = rows.map(
      ({ payload }) =>
        (JSON.parse(payload) as { transition: { position: string; to: string } }).transition,
    );
    expect(transitions).toHaveLength(4003);
    expect(new Set(transitions.map(({ position }) => position)).size).toBe(4003);
    expect(transitions.filter(({ to }) => to === 'killed')).toHaveLength(1);
    expect(fake.violations().items).toEqual([]);
  } finally {
    fake.close();
    await store.close();
  }
}, 30_000);
