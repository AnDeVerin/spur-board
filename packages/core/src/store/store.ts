import { chmodSync, closeSync, fchmodSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import {
  assertNotNewer,
  migrate,
  migrationsDir,
  pruneBackups,
  readMigrations,
  type MigrationResult,
} from './migrate.ts';
import type { Tables } from './schema.ts';

/** An open, migrated store. */
export interface Store {
  /** Query builder. Do not use it inside `transaction`'s `fn`: that deadlocks; use `trx`. */
  readonly db: Kysely<Tables>;
  /** What opening the store migrated. */
  readonly migration: MigrationResult;
  /**
   * Runs `fn` in `BEGIN IMMEDIATE`, so the write lock is held from the start. Commits when
   * `fn` resolves, rolls back and rethrows when it throws.
   */
  transaction<T>(fn: (trx: Kysely<Tables>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function connect(file: string): Database.Database {
  // `timeout` sets SQLite's busy_timeout; written out so a driver default change cannot lower it.
  return new Database(file, { timeout: 5000 });
}

/**
 * Creates `file` if it is missing and sets it and any existing `-wal` and `-shm` to 0600,
 * whatever the umask. Changes no bytes, so it is safe before `assertNotNewer`. Throws if a mode
 * cannot be set, e.g. a file owned by another user.
 */
function makePrivate(file: string): void {
  const fd = openSync(file, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(sidecar, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** WAL, NORMAL sync and foreign keys on. Switching to WAL rewrites the file header. */
function configure(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');
}

/** Opens `file` with WAL, NORMAL sync, foreign keys on and a 5000 ms busy timeout. */
export function openDatabase(file: string): Database.Database {
  const database = connect(file);
  try {
    configure(database);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/**
 * Opens `file` and applies pending migrations. The file, its `-wal` and `-shm` and its migration
 * backups are kept at mode 0600, and only the newest `KEEP_BACKUPS` backups are kept. A database
 * newer than the code is refused before the WAL switch, so its file is left byte for byte as it
 * was; only its mode may change. Throws, with the file closed, if anything fails.
 */
export function openStore(file: string): Store {
  const migrations = readMigrations(migrationsDir);
  makePrivate(file);
  const database = connect(file);
  let migration: MigrationResult;
  try {
    assertNotNewer(database, migrations.length);
    configure(database);
    pruneBackups(file);
    migration = migrate(database, migrations);
  } catch (error) {
    database.close();
    throw error;
  }
  const db = new Kysely<Tables>({ dialect: new SqliteDialect({ database }) });
  return {
    db,
    migration,
    transaction: (fn) =>
      db.connection().execute(async (trx) => {
        await sql`BEGIN IMMEDIATE`.execute(trx);
        try {
          const result = await fn(trx);
          await sql`COMMIT`.execute(trx);
          return result;
        } catch (error) {
          // SQLite may already have rolled back; a second ROLLBACK would mask `error`.
          if (database.inTransaction) await sql`ROLLBACK`.execute(trx);
          throw error;
        }
      }),
    close: () => db.destroy(),
  };
}
