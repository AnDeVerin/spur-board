import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Name prefix of every per-run temp root that global setup creates. */
export const ROOT_PREFIX = 'spur-board-test-';
const OWNER_FILE = 'owner.json';
const HOUR = 60 * 60 * 1000;
/** A root without an owner record is kept until it is this old. */
const NO_OWNER_MAX_AGE = 3 * HOUR;
/** A root the sweep cannot check against a live process is kept until it is this old. */
const UNCHECKED_MAX_AGE = 24 * HOUR;

/** What the sweep reads from /proc; tests inject their own. */
export interface ProcReader {
  /** `/proc/<pid>/stat`, or undefined when the process does not exist. */
  stat(pid: number): string | undefined;
  /** `/proc/sys/kernel/random/boot_id`, or undefined. */
  bootId(): string | undefined;
  /** The `/proc/self/ns/pid` link, or undefined. */
  pidNs(): string | undefined;
}

interface Identity {
  bootId?: string | undefined;
  pidNs?: string | undefined;
}

/** The owner record a run writes into its root. A field that could not be read is left out. */
export interface OwnerRecord extends Identity {
  pid: number;
  createdAt: number;
  startTicks?: string | undefined;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const linuxProc: ProcReader = {
  stat: (pid) => attempt(() => readFileSync(`/proc/${String(pid)}/stat`, 'utf8')),
  bootId: () =>
    attempt(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) || undefined,
  pidNs: () => attempt(() => readlinkSync('/proc/self/ns/pid')) || undefined,
};

/** Field 22 (start time in clock ticks) of a `/proc/<pid>/stat` line; comm may hold `) (`. */
export function readStartTicks(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  // Fields after the comm start at field 3 (state), so field 22 is index 19.
  const ticks = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
}

/** This process's boot and pid namespace, as far as /proc shows them. */
export function currentIdentity(proc: ProcReader = linuxProc): Identity {
  return { bootId: proc.bootId(), pidNs: proc.pidNs() };
}

interface WriteOwnerOptions {
  pid?: number;
  now?: () => number;
  proc?: ProcReader;
}

/** Writes `owner.json` into `root` atomically; never throws. */
export function writeOwner(root: string, options: WriteOwnerOptions = {}): void {
  const { pid = process.pid, now = Date.now, proc = linuxProc } = options;
  const stat = proc.stat(pid);
  const record: OwnerRecord = {
    pid,
    createdAt: now(),
    startTicks: stat === undefined ? undefined : readStartTicks(stat),
    ...currentIdentity(proc),
  };
  const file = join(root, OWNER_FILE);
  attempt(() => {
    writeFileSync(`${file}.tmp`, JSON.stringify(record));
    renameSync(`${file}.tmp`, file);
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function readOwner(root: string): Partial<OwnerRecord> | undefined {
  const parsed = attempt(() => JSON.parse(readFileSync(join(root, OWNER_FILE), 'utf8')) as unknown);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<OwnerRecord>;
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) return undefined;
  if (typeof record.createdAt !== 'number') return undefined;
  return record;
}

function age(root: string, now: number): number {
  const times = [root, join(root, 'tmp')].map((path) => attempt(() => statSync(path).mtimeMs) ?? 0);
  return now - Math.max(...times);
}

function isStale(root: string, now: number, proc: ProcReader, self: Identity): boolean {
  const record = readOwner(root);
  if (record === undefined) return age(root, now) > NO_OWNER_MAX_AGE;
  const complete =
    nonEmpty(record.bootId) &&
    nonEmpty(record.pidNs) &&
    nonEmpty(record.startTicks) &&
    /^\d+$/.test(record.startTicks);
  // A missing field is never a mismatch: without it only age decides.
  if (!complete || !nonEmpty(self.bootId) || !nonEmpty(self.pidNs)) {
    return age(root, now) > UNCHECKED_MAX_AGE;
  }
  if (record.bootId !== self.bootId) return true;
  if (record.pidNs !== self.pidNs) return age(root, now) > UNCHECKED_MAX_AGE;
  const stat = proc.stat(record.pid ?? 0);
  if (stat === undefined) return true;
  const ticks = readStartTicks(stat);
  return ticks !== undefined && ticks !== record.startTicks;
}

interface SweepOptions {
  /** Directories to scan; defaults to `tmpdir()` and `/tmp`. */
  parents?: string[];
  now?: () => number;
  /** Only entries owned by this uid are considered; undefined skips the sweep. */
  uid?: number | undefined;
  proc?: ProcReader;
  /** The sweeper's identity; defaults to `currentIdentity(proc)`. */
  self?: Identity;
}

/**
 * Removes `spur-board-test-*` roots of runs that are gone: owner dead, pid reused or from an
 * earlier boot; roots without an owner record after 3 h; roots it cannot check after 24 h.
 * Never follows symlinks, never touches another uid's entries, never throws. Returns the
 * removed paths.
 */
export function sweepStaleRuns(options: SweepOptions = {}): string[] {
  const removed: string[] = [];
  try {
    const { now = Date.now, proc = linuxProc } = options;
    const uid = 'uid' in options ? options.uid : process.getuid?.();
    if (uid === undefined) return removed;
    const self = options.self ?? currentIdentity(proc);
    const parents = new Set<string>();
    for (const parent of options.parents ?? [tmpdir(), '/tmp']) {
      const real = attempt(() => realpathSync(parent));
      if (real !== undefined) parents.add(real);
    }
    for (const parent of parents) {
      for (const name of attempt(() => readdirSync(parent)) ?? []) {
        if (!name.startsWith(ROOT_PREFIX)) continue;
        const path = join(parent, name);
        const entry = attempt(() => lstatSync(path));
        if (!entry?.isDirectory() || entry.uid !== uid) continue;
        if (!attempt(() => isStale(path, now(), proc, self))) continue;
        const done = attempt(() => {
          rmSync(path, { recursive: true, force: true, maxRetries: 3 });
          return true;
        });
        if (done) removed.push(path);
      }
    }
  } catch {
    // The sweep is best effort; a run never fails because of it.
  }
  return removed;
}
