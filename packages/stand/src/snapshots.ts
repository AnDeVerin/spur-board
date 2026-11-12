// Database snapshots of a seeded scenario: the copy a reset restores instead of seeding again.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { copyDatabase } from '@spur-board/core';
import { acquireLock } from '@spur-board/daemon/in-process';
import type { Scenario } from './scenarios/index.ts';

/**
 * A real directory owned by this user with no group or other permission at all (0700): nobody
 * else can add or swap an entry, or even look inside at the database and its session ids.
 */
export function privateDir(path: string): boolean {
  const info = lstatSync(path);
  return (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o077) === 0
  );
}

/**
 * The first 16 hex digits of a sha256 over what decides the seeded state: the scenario's name,
 * the source of its `seed` and `settled`, its config and every migration's name and SQL. A
 * change to any of them makes a snapshot taken before it stale.
 */
export function snapshotKey(
  scenario: Pick<Scenario, 'name' | 'seed' | 'settled' | 'config'>,
  migrations: readonly { name: string; sql: string }[],
): string {
  const hash = createHash('sha256');
  for (const part of [
    scenario.name,
    String(scenario.seed),
    String(scenario.settled),
    JSON.stringify(scenario.config ?? null),
    ...migrations.flatMap(({ name, sql }) => [name, sql]),
  ])
    hash.update(`${String(part.length)}:${part}\n`);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Copies the running daemon's database to `file`, mode 0600, in a private directory it creates
 * when missing. Takes no lock: the in-process daemon holds the board lock for this process, and
 * a second `acquireLock` would fail while it does.
 */
export function saveSnapshot(dbFile: string, file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  if (!privateDir(dir)) throw new Error(`${dir} is not a private directory; refusing it.`);
  copyDatabase(dbFile, file);
  chmodSync(file, 0o600);
}

/**
 * Copies the snapshot `file` onto `dbFile`, mode 0600, while this process holds the board lock,
 * and releases it before returning, so the daemon started next can take it. Throws
 * `LockHeldError` when another holder has the lock, leaving `dbFile` as it was.
 */
export function restoreSnapshot(file: string, dbFile: string, lockFile: string): void {
  const lock = acquireLock(lockFile);
  try {
    copyDatabase(file, dbFile);
    // VACUUM INTO writes the copy with the umask's mode, not the source's.
    chmodSync(dbFile, 0o600);
  } finally {
    lock.release();
  }
}
