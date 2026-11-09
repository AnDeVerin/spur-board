import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

/** The database file and its journal files, moved together. */
const SET = ['', '-wal', '-shm'] as const;

function openSource(file: string): Database.Database {
  try {
    // Read-write, so SQLite replays a leftover `-wal` into what the copy reads. No PRAGMA,
    // migration or version check: this connection only feeds the copy.
    return new Database(file, { fileMustExist: true, timeout: 5000 });
  } catch (error) {
    throw new Error(`Cannot open database ${file} to copy it`, { cause: error });
  }
}

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Renames `from` to `to`; false when `from` does not exist. */
function moveIfPresent(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Copies a database into one self-contained file at `target`, with the source's rows, schema
 * and `user_version`. `source` is a path or an open connection. The copy is written with
 * `VACUUM INTO` to `<target>.partial` and synced. The target and its `-wal` and `-shm` then
 * move aside as one set (`<target>.replaced-<uuid>`, which SQLite still opens with its own
 * `-wal`), the partial is renamed over `target`, and only then is the set deleted. A failure
 * moves the set back. No `.partial` is left after a return or a throw.
 *
 * Never opens `target`, creates no directory, takes no lock and checks no version: the caller
 * creates the directory and holds the board lock or owns the connection.
 */
export function copyDatabase(source: string | Database.Database, target: string): void {
  const sourceFile = typeof source === 'string' ? source : source.name;
  if (resolve(sourceFile) === resolve(target)) {
    throw new Error(`Cannot copy database ${sourceFile} onto itself`);
  }
  const db = typeof source === 'string' ? openSource(source) : source;
  const partial = `${target}.partial`;
  const aside = `${target}.replaced-${randomUUID()}`;
  const moved: string[] = [];
  try {
    rmSync(partial, { force: true });
    db.prepare('VACUUM INTO ?').run(partial);
    fsyncFile(partial);
    for (const suffix of SET) {
      if (moveIfPresent(`${target}${suffix}`, `${aside}${suffix}`)) moved.push(suffix);
    }
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    try {
      for (const suffix of [...moved].reverse()) {
        renameSync(`${aside}${suffix}`, `${target}${suffix}`);
      }
    } catch {
      // The set stays at `aside`, where SQLite still opens it with its own `-wal`.
      throw new Error(`Copying onto ${target} failed; the previous database is at ${aside}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (typeof source === 'string') db.close();
  }
  for (const suffix of moved) rmSync(`${aside}${suffix}`, { force: true });
}
