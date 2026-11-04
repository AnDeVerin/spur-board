import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@spur-board/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeSlackApi } from '../../gateway-slack/test/fake-api.ts';
import { loadConfig, resolvePaths } from '../src/config.ts';
import { killDaemons, runDaemonToExit, spawnDaemon, waitForLine } from './daemon-process.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

afterEach(killDaemons);

const SLACK_CONFIG = `${VALID_CONFIG_YAML}slack:\n  channels:\n    orchestrators: C000000001\n    feed: C000000002\n`;

function httpPort(home: string): number {
  return loadConfig(resolvePaths({ BOARD_HOME: home }, home)).config.http.port;
}

async function queuedHome(apiUrl: string): Promise<string> {
  const home = makeHome({
    config: SLACK_CONFIG,
    secrets: `SLACK_BOT_TOKEN=xoxb-test\nSLACK_API_URL=${apiUrl}\n`,
  });
  const store = openStore(join(home, 'board.sqlite'));
  try {
    await store.transaction(async (trx) => {
      await trx
        .insertInto('outbox')
        .values({
          kind: 'feed.line',
          dedupe_key: 'feed.line:queued',
          payload: JSON.stringify({
            key: 'board#46',
            title: 'board#46 queued',
            text: 'queued delivery',
            persona: { name: 'worker', role: 'worker' },
            itemKey: 'queued',
          }),
          state: 'pending',
          next_at: new Date().toISOString(),
          last_error: null,
          external_ref: null,
          parent_outbox_id: null,
          first_attempt_at: null,
          first_delivery_at: null,
        })
        .execute();
    });
  } finally {
    await store.close();
  }
  return home;
}

async function deliveredState(home: string): Promise<string> {
  const store = openStore(join(home, 'board.sqlite'));
  try {
    const row = await store.db
      .selectFrom('outbox')
      .select('state')
      .where('dedupe_key', '=', 'feed.line:queued')
      .executeTakeFirstOrThrow();
    return row.state;
  } finally {
    await store.close();
  }
}

describe('daemon process', () => {
  it('invalid config exits 1 before creating the database', () => {
    const home = makeHome({
      config: VALID_CONFIG_YAML.replace('repo: example-org/board', 'repo: bad'),
    });
    const result = runDaemonToExit(home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('projects.0.tracker.repo');
    expect(result.stderr).toContain('hint:');
    expect(existsSync(join(home, 'board.sqlite'))).toBe(false);
  }, 30_000);

  it('fails clearly without flock', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'daemon-nopath-'));
    const result = runDaemonToExit(makeHome(), { PATH: emptyPath });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('flock from util-linux is required');
  }, 30_000);

  it('logs JSON, reaches ready and exits 0 on SIGTERM', async () => {
    const home = makeHome();
    const child = spawnDaemon(home);
    const ready = await waitForLine(child, 'daemon ready');
    expect(ready['level']).toBe(30);
    expect(existsSync(join(home, 'board.sqlite'))).toBe(true);

    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = (await exited) as [number | null, string | null];
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 30_000);

  it.each([false, true])(
    'serves the schema after main starts with Slack=%s',
    async (slack) => {
      const api = slack ? await startFakeSlackApi() : undefined;
      try {
        const home =
          slack && api !== undefined
            ? makeHome({
                config: SLACK_CONFIG,
                secrets: `SLACK_BOT_TOKEN=xoxb-test\nSLACK_API_URL=${api.url}\n`,
              })
            : makeHome();
        const child = spawnDaemon(home);
        await waitForLine(child, 'daemon ready');
        const response = await fetch(`http://127.0.0.1:${String(httpPort(home))}/v1/schema`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
        expect(await response.json()).toHaveProperty('version');
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const [code, signal] = (await exited) as [number | null, string | null];
        expect({ code, signal }).toEqual({ code: 0, signal: null });
      } finally {
        await api?.close();
      }
    },
    30_000,
  );

  it('rejects incomplete Slack settings before opening the database', () => {
    const home = makeHome({ secrets: 'SLACK_BOT_TOKEN=xoxb-test\n' });
    const result = runDaemonToExit(home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('slack.channels.orchestrators');
    expect(existsSync(join(home, 'board.sqlite'))).toBe(false);
  }, 30_000);

  it.each(['general', 'C_FEED', 'D000000001'])(
    'rejects invalid Slack channel ID %s before opening the database',
    (channel) => {
      const home = makeHome({
        config: `${VALID_CONFIG_YAML}slack:\n  channels:\n    orchestrators: C000000001\n    feed: ${channel}\n`,
        secrets: 'SLACK_BOT_TOKEN=xoxb-test\n',
      });
      const result = runDaemonToExit(home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('slack.channels.feed');
      expect(existsSync(join(home, 'board.sqlite'))).toBe(false);
    },
    30_000,
  );

  it('delivers a queued outbox row through the configured Slack API', async () => {
    const api = await startFakeSlackApi();
    try {
      const home = await queuedHome(api.url);
      const child = spawnDaemon(home);
      await waitForLine(child, 'daemon ready');
      await expect.poll(async () => (await api.platform.messages()).length).toBe(1);
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code, signal] = (await exited) as [number | null, string | null];
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(await deliveredState(home)).toBe('done');
      expect(
        api.requests().filter((request) => request.method === 'chat.postMessage'),
      ).toHaveLength(1);
    } finally {
      await api.close();
    }
  }, 30_000);

  it('waits for a held delivery on SIGTERM before closing the store', async () => {
    const api = await startFakeSlackApi();
    const hold = api.holdNextWrite();
    try {
      const home = await queuedHome(api.url);
      const child = spawnDaemon(home);
      const exited = once(child, 'exit');
      await waitForLine(child, 'daemon ready');
      await hold.entered;
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
      const duringStop = await fetch(`http://127.0.0.1:${String(httpPort(home))}/v1/schema`);
      expect(duringStop.status).toBe(503);
      expect(await duringStop.json()).toMatchObject({ code: 'starting' });
      hold.release();
      const [code, signal] = (await exited) as [number | null, string | null];
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(await deliveredState(home)).toBe('done');
    } finally {
      hold.release();
      await api.close();
    }
  }, 30_000);

  it('records a timed-out delivery before the shutdown deadline', async () => {
    const api = await startFakeSlackApi();
    const hold = api.holdNextWrite();
    try {
      const home = await queuedHome(api.url);
      const child = spawnDaemon(home);
      const exited = once(child, 'exit');
      await waitForLine(child, 'daemon ready');
      await hold.entered;
      const stoppedAt = Date.now();
      child.kill('SIGTERM');
      const [code, signal] = (await exited) as [number | null, string | null];
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(Date.now() - stoppedAt).toBeLessThan(9_000);
      expect(await deliveredState(home)).toBe('pending');
    } finally {
      hold.release();
      await api.close();
    }
  }, 30_000);

  it('purges expired command keys at start', async () => {
    const home = makeHome({ config: VALID_CONFIG_YAML + 'commands:\n  retentionDays: 2\n' });
    const file = join(home, 'board.sqlite');
    const day = 86_400_000;
    const seeded = openStore(file);
    await seeded.transaction(async (trx) => {
      for (const [key, age] of [
        ['old', 3 * day],
        ['recent', day],
      ] as const) {
        await trx
          .insertInto('command')
          .values({
            actor: 'operator',
            key,
            operation: 'test.touch',
            fingerprint: null,
            result: '{}',
            at: new Date(Date.now() - age).toISOString(),
          })
          .execute();
      }
    });
    await seeded.close();

    const child = spawnDaemon(home);
    await waitForLine(child, 'daemon ready');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = (await exited) as [number | null, string | null];
    expect({ code, signal }).toEqual({ code: 0, signal: null });

    const reopened = openStore(file);
    const rows = await reopened.db.selectFrom('command').select('key').execute();
    await reopened.close();
    expect(rows).toEqual([{ key: 'recent' }]);
  }, 30_000);
});
