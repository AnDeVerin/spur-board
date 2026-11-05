import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHome, VALID_CONFIG_YAML } from '../packages/daemon/test/home.ts';
import { formatLiveReport, liveSettings } from './smoke-live.ts';

const script = join(import.meta.dirname, 'smoke-live.ts');
const homes: string[] = [];

function home(options: Parameters<typeof makeHome>[0]): string {
  const path = makeHome(options);
  homes.push(path);
  return path;
}

function run(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [script], {
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
    const result = run({ CI: 'true', BOARD_HOME: '/missing', BOARD_LIVE_CHANNEL: 'CTEST00000' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Live conformance is disabled in CI.');
    expect(result.stderr).not.toContain('/missing');
  });

  it('requires an environment channel before loading local secrets', async () => {
    await expect(liveSettings({ BOARD_HOME: '/missing' })).rejects.toThrow(/BOARD_LIVE_CHANNEL/);
  });

  it('rejects configured destinations without printing the channel or tokens', () => {
    const testHome = home({
      config: `${VALID_CONFIG_YAML}\nslack:\n  channels:\n    feed: CTEST00000`,
      secrets: 'SLACK_BOT_TOKEN=bot-secret-canary\nSLACK_APP_TOKEN=app-secret-canary\n',
    });
    const result = run({ BOARD_HOME: testHome, BOARD_LIVE_CHANNEL: 'CTEST00000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('test channel must differ');
    expect(result.stdout + result.stderr).not.toContain('CTEST00000');
    expect(result.stdout + result.stderr).not.toContain('bot-secret-canary');
    expect(result.stdout + result.stderr).not.toContain('app-secret-canary');
  });

  it('rejects missing tokens and API overrides before any network call', async () => {
    const testHome = home({ secrets: 'SLACK_BOT_TOKEN=bot-secret-canary\n' });
    const env = { BOARD_HOME: testHome, BOARD_LIVE_CHANNEL: 'CTEST00000' };
    await expect(liveSettings(env)).rejects.toThrow(/both Slack tokens/);
    await expect(
      liveSettings({ ...env, SLACK_API_URL: 'http://127.0.0.1:1/api/' }),
    ).rejects.toThrow(/API URL overrides/);
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('bot-secret-canary');
  });

  it('formats a complete safe report with declared SDK versions', () => {
    const output = formatLiveReport({
      date: '2026-11-05',
      results: [
        { id: 'delivery', status: 'pass', observation: 'delivery confirmed' },
        { id: 'rate-limit', status: 'fail', observation: '429 not observed' },
      ],
    });
    expect(output).toContain('2026-11-05');
    expect(output).toContain('@slack/web-api 8.2.0');
    expect(output).toContain('@slack/socket-mode 3.1.0');
    expect(output).toContain('PASS delivery');
    expect(output).toContain('FAIL rate-limit');
  });
});
