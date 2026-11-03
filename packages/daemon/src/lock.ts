import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Another process holds the lock. `pid` is null when the file holds no readable PID yet. */
export class LockHeldError extends Error {
  override name = 'LockHeldError';
  readonly file: string;
  readonly pid: number | null;

  constructor(file: string, pid: number | null) {
    super(`another daemon holds ${file} (PID ${pid === null ? 'unknown' : String(pid)})`);
    this.file = file;
    this.pid = pid;
  }
}

/**
 * Takes an exclusive flock on `file` for the life of the process. The kernel drops it when the
 * process dies, so a crash never leaves a stale lock. The file is never unlinked, and only the
 * holder truncates it to write its PID.
 */
export function acquireLock(file: string): { release(): void } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'a+', 0o600);
  // flock(1) locks the open file description it inherits as fd 3, which this process shares.
  const result = spawnSync('flock', ['-n', '-x', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
  });
  if (result.status === 0) {
    ftruncateSync(fd, 0);
    writeSync(fd, `${String(process.pid)}\n`);
    return {
      release() {
        closeSync(fd);
      },
    };
  }
  closeSync(fd);
  if (result.error !== undefined) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error(`flock from util-linux is required to lock ${file}`, {
        cause: result.error,
      });
    }
    throw result.error;
  }
  if (result.status === 1) {
    const text = readFileSync(file, 'utf8').trim();
    throw new LockHeldError(file, /^\d+$/.test(text) ? Number(text) : null);
  }
  const stderr = result.stderr.toString().trim();
  throw new Error(
    `flock failed to lock ${file} (status ${String(result.status)}): ${stderr || 'no output'}`,
  );
}
