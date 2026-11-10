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
import { configSchema, type PrFacts } from '@spur-board/contracts';
import { openStore } from '@spur-board/core';
import { acquireLock } from '@spur-board/daemon/in-process';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // Private, so the umask cannot make the root group-writable.
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(osHome);
  root = realpathSync(root);
});

/** Whether shutdown has begun; a stand already stopping no longer answers `/fake`. */
async function isStopping(current: Stand): Promise<boolean> {
  return Promise.race([
    current.stopping.then(() => true),
    new Promise<boolean>((resolve) => {
      setImmediate(resolve, false);
    }),
  ]);
}

afterEach(async () => {
  try {
    // The runner swallows a violation's 400, so only the log shows an unknown request.
    if (stand !== undefined && !(await isStopping(stand))) {
      const log = await control(stand.manifest(), '/fake', { action: 'violations' });
      expect(log, JSON.stringify(log.body)).toMatchObject({ status: 200 });
    }
  } finally {
    await stand?.stop();
    stand = undefined;
    rmSync(base, { recursive: true, force: true });
  }
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

/** The database and the WAL and SHM files SQLite keeps beside it are owner-only. */
function expectPrivateDatabase(home: string): void {
  const files = readdirSync(home).filter((name) => name.startsWith('board.sqlite'));
  expect(files).toContain('board.sqlite');
  expect(files).toContain('board.sqlite-wal');
  for (const name of files) expect(statSync(join(home, name)).mode & 0o777, name).toBe(0o600);
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
    return {
      files,
      counts,
      // A source that completed a poll holds that poll's time; only whether it did can repeat.
      sources: sources.map(({ last_complete_at, ...source }) => ({
        ...source,
        completed: last_complete_at !== null,
      })),
    };
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
    [
      'unsafe_root',
      () => {
        chmodSync(root, 0o777);
        return { env: {}, port: 0 };
      },
    ],
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
    ['the home is writable by others', 'home', 0o777, /not a stand directory/],
    ['the home is readable by others', 'home', 0o755, /not a stand directory/],
    ['its logs directory is writable by others', 'logs', 0o777, /did not create/],
    ['its logs directory is readable by others', 'logs', 0o750, /did not create/],
  ])('refuses a passed home when %s', async (_name, which, mode, message) => {
    const home = mkdtempSync(join(root, 'spur-board-stand.'));
    mkdirSync(join(home, 'logs'), { mode: 0o700 });
    chmodSync(which === 'home' ? home : join(home, 'logs'), mode);
    await expect(startStand({ root, home, port: 0, env: {}, osHome })).rejects.toThrow(message);
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
    expectPrivateDatabase(home);
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
    expectPrivateDatabase(after.home);
    expect(await instance(after)).not.toBe(before);
    expect((await operatorStatus(after)).code).toBe(0);
  }, 60_000);

  it('gives each stand its own random role sessions and keeps them across reset', async () => {
    const first = await up();
    const other = await startStand({ root, port: 0, env: {}, osHome });
    try {
      for (const role of ['worker', 'orchestrator'] as const) {
        expect(first.roles[role]).toMatch(/^stand-(worker|qa)-[0-9a-f]{24}$/);
        expect(other.manifest().roles[role]).not.toBe(first.roles[role]);
      }
    } finally {
      await other.stop();
    }
    expect((await control(first, '/reset')).status).toBe(200);
    expect(stand?.manifest().roles).toEqual(first.roles);
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

  it('aborts reset, keeps every file and waits for the old daemon to let go', async () => {
    // A board tick that stalls until released keeps the daemon from stopping within its timeout.
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Released in finally too, so a failed assertion cannot leave afterEach waiting on it.
    try {
      stand = await startStand({
        root,
        port: 0,
        env: {},
        osHome,
        shutdownTimeoutMs: 300,
        tick: () => stalled,
      });
      const current = stand;
      const manifest = current.manifest();
      await waitFor(manifest, 'api-ready');
      const files = ['config.yaml', 'secrets.env', 'token', 'board.sqlite'];
      const before = files.map((name) => statSync(join(manifest.home, name)).ino);
      const result = await control(manifest, '/reset');
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.body)).toContain('did not stop cleanly');
      expect(files.map((name) => statSync(join(manifest.home, name)).ino)).toEqual(before);

      // A failed reset starts the stand's own shutdown: `stopping` reports it before `exited`.
      await current.stopping;
      // The old daemon still tears down: the stand has not exited and the lock is still held.
      let exited: number | undefined;
      void current.exited.then((code) => {
        exited = code;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(exited).toBeUndefined();
      expect(() => acquireLock(join(manifest.home, 'board.lock'))).toThrow();

      release();
      expect(await current.exited).toBe(1);
      acquireLock(join(manifest.home, 'board.lock')).release();
    } finally {
      release();
    }
  }, 60_000);

  it('a stop during a stalled reset waits for the retiring daemon and exits 1', async () => {
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Released in finally too, so a failed assertion cannot leave afterEach waiting on it.
    try {
      stand = await startStand({
        root,
        port: 0,
        env: {},
        osHome,
        shutdownTimeoutMs: 300,
        tick: () => stalled,
      });
      const current = stand;
      const manifest = current.manifest();
      await waitFor(manifest, 'api-ready');
      const log = join(manifest.home, 'logs', 'daemon.log');
      const reset = control(manifest, '/reset');
      // The reset has signalled the old daemon, which now waits for the stalled tick.
      await vi.waitFor(
        () => {
          expect(readFileSync(log, 'utf8')).toContain('"msg":"shutting down"');
        },
        { timeout: 10_000 },
      );
      let stopped: number | undefined;
      const stopping = current.stop().then((code) => {
        stopped = code;
        return code;
      });
      expect((await reset).status).toBe(500);
      // Past the shutdown timeout the old daemon still holds its lock, and stop has not resolved.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(stopped).toBeUndefined();
      expect(() => acquireLock(join(manifest.home, 'board.lock'))).toThrow();

      release();
      expect(await stopping).toBe(1);
      expect(await current.exited).toBe(1);
      acquireLock(join(manifest.home, 'board.lock')).release();
    } finally {
      release();
    }
  }, 60_000);

  it('poll reports every source', async () => {
    const manifest = await up();
    const polled = await control(manifest, '/poll');
    expect(polled.status).toBe(200);
    const { outcomes } = polled.body as { outcomes: { source: string; outcome: string }[] };
    // GitHub pull requests answer from the fake. Every other request fails against the network
    // guard. The GitHub Issues adapter turns that failure into an incomplete batch, so its poll
    // counts as delivered; the others fail.
    expect(Object.fromEntries(outcomes.map(({ source, outcome }) => [source, outcome]))).toEqual({
      spur: 'failed',
      'github-issues:stand:stand-org/board': 'delivered',
      'github:stand:stand-org/board': 'delivered',
      'jira:stand-jira': 'failed',
      'github:stand-jira:stand-org/service': 'delivered',
    });
    expect(outcomes).toHaveLength(SOURCES.length);
    const unknown = await control(manifest, '/poll', { source: 'nope' });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { sources: string[] }).sources.sort()).toEqual(SOURCES);
  }, 60_000);

  describe('fake GitHub', () => {
    const REPO = 'stand-org/board';
    const pr = (manifest: StandManifest, number: number, verb: string, extra = {}) =>
      control(manifest, '/fake', {
        system: 'github',
        action: 'pr',
        repo: REPO,
        number,
        verb,
        ...extra,
      });
    const fail = (manifest: StandManifest, failure: Record<string, unknown>) =>
      control(manifest, '/fake', { system: 'github', action: 'fail', failure });

    /** The PR's stored facts, or undefined when no poll has written them. */
    async function snapshot(manifest: StandManifest, number: number): Promise<PrFacts | undefined> {
      const store = openStore(join(manifest.home, 'board.sqlite'));
      try {
        const row = await store.db
          .selectFrom('pr_snapshot')
          .select('detail')
          .where('number', '=', number)
          .executeTakeFirst();
        return row === undefined ? undefined : (JSON.parse(row.detail) as PrFacts);
      } finally {
        await store.close();
      }
    }

    async function polled(manifest: StandManifest, number: number): Promise<PrFacts> {
      const result = await control(manifest, '/poll');
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const facts = await snapshot(manifest, number);
      if (facts === undefined) throw new Error(`no pr_snapshot row for ${String(number)}`);
      return facts;
    }

    it('runs the real adapter against the fake', async () => {
      const manifest = await up();
      expect((await pr(manifest, 7, 'create')).status).toBe(200);
      const result = await control(manifest, '/poll');
      expect(result.status).toBe(200);
      const { outcomes } = result.body as { outcomes: { source: string; outcome: string }[] };
      const bySource = Object.fromEntries(outcomes.map((o) => [o.source, o.outcome]));
      expect(bySource['github:stand:stand-org/board']).toBe('delivered');
      expect(bySource['github:stand-jira:stand-org/service']).toBe('delivered');
      expect(await snapshot(manifest, 7)).toMatchObject({ repo: REPO, number: 7, state: 'open' });
      expect(
        YAML.parse(readFileSync(join(manifest.home, 'config.yaml'), 'utf8')),
      ).not.toHaveProperty('adapters.github.baseUrl');
      expect((await control(manifest, '/fake', { action: 'violations' })).status).toBe(200);
    }, 60_000);

    it('walks every verb through the control endpoint and the real daemon', async () => {
      const manifest = await up();
      const sha = 'c'.repeat(40);
      expect((await pr(manifest, 8, 'create')).status).toBe(200);
      const first = await polled(manifest, 8);
      expect(first).toMatchObject({
        author: 'stand-agent',
        headBranch: 'stand-8',
        mergeable: 'mergeable',
        mergeState: 'blocked',
        requiredChecks: [{ name: 'build', state: 'pending' }],
        reviews: [],
        reviewRequests: [{ kind: 'user', id: 'stand-reviewer', asCodeOwner: false }],
      });
      expect(first.checks.map((check) => check.name)).toEqual(['build', 'status/lint']);

      let previous = first.updatedAt;
      /** Applies a verb, polls, and checks the verb moved `updatedAt` forward. */
      const step = async (verb: string, extra = {}): Promise<PrFacts> => {
        expect((await pr(manifest, 8, verb, extra)).status).toBe(200);
        const facts = await polled(manifest, 8);
        expect(Date.parse(facts.updatedAt), verb).toBeGreaterThan(Date.parse(previous));
        previous = facts.updatedAt;
        return facts;
      };

      const approved = await step('approve');
      expect(approved.reviewRequests).toEqual([]);
      expect(approved.reviews).toMatchObject([
        { reviewer: 'stand-reviewer', state: 'approved', commitSha: first.headSha },
      ]);

      const red = await step('ci-red');
      expect(red.mergeState).toBe('blocked');
      expect(red.requiredChecks).toMatchObject([{ name: 'build', state: 'failure' }]);
      expect(red.checks.find((c) => c.name === 'status/lint')?.state).toBe('pending');

      const green = await step('ci-green');
      expect(green.mergeState).toBe('clean');
      expect(green.checks.map((check) => check.state)).toEqual(['success', 'success']);

      expect(await step('conflict')).toMatchObject({
        mergeable: 'conflicting',
        mergeState: 'dirty',
      });

      expect((await pr(manifest, 8, 'push', { sha: 'nope' })).status).toBe(400);
      const pushed = await step('push', { sha });
      expect(pushed).toMatchObject({
        headSha: sha,
        mergeable: 'mergeable',
        mergeState: 'blocked',
        reviews: [{ reviewer: 'stand-reviewer', commitSha: first.headSha }],
      });
      expect(pushed.checks.map((check) => check.state)).toEqual(['pending', 'pending']);

      const again = await pr(manifest, 8, 'create', { seed: { title: 'overwritten' } });
      expect(again.status).toBe(409);
      expect((await polled(manifest, 8)).title).toBe(pushed.title);

      expect(await step('merge')).toMatchObject({
        state: 'merged',
        mergeable: 'unknown',
        mergeState: 'unknown',
      });
      expect((await pr(manifest, 8, 'approve')).status).toBe(409);
      expect((await pr(manifest, 99, 'approve')).status).toBe(404);
    }, 120_000);

    it('a reset removes fake pull requests', async () => {
      const manifest = await up();
      expect((await pr(manifest, 9, 'create')).status).toBe(200);
      await polled(manifest, 9);
      expect((await control(manifest, '/reset')).status).toBe(200);
      const after = stand?.manifest();
      if (after === undefined) throw new Error('stand stopped');
      expect((await control(after, '/poll')).status).toBe(200);
      const store = openStore(join(after.home, 'board.sqlite'));
      try {
        expect(await store.db.selectFrom('pr_snapshot').selectAll().execute()).toEqual([]);
      } finally {
        await store.close();
      }
      expect((await pr(after, 9, 'approve')).status).toBe(404);
    }, 60_000);

    it('bounds a poll under hang, then resets and stops', async () => {
      const manifest = await up();
      await waitFor(manifest, 'sources-polled');
      expect((await fail(manifest, { mode: 'hang' })).status).toBe(200);
      const bounded = await control(manifest, '/poll', { timeoutMs: 300 });
      expect(bounded.status).toBe(504);
      expect((await control(manifest, '/reset')).status).toBe(200);
      const after = stand?.manifest();
      if (after === undefined) throw new Error('stand stopped');
      // The failure went with the reset: this poll answers.
      const result = await control(after, '/poll', { timeoutMs: 20_000 });
      expect(result.status).toBe(200);
      const current = stand;
      stand = undefined;
      await current?.stop();
    }, 60_000);

    it.each<[string, Record<string, unknown>]>([
      ['hang', { mode: 'hang' }],
      ['delay', { mode: 'delay', ms: 600_000 }],
    ])(
      'stops in time with %s set and two polls sent',
      async (_name, failure) => {
        const manifest = await up();
        await waitFor(manifest, 'sources-polled');
        expect((await fail(manifest, failure)).status).toBe(200);
        const polls = [control(manifest, '/poll'), control(manifest, '/poll')];
        let answered = false;
        for (const poll of polls)
          void poll.then(
            () => {
              answered = true;
            },
            () => {
              answered = true;
            },
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(answered).toBe(false);
        const started = Date.now();
        const current = stand;
        stand = undefined;
        await current?.stop();
        expect(Date.now() - started).toBeLessThan(10_000);
        await Promise.allSettled(polls);
      },
      60_000,
    );
  });
});
