import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configFile,
  dataDirectory,
  findTokenFile,
  loadClientConfig,
  resolveDaemonAddress,
} from '../src/config.ts';

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

const validYaml = `projects:
  - id: board
    tracker: { type: github-issues, repo: example/board, label: board }
    repos: [example/board]
    operatorGithubLogin: operator
operator: { slack: U0000000000 }
digest: { tz: UTC }
`;

describe('daemon address', () => {
  it.each([
    ['explicit URL', 'http://127.0.0.1:9999', false, 9999],
    ['configured port', undefined, false, 4567],
    ['XDG config path', undefined, true, 4567],
  ] as const)('%s', (_name, explicit, xdg, expectedPort) => {
    const paths = setup();
    const location = xdg ? join(paths.home, 'xdg', 'spur-board') : join(paths.home, 'board');
    mkdirSync(location, { recursive: true });
    writeFileSync(
      join(location, 'config.yaml'),
      validYaml.replace('digest:', 'http: { port: 4567 }\ndigest:'),
    );
    const address = resolveDaemonAddress(
      {
        ...(xdg ? { XDG_CONFIG_HOME: join(paths.home, 'xdg') } : { BOARD_HOME: location }),
        ...(explicit ? { BOARD_DAEMON_URL: explicit } : {}),
      },
      paths.home,
    );
    expect(address.href).toBe(`http://127.0.0.1:${String(expectedPort)}/`);
  });

  it.each([
    ['missing config', undefined],
    ['malformed YAML', 'http: ['],
    ['schema-invalid config', 'http: { port: -1 }'],
  ] as const)('refuses a %s without BOARD_DAEMON_URL', (_name, yaml) => {
    const paths = setup();
    const location = join(paths.home, 'board');
    mkdirSync(location);
    if (yaml !== undefined) writeFileSync(join(location, 'config.yaml'), yaml);
    expect(() => resolveDaemonAddress({ BOARD_HOME: location }, paths.home)).toThrow(
      expect.objectContaining({
        code: 'config',
        context: {
          environmentVariable: 'BOARD_DAEMON_URL',
          configPath: join(location, 'config.yaml'),
        },
        hint: expect.stringMatching(/BOARD_DAEMON_URL.*http\.port/) as unknown,
      }),
    );
  });

  it('rejects invalid explicit URLs', () => {
    expect(() => resolveDaemonAddress({ BOARD_DAEMON_URL: 'ftp://example.com' })).toThrow();
    expect(() =>
      resolveDaemonAddress({ BOARD_DAEMON_URL: 'http://user:pass@example.com' }),
    ).toThrow();
  });

  it('requires an explicit address when the configured port is runtime-assigned', () => {
    const paths = setup();
    const location = join(paths.home, 'board');
    mkdirSync(location);
    writeFileSync(
      join(location, 'config.yaml'),
      validYaml.replace('digest:', 'http: { port: 0 }\ndigest:'),
    );
    expect(() => resolveDaemonAddress({ BOARD_HOME: location }, paths.home)).toThrow(
      expect.objectContaining({
        code: 'config',
        hint: expect.stringMatching(/^http\.port: 0 assigns a runtime port/) as unknown,
      }),
    );
    expect(() =>
      resolveDaemonAddress(
        { BOARD_HOME: location, BOARD_DAEMON_URL: 'http://127.0.0.1:4567' },
        paths.home,
      ),
    ).not.toThrow();
  });
});

describe('data directory', () => {
  it.each([
    ['BOARD_HOME', { BOARD_HOME: '/board/home', XDG_DATA_HOME: '/xdg/data' }, '/board/home'],
    ['absolute XDG_DATA_HOME', { XDG_DATA_HOME: '/xdg/data' }, '/xdg/data/spur-board'],
    ['relative XDG_DATA_HOME', { XDG_DATA_HOME: 'xdg/data' }, '/home/op/.local/share/spur-board'],
    ['empty BOARD_HOME', { BOARD_HOME: '' }, '/home/op/.local/share/spur-board'],
    ['no variables', {}, '/home/op/.local/share/spur-board'],
  ] as const)('uses the daemon database directory for %s', (_name, env, expected) => {
    expect(dataDirectory(env, '/home/op')).toBe(expected);
  });

  it('resolves a relative BOARD_HOME from the given working directory', () => {
    expect(dataDirectory({ BOARD_HOME: 'board' }, '/home/op', '/srv')).toBe('/srv/board');
    expect(configFile({ BOARD_HOME: 'board' }, '/home/op', '/srv')).toBe('/srv/board/config.yaml');
    expect(dataDirectory({ BOARD_HOME: '/abs' }, '/home/op', '/srv')).toBe('/abs');
  });
});

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
    expect(() => loadClientConfig(env, { cwd: paths.cwd, home: paths.home })).toThrow(
      expect.objectContaining({ code: 'identity_missing', context: undefined }),
    );
  });

  it('stops external lookup before a shared ancestor', () => {
    const paths = setup();
    const root = join(paths.outside, '..');
    token(root, 'ambient-token');
    chmodSync(root, 0o777);
    expect(findTokenFile(paths.outside, paths.home)).toBeUndefined();
  });

  it('skips an unsafe token candidate, warns, and continues to a safe parent', () => {
    const paths = setup();
    token(paths.project, 'parent-token');
    token(join(paths.project, 'one'), 'unsafe-token');
    const directory = join(paths.project, '.spur-board');
    const nearest = join(paths.project, 'one', '.spur-board');
    const warnings: string[] = [];
    chmodSync(nearest, 0o755);
    expect(findTokenFile(paths.cwd, paths.home, (message) => warnings.push(message))).toBe(
      'parent-token',
    );
    chmodSync(directory, 0o755);
    expect(
      findTokenFile(paths.cwd, paths.home, (message) => warnings.push(message)),
    ).toBeUndefined();
    chmodSync(directory, 0o700);
    chmodSync(join(directory, 'token'), 0o644);
    expect(
      findTokenFile(paths.cwd, paths.home, (message) => warnings.push(message)),
    ).toBeUndefined();
    expect(warnings).toHaveLength(5);
    expect(warnings.every((message) => message.includes('unsafe .spur-board/token'))).toBe(true);
  });

  it('skips a symlinked token directory or file', () => {
    const paths = setup();
    const target = join(paths.home, 'target');
    mkdirSync(target);
    token(target, 'linked-token');
    symlinkSync(join(target, '.spur-board'), join(paths.project, '.spur-board'));
    const warnings: string[] = [];
    expect(
      findTokenFile(paths.cwd, paths.home, (message) => warnings.push(message)),
    ).toBeUndefined();

    const other = join(paths.home, 'other');
    mkdirSync(join(other, '.spur-board'), { mode: 0o700 });
    symlinkSync(join(target, '.spur-board', 'token'), join(other, '.spur-board', 'token'));
    expect(findTokenFile(other, paths.home, (message) => warnings.push(message))).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it('stops the token search at the git worktree root', () => {
    const paths = setup();
    const root = join(paths.project, 'one');
    writeFileSync(join(root, '.git'), 'gitdir: /x\n');
    token(paths.project, 'above');
    expect(findTokenFile(paths.cwd, paths.home)).toBeUndefined();
    expect(() => loadClientConfig(env, paths)).toThrow(
      expect.objectContaining({ code: 'identity_missing' }),
    );
    token(root, 'root');
    expect(findTokenFile(paths.cwd, paths.home)).toBe('root');
    mkdirSync(join(paths.cwd, '.git'));
    expect(findTokenFile(paths.cwd, paths.home)).toBeUndefined();

    const repo = join(paths.outside, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'sub'));
    token(paths.outside, 'x');
    expect(findTokenFile(join(repo, 'sub'), paths.home)).toBeUndefined();
  });

  it('uses BOARD_TOKEN before a file and skips lookup for a session', () => {
    const paths = setup();
    token(paths.project, 'file-token');
    expect(loadClientConfig({ ...env, BOARD_TOKEN: 'explicit' }, paths).token).toBe('explicit');
    expect(
      loadClientConfig({ ...env, BOARD_TOKEN: 'explicit', SPUR_SESSION: 's1' }, paths),
    ).toMatchObject({ session: 's1', token: undefined });
    expect(() => loadClientConfig({ ...env, BOARD_TOKEN: '' }, paths)).toThrow(
      expect.objectContaining({ code: 'config', context: { environmentVariable: 'BOARD_TOKEN' } }),
    );
  });
});
