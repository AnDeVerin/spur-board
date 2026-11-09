import { closeSync, fsyncSync, openSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

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

/**
 * Copies a database into one self-contained file at `target`, with the source's rows, schema
 * and `user_version`. `source` is a path or an open connection. The copy is written with
 * `VACUUM INTO` to `<target>.partial`, synced, and renamed over `target` after the target's
 * stale `-wal` and `-shm` are removed. No `.partial` is left after a return or a throw.
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
  try {
    rmSync(partial, { force: true });
    db.prepare('VACUUM INTO ?').run(partial);
    fsyncFile(partial);
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    if (typeof source === 'string') db.close();
  }
}
