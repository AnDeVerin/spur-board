import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrationsDir, openStore, readMigrations, type Store } from '@spur-board/core';
import { acquireLock } from '@spur-board/daemon/in-process';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { empty } from '../src/scenarios/empty.ts';
import { restoreSnapshot, saveSnapshot, snapshotKey } from '../src/snapshots.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stand-snapshots-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

/** Every row of every table, by rowid, and the schema version. */
async function dump(file: string): Promise<{ userVersion: unknown; tables: unknown }> {
  const store = openStore(file);
  try {
    const names = await sql<{ name: string }>`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `.execute(store.db);
    const tables: Record<string, unknown[]> = {};
    for (const { name } of names.rows)
      tables[name] = (
        await sql.raw(`SELECT rowid AS _rowid, * FROM "${name}" ORDER BY rowid`).execute(store.db)
      ).rows;
    const version = await sql.raw('PRAGMA user_version').execute(store.db);
    return { userVersion: version.rows, tables };
  } finally {
    await store.close();
  }
}

async function insertRows(store: Store): Promise<void> {
  await store.db.insertInto('meta').values({ key: 'stand-a', value: 'one' }).execute();
  await store.db.insertInto('meta').values({ key: 'stand-b', value: 'two' }).execute();
  const at = '2026-01-01T00:00:00.000Z';
  const item = await store.db
    .insertInto('operator_item')
    .values({
      item_key: 'token:stand',
      raise_no: 1,
      kind: 'token_request',
      text: 'Approve operator token stand',
      url: '',
      task_id: null,
      block_id: null,
      raised_at: at,
      cleared_at: at,
      line_outbox_id: null,
      fingerprint: null,
      fact_at: null,
      source: null,
      priority: null,
      inbound_event_json: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await store.db
    .insertInto('operator_token')
    .values({
      name: 'stand',
      hash: 'a'.repeat(64),
      folder: 'stand',
      host: 'stand',
      status: 'approved',
      requested_at: at,
      expires_at: at,
      decided_at: at,
      item_id: item.id,
    })
    .execute();
}

describe('restoreSnapshot', () => {
  it('restoreSnapshot gives back every row', async () => {
    const dbFile = join(dir, 'board.sqlite');
    const lockFile = join(dir, 'board.lock');
    const file = join(dir, 'snapshots', 'empty-0123456789abcdef.sqlite');
    const store = openStore(dbFile);
    try {
      await insertRows(store);
      // Taken while the store is open, as the stand takes it from the running daemon.
      saveSnapshot(dbFile, file);
    } finally {
      await store.close();
    }
    const saved = await dump(dbFile);
    expect(mode(join(dir, 'snapshots'))).toBe(0o700);
    expect(mode(file)).toBe(0o600);

    const changed = openStore(dbFile);
    try {
      await changed.db
        .updateTable('meta')
        .set({ value: 'changed' })
        .where('key', '=', 'stand-a')
        .execute();
      await changed.db.deleteFrom('meta').where('key', '=', 'stand-b').execute();
      await changed.db.deleteFrom('operator_token').execute();
      await changed.db.deleteFrom('operator_item').execute();
      await changed.db.insertInto('meta').values({ key: 'stand-c', value: 'three' }).execute();
    } finally {
      await changed.close();
    }
    expect(await dump(dbFile)).not.toEqual(saved);

    restoreSnapshot(file, dbFile, lockFile);
    expect(mode(dbFile)).toBe(0o600);
    const restored = await dump(dbFile);
    expect(restored).toEqual(saved);
    expect(restored.userVersion).toEqual([{ user_version: readMigrations(migrationsDir).length }]);
    expect(readdirSync(dir).filter((name) => name.includes('.partial'))).toEqual([]);
  });

  it('restoreSnapshot refuses while the lock is held', async () => {
    const source = join(dir, 'source.sqlite');
    const file = join(dir, 'snapshots', 'empty-0123456789abcdef.sqlite');
    const dbFile = join(dir, 'board.sqlite');
    const lockFile = join(dir, 'board.lock');
    const store = openStore(source);
    try {
      await insertRows(store);
      saveSnapshot(source, file);
    } finally {
      await store.close();
    }
    const held = acquireLock(lockFile);
    try {
      let error: unknown;
      try {
        restoreSnapshot(file, dbFile, lockFile);
      } catch (err) {
        error = err;
      }
      expect(error).toMatchObject({ name: 'LockHeldError' });
      expect(existsSync(dbFile)).toBe(false);
      expect(existsSync(`${dbFile}.partial`)).toBe(false);
    } finally {
      held.release();
    }
    restoreSnapshot(file, dbFile, lockFile);
    expect(await dump(dbFile)).toEqual(await dump(source));
    // The restore released its lock: another holder can take it now.
    acquireLock(lockFile).release();
  });

  it('saveSnapshot refuses a snapshots path that is not a private directory', async () => {
    const dbFile = join(dir, 'board.sqlite');
    await openStore(dbFile).close();
    writeFileSync(join(dir, 'snapshots'), 'not a directory');
    expect(() => {
      saveSnapshot(dbFile, join(dir, 'snapshots', 'empty-0123456789abcdef.sqlite'));
    }).toThrow(/not a private directory/);
  });
});

describe('snapshotKey', () => {
  it('snapshotKey changes with migrations and scenario code', () => {
    const migrations = readMigrations(migrationsDir);
    const key = snapshotKey(empty, migrations);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(snapshotKey({ ...empty }, readMigrations(migrationsDir))).toBe(key);

    const copy = join(dir, 'migrations');
    cpSync(new URL(migrationsDir), copy, { recursive: true });
    const copied = pathToFileURL(`${copy}/`);
    expect(snapshotKey(empty, readMigrations(copied))).toBe(key);
    const last = migrations.at(-1);
    if (last === undefined) throw new Error('no migrations');
    appendFileSync(join(copy, `${last.name}.sql`), ' ');
    const changedSql = snapshotKey(empty, readMigrations(copied));
    expect(changedSql).not.toBe(key);
    const next = String(migrations.length + 1).padStart(4, '0');
    writeFileSync(join(copy, `${next}_stand_extra.sql`), 'SELECT 1;\n');
    const added = snapshotKey(empty, readMigrations(copied));
    expect(new Set([key, changedSql, added]).size).toBe(3);

    const variants = [
      { ...empty, seed: () => Promise.resolve({}) },
      { ...empty, settled: () => Promise.resolve({ ok: true as const }) },
      { ...empty, config: { thresholds: { staleMultiplier: 2 } } },
      { ...empty, name: 'other' },
    ];
    const keys = variants.map((variant) => snapshotKey(variant, migrations));
    expect(new Set([key, ...keys]).size).toBe(variants.length + 1);
  });
});
