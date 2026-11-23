import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, inject, it } from 'vitest';
import { isScrubbed } from '../src/env.ts';

// Written out by hand so a name dropped from isScrubbed still fails here.
const PLANTED = [
  'SPUR_SESSION',
  'BOARD_TOKEN',
  'SLACK_BOT_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'JIRA_API_TOKEN',
  'GBRAIN_DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'SOME_SERVICE_TOKEN',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'DBUS_SESSION_BUS_ADDRESS',
  'NOTIFY_SOCKET',
];

const atImport = { ...process.env };

describe('env scrub', () => {
  it('hides planted names at import time and at test time', () => {
    for (const name of PLANTED) {
      expect(atImport[name], name).toBeUndefined();
      expect(process.env[name], name).toBeUndefined();
    }
    expect(Object.keys(atImport).filter(isScrubbed)).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('keeps planted names out of the OS environ', () => {
    const entries = readFileSync('/proc/self/environ', 'utf8').split('\0');
    for (const name of PLANTED) {
      expect(
        entries.filter((entry) => entry.startsWith(`${name}=`)),
        name,
      ).toEqual([]);
    }
  });
});

describe('temp dirs', () => {
  it('points HOME, TMPDIR and XDG_* under the per-run root', () => {
    const root = `${inject('harnessRoot')}/`;
    expect(homedir().startsWith(root), homedir()).toBe(true);
    expect(tmpdir().startsWith(root), tmpdir()).toBe(true);
    expect(homedir()).not.toBe(userInfo().homedir);
    const xdg = Object.entries(process.env).filter(([name]) => name.startsWith('XDG_'));
    expect(xdg.length).toBeGreaterThan(0);
    for (const [name, value] of xdg) {
      expect(value?.startsWith(root), name).toBe(true);
    }
    expect(process.env['XDG_DATA_DIRS']).toBeUndefined();
  });

  it('records the Vitest main process as the owner of the per-run root', () => {
    const owner = JSON.parse(readFileSync(join(inject('harnessRoot'), 'owner.json'), 'utf8')) as {
      pid: number;
    };
    expect(owner.pid).toBe(process.ppid);
  });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launchDirs = [
  ...readdirSync(join(repoRoot, 'packages'))
    .filter((name) => existsSync(join(repoRoot, 'packages', name, 'test')))
    .map((name) => `packages/${name}`),
  'scripts',
];

function refusal(config: unknown): unknown {
  if (typeof config !== 'object' || config === null || !('plugins' in config)) return undefined;
  const { plugins } = config;
  if (!Array.isArray(plugins)) return undefined;
  const plugin: unknown = plugins[0];
  if (typeof plugin !== 'object' || plugin === null) return undefined;
  if (!('name' in plugin) || plugin.name !== 'testkit-root-only') return undefined;
  if (!('config' in plugin) || typeof plugin.config !== 'function') return undefined;
  try {
    plugin.config();
  } catch (error) {
    return error instanceof Error ? error.message : undefined;
  }
  return undefined;
}

describe('package-dir runs', () => {
  it('finds every package with tests', () => {
    expect(launchDirs).toContain('packages/core');
    expect(launchDirs).toContain('packages/skills');
  });

  it.each(launchDirs)('%s has a vitest.config.js that refuses the run', async (rel) => {
    const path = join(repoRoot, rel, 'vitest.config.js');
    expect(existsSync(path), path).toBe(true);
    const module: unknown = await import(pathToFileURL(path).href);
    const config =
      typeof module === 'object' && module !== null && 'default' in module
        ? module.default
        : undefined;
    const message = refusal(config);
    expect(typeof message, rel).toBe('string');
    const hint =
      rel === 'scripts' ? 'pnpm exec vitest run scripts/' : `pnpm exec vitest run ${rel}/test/`;
    expect(message).toMatch(/^testkit: /);
    expect(message).toContain(` ${rel} `);
    expect(message).toContain(hint);
    expect(message).not.toContain('--project');
  });
});

describe('service manager', () => {
  it.skipIf(process.platform !== 'linux')(
    'keeps systemctl --user away from the real user manager',
    (context) => {
      // Read-only probe: is-active never changes a unit.
      const result = spawnSync('systemctl', ['--user', 'is-active', 'spur-board.service'], {
        encoding: 'utf8',
      });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        context.skip('systemctl is not installed');
      }
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/^Failed to connect to /m);
      expect(result.stdout).not.toMatch(
        /^(active|inactive|activating|deactivating|failed|reloading)$/m,
      );
    },
  );
});

describe('network', () => {
  it('blocks a remote fetch', async () => {
    const error: unknown = await fetch('http://example.com/').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ cause: { code: 'ERR_TEST_NETWORK_BLOCKED' } });
  });

  it('blocks a remote http.get, also when a proxy was set', async () => {
    const error = await new Promise<unknown>((resolve) => {
      http
        .get('http://example.com/', () => {
          resolve(null);
        })
        .on('error', resolve);
    });
    expect(error).toMatchObject({ code: 'ERR_TEST_NETWORK_BLOCKED' });
  });
});
