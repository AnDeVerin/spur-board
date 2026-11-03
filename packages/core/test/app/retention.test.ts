import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandRetention, openStore, type Store } from '../../src/index.ts';

const DAY_MS = 86_400_000;
const START = Date.parse('2026-11-03T10:00:00.000Z');

const open: Store[] = [];

function freshStore(): Store {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-retention-')), 'board.db'));
  open.push(store);
  return store;
}

async function seed(store: Store, rows: Record<string, number>): Promise<void> {
  await store.transaction(async (trx) => {
    for (const [key, ms] of Object.entries(rows)) {
      await trx
        .insertInto('command')
        .values({
          actor: 'operator',
          key,
          operation: 'test.touch',
          fingerprint: null,
          result: '{}',
          at: new Date(ms).toISOString(),
        })
        .execute();
    }
  });
}

async function keys(store: Store): Promise<string[]> {
  const rows = await store.db.selectFrom('command').select('key').orderBy('key').execute();
  return rows.map((row) => row.key);
}

/** A clock the test moves together with the fake timers. */
function testClock(): { now(): number; advance(ms: number): Promise<void> } {
  let now = START;
  return {
    now: () => now,
    async advance(ms) {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const store of open.splice(0)) await store.close();
});

describe('commandRetention', () => {
  it.each([7, 2])('purges keys older than %i days at start', async (days) => {
    const store = freshStore();
    await seed(store, {
      expired: START - days * DAY_MS - 1,
      cutoff: START - days * DAY_MS,
      fresh: START - 1,
    });
    const retention = commandRetention({
      store,
      clock: { now: () => START },
      retentionDays: days,
      onError: () => undefined,
    });

    await retention.start();
    expect(await keys(store)).toEqual(['cutoff', 'fresh']);
    await retention.stop();
  });

  it('purges once a day until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = freshStore();
    const clock = testClock();
    // Expires one day after start; `later` expires one day after that.
    await seed(store, { soon: START - DAY_MS, later: START });
    const onError = vi.fn();
    const retention = commandRetention({ store, clock, retentionDays: 1, onError });

    await retention.start();
    expect(await keys(store)).toEqual(['later', 'soon']);
    await clock.advance(DAY_MS - 1);
    expect(await keys(store)).toEqual(['later', 'soon']);
    await clock.advance(1);
    expect(await keys(store)).toEqual(['later']);

    await retention.stop();
    await clock.advance(DAY_MS);
    expect(await keys(store)).toEqual(['later']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failed daily purge to onError', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = freshStore();
    const clock = testClock();
    const onError = vi.fn();
    const retention = commandRetention({ store, clock, retentionDays: 1, onError });

    await retention.start();
    await store.close();
    open.splice(open.indexOf(store), 1);
    await clock.advance(DAY_MS);
    await expect(retention.stop()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('rejects start when the first purge fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = freshStore();
    // Kysely closes the database only once its driver has run a query; before that, close()
    // is a no-op and the next query opens the driver again.
    expect(await keys(store)).toEqual([]);
    await store.close();
    open.splice(open.indexOf(store), 1);
    const clock = testClock();
    const onError = vi.fn();
    const retention = commandRetention({ store, clock, retentionDays: 1, onError });

    await expect(retention.start()).rejects.toThrow();
    expect(onError).not.toHaveBeenCalled();
    await clock.advance(DAY_MS);
    expect(onError).not.toHaveBeenCalled();
  });
});
