import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { migrate, migrationsDir, readMigrations, type MigrationResult } from './migrate.ts';
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

/** Opens `file` with WAL, NORMAL sync, foreign keys on and a 5000 ms busy timeout. */
export function openDatabase(file: string): Database.Database {
  // `timeout` sets SQLite's busy_timeout; written out so a driver default change cannot lower it.
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

/** Opens `file` and applies pending migrations. Throws, with the file closed, if that fails. */
export function openStore(file: string): Store {
  const database = openDatabase(file);
  let migration: MigrationResult;
  try {
    migration = migrate(database, readMigrations(migrationsDir));
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
