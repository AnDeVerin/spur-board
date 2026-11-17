import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standVersion } from '../src/version.ts';

let repository: string;

function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: repository,
    env: { PATH: process.env['PATH'] ?? '' },
    stdio: 'ignore',
  });
}

function commit(): void {
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  );
}

beforeEach(() => {
  repository = mkdtempSync(join(tmpdir(), 'stand-version-'));
  git('init', '--quiet');
  commit();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repository, { recursive: true, force: true });
});

describe('standVersion', () => {
  it('uses the nearest reachable matching tag in the explicit repository', () => {
    git('tag', 'v99.0.0');
    commit();
    git('tag', 'v1.2.3');
    commit();
    git('tag', 'unrelated');
    commit();

    // The runner is in another checkout; inherited Git overrides must not redirect discovery.
    vi.stubEnv('GIT_DIR', join(repository, 'missing'));
    expect(standVersion(repository)).toBe('1.2.3');
  });

  it('returns dev when the repository has no matching release tag', () => {
    git('tag', 'unrelated');
    expect(standVersion(repository)).toBe('dev');
  });

  it('returns dev when Git is unavailable', () => {
    git('tag', 'v1.2.3');
    const emptyPath = join(repository, 'empty-bin');
    mkdirSync(emptyPath);
    vi.stubEnv('PATH', emptyPath);
    expect(standVersion(repository)).toBe('dev');
  });
});
