import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type SessionFacts } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { curatorSessions, enqueueLiveAfterFirstPoll, firstPollDone } from '../../src/app/doctor.ts';
import { raiseItem } from '../../src/app/feed.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import type { ItemKind } from '../../src/domain/fromYou.ts';
import { createObservationCore, getStatus, openStore, type Store } from '../../src/index.ts';

const at = '2026-11-04T12:00:00.000Z';
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const sources = ['github-issues:board:o/r', 'github:board:o/r', 'spur'] as const;
const stores: Store[] = [];

function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-doctor-')), 'board.db'));
  stores.push(store);
  const core = (productVersion: string) =>
    createObservationCore({ store, config, clock: { now: () => Date.parse(at) }, productVersion });
  return { store, core };
}

async function poll(
  core: ReturnType<ReturnType<typeof setup>['core']>,
  source: string,
  options: { complete?: boolean; blind?: boolean } = {},
) {
  const complete = options.complete ?? true;
  await core.observe(source, {
    batch: { source, observedAt: at, complete, items: [], entities: [] },
    effectiveComplete: complete && !options.blind,
    state: {
      ...(complete && !options.blind ? { lastCompleteAt: at } : {}),
      gone: [],
      ...(options.blind ? { blind: { reason: 'auth' as const, message: 'Unavailable' } } : {}),
    },
    outcomes: [],
  });
}

function item(itemKey: string, kind: ItemKind) {
  return {
    itemKey,
    kind,
    text: 'Needs attention',
    url: 'https://example.com',
    taskId: null,
    blockId: null,
    at: new Date(at),
  };
}

async function liveText(store: Store, kinds: readonly ItemKind[]) {
  await scanTransaction(store, config, async (trx) => {
    for (const [index, kind] of kinds.entries())
      await raiseItem(trx, item(`item-${String(index)}`, kind));
    await enqueueLiveAfterFirstPoll(trx, {
      config,
      productVersion: '1.2.3',
      completeSince: new Map(sources.map((source) => [source, at])),
      blind: new Set(),
      at,
    });
  });
  const [live] = await liveRows(store);
  if (live === undefined) throw new Error('Missing live row');
  return (JSON.parse(live.payload) as { text: string }).text;
}

async function liveRows(store: Store) {
  return store.db
    .selectFrom('outbox')
    .select(['dedupe_key', 'payload'])
    .where('dedupe_key', 'like', 'doctor:live:%')
    .orderBy('id')
    .execute();
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('live feed announcement', () => {
  it('waits for complete polls from every configured source, then counts current tasks and items', async () => {
    const { store, core } = setup();
    const observation = core('1.2.3');
    await poll(observation, sources[0], { complete: false });
    await poll(observation, sources[1]);
    await poll(observation, sources[2]);
    expect(await liveRows(store)).toHaveLength(0);
    await store.transaction(async (trx) => {
      await trx
        .insertInto('task')
        .values({
          project: 'board',
          tracker_kind: 'github-issues',
          tracker_id: null,
          key: 'o/r#9',
          membership: 'active',
          archive_reason: null,
          column: 'todo',
          shadow_column: null,
          created_at: at,
          manual_include: 1,
          manual_exclude: 0,
          last_change_at: at,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
    });
    await scanTransaction(store, config, (trx) => raiseItem(trx, item('gap', 'inbound_gap')));
    await poll(observation, sources[0]);
    const rows = await liveRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupe_key).toBe('doctor:live:1.2.3');
    const live = rows[0];
    if (live === undefined) throw new Error('Missing live row');
    expect(JSON.parse(live.payload)).toMatchObject({
      text: 'spur-board is live: 1 tasks, 1 for you',
    });
    expect(
      (
        await store.db
          .selectFrom('meta')
          .select('value')
          .where('key', '=', 'doctor_live_version')
          .executeTakeFirst()
      )?.value,
    ).toBe('"1.2.3"');
  });

  it('counts only items with a feed line and keeps a quiet item in status', async () => {
    const both = setup();
    expect(await liveText(both.store, ['worker_ended', 'inbound_gap'])).toBe(
      'spur-board is live: 0 tasks, 1 for you',
    );

    const quiet = setup();
    expect(await liveText(quiet.store, ['worker_ended'])).toBe(
      'spur-board is live: 0 tasks, 0 for you',
    );
    const status = await getStatus({
      store: quiet.store,
      config,
      clock: { now: () => Date.parse(at) },
      completeSince: new Map(),
    });
    expect(status.items).toMatchObject([{ key: 'item-0', summary: 'Needs attention' }]);
  });

  it('does not treat a blind poll as complete and does not repost after a same-version restart', async () => {
    const { store, core } = setup();
    const first = core('1.2.3');
    await poll(first, sources[0]);
    await poll(first, sources[1], { blind: true });
    await poll(first, sources[2]);
    expect(await liveRows(store)).toHaveLength(0);
    await poll(first, sources[1]);
    expect(await liveRows(store)).toHaveLength(1);

    const restarted = core('1.2.3');
    for (const source of sources) await poll(restarted, source);
    expect(await liveRows(store)).toHaveLength(1);
  });

  it('waits for new complete polls before announcing an upgraded version', async () => {
    const { store, core } = setup();
    for (const source of sources) await poll(core('1.2.3'), source);
    expect(await liveRows(store)).toHaveLength(0);
    const first = core('1.2.3');
    for (const source of sources) await poll(first, source);
    expect(await liveRows(store)).toHaveLength(1);

    const upgraded = core('1.2.4');
    await poll(upgraded, sources[0]);
    await poll(upgraded, sources[1]);
    expect(await liveRows(store)).toHaveLength(1);
    await poll(upgraded, sources[2]);
    expect((await liveRows(store)).map((row) => row.dedupe_key)).toEqual([
      'doctor:live:1.2.3',
      'doctor:live:1.2.4',
    ]);
  });

  it('reports the first poll done once every source that is not blind has completed', async () => {
    const { store, core } = setup();
    const observation = core('1.2.3');
    const done = () => firstPollDone(store.db, config, observation.completeSince);
    expect(await done()).toBe(false);
    await poll(observation, sources[0]);
    await poll(observation, sources[1], { blind: true });
    expect(await done()).toBe(false);
    await poll(observation, sources[2], { complete: false });
    expect(await done()).toBe(false);
    await poll(observation, sources[2]);
    expect(observation.completeSince.has(sources[1])).toBe(false);
    expect(await done()).toBe(true);
  });

  it('rolls back the marker and feed row with the observation transaction', async () => {
    const { store } = setup();
    await expect(
      scanTransaction(store, config, async (trx) => {
        await enqueueLiveAfterFirstPoll(trx, {
          config,
          productVersion: '1.2.3',
          completeSince: new Map(sources.map((source) => [source, at])),
          blind: new Set(),
          at,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await liveRows(store)).toHaveLength(0);
    expect(
      await store.db
        .selectFrom('meta')
        .select('value')
        .where('key', '=', 'doctor_live_version')
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});

const curatorConfig = configSchema.parse({
  projects: ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
    id,
    tracker: { type: 'github-issues', repo: `o/${id}`, label: 'board' },
    repos: [`o/${id}`],
    operatorGithubLogin: 'operator',
    spurProjects: id === 'delta' ? [] : [{ name: `cur-${id[0] ?? ''}`, role: 'curator' }],
  })),
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});

function curatorSetup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-curators-')), 'board.db'));
  stores.push(store);
  const core = createObservationCore({
    store,
    config: curatorConfig,
    clock: { now: () => Date.parse(at) },
  });
  return { store, core };
}

function curatorSession(
  id: string,
  options: { lifecycle?: SessionFacts['lifecycle']; lastActivityAt?: string | null } = {},
): SessionFacts {
  return {
    id,
    spurProject: id.split('-').slice(0, 2).join('-'),
    branch: null,
    pr: null,
    links: {},
    lifecycle: options.lifecycle ?? 'running',
    health: 'working',
    healthSince: at,
    lastActivityAt: options.lastActivityAt ?? null,
    endedAt: null,
    endReason: null,
  };
}

async function spurPoll(
  core: ReturnType<typeof curatorSetup>['core'],
  observedAt: string,
  sessions: readonly SessionFacts[],
  complete = false,
) {
  await core.observe('spur', {
    batch: {
      source: 'spur',
      observedAt,
      complete,
      items: sessions.map((facts) => ({ kind: 'session' as const, facts })),
      entities: [],
    },
    effectiveComplete: complete,
    state: { ...(complete ? { lastCompleteAt: observedAt } : {}), gone: [] },
    outcomes: [],
  });
}

async function sessionOf(store: Store, project: string) {
  return (await curatorSessions(store.db, curatorConfig)).find((entry) => entry.project === project)
    ?.session;
}

describe('curator sessions', () => {
  it('drops absent, completed and errored sessions and keeps paused ones live', async () => {
    const { store, core } = curatorSetup();
    const listed = [
      curatorSession('cur-a-done', { lifecycle: 'completed' }),
      curatorSession('cur-b-1', { lifecycle: 'paused' }),
      curatorSession('cur-g-1', { lifecycle: 'errored' }),
    ];
    await spurPoll(
      core,
      '2026-11-04T12:00:00.000Z',
      [curatorSession('cur-a-gone'), ...listed],
      true,
    );
    expect((await curatorSessions(store.db, curatorConfig))[0]?.session).toBe('cur-a-gone');
    await spurPoll(core, '2026-11-04T12:01:00.000Z', listed, true);
    expect(await curatorSessions(store.db, curatorConfig)).toEqual([
      { project: 'alpha', curator: 'cur-a', session: null },
      { project: 'beta', curator: 'cur-b', session: 'cur-b-1' },
      // An errored session cannot read a ring, so the doorbells do not choose it.
      { project: 'gamma', curator: 'cur-g', session: null },
      { project: 'delta', curator: null, session: null },
    ]);
  });

  it('picks the later first seen as an instant across mixed precision', async () => {
    const { store, core } = curatorSetup();
    await spurPoll(core, '2026-11-04T12:00:00Z', [curatorSession('cur-a-1')]);
    await spurPoll(core, '2026-11-04T12:00:00.5Z', [curatorSession('cur-a-2')]);
    expect(await sessionOf(store, 'alpha')).toBe('cur-a-2');
  });

  it('breaks a first-seen tie by the later activity as an instant', async () => {
    const { store, core } = curatorSetup();
    await spurPoll(core, at, [
      curatorSession('cur-a-1', { lastActivityAt: '2026-11-04T10:00:00Z' }),
      curatorSession('cur-a-2', { lastActivityAt: '2026-11-04T10:00:00.5Z' }),
    ]);
    expect(await sessionOf(store, 'alpha')).toBe('cur-a-2');
  });

  it('sorts a null activity as the oldest', async () => {
    const { store, core } = curatorSetup();
    await spurPoll(core, at, [
      curatorSession('cur-a-1'),
      curatorSession('cur-a-2', { lastActivityAt: '2026-11-04T10:00:00.000Z' }),
    ]);
    expect(await sessionOf(store, 'alpha')).toBe('cur-a-2');
  });

  it.each([
    { column: 'detail', value: 'not json' },
    { column: 'first_seen', value: 'not a date' },
  ] as const)('sorts a row with an unreadable $column as the oldest', async ({ column, value }) => {
    const { store, core } = curatorSetup();
    // Untouched, cur-a-1 wins on its later activity.
    await spurPoll(core, at, [
      curatorSession('cur-a-1', { lastActivityAt: '2026-11-04T11:00:00.000Z' }),
      curatorSession('cur-a-2', { lastActivityAt: '2026-11-04T10:00:00.000Z' }),
    ]);
    expect(await sessionOf(store, 'alpha')).toBe('cur-a-1');
    await store.db
      .updateTable('session_snapshot')
      .set({ [column]: value })
      .where('id', '=', 'cur-a-1')
      .execute();
    expect(await sessionOf(store, 'alpha')).toBe('cur-a-2');
  });

  it('still reports an unreadable row when it is the only live session', async () => {
    const { store, core } = curatorSetup();
    await spurPoll(core, at, [curatorSession('cur-a-1')]);
    await store.db
      .updateTable('session_snapshot')
      .set({ detail: 'not json', first_seen: 'not a date' })
      .where('id', '=', 'cur-a-1')
      .execute();
    expect(await sessionOf(store, 'alpha')).toBe('cur-a-1');
  });
});
