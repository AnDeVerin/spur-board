import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probePid } from '../src/sweep.ts';

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

interface Row {
  name: string;
  /** The error reading `/proc/<pid>/stat` throws; undefined means it reads a stat line. */
  stat?: string;
  /** The error `kill(pid, 0)` throws; undefined means it succeeds. */
  kill?: string;
  probe: ReturnType<typeof probePid>;
}

// The sweep reads `/proc/<pid>/stat` through the `node:fs` named export; patching the builtin
// and syncing its ESM exports reaches it without a module mock.
describe('probePid', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each<Row>([
    { name: 'stat readable', probe: { stat: '42 (node) S' } },
    { name: 'stat unreadable, kill succeeds', stat: 'EACCES', probe: 'exists' },
    { name: 'stat unreadable, kill EPERM', stat: 'EACCES', kill: 'EPERM', probe: 'exists' },
    { name: 'stat missing, kill EPERM', stat: 'ENOENT', kill: 'EPERM', probe: 'exists' },
    { name: 'stat missing, kill ESRCH', stat: 'ENOENT', kill: 'ESRCH', probe: 'absent' },
    { name: 'stat ESRCH, kill ESRCH', stat: 'ESRCH', kill: 'ESRCH', probe: 'absent' },
    { name: 'stat unreadable, kill ESRCH', stat: 'EACCES', kill: 'ESRCH', probe: 'unknown' },
    {
      name: 'stat missing, kill fails otherwise',
      stat: 'ENOENT',
      kill: 'EINVAL',
      probe: 'unknown',
    },
  ])('$name: $probe', ({ stat, kill, probe }) => {
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      if (stat !== undefined) throw failure(stat);
      return '42 (node) S';
    });
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (kill !== undefined) throw failure(kill);
      return true;
    });
    syncBuiltinESMExports();

    expect(probePid(42)).toEqual(probe);
    expect(read).toHaveBeenCalledWith('/proc/42/stat', 'utf8');
    if (stat === undefined) expect(signal).not.toHaveBeenCalled();
    else expect(signal).toHaveBeenCalledWith(42, 0);
  });
});
