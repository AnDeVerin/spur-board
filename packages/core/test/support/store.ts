import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore, type Store } from '../../src/index.ts';

/** Opens a migrated store at `board.db` in a new temp directory named with `prefix`. */
export function openTempStore(prefix: string): { store: Store; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), prefix)), 'board.db');
  return { store: openStore(file), file };
}

/**
 * Opens `file` as a raw connection with the store's settings: a 5000 ms busy timeout, WAL,
 * NORMAL sync and foreign keys on. It mirrors `connect()` and `configure()` in
 * `src/store/store.ts` and skips the version and migration checks of `openStore`.
 */
export function rawDatabase(file: string): Database.Database {
  const database = new Database(file, { timeout: 5000 });
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('foreign_keys = ON');
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
