import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proxyRefusal, refusal } from '../src/guards.ts';

let base: string;
let root: string;
let osHome: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stand-guards-'));
  root = join(base, 'tmp');
  osHome = join(base, 'home');
  // Private, so the umask cannot make the root group-writable.
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(osHome);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('refusal', () => {
  it('allows a clean start', () => {
    expect(refusal({ root, port: 0, env: {}, osHome })).toBeUndefined();
  });

  it('refuses live_home when BOARD_HOME is the root', () => {
    expect(refusal({ root, port: 0, env: { BOARD_HOME: root }, osHome })?.reason).toBe('live_home');
  });

  it('refuses live_home when BOARD_HOME holds the root', () => {
    expect(refusal({ root, port: 0, env: { BOARD_HOME: base }, osHome })?.reason).toBe('live_home');
  });

  it('refuses live_home for a root inside the XDG data dir', () => {
    const data = join(base, 'data');
    const inside = join(data, 'spur-board', 'tmp');
    mkdirSync(inside, { recursive: true });
    expect(refusal({ root: inside, port: 0, env: { XDG_DATA_HOME: data }, osHome })?.reason).toBe(
      'live_home',
    );
  });

  it('refuses live_home for a root inside the default config dir', () => {
    const inside = join(osHome, '.config', 'spur-board', 'tmp');
    mkdirSync(inside, { recursive: true });
    expect(refusal({ root: inside, port: 0, env: {}, osHome })?.reason).toBe('live_home');
  });

  it.each([
    ['777', 0o777],
    ['775', 0o775],
    ['757', 0o757],
  ])('refuses unsafe_root for a root with mode %s and no sticky bit', (_name, mode) => {
    chmodSync(root, mode);
    expect(refusal({ root, port: 0, env: {}, osHome })?.reason).toBe('unsafe_root');
  });

  it.each([
    ['1777', 0o1777],
    ['755', 0o755],
    ['700', 0o700],
  ])('allows a root with mode %s', (_name, mode) => {
    chmodSync(root, mode);
    expect(refusal({ root, port: 0, env: {}, osHome })).toBeUndefined();
  });

  it('refuses unsafe_root for a root that does not exist', () => {
    expect(refusal({ root: join(base, 'missing'), port: 0, env: {}, osHome })?.reason).toBe(
      'unsafe_root',
    );
  });

  it('refuses live_port for 4777', () => {
    expect(refusal({ root, port: 4777, env: {}, osHome })?.reason).toBe('live_port');
  });

  it.each([4779, 4800, 1, 65_535])('refuses port_range for %i', (port) => {
    expect(refusal({ root, port, env: {}, osHome })?.reason).toBe('port_range');
  });

  it.each([0, 4780, 4799])('allows port %i', (port) => {
    expect(refusal({ root, port, env: {}, osHome })).toBeUndefined();
  });

  it.each([
    'SLACK_BOT_TOKEN',
    'JIRA_API_TOKEN',
    'JIRA_CONFIG_FILE',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'BOARD_TOKEN',
    'SPUR_API_TOKEN',
    'SPUR_WEBHOOK_SECRET',
  ])('refuses external_secrets for %s and names it without its value', (name) => {
    const result = refusal({ root, port: 0, env: { [name]: 'real-value-123' }, osHome });
    expect(result?.reason).toBe('external_secrets');
    expect(result?.message).toContain(`-u ${name}`);
    expect(result?.message).not.toContain('real-value-123');
  });

  it('allows empty credentials and Spur or board names that hold no secret', () => {
    expect(
      refusal({
        root,
        port: 0,
        env: {
          GITHUB_TOKEN: '',
          BOARD_TOKEN: '',
          SPUR_SESSION: 's',
          SPUR_PROJECT: 'p',
          SPUR_CONFIG: '/c',
          BOARD_DAEMON_URL: 'http://127.0.0.1:1',
        },
        osHome,
      }),
    ).toBeUndefined();
  });
});

describe('proxyRefusal', () => {
  it.each([
    [{ NODE_USE_ENV_PROXY: '1' }, []],
    [{ NODE_OPTIONS: '--max-old-space-size=64 --use-env-proxy' }, []],
    [{}, ['--use-env-proxy']],
    [{ NODE_OPTIONS: '"--use-env-proxy"' }, []],
    [{ NODE_OPTIONS: "--max-old-space-size=64 '--use-env-proxy'" }, []],
    [{ NODE_OPTIONS: '--use-env-\\proxy' }, []],
    [{ NODE_OPTIONS: '--use_env_proxy' }, []],
    [{ NODE_OPTIONS: '--max-old-space-size=64 --use-env_proxy' }, []],
    [{}, ['--use_env_proxy']],
    [{}, ['--use-env_proxy']],
  ])('refuses env_proxy for %j %j', (env, execArgv) => {
    expect(proxyRefusal({ env, execArgv })?.reason).toBe('env_proxy');
  });

  it.each([
    [{ NODE_USE_ENV_PROXY: '' }, []],
    [{ NODE_OPTIONS: '--max-old-space-size=64' }, ['--conditions=dev']],
  ])('allows %j %j', (env, execArgv) => {
    expect(proxyRefusal({ env, execArgv })).toBeUndefined();
  });
});
