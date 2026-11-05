import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHome, VALID_CONFIG_YAML } from '../packages/daemon/test/home.ts';
import {
  formatLiveReport,
  liveSettings,
  selectedLiveCases,
  verifyLiveChannel,
} from './smoke-live.ts';

const script = join(import.meta.dirname, 'smoke-live.ts');
const homes: string[] = [];

function home(options: Parameters<typeof makeHome>[0]): string {
  const path = makeHome(options);
  homes.push(path);
  return path;
}

function run(
  env: Record<string, string>,
  args: readonly string[] = [],
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('live conformance process preflight', () => {
  it('refuses CI before reading config or connecting', () => {
    const result = run({ CI: 'true', BOARD_HOME: '/missing', BOARD_LIVE_CHANNEL: 'CTEST00000' }, [
      '--case',
      'guided-mention',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Live conformance is disabled in CI.');
    expect(result.stderr).not.toContain('/missing');
  });

  it('requires an environment channel before loading local secrets', async () => {
    await expect(liveSettings({ BOARD_HOME: '/missing' })).rejects.toThrow(/BOARD_LIVE_CHANNEL/);
    await expect(
      liveSettings({ BOARD_HOME: '/missing', BOARD_LIVE_CHANNEL: 'CTEST00000' }),
    ).rejects.toThrow(/BOARD_LIVE_CHANNEL_NAME/);
  });

  it('rejects configured destinations without exposing the channel or tokens', async () => {
    const testHome = home({
      config: `${VALID_CONFIG_YAML}\nslack:\n  channels:\n    feed: CTEST00000`,
      secrets: 'SLACK_BOT_TOKEN=bot-secret-canary\nSLACK_APP_TOKEN=app-secret-canary\n',
    });
    const settings = liveSettings({
      BOARD_HOME: testHome,
      BOARD_LIVE_CHANNEL: 'CTEST00000',
      BOARD_LIVE_CHANNEL_NAME: 'conformance-test',
    });
    await expect(settings).rejects.toThrow(
      /^The test channel must differ from configured destinations\.$/,
    );
  });

  it('rejects missing tokens and API overrides before any network call', async () => {
    const testHome = home({ secrets: 'SLACK_BOT_TOKEN=bot-secret-canary\n' });
    const env = {
      BOARD_HOME: testHome,
      BOARD_LIVE_CHANNEL: 'CTEST00000',
      BOARD_LIVE_CHANNEL_NAME: 'conformance-test',
    };
    await expect(liveSettings(env)).rejects.toThrow(/both Slack tokens/);
    await expect(
      liveSettings({ ...env, SLACK_API_URL: 'http://127.0.0.1:1/api/' }),
    ).rejects.toThrow(/API URL overrides/);
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('bot-secret-canary');
  });

  it('refuses non-interactive input before a live connection', () => {
    const testHome = home({
      secrets: 'SLACK_BOT_TOKEN=bot-secret-canary\nSLACK_APP_TOKEN=app-secret-canary\n',
    });
    const sentinel = join(testHome, 'network-attempted');
    const preload = join(testHome, 'block-network.cjs');
    writeFileSync(
      preload,
      "const net = require('node:net'); const fs = require('node:fs'); net.Socket.prototype.connect = function () { fs.writeFileSync(process.env.BOARD_NETWORK_SENTINEL, 'attempt'); throw new Error('network blocked'); };",
    );
    const result = run({
      BOARD_HOME: testHome,
      BOARD_LIVE_CHANNEL: 'CTEST00000',
      BOARD_LIVE_CHANNEL_NAME: 'conformance-test',
      BOARD_NETWORK_SENTINEL: sentinel,
      NODE_OPTIONS: `--require=${preload}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('interactive terminal');
    expect(existsSync(sentinel)).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('CTEST00000');
    expect(result.stdout + result.stderr).not.toContain('conformance-test');
    expect(result.stdout + result.stderr).not.toContain('bot-secret-canary');
  });

  it('refuses non-interactive input before reading local config or secrets', () => {
    const testHome = home({ config: null });
    const sentinel = join(testHome, 'network-attempted');
    const preload = join(testHome, 'block-network.cjs');
    writeFileSync(
      preload,
      "const net = require('node:net'); const fs = require('node:fs'); net.Socket.prototype.connect = function () { fs.writeFileSync(process.env.BOARD_NETWORK_SENTINEL, 'attempt'); throw new Error('network blocked'); };",
    );
    const result = run({
      BOARD_HOME: testHome,
      BOARD_LIVE_CHANNEL: 'CTEST00000',
      BOARD_LIVE_CHANNEL_NAME: 'conformance-test',
      BOARD_NETWORK_SENTINEL: sentinel,
      NODE_OPTIONS: `--require=${preload}`,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Live conformance requires an interactive terminal.\n');
    expect(existsSync(sentinel)).toBe(false);
    expect(result.stderr).not.toContain(testHome);
  });

  it('requires an exact private channel metadata match', async () => {
    const settings = { channel: 'CTEST00000', channelName: 'conformance-test' };
    const channel = {
      id: settings.channel,
      name: settings.channelName,
      is_private: true,
      is_im: false,
      is_mpim: false,
      is_member: true,
      is_shared: false,
      is_ext_shared: false,
      is_archived: false,
    };
    const lookup = vi.fn(() => Promise.resolve({ ok: true, channel }));
    await expect(verifyLiveChannel(settings, lookup)).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(settings.channel);
    for (const mismatch of [
      { name: 'another-channel' },
      { id: 'CANOTHER00' },
      { is_private: false },
      { is_im: true },
      { is_mpim: true },
      { is_member: false },
      { is_shared: true },
      { is_shared: true, is_org_shared: true },
      { is_ext_shared: true },
      { is_archived: true },
    ]) {
      await expect(
        verifyLiveChannel(settings, () =>
          Promise.resolve({ ok: true, channel: { ...channel, ...mismatch } }),
        ),
      ).rejects.toThrow('The live channel must match the designated private test channel.');
    }
    for (const flag of [
      'is_private',
      'is_im',
      'is_mpim',
      'is_member',
      'is_shared',
      'is_ext_shared',
      'is_archived',
    ]) {
      const incomplete = Object.fromEntries(
        Object.entries(channel).filter(([key]) => key !== flag),
      );
      await expect(
        verifyLiveChannel(settings, () => Promise.resolve({ ok: true, channel: incomplete })),
      ).rejects.toThrow('The live channel must match the designated private test channel.');
    }
    await expect(
      verifyLiveChannel(settings, () => Promise.resolve({ ok: false, channel })),
    ).rejects.toThrow('The live channel must match the designated private test channel.');
  });

  it('formats a complete safe report with declared SDK versions', () => {
    const output = formatLiveReport({
      date: '2026-11-05',
      results: [{ id: 'delivery', status: 'pass', observation: 'delivery confirmed' }],
      rateLimit: { status: 'not-run', observation: 'No incidental 429 observed.' },
    });
    expect(output).toContain('2026-11-05');
    expect(output).toContain('@slack/web-api 8.2.0');
    expect(output).toContain('@slack/socket-mode 3.1.0');
    expect(output).toContain('PASS delivery');
    expect(output).toContain('NOT RUN rate-limit');
  });

  it('selects only the guided mention for a focused rerun', () => {
    expect(selectedLiveCases([])).toBeUndefined();
    expect(selectedLiveCases(['--case', 'guided-mention'])).toEqual(['guided-mention']);
    expect(() => selectedLiveCases(['--case', 'rate-limit'])).toThrow(/focused live run/);
    expect(() => selectedLiveCases(['--case', 'guided-mention', 'delivery'])).toThrow(
      /focused live run/,
    );
  });
});
