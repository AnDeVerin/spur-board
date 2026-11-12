import { execFile } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COLUMN_IDS } from '@spur-board/contracts';
import { migrationsDir, openStore } from '@spur-board/core';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { MANIFEST_FILE, readManifest, STAND_PREFIX, type StandManifest } from '../src/manifest.ts';
import { SCENARIOS, scenarioNames, type Scenario } from '../src/scenarios/index.ts';
import { startStand, type Stand, type StandOptions } from '../src/stand.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SEED_WAIT = { condition: 'scenario', timeoutMs: 30_000 };

let base: string;
let root: string;
let osHome: string;
let stand: Stand | undefined;
/** A stand still live at the end of its test; `afterEach` fails on a non-empty violation log. */
let checked: StandManifest | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stand-scenarios-'));
  root = join(base, 'tmp');
  osHome = join(base, 'home');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(osHome);
  root = realpathSync(root);
});

afterEach(async () => {
  let log: { status: number; body: unknown } | undefined;
  let slack: { status: number; body: unknown } | undefined;
  try {
    if (checked !== undefined) {
      log = await control(checked, '/violations');
      slack = await control(checked, '/fake/slack/outbox');
    }
  } finally {
    await stand?.stop();
    stand = undefined;
    checked = undefined;
    // A stand a test started through the CLI runs in its own process: down it, even after a
    // failure. A manifest naming this process is an in-process stand, stopped above.
    for (const name of readdirSync(root).filter((entry) => entry.startsWith(STAND_PREFIX))) {
      const manifest = readManifest(join(root, name));
      if (manifest !== undefined && manifest.pid !== process.pid)
        await standCli(['down', '--home', manifest.home]);
    }
    rmSync(base, { recursive: true, force: true });
  }
  if (log !== undefined) expect(log.status, JSON.stringify(log.body)).toBe(200);
  if (slack !== undefined)
    expect(
      (slack.body as { violations: unknown[] }).violations,
      JSON.stringify(slack.body),
    ).toEqual([]);
});

async function up(extra: Partial<StandOptions> = {}): Promise<StandManifest> {
  stand = await startStand({ root, port: 0, env: {}, osHome, ...extra });
  checked = stand.manifest();
  return checked;
}

/** The manifest the running stand holds now; a reset or a seed rewrites it. */
function current(): StandManifest {
  if (stand === undefined) throw new Error('no stand');
  checked = stand.manifest();
  return checked;
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

async function ok(manifest: StandManifest, route: string, body: unknown = {}): Promise<unknown> {
  const result = await control(manifest, route, body);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/** Seeds `name` on the running stand and waits until it has settled. */
async function seed(name: string): Promise<SeedAnswer> {
  const answer = (await ok(current(), '/seed', { scenario: name })) as SeedAnswer;
  await ok(current(), '/wait', SEED_WAIT);
  return answer;
}

type Entities = NonNullable<StandManifest['scenario']>;

interface SeedAnswer {
  daemonUrl: string;
  scenario: Entities;
}

/** One operation as the operator, through the public API. */
async function op<T>(manifest: StandManifest, id: string, input: object = {}): Promise<T> {
  const token = readFileSync(manifest.tokenPath, 'utf8').trim();
  const response = await fetch(`${manifest.daemonUrl}/v1/ops/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input }),
  });
  const body = (await response.json()) as { value: T };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.value;
}

interface Status {
  items: { key: string; summary: string }[];
  sources: { source: string; blindReason: string | null }[];
  tasks: { key: string; column: string }[];
}

const status = (manifest: StandManifest) => op<Status>(manifest, 'status.get', {});

/** The sources status.get reports blind for staleness. */
const staleSources = (sources: Status['sources']): string[] =>
  sources.filter(({ blindReason }) => blindReason === 'stale').map(({ source }) => source);

interface WrittenConfig {
  thresholds: { staleMultiplier: number };
  adapters: Record<string, { intervalMs: number }>;
}

const configText = (manifest: StandManifest): string =>
  readFileSync(join(manifest.home, 'config.yaml'), 'utf8');

const writtenConfig = (manifest: StandManifest): WrittenConfig =>
  YAML.parse(configText(manifest)) as WrittenConfig;

interface OutboxMessage {
  n: number;
  text: string;
  actions: string[];
}

async function outbox(manifest: StandManifest): Promise<OutboxMessage[]> {
  return ((await ok(manifest, '/fake/slack/outbox')) as { messages: OutboxMessage[] }).messages;
}

interface Inspected {
  instanceId: string;
  sessions: { id: string; stopReason?: string; retainInList?: true }[];
  requests: { method: string; path: string }[];
  sends: { session: string; message: string }[];
}

async function inspect(manifest: StandManifest): Promise<Inspected> {
  return (await ok(manifest, '/fake', { system: 'spur', verb: 'inspect', args: {} })) as Inspected;
}

/** The stand CLI in a child. Async: `spawnSync` would block the control endpoint in this process. */
function standCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { PATH: process.env['PATH'] ?? '', HOME: osHome, TMPDIR: root } },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code ?? -1), stdout, stderr });
      },
    );
  });
}

const standDirs = (): string[] =>
  readdirSync(root).filter((entry) => entry.startsWith(STAND_PREFIX));

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const boom: Scenario = {
  name: 'boom',
  summary: 'A seed that throws.',
  seed: () => Promise.reject(new Error('boom failed')),
  settled: () => Promise.resolve({ ok: true }),
};

describe('scenario manifest', () => {
  it('names the scenario and its entities in stand.json and the seed answer, without the token', async () => {
    const manifest = await up();
    expect(manifest.scenario).toBeUndefined();
    const answer = await seed('question-to-operator');
    expect(answer.scenario).toEqual({
      name: 'question-to-operator',
      tasks: { question: 'stand-org/board#1' },
      blocks: { question: expect.stringMatching(/^B\d+$/) as unknown },
      sessions: { asker: manifest.roles.worker },
    });
    const file = join(manifest.home, MANIFEST_FILE);
    expect(readManifest(manifest.home)?.scenario).toEqual(answer.scenario);
    expect(current().scenario).toEqual(answer.scenario);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(manifest.tokenPath, 'utf8').trim();
    expect(readFileSync(file, 'utf8')).not.toContain(token);
  }, 60_000);
});

describe('scenarios', () => {
  it('lists seven scenarios, each with a seed and a settled check', () => {
    expect(scenarioNames()).toEqual([
      'empty',
      'columns-basic',
      'question-to-operator',
      'worker-killed-no-pr',
      'spur-source-silent',
      'source-blind',
      'token-approval',
    ]);
    for (const scenario of SCENARIOS) {
      expect(typeof scenario.seed, scenario.name).toBe('function');
      expect(typeof scenario.settled, scenario.name).toBe('function');
    }
  });

  it('starts seeded from startStand', async () => {
    const manifest = await up({ scenario: 'columns-basic' });
    await ok(manifest, '/wait', SEED_WAIT);
    expect(manifest.scenario?.name).toBe('columns-basic');
    expect(readManifest(manifest.home)?.scenario?.name).toBe('columns-basic');
  }, 60_000);

  it('up --scenario through the real CLI', async () => {
    const before = standDirs();
    const refused = await standCli(['up', '--scenario', 'nope']);
    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain('Unknown scenario nope');
    expect(standDirs()).toEqual(before);

    const started = await standCli(['up', '--scenario', 'empty']);
    let home: string | undefined;
    try {
      expect(started.code, started.stderr).toBe(0);
      home = (JSON.parse(started.stdout) as { home: string; scenario?: { name: string } }).home;
      expect(JSON.parse(started.stdout)).toMatchObject({ scenario: { name: 'empty' } });
      const shown = await standCli(['status', '--home', home, '--json']);
      expect(shown.code, shown.stderr).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        scenario: { name: 'empty' },
        apiReady: true,
        violations: 0,
      });
      const text = await standCli(['status', '--home', home]);
      expect(text.stdout).toContain('scenario: {"name":"empty"}');
      const waited = await standCli(['wait', 'scenario', '--home', home]);
      expect(waited.code, waited.stdout).toBe(0);
    } finally {
      if (home !== undefined) {
        const downed = await standCli(['down', '--home', home]);
        expect(downed.code, downed.stderr).toBe(0);
      }
    }
    expect(standDirs()).toEqual(before);
  }, 120_000);

  it('seeds a running stand through the CLI and refuses an unknown scenario', async () => {
    const { home } = await up();
    const seeded = await standCli(['seed', 'empty', '--home', home]);
    expect(seeded.code, seeded.stderr).toBe(0);
    expect(JSON.parse(seeded.stdout)).toMatchObject({ scenario: { name: 'empty' } });
    const waited = await standCli(['wait', 'scenario', '--home', home]);
    expect(waited.code, waited.stdout).toBe(0);
    const unknown = await standCli(['seed', 'nope', '--home', home]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('use one of empty, columns-basic');
    const stray = await standCli(['reset', '--scenario', 'empty', '--home', home]);
    expect(stray.code).toBe(2);
    expect(current().scenario?.name).toBe('empty');
  }, 60_000);

  it('the seed route refuses an unknown or missing scenario', async () => {
    const manifest = await up();
    const unknown = await control(manifest, '/seed', { scenario: 'nope' });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { scenarios: string[] }).scenarios).toEqual(scenarioNames());
    expect((await control(manifest, '/seed', {})).status).toBe(400);
  }, 60_000);

  it('reset restores the same scenario', async () => {
    await up();
    await seed('columns-basic');
    const reset = (await ok(current(), '/reset')) as SeedAnswer & { snapshot?: string };
    expect(reset.scenario.name).toBe('columns-basic');
    expect(reset.snapshot).toBe('restored');
    await ok(current(), '/wait', SEED_WAIT);
    const { tasks } = await status(current());
    expect(tasks).toHaveLength(COLUMN_IDS.length);
    expect(tasks.map(({ column }) => column).sort()).toEqual([...COLUMN_IDS].sort());
  }, 90_000);

  it('wait scenario without a seed answers 400', async () => {
    const manifest = await up();
    const result = await control(manifest, '/wait', SEED_WAIT);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'No scenario is seeded.' });
  }, 60_000);

  it('records the scenario only after its seed resolves', async () => {
    const entered = deferred();
    const gate = deferred();
    const gated: Scenario = {
      name: 'gated',
      summary: 'A seed held until the test opens its gate.',
      async seed() {
        entered.resolve();
        await gate.promise;
        return { tasks: { held: 'stand-org/board#1' } };
      },
      settled: () => Promise.resolve({ ok: true }),
    };
    try {
      const manifest = await up({ scenarios: [gated] });
      const seeding = control(manifest, '/seed', { scenario: 'gated' });
      await entered.promise;
      const during = await control(current(), '/wait', { condition: 'scenario', timeoutMs: 0 });
      expect(during).toMatchObject({ status: 504, body: { diagnostics: 'seeding gated' } });
      expect(readManifest(manifest.home)?.scenario).toBeUndefined();
      gate.resolve();
      expect((await seeding).status).toBe(200);
      await ok(current(), '/wait', { condition: 'scenario', timeoutMs: 0 });
      expect(readManifest(manifest.home)?.scenario).toEqual({
        name: 'gated',
        tasks: { held: 'stand-org/board#1' },
      });
    } finally {
      gate.resolve();
    }
  }, 60_000);

  it('a stop ends a seed that waits on the board', async () => {
    const waiting: Scenario = {
      name: 'waiting',
      summary: 'A seed that waits for a state that never comes.',
      async seed(board) {
        await board.until('never', 600_000, () => false);
        return {};
      },
      settled: () => Promise.resolve({ ok: true }),
    };
    const manifest = await up({ scenarios: [waiting] });
    checked = undefined;
    const seeding = control(manifest, '/seed', { scenario: 'waiting' });
    await vi.waitFor(async () => {
      const during = await control(manifest, '/wait', { condition: 'scenario', timeoutMs: 0 });
      expect(during.body).toMatchObject({ diagnostics: 'seeding waiting' });
    });
    const started = Date.now();
    expect(await stand?.stop()).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await seeding).toMatchObject({
      status: 500,
      body: { error: 'The stand is stopping.', scenario: 'waiting' },
    });
  }, 60_000);

  it('a seed that throws at start fails the start and leaves no home', async () => {
    await expect(
      startStand({ root, port: 0, env: {}, osHome, scenario: 'boom', scenarios: [boom] }),
    ).rejects.toThrow('boom failed');
    expect(standDirs()).toEqual([]);
  }, 60_000);

  it('a seed that throws on a running stand answers 500 and leaves it unseeded', async () => {
    const manifest = await up({ scenarios: [boom] });
    const failed = await control(manifest, '/seed', { scenario: 'boom' });
    expect(failed).toEqual({
      status: 500,
      body: {
        error: 'boom failed',
        scenario: 'boom',
        note: 'The board keeps what the seed wrote before it failed; run reset for a clean stand.',
      },
    });
    await ok(current(), '/wait', { condition: 'api-ready', timeoutMs: 20_000 });
    expect((await control(current(), '/wait', SEED_WAIT)).status).toBe(400);
    expect(readManifest(manifest.home)?.scenario).toBeUndefined();
    await ok(current(), '/reset');
    expect((await control(current(), '/wait', SEED_WAIT)).status).toBe(400);
  }, 60_000);

  it('writes a scenario config under its header line', async () => {
    const tuned: Scenario = {
      name: 'tuned',
      summary: 'A scenario that tunes thresholds and one adapter.',
      config: {
        thresholds: { staleMultiplier: 2_000 },
        adapters: { jira: { intervalMs: 600_000 } },
      },
      seed: () => Promise.resolve({}),
      settled: () => Promise.resolve({ ok: true }),
    };
    const manifest = await up({ scenarios: [tuned] });
    expect(configText(manifest)).not.toContain('# Scenario ');
    expect(writtenConfig(manifest).thresholds.staleMultiplier).toBe(1_000);
    await ok(current(), '/seed', { scenario: 'tuned' });
    expect(configText(current())).toContain(
      '# Scenario tuned overrides thresholds and adapters here.\n',
    );
    const config = writtenConfig(current());
    expect(config.thresholds.staleMultiplier).toBe(2_000);
    expect(config.adapters['jira']?.intervalMs).toBe(600_000);
    expect(config.adapters['spur']?.intervalMs).toBe(2_000);
    expect(config.adapters['github']?.intervalMs).toBe(5_000);
  }, 60_000);

  it('a seed shift outside 1..MAX_SHIFT_MS fails the seed and leaves the clock', async () => {
    const backwards: Scenario = {
      name: 'backwards',
      summary: 'A seed that shifts the clock by zero.',
      async seed(board) {
        await board.shiftClock(0);
        return {};
      },
      settled: () => Promise.resolve({ ok: true }),
    };
    const manifest = await up({ scenarios: [backwards] });
    const failed = await control(manifest, '/seed', { scenario: 'backwards' });
    expect(failed.status).toBe(500);
    expect((failed.body as { error: string }).error).toContain('the clock only moves forward');
    expect(await ok(current(), '/clock', { shiftMs: 1 })).toMatchObject({ offsetMs: 1 });
  }, 60_000);
});

describe('each scenario', () => {
  it('empty: no tasks, no items', async () => {
    await up();
    await seed('empty');
    const { tasks, items } = await status(current());
    expect(tasks).toEqual([]);
    expect(items).toEqual([]);

    await ok(current(), '/fake', {
      system: 'github',
      verb: 'issue-open',
      args: { repo: 'stand-org/board', number: 1, title: 'Not empty' },
    });
    await ok(current(), '/poll');
    const wait = await control(current(), '/wait', { condition: 'scenario', timeoutMs: 0 });
    expect(wait.status).toBe(504);
    expect(JSON.stringify(wait.body)).toContain('task stand-org/board#1 exists');
  }, 60_000);

  it('columns-basic: each column holds the task the manifest names', async () => {
    await up();
    const { scenario } = await seed('columns-basic');
    expect(scenario.direct).toEqual([
      'task.column set by hand: no operation moves a task before the dispatcher (#68)',
    ]);
    const { tasks } = await status(current());
    expect(tasks).toHaveLength(COLUMN_IDS.length);
    for (const column of COLUMN_IDS) {
      const key = scenario.tasks?.[column];
      expect(key, column).toBeDefined();
      expect(tasks.filter((task) => task.column === column).map((task) => task.key)).toEqual([key]);
    }
  }, 60_000);

  it('question-to-operator: the block is open to the operator and an answer rings the worker', async () => {
    const manifest = await up();
    const { scenario } = await seed('question-to-operator');
    const task = scenario.tasks?.['question'] ?? '';
    expect(task).toBe('stand-org/board#1');
    const read = () =>
      op<{ blocks: { id: string; state: string; addressee: string; outcome: string | null }[] }>(
        current(),
        'task.get',
        { task },
      );
    expect((await read()).blocks).toEqual([
      expect.objectContaining({
        id: scenario.blocks?.['question'],
        state: 'open',
        addressee: 'operator',
      }),
    ]);
    const question = (await outbox(current())).find((message) =>
      message.text.includes('Which version should the client target?'),
    );
    if (question === undefined) throw new Error('the question was not posted');
    await ok(current(), '/fake/slack/click', {
      message: question.n,
      button: 'answer',
      text: 'Use v2.',
    });
    await vi.waitFor(
      async () => {
        expect((await read()).blocks[0]).toMatchObject({ state: 'unblocked', outcome: 'done' });
      },
      { timeout: 10_000 },
    );
    // The doorbell may be queued on a later tick than the answer, so outbox-drained alone could
    // pass before it exists: wait for the send itself.
    await vi.waitFor(
      async () => {
        expect((await inspect(current())).sends).toContainEqual(
          expect.objectContaining({ session: manifest.roles.worker }),
        );
      },
      { timeout: 20_000, interval: 100 },
    );
    // Ring 2 is due firstRetryMs (2 min) after ring 1: a poll does not bring it, a shift does.
    const workerSends = async () =>
      (await inspect(current())).sends.filter(({ session }) => session === manifest.roles.worker)
        .length;
    await ok(current(), '/poll');
    expect(await workerSends()).toBe(1);
    const shifted = await standCli(['clock', '+3m', '--home', manifest.home]);
    expect(shifted.code, shifted.stderr).toBe(0);
    await vi.waitFor(
      async () => {
        expect(await workerSends()).toBe(2);
      },
      { timeout: 5_000, interval: 100 },
    );
  }, 60_000);

  it('worker-killed-no-pr: the ended worker item is raised', async () => {
    await up();
    const { scenario } = await seed('worker-killed-no-pr');
    const { items } = await status(current());
    expect(items).toContainEqual(
      expect.objectContaining({
        key: scenario.items?.['killed'],
        summary: 'stand-org/board#1: worker ended (killed), no PR (stand-killed)',
      }),
    );
  }, 60_000);

  it('spur-source-silent: the #275 shape, one logged restart, then a stale spur source', async () => {
    // A fresh home, so the daemon log holds this seed's lines only.
    const manifest = await up({ scenario: 'spur-source-silent' });
    await ok(manifest, '/wait', SEED_WAIT);
    const fake = await inspect(manifest);
    expect(fake.instanceId).toBe('stand-spur-2');
    expect(fake.sessions).toContainEqual(
      expect.objectContaining({ id: 'other-1', stopReason: 'stale_timeout' }),
    );
    expect(fake.sessions).toContainEqual(
      expect.objectContaining({ id: 'retained-1', retainInList: true }),
    );
    for (const id of ['done-1', 'done-2', 'done-3', 'killed-4'])
      expect(fake.requests, id).toContainEqual({
        at: expect.any(String) as unknown,
        method: 'GET',
        path: `/sessions/${id}`,
        route: 'detail',
      });

    const lines = readFileSync(join(manifest.home, 'logs', 'daemon.log'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { msg?: string; source?: string });
    const restarts = lines.flatMap((line, index) => (line.msg === 'spur restarted' ? [index] : []));
    const firstFailure = lines.findIndex(
      (line) => line.msg === 'adapter poll failed' && line.source === 'spur',
    );
    expect(restarts).toHaveLength(1);
    expect(firstFailure).toBeGreaterThan(restarts[0] ?? Infinity);

    // The stand's own stale window: the seed reaches it through a clock shift, not by waiting.
    expect(configText(manifest)).not.toContain('# Scenario ');
    expect(writtenConfig(manifest).thresholds.staleMultiplier).toBe(1_000);

    const { sources, items } = await status(manifest);
    expect(sources).toContainEqual(
      expect.objectContaining({ source: 'spur', blindReason: 'stale' }),
    );
    expect(staleSources(sources)).toEqual(['spur']);
    expect(items.map(({ key }) => key)).toContain(manifest.scenario?.items?.['silent']);
    expect(manifest.scenario?.items?.['silent']).toBe('source:spur');

    // A reset reseeds onto a fresh runner and shifts the clock again.
    await ok(current(), '/reset');
    await ok(current(), '/wait', SEED_WAIT);
    const again = await status(current());
    expect(staleSources(again.sources)).toEqual(['spur']);
    expect(again.items.map(({ key }) => key)).toContain('source:spur');
    expect(await ok(current(), '/clock', { shiftMs: 1 })).toMatchObject({
      offsetMs: 2 * 2_400_000 + 1,
    });
  }, 120_000);

  it('source-blind: the GitHub Issues tracker is blind for auth', async () => {
    await up();
    const { scenario } = await seed('source-blind');
    const source = 'github-issues:stand:stand-org/board';
    expect(scenario).toMatchObject({
      sources: { blind: source },
      items: { blind: `source:${source}` },
    });
    const { sources, items } = await status(current());
    expect(sources).toContainEqual(expect.objectContaining({ source, blindReason: 'auth' }));
    expect(items.map(({ key }) => key)).toContain(`source:${source}`);
  }, 60_000);

  it('token-approval: a pending token whose approve button approves it', async () => {
    await up();
    const { scenario } = await seed('token-approval');
    const tokens = () =>
      op<{ tokens: { name: string; status: string }[] }>(current(), 'token.list', {});
    expect((await tokens()).tokens).toContainEqual(
      expect.objectContaining({ name: 'stand-tester', status: 'pending' }),
    );
    const n = Number(scenario.messages?.['approval']);
    const message = (await outbox(current())).find((candidate) => candidate.n === n);
    const approve = message?.actions.find((action) => /^token:\d+:approve$/.test(action));
    if (approve === undefined) throw new Error('no approve button');
    expect(await ok(current(), '/fake/slack/click', { message: n, button: approve })).toEqual({
      ok: true,
      responses: ['stand-tester: approved'],
    });
    expect((await tokens()).tokens).toContainEqual(
      expect.objectContaining({ name: 'stand-tester', status: 'approved' }),
    );
  }, 60_000);
});

/** `definition` with a seed that counts its calls. */
function counted(definition: Scenario): { scenario: Scenario; seeds: () => number } {
  let seeds = 0;
  return {
    scenario: {
      ...definition,
      seed: (...args) => {
        seeds += 1;
        return definition.seed(...args);
      },
    },
    seeds: () => seeds,
  };
}

interface ResetAnswer extends SeedAnswer {
  snapshot?: string;
}

const snapshotFiles = (manifest: StandManifest, name: string): string[] =>
  readdirSync(join(manifest.home, 'snapshots')).filter((file) =>
    new RegExp(`^${name}-[0-9a-f]{16}\\.sqlite$`).test(file),
  );

/** The rows a seed owns, every table's row count, and the state of the Spur and Slack fakes. */
async function capture(manifest: StandManifest) {
  const store = openStore(join(manifest.home, 'board.sqlite'));
  try {
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `.execute(store.db);
    const counts: Record<string, number> = {};
    for (const { name } of tables.rows) {
      const result = await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(name)}`.execute(
        store.db,
      );
      counts[name] = result.rows[0]?.n ?? -1;
    }
    const blocks = await store.db
      .selectFrom('block')
      .select(['id', 'state', 'addressee_role'])
      .orderBy('id')
      .execute();
    const tasks = await store.db
      .selectFrom('task')
      .select(['key', 'column'])
      .orderBy('key')
      .execute();
    const spur = await inspect(manifest);
    return {
      counts,
      blocks,
      tasks,
      spur: { instanceId: spur.instanceId, sessions: spur.sessions },
      rules: (spur as unknown as { rules: unknown }).rules,
      // Without Slack refs: a feed line the daemon posts after the snapshot is posted again after
      // a restore, at a new ts.
      slack: (await outbox(manifest)).map(({ n, text, actions }) => ({ n, text, actions })),
    };
  } finally {
    await store.close();
  }
}

describe('snapshots', () => {
  it('reset restores the seeded state after destructive changes, without seeding again', async () => {
    const { scenario, seeds } = counted(
      SCENARIOS.find(({ name }) => name === 'question-to-operator') as Scenario,
    );
    await up({ scenarios: [scenario] });
    const seeded = (await ok(current(), '/seed', { scenario: scenario.name })) as ResetAnswer;
    expect(seeded.snapshot).toBe('taken');
    await ok(current(), '/wait', SEED_WAIT);
    const first = await capture(current());
    await ok(current(), '/poll');
    const second = await capture(current());
    // A poll with unchanged fakes may add rows to some tables; those compare by seed-owned rows.
    const stable = Object.keys(first.counts).filter(
      (name) => first.counts[name] === second.counts[name],
    );
    const pick = (counts: Record<string, number>) =>
      Object.fromEntries(stable.map((name) => [name, counts[name]]));

    const question = second.slack.find((message) => message.text.includes('client target'));
    if (question === undefined) throw new Error('the question was not posted');
    await ok(current(), '/fake/slack/click', { message: question.n, button: 'answer', text: 'v2' });
    const github = (verb: string, args: object) =>
      ok(current(), '/fake', { system: 'github', verb, args });
    await github('issue-close', { repo: 'stand-org/board', number: 1 });
    await github('fail', { mode: 'server-error' });
    await ok(current(), '/fake', { system: 'spur', verb: 'session', args: { id: 'extra-1' } });
    await ok(current(), '/fake', { system: 'spur', verb: 'fail', args: { mode: '5xx' } });
    await ok(current(), '/poll');
    const destroyed = await capture(current());
    expect(destroyed.blocks).not.toEqual(second.blocks);

    const reset = (await ok(current(), '/reset')) as ResetAnswer;
    expect(reset.snapshot).toBe('restored');
    expect(reset.scenario.name).toBe(scenario.name);
    expect(seeds()).toBe(1);
    await ok(current(), '/wait', SEED_WAIT);
    const restored = await capture(current());
    expect(pick(restored.counts)).toEqual(pick(second.counts));
    expect(restored.blocks).toEqual(second.blocks);
    expect(restored.tasks).toEqual(second.tasks);
    expect(restored.spur).toEqual(second.spur);
    expect(restored.rules).toEqual({});
    expect(restored.slack).toEqual(second.slack);
    const reopen = await control(current(), '/fake', {
      system: 'github',
      verb: 'issue-open',
      args: { repo: 'stand-org/board', number: 1 },
    });
    expect(reopen.status).toBe(409);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = join(current().home, `board.sqlite${suffix}`);
      expect(statSync(file).mode & 0o777, file).toBe(0o600);
    }
  }, 120_000);

  it('a changed scenario re-seeds and takes a new snapshot', async () => {
    const empty = SCENARIOS.find(({ name }) => name === 'empty') as Scenario;
    const { scenario, seeds } = counted(empty);
    const mutable: Scenario = { ...scenario };
    const manifest = await up({ scenarios: [mutable] });
    await seed('empty');
    const [v1] = snapshotFiles(manifest, 'empty');
    mutable.seed = async (...args) => {
      const entities = await scenario.seed(...args);
      return { ...entities, tasks: { v2: 'none' } };
    };
    const changed = (await ok(current(), '/reset')) as ResetAnswer;
    expect(changed.snapshot).toBe('taken');
    expect(changed.scenario.tasks).toEqual({ v2: 'none' });
    expect(seeds()).toBe(2);
    const files = snapshotFiles(manifest, 'empty');
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(v1);
    await ok(current(), '/wait', SEED_WAIT);
    const again = (await ok(current(), '/reset')) as ResetAnswer;
    expect(again.snapshot).toBe('restored');
    expect(again.scenario.tasks).toEqual({ v2: 'none' });
    expect(seeds()).toBe(2);
  }, 120_000);

  it('a changed migration re-seeds at reset', async () => {
    const dir = join(base, 'migrations');
    cpSync(fileURLToPath(migrationsDir), dir, { recursive: true });
    const { scenario, seeds } = counted(SCENARIOS.find(({ name }) => name === 'empty') as Scenario);
    const manifest = await up({
      scenarios: [scenario],
      migrationsDir: pathToFileURL(`${dir}/`),
    });
    await seed('empty');
    const [before] = snapshotFiles(manifest, 'empty');
    expect(((await ok(current(), '/reset')) as ResetAnswer).snapshot).toBe('restored');
    expect(seeds()).toBe(1);
    const last = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .at(-1);
    if (last === undefined) throw new Error('no migrations');
    appendFileSync(join(dir, last), '-- changed\n');
    expect(((await ok(current(), '/reset')) as ResetAnswer).snapshot).toBe('taken');
    expect(seeds()).toBe(2);
    const files = snapshotFiles(manifest, 'empty');
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(before);
    await ok(current(), '/wait', SEED_WAIT);
  }, 120_000);

  it('a snapshot that cannot be restored stops the stand', async () => {
    const manifest = await up();
    await seed('empty');
    const [file] = snapshotFiles(manifest, 'empty');
    if (file === undefined) throw new Error('no snapshot');
    writeFileSync(join(manifest.home, 'snapshots', file), 'not a database');
    const reset = await control(current(), '/reset');
    checked = undefined;
    expect(reset.status).toBe(500);
    expect(reset.body).toMatchObject({ error: expect.any(String) as unknown });
    expect(await stand?.exited).toBe(1);
    expect(existsSync(join(manifest.home, 'board.sqlite.partial'))).toBe(false);
  }, 60_000);

  it('a failed snapshot keeps the seed and reset seeds again', async () => {
    const { scenario, seeds } = counted(SCENARIOS.find(({ name }) => name === 'empty') as Scenario);
    const manifest = await up({ scenarios: [scenario] });
    writeFileSync(join(manifest.home, 'snapshots'), 'not a directory');
    const seeded = (await ok(current(), '/seed', { scenario: 'empty' })) as ResetAnswer;
    expect(seeded.snapshot).toBe('failed');
    await ok(current(), '/wait', SEED_WAIT);
    expect(readFileSync(join(manifest.home, 'logs', 'daemon.log'), 'utf8')).toContain(
      'stand snapshot failed',
    );
    const reset = (await ok(current(), '/reset')) as ResetAnswer;
    expect(reset.snapshot).toBe('failed');
    expect(seeds()).toBe(2);
    await ok(current(), '/wait', SEED_WAIT);
  }, 60_000);

  it.each(scenarioNames())(
    '%s reaches wait scenario after a restore-reset',
    async (name) => {
      await up();
      await seed(name);
      const reset = (await ok(current(), '/reset')) as ResetAnswer;
      expect(reset.snapshot).toBe('restored');
      await ok(current(), '/wait', SEED_WAIT);
    },
    90_000,
  );

  it('the stand clock does not move back across a restore-reset', async () => {
    await up();
    await seed('empty');
    const shifted = (await ok(current(), '/clock', { shiftMs: 3_600_000 })) as { now: string };
    expect(((await ok(current(), '/reset')) as ResetAnswer).snapshot).toBe('restored');
    const after = (await ok(current(), '/clock', { shiftMs: 1 })) as { now: string };
    expect(Date.parse(after.now)).toBeGreaterThanOrEqual(Date.parse(shifted.now) + 1);
  }, 60_000);
});
