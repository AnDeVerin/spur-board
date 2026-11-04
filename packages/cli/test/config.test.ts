import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(join(folder, '.spur-board'), { recursive: true });
  writeFileSync(join(folder, '.spur-board', 'token'), `${value}\n`);
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

  it('does not search above home and reads only the current external folder', () => {
    const paths = setup();
    token(paths.outside, 'outside-token');
    expect(findTokenFile(paths.outside, paths.home)).toBe('outside-token');
    expect(findTokenFile(join(paths.home, 'other'), paths.home)).toBeUndefined();
    expect(() => loadClientConfig(env, { cwd: paths.cwd, home: paths.home })).toThrow();
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
