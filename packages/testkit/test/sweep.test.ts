import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type OwnerRecord,
  type ProcReader,
  readStartTicks,
  sweepStaleRuns,
  writeOwner,
} from '../src/sweep.ts';

const HOUR = 60 * 60 * 1000;
const BOOT = 'boot-a';
const NS = 'pid:[4026531836]';

function statLine(pid: number, ticks: string, comm = 'node'): string {
  // Fields 3..21 then field 22 (start ticks) and a few more.
  return `${String(pid)} (${comm}) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0\n`;
}

/** Pids in `live` run with those start ticks; pids in `hidden` exist but their stat is unreadable. */
function fakeProc(live: Record<number, string>, hidden: number[] = []): ProcReader {
  return {
    stat: (pid) => {
      if (hidden.includes(pid)) return undefined;
      return pid in live ? statLine(pid, live[pid] ?? '') : null;
    },
    bootId: () => BOOT,
    pidNs: () => NS,
  };
}

/** A fresh parent, canonical so it matches the paths the sweep returns under a symlinked TMPDIR. */
function parent(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'sweep-')));
}

/** A root in `dir` whose root and tmp mtimes are `ageMs` before `base`. */
function root(
  dir: string,
  name: string,
  owner: Partial<OwnerRecord> | null,
  base: number,
  ageMs = 0,
) {
  const path = join(dir, `spur-board-test-${name}`);
  mkdirSync(join(path, 'tmp'), { recursive: true });
  if (owner) writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
  const at = new Date(base - ageMs);
  utimesSync(join(path, 'tmp'), at, at);
  utimesSync(path, at, at);
  return path;
}

const complete = (pid: number, startTicks: string): OwnerRecord => ({
  pid,
  createdAt: 1,
  startTicks,
  bootId: BOOT,
  pidNs: NS,
});

function sweepAt(dir: string, base: number, after: number, proc: ProcReader, extra = {}) {
  return sweepStaleRuns({ parents: [dir], now: () => base + after, proc, ...extra });
}

describe('sweepStaleRuns', () => {
  const base = Date.now();
  // Pid 100 runs with start ticks 5000, pid 200 is gone, pid 300 runs with an unreadable stat.
  const proc = fakeProc({ 100: '5000' }, [300]);

  it.each([
    { name: 'live owner', owner: complete(100, '5000'), hours: 0, removed: false },
    { name: 'dead owner', owner: complete(200, '5000'), hours: 0, removed: true },
    { name: 'reused pid', owner: complete(100, '4999'), hours: 0, removed: true },
    {
      name: 'earlier boot, same pid namespace',
      owner: { ...complete(100, '5000'), bootId: 'boot-old' },
      hours: 0,
      removed: true,
    },
    {
      name: 'foreign pid namespace, young',
      owner: { ...complete(200, '5000'), pidNs: 'pid:[1]' },
      hours: 23,
      removed: false,
    },
    {
      name: 'foreign pid namespace, old',
      owner: { ...complete(200, '5000'), pidNs: 'pid:[1]' },
      hours: 25,
      removed: true,
    },
    {
      name: 'foreign pid namespace and other boot id, young',
      owner: { ...complete(100, '5000'), pidNs: 'pid:[1]', bootId: 'boot-container' },
      hours: 23,
      removed: false,
    },
    {
      name: 'foreign pid namespace and other boot id, old',
      owner: { ...complete(100, '5000'), pidNs: 'pid:[1]', bootId: 'boot-container' },
      hours: 25,
      removed: true,
    },
    {
      name: 'unreadable owner stat, young',
      owner: complete(300, '5000'),
      hours: 23,
      removed: false,
    },
    { name: 'unreadable owner stat, old', owner: complete(300, '5000'), hours: 25, removed: true },
  ])('$name: removed $removed', ({ owner, hours, removed }) => {
    const dir = parent();
    const path = root(dir, 'run', owner, base, hours * HOUR);
    expect(sweepAt(dir, base, 0, proc)).toEqual(removed ? [path] : []);
    expect(existsSync(path)).toBe(!removed);
  });

  it('keeps a root without owner until 3 h, and while its tmp is fresh', () => {
    const dir = parent();
    const young = root(dir, 'young', null, base, 2 * HOUR);
    const old = root(dir, 'old', null, base, 4 * HOUR);
    const busy = root(dir, 'busy', null, base, 4 * HOUR);
    utimesSync(join(busy, 'tmp'), new Date(base), new Date(base));
    writeFileSync(join(dir, 'spur-board-test-junk'), 'x');
    const unparsed = root(dir, 'unparsed', null, base, 4 * HOUR);
    writeFileSync(join(unparsed, 'owner.json'), '{not json');
    utimesSync(unparsed, new Date(base - 4 * HOUR), new Date(base - 4 * HOUR));
    expect(sweepAt(dir, base, 0, proc).sort()).toEqual([old, unparsed].sort());
    expect(existsSync(young)).toBe(true);
    expect(existsSync(busy)).toBe(true);
  });

  it('decides a pid and createdAt only record by age alone', () => {
    const record = { pid: 200, createdAt: 1 };
    // Pid 200 is not running and bootId is missing: neither counts as a mismatch.
    for (const [hours, kept] of [
      [1, true],
      [23, true],
      [25, false],
    ] as const) {
      const dir = parent();
      const path = root(dir, 'partial', record, base, hours * HOUR);
      sweepAt(dir, base, 0, proc);
      expect(existsSync(path), `${String(hours)} h`).toBe(kept);
    }
  });

  it('decides by age alone when the sweeper has no identity of its own', () => {
    const dir = parent();
    const young = root(dir, 'young', complete(200, '5000'), base, 23 * HOUR);
    const old = root(dir, 'old', complete(200, '5000'), base, 25 * HOUR);
    expect(sweepAt(dir, base, 0, proc, { self: { bootId: BOOT } })).toEqual([old]);
    expect(existsSync(young)).toBe(true);
  });

  it('never follows a symlink and skips other uids, other names and files', () => {
    const dir = parent();
    const target = root(dir, 'target-x', complete(200, '5000'), base);
    const elsewhere = mkdtempSync(join(tmpdir(), 'sweep-elsewhere-'));
    const moved = join(elsewhere, 'spur-board-test-moved');
    mkdirSync(moved);
    writeFileSync(join(moved, 'owner.json'), JSON.stringify(complete(200, '5000')));
    symlinkSync(moved, join(dir, 'spur-board-test-link'));
    const other = join(dir, 'other-dir');
    mkdirSync(other);
    writeFileSync(join(dir, 'spur-board-test-file'), 'x');
    const uid = statSync(dir).uid;
    expect(sweepAt(dir, base, 0, proc, { uid: uid + 1 })).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(sweepAt(dir, base, 0, proc, { uid })).toEqual([target]);
    expect(existsSync(join(moved, 'owner.json'))).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(readFileSync(join(dir, 'spur-board-test-file'), 'utf8')).toBe('x');
  });

  it('skips the sweep when the uid is unknown and a missing parent', () => {
    const dir = parent();
    const dead = root(dir, 'dead', complete(200, '5000'), base);
    expect(sweepAt(dir, base, 0, proc, { uid: undefined })).toEqual([]);
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
