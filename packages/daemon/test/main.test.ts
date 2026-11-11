import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, requestToken } from '@spur-board/core';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { startFakeSlackApi } from '@spur-board/gateway-slack/testing';
import { loadConfig, resolvePaths } from '../src/config.ts';
import { acquireLock } from '../src/lock.ts';
import { copyDatabaseMain, publishedVersion } from '../src/main.ts';
import { killDaemons, runDaemonToExit, spawnDaemon, waitForLine } from './daemon-process.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

afterEach(killDaemons);

const SLACK_CONFIG = `${VALID_CONFIG_YAML}slack:\n  channels:\n    orchestrators: C000000001\n    feed: C000000002\n`;
const BOARD_CLI = fileURLToPath(new URL('../../cli/src/bin.mjs', import.meta.url));

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
  it('uses the publishable package version for daemon diagnostics and live announcements', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(publishedVersion()).toBe(manifest.version);
  });
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
    const health = await fetch(`http://127.0.0.1:${String(httpPort(home))}/v1/health`);
    expect(health.status).toBe(200);
    expect(typeof ((await health.json()) as { firstPollDone: unknown }).firstPollDone).toBe(
      'boolean',
    );

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

  it('routes board status and board ask through the daemon registry', async () => {
    const config = VALID_CONFIG_YAML.replace(
      'operatorGithubLogin: octocat\n',
      'operatorGithubLogin: octocat\n    spurProjects:\n      - name: worker\n        role: worker\n',
    );
    const home = makeHome({ config });
    const store = openStore(join(home, 'board.sqlite'));
    const at = new Date().toISOString();
    try {
      await store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            project: 'board',
            tracker_kind: 'github-issues',
            tracker_id: '101',
            key: 'example-org/board#101',
            membership: 'active',
            archive_reason: null,
            column: 'todo',
            shadow_column: null,
            created_at: at,
            last_change_at: at,
            terminal_at: null,
            archive_slot_at: null,
          })
          .execute();
        await trx
          .insertInto('session_snapshot')
          .values({
            id: 'session-1',
            spur_project: 'worker',
            branch: null,
            pr: null,
            raw_state: 'running',
            state: 'running',
            first_seen: at,
            last_seen: at,
            ended_at: null,
            end_reason: null,
            detail: JSON.stringify({
              id: 'session-1',
              spurProject: 'worker',
              branch: null,
              pr: null,
              links: {},
              lifecycle: 'running',
              health: 'working',
              healthSince: at,
              lastActivityAt: null,
              endedAt: null,
              endReason: null,
            }),
            source: 'spur',
            observed_at: at,
          })
          .execute();
        await trx
          .insertInto('block')
          .values({
            id: 1,
            task_id: 1,
            type: 'code',
            reason: 'Inspect checks',
            author: 'operator',
            addressee_role: 'operator',
            target_column: null,
            state: 'open',
            outcome: null,
            outcome_reason: null,
            repeat_of: null,
            unblocked_by: null,
            unblocked_at: null,
            created_at: at,
          })
          .execute();
        await trx
          .insertInto('event')
          .values({
            at,
            project: 'board',
            task_id: 1,
            kind: 'task_added',
            actor: 'system',
            actor_ref: null,
            payload: '{}',
            v: 1,
            request_id: null,
          })
          .execute();
      });
      const token = 'test-query-token';
      await requestToken(
        store,
        loadConfig(resolvePaths({ BOARD_HOME: home }, home)).config,
        {
          name: 'daemon-cli',
          folder: 'workspace/daemon',
          host: 'local',
          hash: createHash('sha256').update(token).digest('hex'),
        },
        new Date(at),
      );
      await store.transaction((trx) =>
        trx
          .updateTable('operator_token')
          .set({ status: 'approved', decided_at: at })
          .where('name', '=', 'daemon-cli')
          .execute(),
      );
    } finally {
      await store.close();
    }
    const child = spawnDaemon(home);
    try {
      await waitForLine(child, 'daemon ready');
      const env = {
        ...process.env,
        BOARD_DAEMON_URL: `http://127.0.0.1:${String(httpPort(home))}`,
        SPUR_SESSION: 'session-1',
      };
      const status = spawnSync(process.execPath, [BOARD_CLI, 'status', '--json'], {
        env,
        encoding: 'utf8',
      });
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        tasks: [{ key: 'example-org/board#101' }],
      });
      const schema = spawnSync(process.execPath, [BOARD_CLI, 'schema', '--json'], {
        env,
        encoding: 'utf8',
      });
      expect(schema.status, schema.stderr).toBe(0);
      const schemaResult = JSON.parse(schema.stdout) as {
        version: string;
        operations: { id: string }[];
      };
      expect(schemaResult.version).toMatch(/^[0-9a-f]{64}$/);
      expect(schemaResult.operations.map((operation) => operation.id)).toContain('status.get');
      const ask = spawnSync(
        process.execPath,
        [BOARD_CLI, 'ask', 'example-org/board#101', 'Which version?', '--key', 'ask-1', '--json'],
        { env, encoding: 'utf8' },
      );
      expect(ask.status, ask.stderr).toBe(0);
      expect(JSON.parse(ask.stdout)).toMatchObject({
        block: { task: 'example-org/board#101', reason: 'Which version?' },
      });
      const operatorEnv = { ...env, SPUR_SESSION: '', BOARD_TOKEN: 'test-query-token' };
      const task = spawnSync(
        process.execPath,
        [BOARD_CLI, 'task', 'example-org/board#101', '--json'],
        {
          env: operatorEnv,
          encoding: 'utf8',
        },
      );
      expect(task.status, task.stderr).toBe(0);
      expect(JSON.parse(task.stdout)).toMatchObject({
        task: { key: 'example-org/board#101' },
        blocks: [{ id: 'B1' }, { id: 'B2' }],
      });
      const history = spawnSync(
        process.execPath,
        [BOARD_CLI, 'task', 'history', 'example-org/board#101', '--json'],
        {
          env: operatorEnv,
          encoding: 'utf8',
        },
      );
      expect(history.status, history.stderr).toBe(0);
      const historyOutput = JSON.parse(history.stdout) as {
        task: { key: string };
        events: { kind: string }[];
      };
      expect(historyOutput.task.key).toBe('example-org/board#101');
      const eventKinds = historyOutput.events.map((event) => event.kind);
      // Startup may raise an operator item for the seeded block before this query.
      expect(eventKinds.filter((kind) => kind !== 'from_you_raised')).toEqual([
        'task_added',
        'block_opened',
        'comment_added',
      ]);
      expect(eventKinds.filter((kind) => kind === 'from_you_raised').length).toBeLessThanOrEqual(1);
      const inbox = spawnSync(process.execPath, [BOARD_CLI, 'inbox', '--json'], {
        env: operatorEnv,
        encoding: 'utf8',
      });
      expect(inbox.status, inbox.stderr).toBe(0);
      expect(JSON.parse(inbox.stdout)).toMatchObject({ blocks: [{ id: 'B1' }, { id: 'B2' }] });
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }, 30_000);

  it('serves token list and revoke through the production operation registry', async () => {
    const home = makeHome();
    const file = join(home, 'board.sqlite');
    const secret = 'test-operator-token';
    const at = new Date();
    const seeded = openStore(file);
    try {
      await requestToken(
        seeded,
        loadConfig(resolvePaths({ BOARD_HOME: home }, home)).config,
        {
          name: 'desk',
          folder: 'workspace/desk',
          host: 'local',
          hash: createHash('sha256').update(secret).digest('hex'),
        },
        at,
      );
      await seeded.transaction((trx) =>
        trx
          .updateTable('operator_token')
          .set({ status: 'approved', decided_at: at.toISOString() })
          .where('name', '=', 'desk')
          .execute(),
      );
    } finally {
      await seeded.close();
    }
    const child = spawnDaemon(home);
    try {
      await waitForLine(child, 'daemon ready');
      const url = `http://127.0.0.1:${String(httpPort(home))}/v1/ops/`;
      const call = (operation: string, input: object) =>
        fetch(`${url}${operation}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({ input }),
        });
      const listed = await call('token.list', {});
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        value: { tokens: [{ name: 'desk', folder: 'workspace/desk', status: 'approved' }] },
      });
      const revoked = await call('token.revoke', { name: 'desk' });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ value: { name: 'desk', status: 'revoked' } });
      const rejected = await call('token.list', {});
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: 'forbidden' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  }, 30_000);

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

  it('logs once when Slack delivery is configured without an app token', async () => {
    const api = await startFakeSlackApi();
    try {
      const home = await queuedHome(api.url);
      const child = spawnDaemon(home);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      await waitForLine(child, 'daemon ready');
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      const lines = output.split('\n').flatMap((line) => {
        if (line === '') return [];
        return [JSON.parse(line) as Record<string, unknown>];
      });
      expect(
        lines.filter((line) => line['msg'] === 'Slack inbound disabled: SLACK_APP_TOKEN is absent'),
      ).toHaveLength(1);
    } finally {
      await api.close();
    }
  }, 30_000);

  it('delivers Spur doorbells without Slack and leaves gateway rows pending', async () => {
    const sends: { session: string; body: unknown }[] = [];
    const spurApi = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const match = /^\/sessions\/([^/]+)\/send$/.exec(req.url ?? '');
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && match?.[1] !== undefined) {
          const session = decodeURIComponent(match[1]);
          sends.push({ session, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          res.end(JSON.stringify({ id: session }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `Route not found: ${req.method ?? ''} ${req.url ?? ''}` }));
      });
    });
    onTestFinished(() => {
      spurApi.close();
    });
    spurApi.listen(0, '127.0.0.1');
    await once(spurApi, 'listening');
    const { port } = spurApi.address() as AddressInfo;
    const home = makeHome({
      config: `${VALID_CONFIG_YAML}adapters:\n  spur:\n    baseUrl: http://127.0.0.1:${String(port)}\n`,
    });
    const store = openStore(join(home, 'board.sqlite'));
    await store.transaction(async (trx) => {
      for (const [kind, key, payload] of [
        [
          'doorbell',
          'doorbell:test',
          { session: 'worker-1', text: 'o/r#101 block B1: check board inbox' },
        ],
        [
          'feed.line',
          'feed.line:test',
          {
            key: 'o/r#101',
            title: 'Test',
            text: 'pending',
            persona: { name: 'board', role: 'board' },
            itemKey: 'test',
          },
        ],
      ] as const) {
        await trx
          .insertInto('outbox')
          .values({
            kind,
            dedupe_key: key,
            payload: JSON.stringify(payload),
            state: 'pending',
            next_at: new Date().toISOString(),
            last_error: null,
            external_ref: null,
            parent_outbox_id: null,
            first_attempt_at: null,
            first_delivery_at: null,
          })
          .execute();
      }
    });
    await store.close();
    // The systemd user manager's PATH has no ~/.local/bin, where Spur installs its CLI.
    const child = spawnDaemon(home, { PATH: '/usr/bin:/bin' });
    await waitForLine(child, 'daemon ready');
    await expect.poll(() => sends.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect((await exited)[0]).toBe(0);
    expect(sends).toEqual([
      { session: 'worker-1', body: { message: 'o/r#101 block B1: check board inbox' } },
    ]);
    const result = openStore(join(home, 'board.sqlite'));
    try {
      const rows = await result.db
        .selectFrom('outbox')
        .select(['kind', 'state', 'payload'])
        .execute();
      expect(
        rows.filter((row) => row.kind === 'doorbell').map(({ kind, state }) => ({ kind, state })),
      ).toEqual([{ kind: 'doorbell', state: 'done' }]);
      expect(
        rows
          .filter((row) => row.kind === 'feed.line')
          .map((row) => ({
            state: row.state,
            itemKey: (JSON.parse(row.payload) as { itemKey: string }).itemKey,
          }))
          .sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
      ).toEqual([
        { state: 'pending', itemKey: 'source:github-issues:board:example-org/board' },
        { state: 'pending', itemKey: 'source:github:board:example-org/board' },
        { state: 'pending', itemKey: 'test' },
      ]);
    } finally {
      await result.close();
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
      child.kill('SIGTERM');
      const [code, signal] = (await exited) as [number | null, string | null];
      expect({ code, signal }).toEqual({ code: 0, signal: null });
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

describe('copyDatabaseMain', () => {
  async function boardHome(): Promise<{ home: string; dbFile: string; backup: string }> {
    const home = mkdtempSync(join(tmpdir(), 'daemon-copy-'));
    const dbFile = join(home, 'board.sqlite');
    const store = openStore(dbFile);
    await store.db.insertInto('meta').values({ key: 'copy_probe', value: '"kept"' }).execute();
    await store.close();
    return {
      home,
      dbFile,
      backup: join(mkdtempSync(join(tmpdir(), 'daemon-backup-')), 'b.sqlite'),
    };
  }

  async function probe(file: string): Promise<string | undefined> {
    const store = openStore(file);
    try {
      const row = await store.db
        .selectFrom('meta')
        .select('value')
        .where('key', '=', 'copy_probe')
        .executeTakeFirst();
      return row?.value;
    } finally {
      await store.close();
    }
  }

  it('D1: refuses relative paths and copies that do not touch the board database', async () => {
    const { home, dbFile, backup } = await boardHome();
    const errors: string[] = [];
    const run = (args: string[]) =>
      copyDatabaseMain(args, { BOARD_HOME: home }, home, (text) => errors.push(text));
    const other = join(home, 'other.sqlite');

    expect(run([other, backup])).toBe(2);
    expect(run(['board.sqlite', backup])).toBe(2);
    expect(run([dbFile, 'b.sqlite'])).toBe(2);
    expect(run([dbFile])).toBe(2);
    expect(errors.join('')).toContain(dbFile);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(join(home, 'board.lock'))).toBe(false);
  });

  it('D2: exits 75 with the holder PID while another holder has the board lock', async () => {
    const { home, dbFile, backup } = await boardHome();
    const lock = acquireLock(join(home, 'board.lock'));
    onTestFinished(() => {
      lock.release();
    });
    const errors: string[] = [];

    const code = copyDatabaseMain([dbFile, backup], { BOARD_HOME: home }, home, (text) =>
      errors.push(text),
    );

    expect(code).toBe(75);
    expect(errors.join('')).toContain(`PID ${String(process.pid)}`);
    expect(existsSync(backup)).toBe(false);
  });

  it('D3: copies the board database under the lock and releases it', async () => {
    const { home, dbFile, backup } = await boardHome();
    const errors: string[] = [];

    const code = copyDatabaseMain([dbFile, backup], { BOARD_HOME: home }, home, (text) =>
      errors.push(text),
    );

    expect({ code, errors }).toEqual({ code: 0, errors: [] });
    expect(await probe(backup)).toBe('"kept"');
    expect(readdirSync(join(backup, '..')).filter((name) => name.endsWith('.partial'))).toEqual([]);
    acquireLock(join(home, 'board.lock')).release();
  });

  it('D4: accepts the absolute database path when HOME or BOARD_HOME is relative', async () => {
    // Relative to the worker's cwd: vitest workers cannot chdir.
    const { home, dbFile, backup } = await boardHome();
    const errors: string[] = [];
    const fromBoardHome = copyDatabaseMain(
      [dbFile, backup],
      { BOARD_HOME: relative(process.cwd(), home) },
      home,
      (text) => errors.push(text),
    );
    const userHome = mkdtempSync(join(tmpdir(), 'daemon-home-'));
    const dataDir = join(userHome, '.local', 'share', 'spur-board');
    mkdirSync(dataDir, { recursive: true });
    const fromHome = copyDatabaseMain(
      [backup, join(dataDir, 'board.sqlite')],
      {},
      relative(process.cwd(), userHome),
      (text) => errors.push(text),
    );

    expect({ fromBoardHome, fromHome, errors }).toEqual({
      fromBoardHome: 0,
      fromHome: 0,
      errors: [],
    });
    expect(await probe(join(dataDir, 'board.sqlite'))).toBe('"kept"');
  });
});
