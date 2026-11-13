import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

/** A point in the copy after which a kill leaves a complete database at the target path. */
type CopyStep = 'partial' | 'checkpoint' | 'link' | 'journal' | 'rename';

/**
 * Opens a database read-write with no PRAGMA, migration or version check: the connection only
 * feeds a copy or checkpoints a WAL. Read-write, so SQLite replays a leftover `-wal`.
 */
function openRaw(file: string, purpose: string): Database.Database {
  try {
    return new Database(file, { fileMustExist: true, timeout: 5000 });
  } catch (error) {
    throw new Error(`Cannot open database ${file} to ${purpose}`, { cause: error });
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

/** Moves every committed row of the target's `-wal` into its main file and empties the WAL. */
function checkpoint(file: string): void {
  const db = openRaw(file, 'checkpoint it');
  try {
    const [result] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (result !== undefined && result.busy !== 0) {
      throw new Error(`Database ${file} is in use; its WAL cannot be checkpointed`);
    }
  } finally {
    db.close();
  }
}

/**
 * Copies a database into one self-contained file at `target`, with the source's rows, schema and
 * `user_version`. `source` is a path or an open connection. The copy is written with `VACUUM INTO`
 * to `<target>.partial`, created at mode 0600, and synced. An existing target with a non-empty
 * `-wal` is then checkpointed, so its main file holds every committed row. The target is
 * hard-linked to `<target>.replaced-<uuid>`, its empty `-wal` and `-shm` are removed, the partial
 * is renamed over `target`, and only then is the link removed. A kill at any point leaves a
 * complete database at `target`, the old one or the new one. A failure before the rename leaves the
 * target as it is, with no `.partial` and no link. `step` is called after each step; tests use it
 * to stand in for a kill.
 *
 * Opens `target` only to checkpoint a non-empty `-wal`. Creates no directory, takes no lock and
 * checks no version: the caller creates the directory and holds the board lock or owns the
 * connection.
 */
export function copyDatabase(
  source: string | Database.Database,
  target: string,
  step: (name: CopyStep) => void = () => undefined,
): void {
  const sourceFile = typeof source === 'string' ? source : source.name;
  if (resolve(sourceFile) === resolve(target)) {
    throw new Error(`Cannot copy database ${sourceFile} onto itself`);
  }
  const db = typeof source === 'string' ? openRaw(source, 'copy it') : source;
  const partial = `${target}.partial`;
  const aside = `${target}.replaced-${randomUUID()}`;
  let linked = false;
  try {
    rmSync(partial, { force: true });
    // Created first so the copy is owner-only whatever the umask; VACUUM INTO keeps the mode.
    closeSync(openSync(partial, 'wx', 0o600));
    db.prepare('VACUUM INTO ?').run(partial);
    fsyncFile(partial);
    step('partial');
    if (existsSync(target)) {
      // Only a non-empty WAL can hold committed rows outside the main file. Without one there
      // is nothing to preserve, and a damaged target must not block the copy that replaces it.
      if ((statSync(`${target}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0) {
        checkpoint(target);
        step('checkpoint');
      }
      linkSync(target, aside);
      linked = true;
      step('link');
    }
    // Empty after the checkpoint; a stale journal must not be replayed onto the new file.
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    step('journal');
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    if (linked) rmSync(aside, { force: true });
    throw error;
  } finally {
    if (typeof source === 'string') db.close();
  }
  step('rename');
  if (linked) rmSync(aside, { force: true });
}
