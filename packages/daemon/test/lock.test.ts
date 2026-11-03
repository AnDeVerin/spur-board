import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, LockHeldError } from '../src/lock.ts';

const held: { release(): void }[] = [];

function lockFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'daemon-lock-')), 'data', 'board.lock');
}

function acquire(file: string): { release(): void } {
  const lock = acquireLock(file);
  held.push(lock);
  return lock;
}

function heldError(file: string): LockHeldError {
  try {
    acquireLock(file).release();
  } catch (err) {
    expect(err).toBeInstanceOf(LockHeldError);
    return err as LockHeldError;
  }
  throw new Error('acquireLock did not throw');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const lock of held.splice(0)) lock.release();
});

describe('acquireLock', () => {
  it('creates the directory and writes its PID', () => {
    const file = lockFile();
    acquire(file);
    expect(readFileSync(file, 'utf8')).toBe(`${String(process.pid)}\n`);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a second holder and names the file and PID', () => {
    const file = lockFile();
    acquire(file);
    const err = heldError(file);
    expect(err.file).toBe(file);
    expect(err.pid).toBe(process.pid);
    expect(err.message).toBe(`another daemon holds ${file} (PID ${String(process.pid)})`);
    // The loser never truncates the holder's PID.
    expect(readFileSync(file, 'utf8')).toBe(`${String(process.pid)}\n`);
  });

  it('reports PID unknown when the file holds no PID', () => {
    const file = lockFile();
    acquire(file);
    writeFileSync(file, '');
    const err = heldError(file);
    expect(err.pid).toBeNull();
    expect(err.message).toContain(`${file} (PID unknown)`);
  });

  it('can be taken again after release and keeps the file', () => {
    const file = lockFile();
    acquireLock(file).release();
    expect(existsSync(file)).toBe(true);
    acquire(file);
    expect(readFileSync(file, 'utf8')).toBe(`${String(process.pid)}\n`);
  });

  it('replaces a stale PID left by a dead holder', () => {
    const file = lockFile();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '999999999\n');
    acquire(file);
    expect(readFileSync(file, 'utf8')).toBe(`${String(process.pid)}\n`);
  });

  it('fails clearly without flock', () => {
    const empty = mkdtempSync(join(tmpdir(), 'daemon-nopath-'));
    vi.stubEnv('PATH', empty);
    expect(() => acquireLock(lockFile())).toThrow('flock from util-linux is required to lock');
  });
});
