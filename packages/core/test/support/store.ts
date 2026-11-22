import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, onTestFinished } from 'vitest';
import { openStore, type Store } from '../../src/index.ts';

/**
 * Removes `dir` after the current test's afterEach hooks, or after the enclosing suite when
 * called outside a test. Never fails a test; global teardown removes what is left.
 */
function removeAfterTest(dir: string): void {
  const remove = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Global teardown and the next run's sweep remove what is left.
    }
  };
  try {
    onTestFinished(remove);
  } catch {
    try {
      afterAll(remove);
    } catch {
      // Not inside a suite either: global teardown removes it.
    }
  }
}

/**
 * Opens a migrated store at `board.db` in a new temp directory named with `prefix`. The
 * directory is removed after the test, or after the suite when opened outside a test.
 */
export function openTempStore(prefix: string): { store: Store; file: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  removeAfterTest(dir);
  const file = join(dir, 'board.db');
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
