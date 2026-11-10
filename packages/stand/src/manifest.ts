import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

export const MANIFEST_FILE = 'stand.json';
export const STAND_PREFIX = 'spur-board-stand.';
const STAND_NAME = /^spur-board-stand\.[A-Za-z0-9]{6}$/;

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
  try {
    const parsed = standManifest.safeParse(
      JSON.parse(readFileSync(join(home, MANIFEST_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

type ReadProc = (path: string) => string;
const readProc: ReadProc = (path) => readFileSync(path, 'utf8');

/**
 * Process group and start time from `/proc/<pid>/stat`, or undefined when no such process
 * (`ENOENT`, or `ESRCH` while it exits). Any other read error or an unparsable line throws: the
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
 * A directory a stand may own: a direct child of `root` named `spur-board-stand.` plus six
 * letters or digits, a real directory (not a symlink) owned by this user.
 */
export function isStandDir(dir: string, root: string): boolean {
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.())
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
export function removeStand(dir: string, root: string): RemoveResult {
  if (!isStandDir(dir, root)) return { kept: 'not a stand directory' };
  const manifest = readManifest(dir);
  if (manifest === undefined) return { kept: 'no valid manifest' };
  if (manifest.home !== realpathSync(dir)) return { kept: 'the manifest names another home' };
  if (isLive(manifest)) return { kept: 'the stand may still run' };
  rmSync(dir, { recursive: true, force: true });
  return 'removed';
}

/** Applies `removeStand` to every `spur-board-stand.*` entry of `root`. */
export function prune(root: string): { dir: string; result: RemoveResult }[] {
  return readdirSync(root)
    .filter((name) => name.startsWith(STAND_PREFIX))
    .map((name) => {
      const dir = join(root, name);
      return { dir, result: removeStand(dir, root) };
    });
}

/** Live stands under `root` with a valid manifest. */
export function liveStands(root: string): StandManifest[] {
  return readdirSync(root)
    .filter((name) => name.startsWith(STAND_PREFIX))
    .map((name) => join(root, name))
    .filter((dir) => isStandDir(dir, root))
    .flatMap((dir) => {
      const manifest = readManifest(dir);
      return manifest !== undefined && manifest.home === realpathSync(dir) && isLive(manifest)
        ? [manifest]
        : [];
    });
}
