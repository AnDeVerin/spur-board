import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, batchSchema, type Batch } from '@spur-board/contracts';
import {
  createApply,
  createBlockMutations,
  tickBoard,
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

it.each(
  (['needs_input', 'error', 'rate_limited', 'stopped'] as const).flatMap((health) =>
    (['active', 'dismissed', 'prethreshold'] as const).flatMap((phase) =>
      (['adapter', 'core and adapter'] as const).map((restart) => ({ health, phase, restart })),
    ),
  ),
)(
  'preserves observed $health episode ($phase, $restart recreation)',
  async ({ health, phase, restart }) => {
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
      thresholds: { staleMultiplier: 1000 },
    });
    let now = Date.parse('2026-11-01T12:00:00.000Z');
    const began = now;
    const clock = { now: () => now };
    const file = join(mkdtempSync(join(tmpdir(), 'stall-restart-')), 'board.sqlite');
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
        intervalMs: config.adapters.spur.intervalMs,
        flipSmoothingMs: config.health.flipSmoothingMs,
        fetch: fake.fetch,
      });
    let adapter = source();
    let core = createObservationCore({ store, config, clock });
    const update = (state: string) => {
      expect(
        fake.control('session', {
          id: 'worker-1',
          project: 'worker',
          status: state === 'stopped' ? 'stopped' : 'running',
          state,
          links: [{ label: 'board-worker', url: 'https://github.com/o/r/issues/1' }],
        }).status,
      ).toBe(200);
    };
    const blocks = () => store.db.selectFrom('block').selectAll().orderBy('id').execute();
    const tick = () => tickBoard({ store, config, clock, completeSince: core.completeSince });
    async function poll() {
      const batch = batchSchema.parse(
        await adapter.poll({
          ...(await core.context('spur')),
          signal: new AbortController().signal,
        }),
      );
      await core.observe('spur', {
        batch,
        effectiveComplete: true,
        state: { lastCompleteAt: batch.observedAt, gone: [] },
        outcomes: [],
      });
      const item = batch.items.find((entry) => entry.kind === 'session');
      if (item?.kind !== 'session') throw new Error('No current session facts');
      return item.facts;
    }
    try {
      await createApply({ store, config, clock })(
        createMembershipMutations(config).add,
        { task: 'o/r#1' },
        'operator',
      );
      update(health);
      const original = await poll();
      const task = await store.db.selectFrom('task').selectAll().executeTakeFirstOrThrow();
      await store.db
        .insertInto('turn')
        .values({
          task_id: task.id,
          column: task.column,
          epoch: task.column_epoch,
          seq: 1,
          role: 'worker',
          reason: 'Observe the episode',
          handed: '[]',
          acked_by: 'agent:worker/worker-1',
          acked_at: new Date(now).toISOString(),
          created_at: new Date(now).toISOString(),
          closed_at: null,
          closed_reason: null,
        })
        .execute();
      now += phase === 'prethreshold' ? 300_000 : config.health.turnStallAfterMs;
      await tick();
      if (phase === 'dismissed') {
        const [block] = await blocks();
        if (block === undefined) throw new Error('Missing original block');
        await createApply({ store, config, clock })(
          createBlockMutations(config).unblock,
          { mode: 'reason', block: `B${String(block.id)}`, reason: 'Handled' },
          'operator',
        );
      }
      const before = await blocks();
      expect(before).toHaveLength(phase === 'prethreshold' ? 0 : 1);
      now += 1000;
      const restartedAt = now;
      if (restart === 'core and adapter') {
        await store.close();
        store = openStore(file);
        core = createObservationCore({ store, config, clock });
      }
      adapter = source();
      const reproduced = await poll();
      expect(reproduced.health).toBe(health);
      expect(reproduced.healthSince).not.toBe(original.healthSince);
      expect(await blocks()).toEqual(before);
      const due =
        (restart === 'core and adapter' ? restartedAt : began) + config.health.turnStallAfterMs;
      if (phase === 'prethreshold') {
        now = due - 1;
        await tick();
        expect(await blocks()).toEqual([]);
        now += 1;
        await tick();
        expect(await blocks()).toHaveLength(1);
      } else {
        now = restartedAt + config.health.turnStallAfterMs;
        await tick();
        expect(await blocks()).toEqual(before);
      }
      const established = await blocks();
      update('working');
      expect((await poll()).health).toBe(health);
      expect(await blocks()).toEqual(established);
      now += config.health.flipSmoothingMs;
      expect((await poll()).health).toBe('working');
      expect((await blocks()).every((block) => block.state === 'unblocked')).toBe(true);
      update(health);
      expect((await poll()).health).toBe('working');
      const relapseAt = now;
      now += config.health.flipSmoothingMs;
      expect((await poll()).health).toBe(health);
      now = relapseAt + config.health.turnStallAfterMs - 1;
      await tick();
      expect((await blocks()).filter((block) => block.state === 'open')).toEqual([]);
      now += 1;
      await tick();
      const renewed = await blocks();
      expect(renewed).toHaveLength(established.length + 1);
      expect(renewed.at(-1)?.state).toBe('open');
      expect(fake.violations().items).toEqual([]);
    } finally {
      fake.close();
      await store.close();
    }
  },
);
