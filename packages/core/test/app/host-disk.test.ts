import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { dismissItem } from '../../src/app/feed.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { recordHostDisk, tickBoard, type HostDiskSample, type Store } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';

const START = Date.parse('2026-11-03T10:00:00.000Z');
const GIB = 2 ** 30;
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'web', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function setup() {
  const { store } = openTempStore('core-host-disk-');
  stores.push(store);
  let now = START;
  const clock = { now: () => now };
  /** Records one sample of `volumes` (mount, percent used) 30 s after the last. */
  const sample = async (...volumes: [string, number][]) => {
    now += 30_000;
    const value: HostDiskSample = {
      sampledAt: new Date(now).toISOString(),
      volumes: volumes.map(([mount, usedPercent]) => ({
        mount,
        usedPercent,
        availableBytes: ((100 - usedPercent) / 100) * 100 * GIB,
      })),
    };
    await recordHostDisk(store, value);
  };
  const tick = () => tickBoard({ store, config, clock, completeSince: new Map() });
  const items = () =>
    store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'like', 'host-disk:%')
      .orderBy('id')
      .execute();
  const active = async () => (await items()).filter((item) => item.cleared_at === null);
  const outbox = (kind: string) =>
    store.db.selectFrom('outbox').selectAll().where('kind', '=', kind).execute();
  const state = async () => {
    const row = await store.db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', 'host_disk')
      .executeTakeFirst();
    return row === undefined ? undefined : (JSON.parse(row.value) as Record<string, unknown>);
  };
  return { store, sample, tick, items, active, outbox, state, now: () => now };
}

describe('host disk items', () => {
  it('raises one item per volume after two samples at or above 90%', async () => {
    const board = setup();
    await board.sample(['/', 95], ['/data', 90], ['/tmp', 50]);
    await board.sample(['/', 95], ['/data', 90], ['/tmp', 50]);
    await board.tick();
    const active = await board.active();
    expect(active.map((item) => [item.item_key, item.kind, item.task_id, item.text])).toEqual([
      ['host-disk:/', 'board_observation', null, 'host disk /: 95% used, 5.0 GiB free'],
      ['host-disk:/data', 'board_observation', null, 'host disk /data: 90% used, 10.0 GiB free'],
    ]);
    for (const item of active) expect(item.line_outbox_id).not.toBeNull();
    expect(await board.outbox('feed.line')).toHaveLength(2);
  });

  it('a single sample at 90% raises nothing', async () => {
    const board = setup();
    await board.sample(['/', 90]);
    await board.tick();
    await board.sample(['/', 89.9]);
    await board.sample(['/', 95]);
    await board.tick();
    expect(await board.items()).toEqual([]);
  });

  it('keeps the item between 80% and 90% and clears below 80%', async () => {
    const board = setup();
    await board.sample(['/', 95]);
    await board.sample(['/', 95]);
    await board.tick();
    const [raised] = await board.active();
    expect(raised?.raise_no).toBe(1);

    await board.sample(['/', 85]);
    await board.tick();
    const [kept] = await board.active();
    expect(kept).toMatchObject({
      id: raised?.id,
      raise_no: 1,
      text: 'host disk /: 85% used, 15.0 GiB free',
      fact_at: new Date(board.now()).toISOString(),
    });
    expect(await board.outbox('feed.line')).toHaveLength(1);
    expect(await board.outbox('feed.line.edit')).toEqual([]);

    await board.sample(['/', 79.9]);
    await board.tick();
    expect(await board.active()).toEqual([]);
    expect(await board.outbox('feed.line.edit')).toHaveLength(1);

    await board.sample(['/', 92]);
    await board.sample(['/', 92]);
    await board.tick();
    const [again] = await board.active();
    expect(again).toMatchObject({ item_key: 'host-disk:/', raise_no: 2 });
    expect(again?.id).not.toBe(raised?.id);
  });

  it('keeps a closed item closed until the episode ends', async () => {
    const board = setup();
    await board.sample(['/', 95]);
    await board.sample(['/', 95]);
    await board.tick();
    const [raised] = await board.active();
    if (raised === undefined) throw new Error('no item');
    await scanTransaction(board.store, config, (trx) =>
      dismissItem(trx, raised, 'operator', new Date(board.now())),
    );
    await board.sample(['/', 85]);
    await board.sample(['/', 96]);
    await board.sample(['/', 96]);
    await board.tick();
    expect(await board.active()).toEqual([]);

    await board.sample(['/', 50]);
    await board.sample(['/', 95]);
    await board.sample(['/', 95]);
    await board.tick();
    expect(await board.active()).toMatchObject([{ item_key: 'host-disk:/', raise_no: 2 }]);
  });

  it('never raises for CPU or RAM', async () => {
    const board = setup();
    const busy = {
      sampledAt: new Date(START).toISOString(),
      cpuPercent: 99,
      memory: { totalBytes: GIB, availableBytes: 0.01 * GIB, usedPercent: 99 },
      volumes: [
        { mount: '/', usedPercent: 50, availableBytes: 50 * GIB },
        { mount: '/data', usedPercent: 50, availableBytes: 50 * GIB },
      ],
    };
    await recordHostDisk(board.store, busy);
    await recordHostDisk(board.store, {
      ...busy,
      sampledAt: new Date(START + 30_000).toISOString(),
    });
    await board.tick();
    expect(await board.items()).toEqual([]);
    const state = await board.state();
    expect(Object.keys(state ?? {})).toEqual(['/', '/data']);
    for (const entry of Object.values(state ?? {})) expect(entry).toMatchObject({ since: null });
  });

  it('keeps a mount missing from a sample and reads a malformed state as empty', async () => {
    const board = setup();
    await board.sample(['/', 95]);
    await board.sample(['/', 95]);
    await board.sample(['/data', 10]);
    await board.tick();
    expect((await board.active()).map((item) => item.item_key)).toEqual(['host-disk:/']);

    await board.store.db
      .updateTable('meta')
      .set({ value: '{"/":{"streak":"x"}}' })
      .where('key', '=', 'host_disk')
      .execute();
    await board.tick();
    expect(await board.active()).toEqual([]);
    await board.sample(['/', 95]);
    expect(await board.state()).toMatchObject({ '/': { streak: 1, since: null } });
  });
});
