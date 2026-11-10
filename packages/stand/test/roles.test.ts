import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isScrubbed } from '@spur-board/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StandManifest } from '../src/manifest.ts';
import { BOARD_CLI, blockedBoardCommand, roleEnv, ROLES, standEnv } from '../src/roles.ts';

const BASE = {
  PATH: '/usr/bin',
  SPUR_SESSION: 'inherited-session',
  BOARD_TOKEN: 'inherited-token',
  GH_TOKEN: 'gh',
  JIRA_API_TOKEN: 'jira',
  HTTP_PROXY: 'http://127.0.0.1:1',
  https_proxy: 'http://127.0.0.1:2',
  NO_PROXY: 'localhost',
  NODE_USE_ENV_PROXY: '1',
  NODE_OPTIONS: '--use-env-proxy --max-old-space-size=64',
};
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'];

let home: string;
let manifest: StandManifest;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stand-roles-'));
  const tokenPath = join(home, 'token');
  writeFileSync(tokenPath, 'operator-token\n', { mode: 0o600 });
  manifest = {
    version: 1,
    id: 'abcdef',
    home,
    pid: 1,
    pidStartTime: 1,
    daemonUrl: 'http://127.0.0.1:4790',
    controlUrl: 'http://127.0.0.1:4791',
    controlToken: 'control',
    tokenPath,
    roles: { worker: 'stand-worker-1', orchestrator: 'stand-qa-1' },
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function proxyFree(env: Record<string, string>): void {
  for (const name of Object.keys(env)) expect(PROXY_NAMES).not.toContain(name.toUpperCase());
  expect(env['NODE_OPTIONS'] ?? '').not.toContain('--use-env-proxy');
}

describe('standEnv', () => {
  it('drops scrubbed names and the env proxy flag', () => {
    const env = standEnv(BASE);
    expect(env).toEqual({ PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=64' });
    expect(Object.keys(env).filter(isScrubbed)).toEqual([]);
    proxyFree(env);
  });

  it('drops NODE_OPTIONS when only the proxy flag was in it', () => {
    expect(standEnv({ NODE_OPTIONS: '--use-env-proxy' })).not.toHaveProperty('NODE_OPTIONS');
  });
});

describe('roleEnv', () => {
  it('gives the operator the stand token and no session', () => {
    const env = roleEnv(manifest, 'operator', BASE);
    expect(env).not.toHaveProperty('SPUR_SESSION');
    expect(env['BOARD_TOKEN']).toBe('operator-token');
  });

  it.each([
    ['worker', 'stand-worker-1'],
    ['orchestrator', 'stand-qa-1'],
  ] as const)('gives the %s its session id and no token', (role, session) => {
    const env = roleEnv(manifest, role, BASE);
    expect(env['SPUR_SESSION']).toBe(session);
    expect(env).not.toHaveProperty('BOARD_TOKEN');
  });

  it.each(ROLES)('points %s at the stand and passes no other scrubbed name', (role) => {
    const env = roleEnv(manifest, role, BASE);
    expect(env['BOARD_DAEMON_URL']).toBe(manifest.daemonUrl);
    expect(env['BOARD_HOME']).toBe(home);
    const own = ['BOARD_DAEMON_URL', 'BOARD_HOME', 'BOARD_TOKEN', 'SPUR_SESSION'];
    expect(Object.keys(env).filter((name) => isScrubbed(name) && !own.includes(name))).toEqual([]);
    proxyFree(env);
  });
});

describe('board CLI', () => {
  it('resolves the source CLI entry point', () => {
    expect(BOARD_CLI.endsWith(join('packages', 'cli', 'src', 'bin.mjs'))).toBe(true);
    expect(existsSync(BOARD_CLI)).toBe(true);
  });

  it.each([['service', 'install'], ['update'], ['rollback'], ['skills', 'install']])(
    'refuses %s',
    (...args) => {
      expect(blockedBoardCommand(args)).toBeDefined();
    },
  );

  it('allows a board operation', () => {
    expect(blockedBoardCommand(['status', '--json'])).toBeUndefined();
  });
});
