import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { purgeExpiredCommands, openStore, type Store } from '../../src/index.ts';

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

afterEach(async () => {
  for (const store of open.splice(0)) await store.close();
});

describe('purgeExpiredCommands', () => {
  it.each([7, 2])('purges keys older than %i days', async (days) => {
    const store = freshStore();
    await seed(store, {
      expired: START - days * DAY_MS - 1,
      cutoff: START - days * DAY_MS,
      fresh: START - 1,
    });
    await purgeExpiredCommands(store, { now: () => START }, days);
    expect(await keys(store)).toEqual(['cutoff', 'fresh']);
  });
});
