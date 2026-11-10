import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { request } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { openStore } from '@spur-board/core';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { runCli, type CliIo } from '../../cli/src/cli.ts';
import { readManifest, standManifest, type StandManifest } from '../src/manifest.ts';
import { roleEnv, type StandRole } from '../src/roles.ts';
import { startStand, StandRefusedError, type Stand } from '../src/stand.ts';

const SOURCES = [
  'spur',
  'github-issues:stand:stand-org/board',
  'github:stand:stand-org/board',
  'jira:stand-jira',
  'github:stand-jira:stand-org/service',
].sort();

let base: string;
let root: string;
let osHome: string;
let stand: Stand | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stand-it-'));
  root = join(base, 'tmp');
  osHome = join(base, 'home');
  mkdirSync(root);
  mkdirSync(osHome);
  root = realpathSync(root);
});

afterEach(async () => {
  await stand?.stop();
  stand = undefined;
  rmSync(base, { recursive: true, force: true });
});

/** Listens on the first free stand port, so a stand asked to bind it fails to start. */
async function occupyStandPort(): Promise<{ port: number; close(): Promise<void> }> {
  for (let port = 4780; port <= 4799; port += 1) {
    const server = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => {
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        resolve(true);
      });
    });
    if (bound)
      return {
        port,
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      };
  }
  throw new Error('every stand port is taken');
}

async function up(): Promise<StandManifest> {
  stand = await startStand({ root, port: 0, env: {}, osHome });
  return stand.manifest();
}

async function control(
  manifest: StandManifest,
  route: string,
  body: unknown = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${manifest.controlUrl}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${manifest.controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(manifest: StandManifest, condition: string): Promise<void> {
  const result = await control(manifest, '/wait', { condition, timeoutMs: 20_000 });
  expect(result, JSON.stringify(result.body)).toMatchObject({ status: 200 });
}

async function instance(manifest: StandManifest): Promise<string | null> {
  const response = await fetch(`${manifest.daemonUrl}/v1/schema`);
  await response.body?.cancel();
  return response.headers.get('x-board-instance');
}

async function operatorStatus(
  manifest: StandManifest,
  role: StandRole = 'operator',
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await runCli(['status', '--json'], {
    env: roleEnv(manifest, role, {}),
    io,
  });
  return { code, stdout, stderr };
}

/** Raw control call, so the test sets Host, Origin and Authorization itself. */
function rawReset(manifest: StandManifest, headers: Record<string, string>): Promise<number> {
  const url = new URL(`${manifest.controlUrl}/reset`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

async function fingerprint(manifest: StandManifest) {
  const files = Object.fromEntries(
    ['config.yaml', 'secrets.env', 'token'].map((name) => [
      name,
      readFileSync(join(manifest.home, name), 'utf8'),
    ]),
  );
  const store = openStore(join(manifest.home, 'board.sqlite'));
  try {
    const tables = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.execute(store.db);
    const counts: Record<string, number> = {};
    for (const { name } of tables.rows) {
      const result = await sql<{
        n: number;
      }>`SELECT count(*) AS n FROM ${sql.table(name)}`.execute(store.db);
      counts[name] = result.rows[0]?.n ?? -1;
    }
    const sources = await store.db
      .selectFrom('source_state')
      .select(['source', 'blind_reason', 'initialized', 'last_complete_at', 'gone'])
      .orderBy('source')
      .execute();
    return { files, counts, sources };
  } finally {
    await store.close();
  }
}

describe('stand', () => {
  it.each([
    ['live_home', () => ({ env: { BOARD_HOME: root }, port: 0 })],
    ['live_port', () => ({ env: {}, port: 4777 })],
    ['port_range', () => ({ env: {}, port: 4800 })],
    ['external_secrets', () => ({ env: { GITHUB_TOKEN: 'real' }, port: 0 })],
    ['env_proxy', () => ({ env: { NODE_USE_ENV_PROXY: '1' }, port: 0 })],
  ])('refuses %s before creating anything', async (reason, input) => {
    const error: unknown = await startStand({ root, osHome, ...input() }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(StandRefusedError);
    expect((error as StandRefusedError).reason).toBe(reason);
    expect(readdirSync(root).filter((name) => name.startsWith('spur-board-stand.'))).toEqual([]);
  });

  it('removes the home it created when the daemon cannot start', async () => {
    const taken = await occupyStandPort();
    try {
      await expect(startStand({ root, port: taken.port, env: {}, osHome })).rejects.toThrow();
      expect(readdirSync(root).filter((name) => name.startsWith('spur-board-stand.'))).toEqual([]);
    } finally {
      await taken.close();
    }
  }, 60_000);

  it('keeps a home the caller passed when the daemon cannot start', async () => {
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    const taken = await occupyStandPort();
    try {
      await expect(startStand({ root, home, port: taken.port, env: {}, osHome })).rejects.toThrow();
      expect(readdirSync(root)).toEqual([basename(home)]);
    } finally {
      await taken.close();
    }
  }, 60_000);

  it('refuses a passed home holding files it did not create, without writing through links', async () => {
    const outside = join(base, 'live-config.yaml');
    writeFileSync(outside, 'live: true\n');
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    symlinkSync(outside, join(home, 'config.yaml'));
    await expect(startStand({ root, home, port: 0, env: {}, osHome })).rejects.toThrow(
      /did not create/,
    );
    expect(readFileSync(outside, 'utf8')).toBe('live: true\n');
    expect(readdirSync(home)).toEqual(['config.yaml']);
  });

  it('refuses a passed home whose spawn log is a symlink', async () => {
    const outside = join(base, 'outside.log');
    writeFileSync(outside, '');
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    mkdirSync(join(home, 'logs'));
    symlinkSync(outside, join(home, 'logs', 'stand.log'));
    await expect(startStand({ root, home, port: 0, env: {}, osHome })).rejects.toThrow(
      /did not create/,
    );
  });

  it.each([
    ['the home', 'home'],
    ['its logs directory', 'logs'],
  ])('refuses a passed home when %s is writable by others', async (_name, which) => {
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    mkdirSync(join(home, 'logs'), { mode: 0o700 });
    chmodSync(which === 'home' ? home : join(home, 'logs'), 0o777);
    await expect(startStand({ root, home, port: 0, env: {}, osHome })).rejects.toThrow(
      /not a stand directory|did not create/,
    );
    expect(readdirSync(join(home, 'logs'))).toEqual([]);
  });

  it('refuses a passed home that is the live board home', async () => {
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    const error: unknown = await startStand({
      root,
      home,
      port: 0,
      env: { BOARD_HOME: home },
      osHome,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StandRefusedError);
    expect((error as StandRefusedError).reason).toBe('live_home');
    expect(readdirSync(home)).toEqual([]);
  });

  it('starts on a passed home that holds only its spawn log', async () => {
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    mkdirSync(join(home, 'logs'), { mode: 0o700 });
    writeFileSync(join(home, 'logs', 'stand.log'), '', { mode: 0o600 });
    stand = await startStand({ root, home, port: 0, env: {}, osHome });
    expect(stand.manifest().home).toBe(realpathSync(home));
  }, 60_000);

  it('starts a stand', async () => {
    const manifest = await up();
    const { home } = manifest;
    expect(statSync(home).mode & 0o777).toBe(0o700);
    for (const name of ['stand.json', 'secrets.env', 'token'])
      expect(statSync(join(home, name)).mode & 0o777, name).toBe(0o600);
    expect(standManifest.parse(JSON.parse(readFileSync(join(home, 'stand.json'), 'utf8')))).toEqual(
      manifest,
    );
    const config: unknown = YAML.parse(readFileSync(join(home, 'config.yaml'), 'utf8'));
    expect(configSchema.safeParse(config).success).toBe(true);
    expect((await fetch(`${manifest.daemonUrl}/v1/schema`)).status).toBe(200);
  }, 60_000);

  it('leaves no source blind', async () => {
    const manifest = await up();
    await waitFor(manifest, 'sources-polled');
    const store = openStore(join(manifest.home, 'board.sqlite'));
    try {
      const rows = await store.db
        .selectFrom('source_state')
        .select(['source', 'blind_reason'])
        .execute();
      expect(rows.map((row) => row.source).sort()).toEqual(SOURCES);
      for (const row of rows) expect(row.blind_reason, row.source).toBeNull();
    } finally {
      await store.close();
    }
    const status = await operatorStatus(manifest);
    expect(status.code, status.stderr).toBe(0);
    const parsed = JSON.parse(status.stdout) as {
      sources: { source: string; blindReason: string | null }[];
    };
    expect(parsed.sources.map((source) => source.source).sort()).toEqual(SOURCES);
    for (const source of parsed.sources)
      expect(['config', 'auth']).not.toContain(source.blindReason);
  }, 60_000);

  it('rejects unauthenticated or foreign-host control calls', async () => {
    const manifest = await up();
    const before = await instance(manifest);
    const port = Number(new URL(manifest.controlUrl).port);
    const host = `127.0.0.1:${String(port)}`;
    const bearer = `Bearer ${manifest.controlToken}`;
    expect(await rawReset(manifest, { host })).toBe(401);
    expect(await rawReset(manifest, { host, authorization: 'Bearer wrong' })).toBe(401);
    expect(
      await rawReset(manifest, { host: `localhost:${String(port)}`, authorization: bearer }),
    ).toBe(403);
    expect(
      await rawReset(manifest, { host: `127.0.0.1:${String(port + 1)}`, authorization: bearer }),
    ).toBe(403);
    expect(await rawReset(manifest, { host, authorization: bearer, origin: 'http://evil' })).toBe(
      403,
    );
    expect(await instance(manifest)).toBe(before);
    await waitFor(manifest, 'api-ready');
  }, 60_000);

  it('reset equals a fresh start', async () => {
    const manifest = await up();
    await waitFor(manifest, 'sources-polled');
    const fresh = await fingerprint(manifest);
    const before = await instance(manifest);

    const request = await fetch(`${manifest.daemonUrl}/v1/tokens/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'extra',
        folder: '/work/extra',
        host: 'box',
        hash: createHash('sha256').update('extra').digest('hex'),
      }),
    });
    expect(request.ok, await request.text()).toBe(true);
    writeFileSync(join(manifest.home, 'config.yaml'), '# edited\n', { flag: 'a' });
    expect(await fingerprint(manifest)).not.toEqual(fresh);

    expect((await control(manifest, '/reset')).status).toBe(200);
    const after = stand?.manifest();
    if (after === undefined) throw new Error('stand stopped');
    expect(readManifest(after.home)).toEqual(after);
    await waitFor(after, 'sources-polled');
    expect(await fingerprint(after)).toEqual(fresh);
    expect(await instance(after)).not.toBe(before);
    expect((await operatorStatus(after)).code).toBe(0);
  }, 60_000);

  it('answers worker and orchestrator calls after up and after reset', async () => {
    const manifest = await up();
    // A Spur poll has failed against the guard by now; the seeded sessions must survive it.
    await waitFor(manifest, 'sources-polled');
    for (const role of ['worker', 'orchestrator'] as const) {
      const result = await operatorStatus(manifest, role);
      expect(result.code, `${role}: ${result.stderr}`).toBe(0);
    }
    expect((await control(manifest, '/reset')).status).toBe(200);
    const after = stand?.manifest();
    if (after === undefined) throw new Error('stand stopped');
    await waitFor(after, 'sources-polled');
    for (const role of ['worker', 'orchestrator'] as const) {
      const result = await operatorStatus(after, role);
      expect(result.code, `${role}: ${result.stderr}`).toBe(0);
    }
  }, 60_000);

  it('aborts reset and keeps every file when the daemon does not stop cleanly', async () => {
    // A board tick that never settles keeps the daemon from stopping within its timeout.
    stand = await startStand({
      root,
      port: 0,
      env: {},
      osHome,
      shutdownTimeoutMs: 300,
      tick: () => new Promise<void>(() => undefined),
    });
    const manifest = stand.manifest();
    await waitFor(manifest, 'api-ready');
    const files = ['config.yaml', 'secrets.env', 'token', 'board.sqlite'];
    const before = files.map((name) => statSync(join(manifest.home, name)).ino);
    const result = await control(manifest, '/reset');
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).toContain('did not stop cleanly');
    expect(await stand.exited).toBe(1);
    expect(files.map((name) => statSync(join(manifest.home, name)).ino)).toEqual(before);
  }, 60_000);

  it('poll reports every source', async () => {
    const manifest = await up();
    const polled = await control(manifest, '/poll');
    expect(polled.status).toBe(200);
    const { outcomes } = polled.body as { outcomes: { source: string; outcome: string }[] };
    // Every request fails against the network guard. The GitHub Issues adapter turns that failure
    // into an incomplete batch, so its poll counts as delivered; the others fail.
    expect(Object.fromEntries(outcomes.map(({ source, outcome }) => [source, outcome]))).toEqual({
      spur: 'failed',
      'github-issues:stand:stand-org/board': 'delivered',
      'github:stand:stand-org/board': 'failed',
      'jira:stand-jira': 'failed',
      'github:stand-jira:stand-org/service': 'failed',
    });
    expect(outcomes).toHaveLength(SOURCES.length);
    const unknown = await control(manifest, '/poll', { source: 'nope' });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { sources: string[] }).sources.sort()).toEqual(SOURCES);
  }, 60_000);
});
