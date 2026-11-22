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

/**
 * What the host says about a pid: its readable `/proc/<pid>/stat` line, `absent` (no such
 * process), `exists` (the process is there but its stat cannot be read) or `unknown`.
 */
export type PidProbe = { stat: string } | 'absent' | 'exists' | 'unknown';

/** What the sweep reads from the host; tests inject their own. */
export interface ProcReader {
  probe(pid: number): PidProbe;
  /** `/proc/sys/kernel/random/boot_id`, or undefined. */
  bootId(): string | undefined;
  /** The `/proc/self/ns/pid` link, or undefined. */
  pidNs(): string | undefined;
  /** `/etc/machine-id` (else `/var/lib/dbus/machine-id`), or undefined. */
  machineId(): string | undefined;
}

interface Identity {
  bootId?: string | undefined;
  pidNs?: string | undefined;
  machineId?: string | undefined;
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

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The kernel's answer to `kill(pid, 0)`: EPERM means the process exists. */
function signalProbe(pid: number): 'absent' | 'exists' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'exists';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EPERM') return 'exists';
    return code === 'ESRCH' ? 'absent' : 'unknown';
  }
}

function probePid(pid: number): PidProbe {
  try {
    return { stat: readFileSync(`/proc/${String(pid)}/stat`, 'utf8') };
  } catch (error) {
    const code = errorCode(error);
    const signal = signalProbe(pid);
    if (signal === 'exists') return 'exists';
    // A hidden or unreadable stat is no proof of absence; only ENOENT confirmed by kill is.
    return (code === 'ENOENT' || code === 'ESRCH') && signal === 'absent' ? 'absent' : 'unknown';
  }
}

function readTrimmed(path: string): string | undefined {
  return attempt(() => readFileSync(path, 'utf8').trim()) || undefined;
}

const linuxProc: ProcReader = {
  probe: probePid,
  bootId: () => readTrimmed('/proc/sys/kernel/random/boot_id'),
  pidNs: () => attempt(() => readlinkSync('/proc/self/ns/pid')) || undefined,
  machineId: () => readTrimmed('/etc/machine-id') ?? readTrimmed('/var/lib/dbus/machine-id'),
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

/** This process's host, boot and pid namespace, as far as the host shows them. */
export function currentIdentity(proc: ProcReader = linuxProc): Identity {
  return { bootId: proc.bootId(), pidNs: proc.pidNs(), machineId: proc.machineId() };
}

interface WriteOwnerOptions {
  pid?: number;
  now?: () => number;
  proc?: ProcReader;
}

/** Writes `owner.json` into `root` atomically; never throws. */
export function writeOwner(root: string, options: WriteOwnerOptions = {}): void {
  const { pid = process.pid, now = Date.now, proc = linuxProc } = options;
  const probe = proc.probe(pid);
  const record: OwnerRecord = {
    pid,
    createdAt: now(),
    startTicks: typeof probe === 'object' ? readStartTicks(probe.stat) : undefined,
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

/**
 * Removes a root at once only on proof its owner is gone; keeps it while the owner's pid exists;
 * decides by age only when there is no liveness signal at all.
 */
function isStale(root: string, now: number, proc: ProcReader, self: Identity): boolean {
  const record = readOwner(root);
  if (record === undefined) return age(root, now) > NO_OWNER_MAX_AGE;
  const unchecked = () => age(root, now) > UNCHECKED_MAX_AGE;
  const checkable =
    nonEmpty(record.bootId) &&
    nonEmpty(record.pidNs) &&
    nonEmpty(record.machineId) &&
    nonEmpty(record.startTicks) &&
    /^\d+$/.test(record.startTicks) &&
    nonEmpty(self.bootId) &&
    nonEmpty(self.pidNs) &&
    nonEmpty(self.machineId);
  // A missing field is never a mismatch. Another host or pid namespace may share this temp dir
  // and report the same namespace link or its own boot id, so only age decides there.
  if (!checkable || record.machineId !== self.machineId || record.pidNs !== self.pidNs) {
    return unchecked();
  }
  if (record.bootId !== self.bootId) return true;
  const probe = proc.probe(record.pid ?? 0);
  if (probe === 'absent') return true;
  if (probe === 'exists') return false;
  if (probe === 'unknown') return unchecked();
  const ticks = readStartTicks(probe.stat);
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
 * Removes `spur-board-test-*` roots of runs that are gone: on the same host and in the same pid
 * namespace, owner absent, pid reused or an earlier boot. Keeps a root whose owner pid exists.
 * Roots without an owner record go after 3 h; roots with no liveness signal (another host or
 * pid namespace, an incomplete record or identity, an owner of unknown state) after 24 h.
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
