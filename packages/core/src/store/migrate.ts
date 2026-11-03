import { readFileSync, readdirSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';

/** One numbered SQL file. `name` is the file name without `.sql`, e.g. `0001_init`. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** What `migrate` did: versions before and after, files applied, and the backup it wrote. */
export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
  backup: string | null;
}

/** The migration files that ship with this package. */
export const migrationsDir = new URL('./migrations/', import.meta.url);

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Throws unless the versions run 1, 2, ... N with no gap or duplicate. */
function checkSequence(migrations: readonly Migration[]): void {
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new Error(
        `Migration ${migration.name} has version ${String(migration.version)}, expected ${String(i + 1)}: versions must run 1..N with no gap or duplicate`,
      );
    }
  });
}

/** Reads every `NNNN_name.sql` file in `dir`, in version order. Any other `.sql` name throws. */
export function readMigrations(dir: URL): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file): Migration => {
      const match = FILE_NAME.exec(file);
      if (match?.[1] === undefined) {
        throw new Error(`Migration file ${file} does not match NNNN_name.sql`);
      }
      return {
        version: Number(match[1]),
        name: file.slice(0, -'.sql'.length),
        sql: readFileSync(new URL(file, dir), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);
  checkSequence(migrations);
  return migrations;
}

function backupPath(file: string, from: number): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${file}.v${String(from)}.${stamp}.bak`;
}

/**
 * Reads `user_version` and throws if it is above `target`. Only reads, so it is safe to call
 * before any PRAGMA that could rewrite the file.
 */
export function assertNotNewer(db: BetterSqlite3.Database, target: number): number {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > target) {
    throw new Error(
      `Database ${db.name} has schema v${String(version)}, newer than this code (v${String(target)}); upgrade spur-board to open it`,
    );
  }
  return version;
}

/**
 * Brings `db` to the last version in `migrations`. The version lives only in
 * `PRAGMA user_version`. A database newer than the code is refused before any write. Unless
 * the file is new and empty, a database with pending migrations is first copied with
 * `VACUUM INTO`. All pending migrations then run in one `BEGIN IMMEDIATE` transaction with
 * foreign keys off, and `foreign_key_check` must come back empty before `COMMIT`; any error
 * rolls everything back.
 */
export function migrate(
  db: BetterSqlite3.Database,
  migrations: readonly Migration[],
): MigrationResult {
  checkSequence(migrations);
  const target = migrations.length;
  const from = assertNotNewer(db, target);
  const pending = migrations.filter((migration) => migration.version > from);
  if (pending.length === 0) return { from, to: from, applied: [], backup: null };

  let backup: string | null = null;
  // A v0 file can still hold data (made by hand or by another tool); only a file with no
  // schema at all has nothing to lose.
  const empty = db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get() === 0;
  if (!empty) {
    backup = backupPath(db.name, from);
    db.prepare('VACUUM INTO ?').run(backup);
  }
  const kept = `database kept at v${String(from)}${backup === null ? '' : `, backup at ${backup}`}`;

  // foreign_keys cannot change inside a transaction.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const migration of pending) {
        try {
          db.exec(migration.sql);
        } catch (error) {
          throw new Error(`Migration ${migration.name} failed; ${kept}`, { cause: error });
        }
        db.pragma(`user_version = ${String(migration.version)}`);
      }
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Migrations left ${String(violations.length)} foreign key violations: ${JSON.stringify(violations)}; ${kept}`,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return {
    from,
    to: target,
    applied: pending.map((migration) => migration.name),
    backup,
  };
}
