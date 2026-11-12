import { execFile } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMN_IDS } from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('reset seeds the same scenario again', async () => {
    await up();
    await seed('columns-basic');
    const reset = (await ok(current(), '/reset')) as SeedAnswer;
    expect(reset.scenario.name).toBe('columns-basic');
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

    const { sources, items } = await status(manifest);
    expect(sources).toContainEqual(
      expect.objectContaining({ source: 'spur', blindReason: 'stale' }),
    );
    expect(items.map(({ key }) => key)).toContain(manifest.scenario?.items?.['silent']);
    expect(manifest.scenario?.items?.['silent']).toBe('source:spur');
  }, 90_000);

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
