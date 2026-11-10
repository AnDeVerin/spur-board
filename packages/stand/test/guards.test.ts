import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  mkdirSync(root);
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
  ])('refuses external_secrets for %s and names it without its value', (name) => {
    const result = refusal({ root, port: 0, env: { [name]: 'real-value-123' }, osHome });
    expect(result?.reason).toBe('external_secrets');
    expect(result?.message).toContain(`-u ${name}`);
    expect(result?.message).not.toContain('real-value-123');
  });

  it('allows empty external secrets and board or session names', () => {
    expect(
      refusal({
        root,
        port: 0,
        env: { GITHUB_TOKEN: '', SPUR_SESSION: 's', BOARD_TOKEN: 't' },
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
