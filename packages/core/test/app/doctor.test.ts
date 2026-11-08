import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueLiveAfterFirstPoll } from '../../src/app/doctor.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { createObservationCore, openStore, type Store } from '../../src/index.ts';

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
      await trx
        .insertInto('operator_item')
        .values({
          item_key: 'manual',
          raise_no: 1,
          kind: 'manual',
          text: 'Needs attention',
          url: 'https://example.com',
          task_id: null,
          block_id: null,
          raised_at: at,
          cleared_at: null,
          line_outbox_id: null,
          inbound_event_json: null,
        })
        .execute();
    });
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
