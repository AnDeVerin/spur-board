import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@spur-board/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeSlackApi } from '../../gateway-slack/test/fake-api.ts';
import { killDaemons, runDaemonToExit, spawnDaemon, waitForLine } from './daemon-process.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

afterEach(killDaemons);

const SLACK_CONFIG = `${VALID_CONFIG_YAML}slack:\n  channels:\n    orchestrators: C_ORCHESTRATORS\n    feed: C_FEED\n`;

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

  it('rejects incomplete Slack settings before opening the database', () => {
    const home = makeHome({ secrets: 'SLACK_BOT_TOKEN=xoxb-test\n' });
    const result = runDaemonToExit(home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('slack.channels.orchestrators');
    expect(existsSync(join(home, 'board.sqlite'))).toBe(false);
  }, 30_000);

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
      hold.release();
      const [code, signal] = (await exited) as [number | null, string | null];
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(await deliveredState(home)).toBe('done');
    } finally {
      hold.release();
      await api.close();
    }
  }, 30_000);
});
