import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findTokenFile, loadClientConfig } from '../src/config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cli-token-config-'));
  dirs.push(root);
  const home = join(root, 'home');
  const project = join(home, 'project');
  const cwd = join(project, 'one', 'two');
  const outside = join(root, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, 'other'));
  mkdirSync(outside);
  mkdirSync(join(home, '.spur-board'));
  writeFileSync(join(home, '.spur-board', 'token'), 'global\n');
  return { home, project, cwd, outside };
}

function token(folder: string, value: string) {
  mkdirSync(join(folder, '.spur-board'), { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, '.spur-board', 'token'), `${value}\n`, { mode: 0o600 });
}

const env = { BOARD_DAEMON_URL: 'http://127.0.0.1:4311' };

describe('operator token lookup', () => {
  it('finds a file two folders up and never uses a home-wide token', () => {
    const paths = setup();
    token(paths.project, 'project-token');
    expect(findTokenFile(paths.cwd, paths.home)).toBe('project-token');
    expect(loadClientConfig(env, paths).token).toBe('project-token');
    expect(findTokenFile(paths.home, paths.home)).toBeUndefined();
    expect(findTokenFile(join(paths.home, 'other'), paths.home)).toBeUndefined();
  });

  it('does not search above home and finds an external parent from a subfolder', () => {
    const paths = setup();
    const nested = join(paths.outside, 'one', 'two');
    mkdirSync(nested, { recursive: true });
    token(paths.outside, 'outside-token');
    expect(findTokenFile(paths.outside, paths.home)).toBe('outside-token');
    expect(findTokenFile(nested, paths.home)).toBe('outside-token');
    expect(loadClientConfig(env, { cwd: nested, home: paths.home }).token).toBe('outside-token');
    expect(findTokenFile(join(paths.home, 'other'), paths.home)).toBeUndefined();
    expect(() => loadClientConfig(env, { cwd: paths.cwd, home: paths.home })).toThrow();
  });

  it('stops external lookup before a shared ancestor', () => {
    const paths = setup();
    const root = join(paths.outside, '..');
    token(root, 'ambient-token');
    chmodSync(root, 0o777);
    expect(findTokenFile(paths.outside, paths.home)).toBeUndefined();
  });

  it('rejects a shared token directory or readable token file', () => {
    const paths = setup();
    token(paths.project, 'unsafe-token');
    const directory = join(paths.project, '.spur-board');
    chmodSync(directory, 0o755);
    expect(() => findTokenFile(paths.cwd, paths.home)).toThrow();
    chmodSync(directory, 0o700);
    chmodSync(join(directory, 'token'), 0o644);
    expect(() => findTokenFile(paths.cwd, paths.home)).toThrow();
  });

  it('rejects a symlinked token directory or file', () => {
    const paths = setup();
    const target = join(paths.home, 'target');
    mkdirSync(target);
    token(target, 'linked-token');
    symlinkSync(join(target, '.spur-board'), join(paths.project, '.spur-board'));
    expect(() => findTokenFile(paths.cwd, paths.home)).toThrow();

    const other = join(paths.home, 'other');
    mkdirSync(join(other, '.spur-board'), { mode: 0o700 });
    symlinkSync(join(target, '.spur-board', 'token'), join(other, '.spur-board', 'token'));
    expect(() => findTokenFile(other, paths.home)).toThrow();
  });

  it('uses BOARD_TOKEN before a file and skips lookup for a session', () => {
    const paths = setup();
    token(paths.project, 'file-token');
    expect(loadClientConfig({ ...env, BOARD_TOKEN: 'explicit' }, paths).token).toBe('explicit');
    expect(
      loadClientConfig({ ...env, BOARD_TOKEN: 'explicit', SPUR_SESSION: 's1' }, paths),
    ).toMatchObject({ session: 's1', token: undefined });
    expect(() => loadClientConfig({ ...env, BOARD_TOKEN: '' }, paths)).toThrow();
  });
});
