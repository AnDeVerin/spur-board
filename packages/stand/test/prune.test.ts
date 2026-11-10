import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  procStat,
  prune,
  readManifest,
  removeStand,
  standManifest,
  writeManifest,
  type StandManifest,
} from '../src/manifest.ts';

let base: string;
let root: string;
let otherRoot: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stand-prune-'));
  root = join(base, 'root');
  otherRoot = join(base, 'other-root');
  mkdirSync(root);
  mkdirSync(otherRoot);
  root = realpathSync(root);
  otherRoot = realpathSync(otherRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const selfStart = (): number => {
  const stat = procStat(process.pid);
  if (stat === undefined) throw new Error('no /proc entry for this process');
  return stat.startTime;
};

/** A pid that ran and exited, so no process holds it now (barring reuse within the test). */
const deadPid = (): number => spawnSync('true').pid;

function stand(
  dir: string,
  owner: { pid: number; pidStartTime: number },
  home = dir,
): StandManifest {
  mkdirSync(dir, { recursive: true });
  const manifest = standManifest.parse({
    version: 1,
    id: 'abcdef',
    home: realpathSync(home),
    ...owner,
    daemonUrl: 'http://127.0.0.1:1',
    controlUrl: 'http://127.0.0.1:2',
    controlToken: 'control',
    tokenPath: join(dir, 'token'),
    roles: { worker: 'w', orchestrator: 'o' },
  });
  writeManifest(dir, manifest);
  return manifest;
}

describe('prune', () => {
  it('removes dead stands and keeps live, foreign and non-stand directories', () => {
    const live = join(root, 'spur-board-stand.live01');
    stand(live, { pid: process.pid, pidStartTime: selfStart() });
    const noManifest = join(root, 'spur-board-stand.nomani');
    mkdirSync(noManifest);
    const invalid = join(root, 'spur-board-stand.badjsn');
    mkdirSync(invalid);
    writeFileSync(join(invalid, 'stand.json'), '{not json', { mode: 0o600 });
    const target = join(otherRoot, 'spur-board-stand.target');
    stand(target, { pid: deadPid(), pidStartTime: 1 });
    const link = join(root, 'spur-board-stand.lnkxyz');
    symlinkSync(target, link);
    const otherName = join(root, 'other-name');
    stand(otherName, { pid: deadPid(), pidStartTime: 1 });
    const sibling = join(root, 'sibling');
    mkdirSync(sibling);
    const pointsAway = join(root, 'spur-board-stand.abcdef');
    stand(pointsAway, { pid: deadPid(), pidStartTime: 1 }, sibling);
    const deadStart = join(root, 'spur-board-stand.dstart');
    stand(deadStart, { pid: process.pid, pidStartTime: selfStart() + 1 });
    const deadPidDir = join(root, 'spur-board-stand.deadpd');
    stand(deadPidDir, { pid: deadPid(), pidStartTime: 1 });

    const results = new Map(prune(root).map(({ dir, result }) => [dir, result]));

    expect(results.get(deadStart)).toBe('removed');
    expect(results.get(deadPidDir)).toBe('removed');
    expect(existsSync(deadStart)).toBe(false);
    expect(existsSync(deadPidDir)).toBe(false);
    for (const kept of [live, noManifest, invalid, link, pointsAway]) {
      expect(results.get(kept)).toHaveProperty('kept');
      expect(existsSync(kept)).toBe(true);
    }
    for (const kept of [target, otherName, sibling]) expect(existsSync(kept)).toBe(true);
    expect(readManifest(target)).toBeDefined();
  });
});

describe('removeStand', () => {
  it('keeps a directory outside the stand name pattern even with a dead manifest', () => {
    const dir = join(root, 'my-data');
    stand(dir, { pid: deadPid(), pidStartTime: 1 });
    expect(removeStand(dir, root)).toHaveProperty('kept');
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dead stand directory under another root', () => {
    const dir = join(otherRoot, 'spur-board-stand.abcdef');
    stand(dir, { pid: deadPid(), pidStartTime: 1 });
    expect(removeStand(dir, root)).toHaveProperty('kept');
    expect(existsSync(dir)).toBe(true);
  });
});
