import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type OwnerRecord,
  type PidProbe,
  type ProcReader,
  readStartTicks,
  sweepStaleRuns,
  writeOwner,
} from '../src/sweep.ts';

const HOUR = 60 * 60 * 1000;
const BOOT = 'boot-a';
const NS = 'pid:[4026531836]';
const MACHINE = 'machine-a';

function statLine(pid: number, ticks: string, comm = 'node'): string {
  // Fields 3..21 then field 22 (start ticks) and a few more.
  return `${String(pid)} (${comm}) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0\n`;
}

/** What the fake host says about each pid; any other pid is absent. */
const PIDS: Record<number, PidProbe> = {
  100: { stat: statLine(100, '5000') },
  300: 'exists',
  400: 'unknown',
  500: { stat: 'garbage' },
};

const proc: ProcReader = {
  probe: (pid) => PIDS[pid] ?? 'absent',
  bootId: () => BOOT,
  pidNs: () => NS,
  machineId: () => MACHINE,
};

/** A fresh canonical dir (it matches the paths the sweep returns under a symlinked TMPDIR). */
function parent(prefix = 'sweep-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Global teardown removes whatever is left.
    }
  });
  return dir;
}

/** A root in `dir` whose root and tmp mtimes are `ageMs` before `base`. */
function root(
  dir: string,
  name: string,
  owner: Partial<OwnerRecord> | string | null,
  base: number,
  ageMs = 0,
) {
  const path = join(dir, `spur-board-test-${name}`);
  mkdirSync(join(path, 'tmp'), { recursive: true });
  if (owner !== null) {
    const text = typeof owner === 'string' ? owner : JSON.stringify(owner);
    writeFileSync(join(path, 'owner.json'), text);
  }
  const at = new Date(base - ageMs);
  utimesSync(join(path, 'tmp'), at, at);
  utimesSync(path, at, at);
  return path;
}

const complete = (pid: number, startTicks = '5000'): OwnerRecord => ({
  pid,
  createdAt: 1,
  startTicks,
  bootId: BOOT,
  pidNs: NS,
  machineId: MACHINE,
});

function sweepAt(dir: string, base: number, proc: ProcReader, extra = {}) {
  return sweepStaleRuns({ parents: [dir], now: () => base, proc, ...extra });
}

interface Row {
  name: string;
  owner: Partial<OwnerRecord> | string | null;
  hours: number;
  removed: boolean;
  /** Sweeper identity; defaults to the fake host's. */
  self?: { bootId?: string; pidNs?: string; machineId?: string };
  /** The root's tmp was written just now. */
  busy?: boolean;
}

describe('sweepStaleRuns', () => {
  const base = Date.now();
  const otherBoot = { ...complete(100), bootId: 'boot-old' };
  const otherNs = { ...complete(200), pidNs: 'pid:[1]' };
  const otherNsAndBoot = { ...complete(100), pidNs: 'pid:[1]', bootId: 'boot-container' };
  const otherHost = { ...complete(100), bootId: 'boot-other-host', machineId: 'machine-b' };
  const otherHostDeadPid = { ...complete(200), machineId: 'machine-b' };
  const noMachine = { pid: 100, createdAt: 1, startTicks: '5000', bootId: 'boot-old', pidNs: NS };
  const partial = { pid: 200, createdAt: 1 };
  // A complete record whose owner pid is absent, or the full sweeper identity, minus one field:
  // a missing field is never proof the owner is gone, so a young root stays.
  const without = <T extends object>(value: T, field: keyof T): Partial<T> =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)) as Partial<T>;
  const deadWithout = (field: keyof OwnerRecord) => without(complete(200), field);
  const selfWithout = (field: 'bootId' | 'pidNs' | 'machineId') =>
    without({ bootId: BOOT, pidNs: NS, machineId: MACHINE }, field);

  // Every keep or remove decision: remove at once only on proof the owner is gone, keep while
  // its pid exists, and fall back to age only without any liveness signal.
  it.each<Row>([
    { name: 'no owner record, young', owner: null, hours: 2, removed: false },
    { name: 'no owner record, old', owner: null, hours: 4, removed: true },
    {
      name: 'no owner record, old but tmp fresh',
      owner: null,
      hours: 4,
      busy: true,
      removed: false,
    },
    { name: 'unparseable owner record, young', owner: '{not json', hours: 2, removed: false },
    { name: 'unparseable owner record, old', owner: '{not json', hours: 4, removed: true },
    { name: 'live owner', owner: complete(100), hours: 0, removed: false },
    { name: 'live owner, old', owner: complete(100), hours: 25, removed: false },
    { name: 'owner absent', owner: complete(200), hours: 0, removed: true },
    { name: 'reused pid', owner: complete(100, '4999'), hours: 0, removed: true },
    { name: 'owner stat unparseable', owner: complete(500), hours: 25, removed: false },
    {
      name: 'owner exists, stat unreadable, young',
      owner: complete(300),
      hours: 0,
      removed: false,
    },
    { name: 'owner exists, stat unreadable, old', owner: complete(300), hours: 25, removed: false },
    { name: 'owner state unknown, young', owner: complete(400), hours: 23, removed: false },
    { name: 'owner state unknown, old', owner: complete(400), hours: 25, removed: true },
    { name: 'earlier boot, same host and namespace', owner: otherBoot, hours: 0, removed: true },
    { name: 'other host, young', owner: otherHost, hours: 23, removed: false },
    { name: 'other host, old', owner: otherHost, hours: 25, removed: true },
    {
      name: 'other host, same boot, pid absent',
      owner: otherHostDeadPid,
      hours: 23,
      removed: false,
    },
    { name: 'record without host, young', owner: noMachine, hours: 23, removed: false },
    { name: 'record without host, old', owner: noMachine, hours: 25, removed: true },
    {
      name: 'sweeper without host, young',
      owner: complete(200),
      hours: 23,
      self: { bootId: BOOT, pidNs: NS },
      removed: false,
    },
    {
      name: 'sweeper without host, old',
      owner: complete(200),
      hours: 25,
      self: { bootId: BOOT, pidNs: NS },
      removed: true,
    },
    { name: 'other pid namespace, young', owner: otherNs, hours: 23, removed: false },
    { name: 'other pid namespace, old', owner: otherNs, hours: 25, removed: true },
    { name: 'other namespace and boot, young', owner: otherNsAndBoot, hours: 23, removed: false },
    { name: 'other namespace and boot, old', owner: otherNsAndBoot, hours: 25, removed: true },
    { name: 'pid and createdAt only, 1 h', owner: partial, hours: 1, removed: false },
    { name: 'pid and createdAt only, 23 h', owner: partial, hours: 23, removed: false },
    { name: 'pid and createdAt only, 25 h', owner: partial, hours: 25, removed: true },
    {
      name: 'sweeper without namespace, young',
      owner: complete(200),
      hours: 23,
      self: { bootId: BOOT },
      removed: false,
    },
    {
      name: 'sweeper without namespace, old',
      owner: complete(200),
      hours: 25,
      self: { bootId: BOOT },
      removed: true,
    },
    {
      name: 'dead owner, record without boot',
      owner: deadWithout('bootId'),
      hours: 0,
      removed: false,
    },
    {
      name: 'dead owner, record without namespace',
      owner: deadWithout('pidNs'),
      hours: 0,
      removed: false,
    },
    {
      name: 'dead owner, record without start ticks',
      owner: deadWithout('startTicks'),
      hours: 0,
      removed: false,
    },
    {
      name: 'dead owner, record without host',
      owner: deadWithout('machineId'),
      hours: 0,
      removed: false,
    },
    {
      name: 'dead owner, non-numeric start ticks',
      owner: complete(200, 'abc'),
      hours: 0,
      removed: false,
    },
    {
      name: 'dead owner, sweeper without boot',
      owner: complete(200),
      hours: 0,
      self: selfWithout('bootId'),
      removed: false,
    },
    {
      name: 'dead owner, sweeper without namespace only',
      owner: complete(200),
      hours: 0,
      self: selfWithout('pidNs'),
      removed: false,
    },
    {
      name: 'dead owner, sweeper without host only',
      owner: complete(200),
      hours: 0,
      self: selfWithout('machineId'),
      removed: false,
    },
    {
      name: 'dead owner, record and sweeper without namespace',
      owner: deadWithout('pidNs'),
      hours: 0,
      self: selfWithout('pidNs'),
      removed: false,
    },
    {
      name: 'dead owner, record and sweeper without host',
      owner: deadWithout('machineId'),
      hours: 0,
      self: selfWithout('machineId'),
      removed: false,
    },
    { name: 'pid 0, young', owner: complete(0), hours: 0, removed: false },
    {
      name: 'non-integer pid, young',
      owner: { ...complete(200), pid: 1.5 },
      hours: 0,
      removed: false,
    },
    {
      name: 'non-numeric createdAt, young',
      owner: JSON.stringify({ ...complete(200), createdAt: '1' }),
      hours: 0,
      removed: false,
    },
  ])('$name: removed $removed', ({ owner, hours, removed, self, busy }) => {
    const dir = parent();
    const path = root(dir, 'run', owner, base, hours * HOUR);
    if (busy) utimesSync(join(path, 'tmp'), new Date(base), new Date(base));
    expect(sweepAt(dir, base, proc, self ? { self } : {})).toEqual(removed ? [path] : []);
    expect(existsSync(path)).toBe(!removed);
  });

  it('never follows a symlink and skips other uids, other names and files', () => {
    const dir = parent();
    const target = root(dir, 'target-x', complete(200), base);
    const moved = join(parent('sweep-elsewhere-'), 'spur-board-test-moved');
    mkdirSync(moved);
    writeFileSync(join(moved, 'owner.json'), JSON.stringify(complete(200)));
    symlinkSync(moved, join(dir, 'spur-board-test-link'));
    const other = join(dir, 'other-dir');
    mkdirSync(other);
    writeFileSync(join(dir, 'spur-board-test-file'), 'x');
    const uid = statSync(dir).uid;
    expect(sweepAt(dir, base, proc, { uid: uid + 1 })).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(sweepAt(dir, base, proc, { uid })).toEqual([target]);
    expect(existsSync(join(moved, 'owner.json'))).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(readFileSync(join(dir, 'spur-board-test-file'), 'utf8')).toBe('x');
  });

  it('skips the sweep when the uid is unknown and a missing parent', () => {
    const dir = parent();
    const dead = root(dir, 'dead', complete(200), base);
    expect(sweepAt(dir, base, proc, { uid: undefined })).toEqual([]);
    expect(existsSync(dead)).toBe(true);
    expect(() =>
      sweepStaleRuns({ parents: [join(dir, 'missing')], proc, now: () => base }),
    ).not.toThrow();
  });
});

describe('readStartTicks', () => {
  it('reads field 22 after the last parenthesis', () => {
    expect(readStartTicks(statLine(7, '123456', 'a) (b'))).toBe('123456');
    expect(readStartTicks('garbage')).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'linux')('real /proc', () => {
  it('keeps the root of this process and removes one of an exited child', async () => {
    const dir = parent();
    const mine = join(dir, 'spur-board-test-mine');
    mkdirSync(mine);
    writeOwner(mine);
    const owner = JSON.parse(readFileSync(join(mine, 'owner.json'), 'utf8')) as OwnerRecord;
    expect(owner.pid).toBe(process.pid);
    expect(owner.startTicks).toMatch(/^\d+$/);

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const gone = join(dir, 'spur-board-test-gone');
    mkdirSync(gone);
    writeOwner(gone, { pid: child.pid ?? 0 });
    child.kill('SIGKILL');
    await exited;

    expect(sweepStaleRuns({ parents: [dir] })).toEqual([gone]);
    expect(existsSync(mine)).toBe(true);
  });
});
