import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { overlaps } from './guards.ts';

export const MANIFEST_FILE = 'stand.json';
export const STAND_PREFIX = 'spur-board-stand.';
const STAND_NAME = /^spur-board-stand\.[A-Za-z0-9]{6}$/;

/** Entities a scenario names in one group, by the scenario's own names. */
const named = z.record(z.string().min(1), z.string().min(1)).optional();

export const standManifest = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  home: z.string().min(1),
  pid: z.int().positive(),
  /** Field 22 of `/proc/<pid>/stat`: tells a live stand from a reused pid. */
  pidStartTime: z.int().nonnegative(),
  daemonUrl: z.url(),
  controlUrl: z.url(),
  controlToken: z.string().min(1),
  tokenPath: z.string().min(1),
  roles: z.strictObject({ worker: z.string().min(1), orchestrator: z.string().min(1) }),
  /**
   * The scenario whose seed resolved, with what it named: items by key, Slack messages by their
   * outbox number, and `direct` the notes of each write made outside the public API.
   */
  scenario: z
    .strictObject({
      name: z.string().min(1),
      tasks: named,
      prs: named,
      blocks: named,
      sessions: named,
      sources: named,
      items: named,
      tokens: named,
      messages: named,
      direct: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});
export type StandManifest = z.output<typeof standManifest>;

/** Writes `stand.json` with mode 600 through a new temporary file and a rename. */
export function writeManifest(home: string, manifest: StandManifest): void {
  const tmp = join(home, `.${MANIFEST_FILE}.${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, `${JSON.stringify(standManifest.parse(manifest), null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(tmp, join(home, MANIFEST_FILE));
}

/** The manifest in `home`, or undefined when it is missing, unreadable or invalid. */
export function readManifest(home: string): StandManifest | undefined {
  let fd: number;
  try {
    fd = openSync(
      join(home, MANIFEST_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    // Only a regular file of this user counts; anything another user could plant is ignored.
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.()) return undefined;
    const parsed = standManifest.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

type ReadProc = (path: string) => string;
const readProc: ReadProc = (path) => readFileSync(path, 'utf8');

/**
 * Process group and start time from `/proc/<pid>/stat`, or undefined when no such process runs
 * (`ENOENT`, `ESRCH` while it exits, or a zombie or dead state). Any other read error or an unparsable line throws: the
 * process may still run.
 */
export function procStat(
  pid: number,
  read: ReadProc = readProc,
): { pgrp: number; startTime: number } | undefined {
  let text: string;
  try {
    text = read(`/proc/${String(pid)}/stat`);
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    throw err;
  }
  // The command name (field 2) may hold spaces and parentheses; fields after it follow the last ')'.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  // Field 3: a zombie (Z) or dead (X, x) process has exited; only its parent has not reaped it.
  if (fields[0] === 'Z' || fields[0] === 'X' || fields[0] === 'x') return undefined;
  const pgrp = Number(fields[2]);
  const startTime = Number(fields[19]);
  if (!Number.isInteger(pgrp) || !Number.isInteger(startTime))
    throw new Error(`Cannot parse /proc/${String(pid)}/stat`);
  return { pgrp, startTime };
}

/**
 * The manifest's process may still run: same pid and start time, or `/proc` cannot tell. Only a
 * missing pid or a different start time counts as dead.
 */
export function isLive(
  manifest: Pick<StandManifest, 'pid' | 'pidStartTime'>,
  read: ReadProc = readProc,
): boolean {
  try {
    const stat = procStat(manifest.pid, read);
    return stat !== undefined && stat.startTime === manifest.pidStartTime;
  } catch {
    return true;
  }
}

/**
 * Watches the process `pid`: undefined when it is already gone, else a check that turns true once
 * the pid is gone or now names a process with another start time.
 */
export function watchProcess(pid: number, read: ReadProc = readProc): (() => boolean) | undefined {
  const stat = procStat(pid, read);
  if (stat === undefined) return undefined;
  const watched = { pid, pidStartTime: stat.startTime };
  return () => !isLive(watched, read);
}

/**
 * A directory a stand may own: a direct child of `root` named `spur-board-stand.` plus six
 * letters or digits, a real directory (not a symlink) owned by this user with no group or other
 * permission (0700).
 */
export function isStandDir(dir: string, root: string): boolean {
  try {
    const info = lstatSync(dir);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      // Owner-only, like the home the stand writes: another user who could write here could plant
      // a manifest naming one of our processes, and one who could read could see its database.
      (info.mode & 0o077) !== 0
    )
      return false;
    if (!STAND_NAME.test(basename(dir))) return false;
    return dirname(realpathSync(dir)) === realpathSync(root);
  } catch {
    return false;
  }
}

export type RemoveResult = 'removed' | { kept: string };

/**
 * Deletes a dead stand's directory. It must pass `isStandDir`, hold a valid manifest naming this
 * directory as its home, and the manifest's process must be gone or have another start time.
 */
export function removeStand(
  dir: string,
  root: string,
  liveDirs: readonly string[] = [],
): RemoveResult {
  if (!isStandDir(dir, root)) return { kept: 'not a stand directory' };
  const real = realpathSync(dir);
  // A live board may run from a former stand home: its directories are never removed.
  if (liveDirs.some((live) => overlaps(live, real)))
    return { kept: 'the live board uses this directory' };
  const manifest = readManifest(dir);
  if (manifest === undefined) return { kept: 'no valid manifest' };
  if (manifest.home !== real) return { kept: 'the manifest names another home' };
  if (isLive(manifest)) return { kept: 'the stand may still run' };
  rmSync(dir, { recursive: true, force: true });
  return 'removed';
}

/** Applies `removeStand` to every `spur-board-stand.*` entry of `root`. */
export function prune(
  root: string,
  liveDirs: readonly string[] = [],
): { dir: string; result: RemoveResult }[] {
  return readdirSync(root)
    .filter((name) => name.startsWith(STAND_PREFIX))
    .map((name) => {
      const dir = join(root, name);
      return { dir, result: removeStand(dir, root, liveDirs) };
    });
}

/**
 * The manifest of the stand directory `dir`, or undefined unless `dir` passes `isStandDir` and
 * its manifest names `dir` itself as the home. Callers use its pid and paths only after this.
 */
export function standAt(dir: string, root: string): StandManifest | undefined {
  if (!isStandDir(dir, root)) return undefined;
  const manifest = readManifest(dir);
  return manifest !== undefined && manifest.home === realpathSync(dir) ? manifest : undefined;
}

/** Live stands under `root` with a valid manifest. */
export function liveStands(root: string): StandManifest[] {
  return readdirSync(root)
    .filter((name) => name.startsWith(STAND_PREFIX))
    .flatMap((name) => {
      const manifest = standAt(join(root, name), root);
      return manifest !== undefined && isLive(manifest) ? [manifest] : [];
    });
}
