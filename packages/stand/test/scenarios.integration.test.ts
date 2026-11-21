import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { COLUMN_IDS, type ColumnId } from '@spur-board/contracts';
import { migrationsDir, openStore } from '@spur-board/core';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { MANIFEST_FILE, readManifest, STAND_PREFIX, type StandManifest } from '../src/manifest.ts';
import { SCENARIOS, scenarioNames, type Scenario } from '../src/scenarios/index.ts';
import { startStand, type Stand, type StandOptions } from '../src/stand.ts';
import { liveConfigDir, writeLiveConfig } from './live-config.ts';

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
  writeLiveConfig(liveConfigDir(osHome));
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
async function op<T>(
  manifest: StandManifest,
  id: string,
  input: object = {},
  key?: string,
): Promise<T> {
  const token = readFileSync(manifest.tokenPath, 'utf8').trim();
  const response = await fetch(`${manifest.daemonUrl}/v1/ops/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input, ...(key === undefined ? {} : { key }) }),
  });
  const body = (await response.json()) as { value: T };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.value;
}

interface Status {
  items: { key: string; summary: string }[];
  sources: { source: string; project: string | null; blindReason: string | null }[];
  services: { service: string; state: string }[];
  tasks: { key: string; column: string; state: string }[];
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
  sessions: { id: string; status: string; stopReason?: string; retainInList?: true }[];
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
  it('lists all scenarios, each with a seed and a settled check', () => {
    expect(scenarioNames()).toEqual([
      'empty',
      'columns-basic',
      'columns-unknown',
      'question-to-operator',
      'question-to-curator',
      'curator-escalation',
      'curator-absent',
      'project-question-to-operator',
      'operator-conversation',
      'worker-killed-no-pr',
      'spur-source-silent',
      'source-blind',
      'token-approval',
      'feed-code-hints',
      'columns-basic-jira',
      'worker-killed-no-pr-jira',
      'source-blind-jira',
      'default-branch-red',
      'dispatch-happy-path',
      'dispatch-split-pr',
      'dispatch-ticket-done-no-pr',
      'dispatch-close-after-merge',
      'pr-finality',
      'dispatch-review-loop',
      'dispatch-orchestrator-role',
      'dispatch-ci-red-after-submit',
      'dispatch-conflict-in-review',
      'dispatch-conflict-in-ready-to-merge',
      'dispatch-reentry-same-head',
      'dispatch-edited-comment',
      'dispatch-external-comment',
      'dispatch-dead-executor',
      'dispatch-source-blind',
      'dispatch-cycle-limit',
      'dispatch-course-check',
      'dispatch-course-check-to',
      'dispatch-long-comment-history',
      'dispatch-ci-pending-after-submit',
      'dispatch-submit-before-pr-linked',
      'dispatch-submit-head-moved',
      'dispatch-submit-no-pr',
      'dispatch-new-head-in-ready-to-merge',
      'dispatch-ci-red-new-head-in-product-review',
      'dispatch-ring-closed-turn',
      'dispatch-turn-view',
      'dispatch-reviewer-status-comment',
      'dispatch-unresolved-thread',
      'dispatch-approval-with-notes',
      'dispatch-unbound-review',
      'qa-carried',
      'qa-skipped',
      'approval-stale',
      'approval-stale-quiet',
      'approval-multi',
      'approval-rewritten',
      'approval-uncounted',
      'approval-stale-no-watch',
      'spur-transitions-rapid-recovery',
      'spur-transitions-cursor-expired',
      'spur-transitions-killed-holder',
      'spur-turn-stall',
      'card-long',
      'readme-board',
      'ready-mirror',
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
      expect(JSON.parse(started.stdout)).not.toHaveProperty('webUrl');
      expect(started.stderr).toContain('needs web.publicOrigin with {port}');
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

  it('columns-unknown: omitted-column tasks remain readable through production operations', async () => {
    await up();
    const { scenario } = await seed('columns-unknown');
    const config = await op<{ projects: { id: string; columns: { id: string }[] }[] }>(
      current(),
      'config.get',
      {},
    );
    const columns = config.projects
      .find((project) => project.id === 'stand')
      ?.columns.map(({ id }) => id);
    expect(columns).toEqual(['todo', 'dev', 'done']);
    const { tasks } = await status(current());
    expect(tasks).toHaveLength(COLUMN_IDS.length);
    const unknown = tasks.filter((task) => !columns?.includes(task.column));
    expect(unknown).toHaveLength(COLUMN_IDS.length - 3);
    expect(tasks.filter((task) => columns?.includes(task.column))).toHaveLength(3);
    const key = scenario.tasks?.['qa'];
    expect(unknown.map((task) => task.key)).toContain(key);
    const read = await op<{ task: { key: string; column: string } }>(current(), 'task.get', {
      task: key,
    });
    expect(read.task).toMatchObject({ key, column: 'qa' });
  }, 60_000);

  it('question-to-operator: the block is open to the operator and an answer rings the worker', async () => {
    const manifest = await up();
    const { scenario } = await seed('question-to-operator');
    const task = scenario.tasks?.['question'] ?? '';
    expect(task).toBe('stand-org/board#1');
    const read = () =>
      op<{
        blocks: { id: string; state: string; addressee: string; outcome: string | null }[];
        comments: { block: string | null; author: string; text: string }[];
      }>(current(), 'task.get', { task });
    const blockId = scenario.blocks?.['question'];
    const onBlock = async () =>
      (await read()).comments.filter((comment) => comment.block === blockId);
    expect((await read()).blocks).toEqual([
      expect.objectContaining({
        id: blockId,
        state: 'open',
        addressee: 'operator',
      }),
    ]);
    // The question is the block's reason, not also its first reply.
    expect(await onBlock()).toEqual([]);
    const question = (await outbox(current())).find((message) =>
      message.text.includes('Which version should the client target?'),
    );
    if (question === undefined) throw new Error('the question was not posted');
    const workerHealth = (state: 'working' | 'waiting') =>
      ok(current(), '/fake', {
        system: 'spur',
        verb: 'session',
        args: { id: manifest.roles.worker, state },
      });
    const workerSends = async () =>
      (await inspect(current())).sends.filter(({ session }) => session === manifest.roles.worker)
        .length;
    // While the worker is observed working, the answer's ring is held.
    await workerHealth('working');
    await ok(current(), '/poll');
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
    expect((await onBlock()).map(({ author, text }) => ({ author, text }))).toEqual([
      { author: 'operator', text: 'Use v2.' },
    ]);
    await ok(current(), '/poll');
    await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
    expect(await workerSends()).toBe(0);
    // Once the worker waits, the next poll lets the ring go.
    await workerHealth('waiting');
    await ok(current(), '/poll');
    // The doorbell may be queued on a later tick than the poll, so outbox-drained alone could
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

  it('question-to-operator: ring 2 waits while ring 1 is held in the Spur queue', async () => {
    const manifest = await up();
    const { scenario } = await seed('question-to-operator');
    const worker = manifest.roles.worker;
    const fakeSession = (queue: 'hold' | 'deliver') =>
      ok(current(), '/fake', { system: 'spur', verb: 'session', args: { id: worker, queue } });
    await fakeSession('hold');
    const question = (await outbox(current())).find((message) =>
      message.text.includes('Which version should the client target?'),
    );
    if (question === undefined) throw new Error('the question was not posted');
    expect(scenario.blocks?.['question']).toBeDefined();
    await ok(current(), '/fake/slack/click', {
      message: question.n,
      button: 'answer',
      text: 'Use v2.',
    });
    const workerSends = async () =>
      (await inspect(current())).sends.filter(({ session }) => session === worker).length;
    await vi.waitFor(
      async () => {
        expect(await workerSends()).toBe(1);
      },
      { timeout: 20_000, interval: 100 },
    );
    // The poll reads ring 1 in the Spur queue; past firstRetryMs the board still holds ring 2.
    await ok(current(), '/poll');
    const shifted = await standCli(['clock', '+3m', '--home', manifest.home]);
    expect(shifted.code, shifted.stderr).toBe(0);
    await ok(current(), '/poll');
    await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
    expect(await workerSends()).toBe(1);
    // Once Spur delivers the queued ring, the next poll lets ring 2 go.
    await fakeSession('deliver');
    await ok(current(), '/poll');
    await vi.waitFor(
      async () => {
        expect(await workerSends()).toBe(2);
      },
      { timeout: 5_000, interval: 100 },
    );
  }, 60_000);

  it('spur-transitions-rapid-recovery: retains both edges and their original reset and links', async () => {
    await up();
    await seed('spur-transitions-rapid-recovery');
    const store = openStore(join(current().home, 'board.sqlite'));
    try {
      const events = await store.db
        .selectFrom('event')
        .selectAll()
        .where('kind', '=', 'session_state_changed')
        .orderBy('id')
        .execute();
      const edges = events
        .map((row) => ({
          at: row.at,
          payload: JSON.parse(row.payload) as {
            transition?: {
              session: string;
              from: string | null;
              to: string;
              at: string;
              links: unknown;
              rateLimitResetAt?: string;
            };
          },
        }))
        .filter(
          ({ payload }) =>
            payload.transition?.session === 'transition-worker' && payload.transition.from !== null,
        );
      expect(edges.map(({ payload }) => payload.transition?.to)).toEqual([
        'rate_limited',
        'working',
      ]);
      expect(edges[0]?.payload.transition).toMatchObject({
        rateLimitResetAt: '2099-01-01T00:00:00.000Z',
        links: { 'board-worker': 'https://github.com/stand-org/board/issues/1' },
      });
      expect(edges.every(({ at, payload }) => at === payload.transition?.at)).toBe(true);
      expect(edges[1]?.payload.transition).not.toHaveProperty('rateLimitResetAt');
    } finally {
      await store.close();
    }
  }, 60_000);

  it('spur-transitions-cursor-expired: resyncs once and does not duplicate historical events', async () => {
    await up();
    await seed('spur-transitions-cursor-expired');
    const fake = (await ok(current(), '/fake', { system: 'spur', verb: 'inspect', args: {} })) as {
      cursor: string;
      requests: { path: string }[];
    };
    const feed = fake.requests.filter(({ path }) => path.startsWith('/sessions/transitions'));
    expect(new URL(feed.at(-1)?.path ?? '', 'http://fake').searchParams.get('since')).toBe(
      fake.cursor,
    );
    const finalFeedIndex = fake.requests.findIndex((request) => request === feed.at(-1));
    const priorFeedIndex = fake.requests.findIndex((request) => request === feed.at(-2));
    expect(
      fake.requests
        .slice(priorFeedIndex, finalFeedIndex)
        .filter(({ path }) => path === '/sessions'),
    ).toHaveLength(1);
    const store = openStore(join(current().home, 'board.sqlite'));
    try {
      const events = await store.db
        .selectFrom('event')
        .select('payload')
        .where('kind', '=', 'session_state_changed')
        .execute();
      const positions = events
        .map(
          ({ payload }) =>
            (JSON.parse(payload) as { transition?: { position: string } }).transition?.position,
        )
        .filter((value) => value !== undefined);
      expect(new Set(positions).size).toBe(positions.length);
    } finally {
      await store.close();
    }
  }, 60_000);

  it('spur-transitions-killed-holder: ended facts and worker_ended arrive without a second poll', async () => {
    await up();
    await seed('spur-transitions-killed-holder');
    expect(
      (await status(current())).items.some((item) =>
        item.summary.includes(`holder ${current().roles.worker} ended`),
      ),
    ).toBe(true);
    const task = await op<{ sessions: { id: string; endReason: string | null }[] }>(
      current(),
      'task.get',
      { task: 'stand-org/board#1' },
    );
    expect(task.sessions.find(({ id }) => id === current().roles.worker)?.endReason).toBe('kill');
    const inbox = await op<{ items: { kind: string; action: string }[] }>(
      current(),
      'inbox.operator',
      {},
    );
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        kind: 'worker_ended',
        action: 'start a new worker for the task, or archive the task',
      }),
    );
    expect(inbox.items.filter((item) => item.kind === 'block')).toEqual([]);
  }, 60_000);

  it('worker-killed-no-pr: the ended worker item is raised and the task row agrees', async () => {
    await up();
    const { scenario } = await seed('worker-killed-no-pr');
    const { items, tasks } = await status(current());
    expect(items).toContainEqual(
      expect.objectContaining({
        key: scenario.items?.['killed'],
        summary: 'stand-org/board#1: worker ended (killed), no PR (stand-killed)',
      }),
    );
    // #272: the row counted the stored health, not the end reason the item names.
    expect(tasks.find((task) => task.key === 'stand-org/board#1')?.state).toMatch(
      /; sessions 1 ended \(killed\)$/,
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

    // A reset restores the snapshot onto a fresh runner and makes the seed's clock shift again.
    expect(await ok(current(), '/reset')).toMatchObject({ snapshot: 'restored' });
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
    const inbox = await op<{ items: { url?: string }[] }>(current(), 'inbox.operator', {});
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        url: 'https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api',
      }),
    );
  }, 60_000);

  it('default-branch-red: one failure item under _board; a green head clears it; a failed scheduled run raises nothing', async () => {
    await up();
    const { scenario } = await seed('default-branch-red');
    const repo = 'stand-org/board';
    const source = `github:stand:${repo}`;
    const key = `default-branch:${source}`;
    expect(scenario).toMatchObject({ sources: { red: source }, items: { red: key } });
    interface Inbox {
      items: {
        kind: string;
        severity: string;
        project: string;
        text: string;
        action: string;
        url?: string;
      }[];
      handled: { text: string; url?: string }[];
    }
    type Branch = { state: string; sha: string; check: string | null; url: string | null } | null;
    const inbox = () => op<Inbox>(current(), 'inbox.operator', {});
    const branchOf = async () =>
      (
        (await status(current())).sources as unknown as { source: string; defaultBranch?: Branch }[]
      ).find((entry) => entry.source === source)?.defaultBranch;
    const red = await inbox();
    const url = `https://github.stand.invalid/${repo}/actions/runs/1`;
    expect(red.items).toEqual([
      {
        ...red.items[0],
        kind: 'board_observation',
        severity: 'failure',
        project: '_board',
        action: 'open the failing run; fix or revert',
        url,
      },
    ]);
    expect(red.items[0]?.text).toMatch(
      new RegExp(
        `^stand-org/board: main is red since [0-9a-f]{7} \\(build\\): fix main before merging more \\(run ${url}\\): open the failing run; fix or revert$`,
      ),
    );
    expect(await branchOf()).toMatchObject({ state: 'red', check: 'build', url });

    const branch = (args: object) =>
      ok(current(), '/fake', { system: 'github', verb: 'branch', args: { repo, ...args } });
    await branch({ state: 'green' });
    await ok(current(), '/poll');
    const green = await inbox();
    expect(green.items.filter((entry) => entry.text.startsWith(`${repo}: main`))).toEqual([]);
    expect(green.handled.filter((entry) => entry.text.startsWith(`${repo}: main`))).toHaveLength(1);
    expect(green.handled.find((entry) => entry.text.startsWith(`${repo}: main`))?.url).toBe(url);
    expect(await branchOf()).toMatchObject({ state: 'green' });

    await branch({ state: 'green', scheduledFailure: 'nightly' });
    await ok(current(), '/poll');
    const scheduled = await inbox();
    expect(await branchOf()).toMatchObject({ state: 'green' });
    expect(scheduled.items.filter((entry) => entry.text.startsWith(`${repo}: main`))).toEqual([]);
    expect(scheduled.handled).toHaveLength(green.handled.length);
    expect((await status(current())).items.map((item) => item.key)).not.toContain(key);
  }, 60_000);

  it('ready-mirror: the fake Project places tasks, and a Status change moves them on the next poll', async () => {
    const manifest = await up({ scenario: 'ready-mirror' });
    await ok(manifest, '/wait', SEED_WAIT);
    const source = 'github-project:stand:stand-org/1';
    const [ready, backlog, outside] = [
      'stand-org/board#1',
      'stand-org/board#2',
      'stand-org/board#3',
    ];
    expect(manifest.scenario).toMatchObject({
      tasks: { ready, backlog, outside },
      sources: { mirror: source },
    });
    const columns = async () =>
      Object.fromEntries((await status(current())).tasks.map((task) => [task.key, task.column]));
    expect(await columns()).toMatchObject({
      [ready]: 'ready-for-dev',
      [backlog]: 'todo',
      [outside]: 'todo',
    });
    const mirror = (await status(current())).sources.find((entry) => entry.source === source);
    expect(mirror).toMatchObject({ project: 'stand', blindReason: null, failure: null });

    const projectStatus = (number: number, value: string) =>
      ok(current(), '/fake', {
        system: 'github',
        verb: 'issue-project-status',
        args: { repo: 'stand-org/board', number, status: value },
      });
    await projectStatus(1, 'removed');
    await projectStatus(2, 'Ready');
    await ok(current(), '/poll');
    expect(await columns()).toMatchObject({
      [ready]: 'todo',
      [backlog]: 'ready-for-dev',
      [outside]: 'todo',
    });
    expect(await ok(current(), '/violations')).toEqual({ total: 0, items: [] });
  }, 60_000);

  it('columns-basic-jira: each column holds the stand-jira task the manifest names', async () => {
    await up();
    const { scenario } = await seed('columns-basic-jira');
    const { tasks } = await op<{ tasks: { key: string; column: string; project: string }[] }>(
      current(),
      'status.get',
      { project: 'stand-jira' },
    );
    expect(tasks).toHaveLength(COLUMN_IDS.length);
    for (const [i, column] of COLUMN_IDS.entries()) {
      const key = scenario.tasks?.[column];
      expect(key, column).toBe(`STAND-${String(i + 1)}`);
      expect(tasks.filter((task) => task.column === column).map((task) => task.key)).toEqual([key]);
    }
  }, 60_000);

  it('worker-killed-no-pr-jira: the ended worker item is raised on the stand-jira task', async () => {
    await up();
    const { scenario } = await seed('worker-killed-no-pr-jira');
    expect(scenario.tasks?.['killed']).toBe('STAND-1');
    const { items } = await op<{ items: { key: string; summary: string }[] }>(
      current(),
      'status.get',
      { project: 'stand-jira' },
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        key: scenario.items?.['killed'],
        summary: 'STAND-1: worker ended (killed), no PR (stand-killed)',
      }),
    );
  }, 60_000);

  it('source-blind-jira: the Jira tracker is blind for auth, GitHub Issues is not', async () => {
    await up();
    const { scenario } = await seed('source-blind-jira');
    const source = 'jira:stand-jira';
    expect(scenario).toMatchObject({
      sources: { blind: source },
      items: { blind: `source:${source}` },
    });
    const { sources, items } = await status(current());
    expect(sources).toContainEqual(expect.objectContaining({ source, blindReason: 'auth' }));
    expect(sources).toContainEqual(
      expect.objectContaining({ source: 'github-issues:stand:stand-org/board', blindReason: null }),
    );
    expect(items.map(({ key }) => key)).toContain(`source:${source}`);
    // Another project chosen: the blind Jira source and its service still show; items stay its own.
    const chosen = await op<Status>(current(), 'status.get', { project: 'stand' });
    expect(chosen.sources).toContainEqual(
      expect.objectContaining({ source, project: 'stand-jira', blindReason: 'auth' }),
    );
    expect(chosen.services).toContainEqual(
      expect.objectContaining({ service: 'jira', state: 'failing' }),
    );
    expect(chosen.items.map(({ key }) => key)).not.toContain(`source:${source}`);
    const inbox = await op<{ items: { url?: string }[] }>(current(), 'inbox.operator', {});
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro',
      }),
    );
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

  it('feed-code-hints: each board-written hint reaches Slack as code, the rest escaped', async () => {
    await up();
    // The seed throws unless `/board tokens` replied `Posted 7 operator tokens to the feed.`:
    // the six requests and the stand's own operator token.
    const { scenario } = await seed('feed-code-hints');
    const messages = await outbox(current());
    const byName = (name: string) => {
      const n = Number(scenario.messages?.[name]);
      const message = messages.find((candidate) => candidate.n === n);
      if (message === undefined) throw new Error(`no ${name} message`);
      return message.text;
    };
    const backticks = (text: string): number => text.split('`').length - 1;

    const list = byName('list');
    const more = /> (\d+) more: `board token list`$/.exec(list);
    if (more === null) throw new Error(`no hidden-count hint in ${list}`);
    const hidden = Number(more[1]);
    const shown = (list.match(/ \((?:pending|approved)\), /g) ?? []).length;
    expect(hidden).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThan(7);
    expect(shown + hidden).toBe(7);
    expect(backticks(list)).toBe(2);
    expect(list).toContain('´pwd´');
    expect(list).toContain('&amp;');
    expect(list).not.toContain('&&');

    const blocked = byName('blocked');
    expect(blocked).toContain(' read `board task stand-org/board#1`');
    expect(backticks(blocked)).toBe(2);

    expect(await ok(current(), '/violations')).toMatchObject({ total: 0 });
  }, 60_000);
});

describe('curator scenarios', () => {
  const QUESTION = 'Which version should the client target?';
  const NOTE = 'The API owner decides this; I cannot.';

  interface SlackMessage extends OutboxMessage {
    conversation: string;
    root: boolean;
  }
  interface BlockView {
    id: string;
    state: string;
    addressee: string;
    outcome: string | null;
  }
  interface HistoryEvent {
    kind: string;
    actor: string;
    summary: string;
  }

  const slack = async (): Promise<SlackMessage[]> =>
    ((await ok(current(), '/fake/slack/outbox')) as { messages: SlackMessage[] }).messages;
  const channelOf = (message: SlackMessage): string =>
    (JSON.parse(message.conversation) as { channel: string }).channel;
  const blockOf = async (task: string, id: string): Promise<BlockView | undefined> =>
    (await op<{ blocks: BlockView[] }>(current(), 'task.get', { task })).blocks.find(
      (block) => block.id === id,
    );
  const history = async (task: string): Promise<HistoryEvent[]> =>
    (await op<{ events: HistoryEvent[] }>(current(), 'task.history', { task })).events;
  /** The fake Spur sends to `session` that name block `id`. */
  const sendsNaming = async (session: string, id: string): Promise<string[]> =>
    (await inspect(current())).sends
      .filter((send) => send.session === session && send.message.includes(`block ${id}:`))
      .map(({ message }) => message);
  const asCurator = (manifest: StandManifest, args: string[]) =>
    standCli(['board', '--home', manifest.home, '--as', 'curator', ...args]);
  /** The seeded task and block, failing when the seed named neither. */
  function question(scenario: Entities): { task: string; id: string } {
    const task = scenario.tasks?.['question'];
    const id = scenario.blocks?.['question'];
    if (task === undefined || id === undefined) throw new Error('the seed named no question');
    return { task, id };
  }

  it('spur-turn-stall: delivers to curator, escalates to operator, withdraws on recovery', async () => {
    await up();
    const { scenario } = await seed('spur-turn-stall');
    const task = scenario.tasks?.['stall'];
    const id = scenario.blocks?.['stall'];
    if (task === undefined || id === undefined) throw new Error('Missing stall seed');
    expect(await blockOf(task, id)).toMatchObject({ state: 'open', addressee: 'curator' });
    expect(await sendsNaming(current().roles.curator, id)).toHaveLength(1);
    const inbox = await asCurator(current(), ['inbox', '--json']);
    expect(inbox.code, inbox.stderr).toBe(0);
    expect(
      (JSON.parse(inbox.stdout) as { blocks: { id: string }[] }).blocks.map((block) => block.id),
    ).toContain(id);
    const escalated = await asCurator(current(), [
      'escalate',
      id,
      '--note',
      'Operator intervention needed.',
    ]);
    expect(escalated.code, escalated.stderr).toBe(0);
    await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 20_000 });
    expect(await blockOf(task, id)).toMatchObject({ state: 'open', addressee: 'operator' });
    expect((await slack()).some((message) => message.text.includes('remains needs_input'))).toBe(
      true,
    );
    await ok(current(), '/fake', {
      system: 'spur',
      verb: 'session',
      args: { id: current().roles.orchestrator, state: 'working' },
    });
    await ok(current(), '/poll');
    await vi.waitFor(
      async () => {
        expect(await blockOf(task, id)).toMatchObject({ state: 'unblocked', outcome: 'withdrawn' });
      },
      { timeout: 20_000, interval: 100 },
    );
    expect((await history(task)).some((event) => event.kind === 'block_escalated')).toBe(true);
  }, 60_000);

  it('question-to-curator: the curator reads its inbox, answers, and the worker is rung', async () => {
    const manifest = await up();
    const { scenario } = await seed('question-to-curator');
    const { task, id } = question(scenario);
    expect(configText(current())).toContain(
      "# Scenario question-to-curator sets the stand project's Spur projects here.\n",
    );
    const config = YAML.parse(configText(current())) as {
      projects: { id: string; spurProjects?: { name: string; role: string }[] }[];
    };
    expect(config.projects.find((project) => project.id === 'stand')?.spurProjects).toContainEqual({
      name: 'stand-curator',
      role: 'curator',
    });
    expect(manifest.roles.curator).toMatch(/^stand-curator-[0-9a-f]{24}$/);
    expect(await blockOf(task, id)).toMatchObject({ state: 'open', addressee: 'curator' });
    expect((await slack()).filter((message) => channelOf(message) === 'C0STANDORCH')).toEqual([]);
    await vi.waitFor(
      async () => {
        expect(await sendsNaming(manifest.roles.curator, id)).not.toEqual([]);
      },
      { timeout: 20_000, interval: 100 },
    );

    const inbox = await asCurator(manifest, ['inbox', '--json']);
    expect(inbox.code, inbox.stderr).toBe(0);
    expect(
      (JSON.parse(inbox.stdout) as { blocks: { id: string }[] }).blocks.map((block) => block.id),
    ).toContain(id);
    const answered = await asCurator(manifest, ['answer', id, 'Use v2.']);
    expect(answered.code, answered.stderr).toBe(0);
    expect(await blockOf(task, id)).toMatchObject({ state: 'unblocked', outcome: 'done' });

    await ok(current(), '/poll');
    await vi.waitFor(
      async () => {
        expect(await sendsNaming(manifest.roles.worker, id)).not.toEqual([]);
      },
      { timeout: 20_000, interval: 100 },
    );
    await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
    const feed = (await slack()).filter(
      (message) => channelOf(message) === 'C0STANDFEED' && message.text.includes('Use v2.'),
    );
    expect(feed).toEqual([expect.objectContaining({ root: true, actions: [] })]);
  }, 60_000);

  it('question-to-curator: an unread ring series moves the block to the operator', async () => {
    const manifest = await up();
    const { scenario } = await seed('question-to-curator');
    const { task, id } = question(scenario);
    const curatorSends = async () => (await sendsNaming(manifest.roles.curator, id)).length;
    expect(await curatorSends()).toBe(1);
    const shift = async (by: string) => {
      const shifted = await standCli(['clock', by, '--home', manifest.home]);
      expect(shifted.code, shifted.stderr).toBe(0);
      await ok(current(), '/poll');
    };
    await shift('+3m');
    await vi.waitFor(
      async () => {
        expect(await curatorSends()).toBe(2);
      },
      { timeout: 10_000, interval: 100 },
    );
    await shift('+6m');
    await vi.waitFor(
      async () => {
        expect(await curatorSends()).toBe(3);
      },
      { timeout: 10_000, interval: 100 },
    );
    await shift('+16m');
    await vi.waitFor(
      async () => {
        expect(await blockOf(task, id)).toMatchObject({ state: 'open', addressee: 'operator' });
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(await history(task)).toContainEqual(
      expect.objectContaining({ kind: 'block_escalated', actor: 'system' }),
    );
    expect(await curatorSends()).toBe(3);
  }, 60_000);

  it('curator-escalation: the operator gets the question and the curator note in one thread', async () => {
    const manifest = await up();
    const { scenario } = await seed('curator-escalation');
    const { task, id } = question(scenario);
    expect(await blockOf(task, id)).toMatchObject({ state: 'open', addressee: 'operator' });
    const orchestrators = (await slack()).filter((message) => channelOf(message) === 'C0STANDORCH');
    const root = orchestrators.find((message) => message.root && message.text.includes(QUESTION));
    if (root === undefined) throw new Error('no root message holds the question');
    expect(orchestrators).toContainEqual(
      expect.objectContaining({
        conversation: root.conversation,
        root: false,
        text: expect.stringContaining(NOTE) as unknown,
      }),
    );
    // The note is posted with `ringsAuthor: false`: the worker hears nothing of the escalation.
    await ok(current(), '/poll');
    await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
    expect(await sendsNaming(manifest.roles.worker, id)).toEqual([]);
  }, 60_000);

  it('curator-absent: with no live curator session the board passes the question on', async () => {
    const manifest = await up();
    const { scenario } = await seed('curator-absent');
    const { task, id } = question(scenario);
    expect(
      (await inspect(current())).sessions.find((session) => session.id === manifest.roles.curator),
    ).toMatchObject({ status: 'killed' });
    expect(await blockOf(task, id)).toMatchObject({ state: 'open', addressee: 'operator' });
    expect(
      (await slack()).filter(
        (message) =>
          channelOf(message) === 'C0STANDORCH' && message.root && message.text.includes(QUESTION),
      ),
    ).toHaveLength(1);
    const events = await history(task);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'block_escalated', actor: 'system' }),
    );
    expect(events.map(({ kind }) => kind)).not.toContain('doorbell_rung');
    expect(await sendsNaming(manifest.roles.curator, id)).toEqual([]);
  }, 60_000);

  it('operator-conversation: the five issue messages reach their addressees', async () => {
    const manifest = await up();
    await seed('operator-conversation');
    const { curator, orchestrator } = manifest.roles;
    interface InboxBlock {
      id: string;
      task: string | null;
      project?: string;
      type: string;
      addressee: string;
      reason: string;
      state: string;
    }
    const inbox = async (role: 'curator' | 'orchestrator'): Promise<InboxBlock[]> => {
      const listed = await standCli([
        'board',
        '--home',
        manifest.home,
        '--as',
        role,
        'inbox',
        '--json',
      ]);
      expect(listed.code, listed.stderr).toBe(0);
      return (JSON.parse(listed.stdout) as { blocks: InboxBlock[] }).blocks;
    };
    /** Posts `text` and returns its message number and the block `role`'s inbox gained. */
    const post = async (text: string, role: 'curator' | 'orchestrator') => {
      const before = new Set((await inbox(role)).map((block) => block.id));
      const { message } = (await ok(current(), '/fake/slack/post', { text })) as {
        message: number;
      };
      const gained = (await inbox(role)).filter((block) => !before.has(block.id));
      expect(gained, text).toHaveLength(1);
      return { message, block: gained[0] as InboxBlock };
    };
    const rings = async (session: string, id: string, at = 1) => {
      await ok(current(), '/poll');
      await vi.waitFor(
        async () => {
          expect((await sendsNaming(session, id)).length).toBeGreaterThanOrEqual(at);
        },
        { timeout: 20_000, interval: 100 },
      );
    };
    const drained = () =>
      ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
    const thread = async (n: number) => {
      const messages = await slack();
      const root = messages.find((message) => message.n === n);
      return messages.filter((message) => message.conversation === root?.conversation);
    };
    const projectBlock = { type: 'needs_input', task: null, project: 'stand', state: 'open' };

    const first = await post('@cur hello', 'curator');
    expect(first.block).toMatchObject({ ...projectBlock, reason: 'hello', addressee: 'curator' });
    await rings(curator, first.block.id);
    expect(await sendsNaming(orchestrator, first.block.id)).toEqual([]);
    const answered = await standCli([
      'board',
      '--home',
      manifest.home,
      '--as',
      'curator',
      'answer',
      first.block.id,
      'Hi from the curator.',
    ]);
    expect(answered.code, answered.stderr).toBe(0);
    await drained();
    expect(await thread(first.message)).toContainEqual(
      expect.objectContaining({
        root: false,
        text: expect.stringContaining('Hi from the curator.') as unknown,
      }),
    );
    expect(channelOf((await thread(first.message))[0] as SlackMessage)).toBe('C0STANDORCH');
    expect((await inbox('curator')).map((block) => block.id)).toContain(first.block.id);
    const before = (await sendsNaming(curator, first.block.id)).length;
    const follow = { message: first.message, button: 'answer', text: 'and more' };
    await ok(current(), '/fake/slack/click', follow);
    await rings(curator, first.block.id, before + 1);
    await ok(current(), '/fake/slack/click', { ...follow, text: 'close' });
    await drained();
    expect(await thread(first.message)).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining('resolved: done (operator)') as unknown,
      }),
    );
    expect((await inbox('curator')).map((block) => block.id)).not.toContain(first.block.id);

    const quiet: number[] = [];
    for (const text of ['hello', '@nobody hello', 'please ask @cur']) {
      const curatorBefore = (await inbox('curator')).length;
      const step = await post(text, 'orchestrator');
      expect(step.block).toMatchObject({ ...projectBlock, reason: text, addressee: 'worker' });
      await rings(orchestrator, step.block.id);
      expect(await inbox('curator')).toHaveLength(curatorBefore);
      expect(await sendsNaming(curator, step.block.id)).toEqual([]);
      quiet.push(step.message);
    }

    const task = 'stand-org/board#1';
    const { message } = (await ok(current(), '/fake/slack/post', {
      text: '@cur stand-org/board#1 status?',
    })) as { message: number };
    quiet.push(message);
    const onTask = (await op<{ blocks: InboxBlock[] }>(current(), 'task.get', { task })).blocks;
    expect(onTask).toEqual([
      expect.objectContaining({
        type: 'needs_input',
        task,
        addressee: 'curator',
        reason: 'stand-org/board#1 status?',
        state: 'open',
      }),
    ]);
    await rings(curator, onTask[0]?.id ?? '');

    await drained();
    for (const n of quiet) {
      expect((await thread(n)).map((m) => ({ n: m.n, root: m.root }))).toEqual([{ n, root: true }]);
    }
  }, 120_000);

  it('project-question-to-operator: the operator answers in the thread and the curator is rung', async () => {
    const manifest = await up();
    const { scenario } = await seed('project-question-to-operator');
    const id = scenario.blocks?.['question'];
    if (id === undefined) throw new Error('the seed named no question');
    const asks = (message: SlackMessage) =>
      message.text.includes('May I restart the stand deploy?');
    const root = (await slack()).find(
      (message) => channelOf(message) === 'C0STANDORCH' && message.root && asks(message),
    );
    if (root === undefined) throw new Error('no thread root holds the project question');
    expect((await slack()).filter((m) => channelOf(m) === 'C0STANDFEED' && asks(m))).not.toEqual(
      [],
    );
    await ok(current(), '/fake/slack/click', { message: root.n, button: 'answer', text: 'Yes.' });
    await vi.waitFor(
      async () => {
        const inbox = await op<{ blocks: { id: string }[] }>(current(), 'inbox.get', {});
        expect(inbox.blocks.map((block) => block.id)).not.toContain(id);
      },
      { timeout: 10_000, interval: 100 },
    );
    await ok(current(), '/poll');
    await vi.waitFor(
      async () => {
        expect(await sendsNaming(manifest.roles.curator, id)).not.toEqual([]);
      },
      { timeout: 20_000, interval: 100 },
    );
    await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
    expect(
      (await slack()).filter(
        (message) =>
          channelOf(message) === 'C0STANDORCH' &&
          message.text.includes('resolved: done (operator)'),
      ),
    ).not.toEqual([]);
    const inbox = await asCurator(manifest, ['inbox', '--json']);
    expect(inbox.code, inbox.stderr).toBe(0);
    expect((JSON.parse(inbox.stdout) as { comments: { block: string }[] }).comments).toContainEqual(
      expect.objectContaining({ block: id }),
    );
  }, 60_000);
});

describe('dispatcher scenarios', () => {
  const ISSUE = 'stand-org/board#1';
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const TIMEOUT = 90_000;

  interface TurnView {
    id: string;
    task: string;
    column: string;
    addressee: string;
    reason: string;
    head: string | null;
    taken: { by: string } | null;
    handed: { kind: string; id: string }[];
    threads?: { id: string; url: string; outdated: boolean }[];
  }
  interface Inbox {
    turns: TurnView[];
  }

  /** One operation under `x-board-session: <session>`, through the public API. */
  async function sessionOp<T>(
    session: string,
    id: string,
    input: object = {},
    key?: string,
  ): Promise<T> {
    const response = await fetch(`${current().daemonUrl}/v1/ops/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-session': session },
      body: JSON.stringify({ input, ...(key === undefined ? {} : { key }) }),
    });
    const body = (await response.json()) as { value: T };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.value;
  }
  const as = (role: 'worker' | 'orchestrator' | 'curator') => current().roles[role];
  const github = (verb: string, args: object = {}) =>
    ok(current(), '/fake', {
      system: 'github',
      verb,
      args: verb === 'fail' ? args : { repo: 'stand-org/board', number: 1, ...args },
    });
  const spur = (verb: string, args: object) =>
    ok(current(), '/fake', { system: 'spur', verb, args });
  const poll = () => ok(current(), '/poll');

  /** The session's open turn on the flow task, if any. */
  const turnOf = async (session: string): Promise<TurnView | undefined> =>
    (await sessionOp<Inbox>(session, 'inbox.get')).turns.find(({ task }) => task === ISSUE);
  async function mustTurn(session: string): Promise<TurnView> {
    const turn = await turnOf(session);
    if (turn === undefined) throw new Error(`no turn for ${session}`);
    return turn;
  }
  const ack = (session: string, turn: string) =>
    sessionOp(session, 'inbox.ack', { entries: [{ id: turn }] }, randomUUID());
  const submit = (session: string, turn: string, sha: string) =>
    sessionOp<{ task: { column: string } }>(session, 'task.submit', { turn, sha }, randomUUID());
  const column = async () =>
    (await status(current())).tasks.find(({ key }) => key === ISSUE)?.column;

  async function withStore<T>(
    read: (store: ReturnType<typeof openStore>) => Promise<T>,
  ): Promise<T> {
    const store = openStore(join(current().home, 'board.sqlite'));
    try {
      return await read(store);
    } finally {
      await store.close();
    }
  }
  /** Every `task_moved` payload, oldest first. */
  const moves = () =>
    withStore(async (store) =>
      (
        await store.db
          .selectFrom('event')
          .select('payload')
          .where('kind', '=', 'task_moved')
          .orderBy('id')
          .execute()
      ).map(
        ({ payload }) =>
          JSON.parse(payload) as { from: string; to: string; reason: string; gate?: string[] },
      ),
    );
  const fromTo = async () => (await moves()).map(({ from, to, reason }) => [from, to, reason]);
  const turnRow = (id: number) =>
    withStore((store) =>
      store.db.selectFrom('turn').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    );
  const sessionLink = (session: string) =>
    withStore((store) =>
      store.db
        .selectFrom('link')
        .select(['role', 'banned'])
        .where('entity', '=', 'session')
        .where('session_id', '=', session)
        .executeTakeFirst(),
    );
  const itemKeys = async () => (await status(current())).items.map(({ key }) => key);
  /** The turn rows of `column`, oldest first. */
  const turnsIn = (column: ColumnId) =>
    withStore((store) =>
      store.db.selectFrom('turn').selectAll().where('column', '=', column).orderBy('id').execute(),
    );

  it(
    'dispatch-happy-path: merge and the ticket close move the task to Done with a wrap-up turn',
    async () => {
      await up();
      const { scenario } = await seed('dispatch-happy-path');
      const config = YAML.parse(configText(current())) as {
        projects: { id: string; dispatcher?: { mode: string } }[];
      };
      expect(config.projects.map(({ id, dispatcher }) => [id, dispatcher?.mode])).toEqual([
        ['stand', 'on'],
        ['stand-jira', undefined],
      ]);
      expect(configText(current())).toContain(
        "# Scenario dispatch-happy-path sets the stand project's columns and dispatcher here.\n",
      );
      expect(await fromTo()).toEqual([
        ['todo', 'dev', 'gate_passed'],
        ['dev', 'review', 'gate_passed'],
        ['review', 'ready-to-merge', 'gate_passed'],
      ]);
      const item = scenario.items?.['turn'];
      expect(await itemKeys()).toContain(item);

      await github('merge');
      await github('issue-close');
      await poll();
      expect(await column()).toBe('done');
      expect(await mustTurn(as('worker'))).toMatchObject({
        column: 'done',
        reason: 'done: wrap up',
      });
      expect(await itemKeys()).not.toContain(item);
      expect((await fromTo()).at(-1)).toEqual(['ready-to-merge', 'done', 'merged']);
    },
    TIMEOUT,
  );

  it(
    'dispatch-happy-path: timestamp-only adapter refreshes persist without facts events',
    async () => {
      await up();
      await seed('dispatch-happy-path');
      await poll();
      const capture = () =>
        withStore(async (store) => {
          const ticket = await store.db
            .selectFrom('ticket_snapshot')
            .innerJoin('task', 'task.id', 'ticket_snapshot.task_id')
            .selectAll('ticket_snapshot')
            .select('task.last_change_at')
            .where('task.key', '=', ISSUE)
            .executeTakeFirstOrThrow();
          const pr = await store.db
            .selectFrom('pr_snapshot')
            .selectAll()
            .where('repo', '=', 'stand-org/board')
            .where('number', '=', 1)
            .executeTakeFirstOrThrow();
          const session = await store.db
            .selectFrom('session_snapshot')
            .selectAll()
            .where('id', '=', as('worker'))
            .executeTakeFirstOrThrow();
          const facts = (detail: string) => JSON.parse(detail) as Record<string, unknown>;
          return {
            ticket: { facts: facts(ticket.detail), observedAt: ticket.observed_at },
            pr: { facts: facts(pr.detail), observedAt: pr.observed_at },
            session: { facts: facts(session.detail), observedAt: session.observed_at },
            taskTime: ticket.last_change_at,
            events: await store.db
              .selectFrom('event')
              .selectAll()
              .where('kind', 'in', [
                'ticket_facts_changed',
                'pr_facts_changed',
                'session_facts_changed',
              ])
              .orderBy('id')
              .execute(),
          };
        });
      const before = await capture();
      await ok(current(), '/clock', { shiftMs: 1_000 });
      await spur('session', { id: as('worker') });
      await github('resolve');
      await github('issue-label', { labels: before.ticket.facts['labels'] });
      // Manual poll restarts the adapter and resets healthSince. Let its scheduled polls
      // preserve smoothing state so only the fake's refresh timestamp changes.
      await vi.waitFor(
        async () => {
          const after = await capture();
          for (const kind of ['ticket', 'pr', 'session'] as const) {
            const timestamp = kind === 'session' ? 'lastActivityAt' : 'updatedAt';
            expect(after[kind].facts[timestamp]).not.toBe(before[kind].facts[timestamp]);
            expect(after[kind].facts).toEqual({
              ...before[kind].facts,
              [timestamp]: after[kind].facts[timestamp],
            });
            expect(Date.parse(after[kind].observedAt)).toBeGreaterThan(
              Date.parse(before[kind].observedAt),
            );
          }
          expect(after.events).toEqual(before.events);
          expect(after.taskTime).toBe(before.taskTime);
        },
        { timeout: 10_000, interval: 100 },
      );
    },
    TIMEOUT,
  );

  it(
    'dispatch-split-pr: a second PR merged with the issue closed moves the split task to Done',
    async () => {
      await up();
      await seed('dispatch-split-pr');
      expect(await column()).toBe('dev');
      expect((await fromTo()).at(-1)).toEqual(['ready-to-merge', 'dev', 'gate_broken']);

      await github('create', { number: 2, seed: { headRefName: 'stand-1-b', headRefOid: B } });
      await github('ci-green', { number: 2 });
      await poll();
      expect(await column()).toBe('dev');
      await github('merge', { number: 2 });
      await github('issue-close');
      await poll();
      expect(await column()).toBe('done');
      expect(await mustTurn(as('worker'))).toMatchObject({
        column: 'done',
        reason: 'done: wrap up',
      });
      expect((await fromTo()).slice(-2)).toEqual([
        ['ready-to-merge', 'dev', 'gate_broken'],
        ['dev', 'done', 'merged'],
      ]);
      const { links } = await op<{ links: { kind: string; ref: string; state?: string }[] }>(
        current(),
        'task.get',
        { task: ISSUE },
      );
      expect(links.filter(({ kind }) => kind === 'pr')).toEqual([
        expect.objectContaining({ ref: 'stand-org/board#1', state: 'merged' }),
        expect.objectContaining({ ref: 'stand-org/board#2', state: 'merged' }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-ticket-done-no-pr: default source confirmations finish within two polling rounds',
    async () => {
      await up();
      await seed('dispatch-ticket-done-no-pr');
      expect(await column()).toBe('todo');
      await github('issue-close');
      await poll();
      const first = await withStore(async (store) => ({
        task: await store.db
          .selectFrom('task')
          .select(['column', 'last_change_at', 'created_at'])
          .where('key', '=', ISSUE)
          .executeTakeFirstOrThrow(),
        ticket: await store.db
          .selectFrom('ticket_snapshot')
          .select(['observed_at'])
          .executeTakeFirstOrThrow(),
        sources: await store.db
          .selectFrom('source_state')
          .select(['source', 'last_complete_at', 'blind_reason'])
          .where('source', 'in', ['github:stand:stand-org/board', 'spur'])
          .execute(),
      }));
      const fresh =
        first.sources.length === 2 &&
        first.sources.every(
          ({ last_complete_at, blind_reason }) =>
            blind_reason === null &&
            last_complete_at !== null &&
            last_complete_at > first.ticket.observed_at,
        );
      if (!fresh) {
        expect(first.task.column).toBe('todo');
        expect(await fromTo()).toEqual([]);
      }
      await poll();
      expect(await column()).toBe('done');
      const confirmed = await withStore((store) =>
        store.db
          .selectFrom('source_state')
          .select(['source', 'last_complete_at', 'blind_reason'])
          .where('source', 'in', ['github:stand:stand-org/board', 'spur'])
          .execute(),
      );
      expect(confirmed).toHaveLength(2);
      for (const source of confirmed) {
        expect(source.blind_reason).toBeNull();
        expect(
          source.last_complete_at !== null && source.last_complete_at > first.ticket.observed_at,
        ).toBe(true);
      }
      expect(await fromTo()).toEqual([['todo', 'done', 'ticket_done_no_pr']]);
      expect(await turnOf(as('worker'))).toBeUndefined();
      const { links } = await op<{ links: { kind: string }[] }>(current(), 'task.get', {
        task: ISSUE,
      });
      expect(links.filter(({ kind }) => kind === 'pr' || kind === 'session')).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-ticket-done-no-pr: discovering a live worker never enters Done',
    async () => {
      await up();
      await seed('dispatch-ticket-done-no-pr');
      await github('issue-close');
      await spur('session', {
        id: as('worker'),
        links: [{ label: 'board-worker', url: 'https://github.com/stand-org/board/issues/1' }],
      });
      await poll();
      await poll();
      expect(await column()).toBe('dev');
      expect((await moves()).filter(({ to }) => to === 'done')).toEqual([]);
      expect(await mustTurn(as('worker'))).toMatchObject({ column: 'dev' });
    },
    TIMEOUT,
  );

  it(
    'dispatch-close-after-merge: an issue closed one poll after the merge goes straight to Done',
    async () => {
      await up();
      await seed('dispatch-close-after-merge');
      expect(configText(current())).toContain(
        '# Scenario dispatch-close-after-merge overrides thresholds and adapters here.',
      );
      const written = YAML.parse(configText(current())) as {
        adapters: { githubIssues: { intervalMs: number } };
      };
      expect(written.adapters.githubIssues.intervalMs).toBe(60_000);
      expect(await fromTo()).toEqual([
        ['todo', 'dev', 'gate_passed'],
        ['dev', 'review', 'gate_passed'],
        ['review', 'ready-to-merge', 'gate_passed'],
        ['ready-to-merge', 'done', 'merged'],
      ]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-turn-view: board task shows the Dev turn unacked, then its ack time, then closed as submitted under detail',
    async () => {
      interface TaskTurn {
        id: string;
        column: string;
        addressee: string;
        at: string;
        taken: { by: string; at: string } | null;
        closed: { at: string; outcome: string } | null;
      }
      interface TaskGet {
        turn: TaskTurn | null;
        turns?: TaskTurn[];
      }
      const task = (detail?: boolean) =>
        op<TaskGet>(current(), 'task.get', {
          task: ISSUE,
          ...(detail === undefined ? {} : { detail }),
        });
      await up();
      await seed('dispatch-turn-view');
      const unacked = await task();
      expect(unacked.turn).toMatchObject({
        id: 'T1',
        column: 'dev',
        addressee: 'worker',
        taken: null,
        closed: null,
      });
      expect(unacked).not.toHaveProperty('turns');

      await ack(as('worker'), 'T1');
      const acked = await task();
      expect(acked.turn).toMatchObject({
        id: 'T1',
        taken: {
          by: expect.stringContaining(`/${as('worker')}`) as unknown,
          at: expect.any(String) as unknown,
        },
      });

      await github('create', { seed: { headRefOid: A } });
      await github('ci-green');
      await poll();
      expect((await submit(as('worker'), 'T1', A)).task.column).toBe('review');
      const detail = await task(true);
      expect(detail.turns).toEqual([
        expect.objectContaining({
          id: 'T1',
          column: 'dev',
          closed: expect.objectContaining({ outcome: 'submitted' }) as unknown,
        }),
      ]);
      expect(detail.turn).toMatchObject({
        column: 'review',
        addressee: 'orchestrator:review',
        closed: null,
      });
    },
    TIMEOUT,
  );

  it(
    'dispatch-orchestrator-role: shares the PR and branch, receives Review, acks and submits without a worker link',
    async () => {
      await up();
      await seed('dispatch-orchestrator-role');
      const review = await mustTurn(as('orchestrator'));
      expect(review.column).toBe('review');
      expect(
        await withStore((store) =>
          store.db
            .selectFrom('link')
            .selectAll()
            .where('session_id', '=', as('orchestrator'))
            .where('role', '=', 'worker')
            .execute(),
        ),
      ).toEqual([]);
      await ack(as('orchestrator'), review.id);
      expect((await mustTurn(as('orchestrator'))).taken).toMatchObject({
        by: `agent:stand-qa/${as('orchestrator')}`,
      });
      expect((await submit(as('orchestrator'), review.id, A)).task.column).toBe('ready-to-merge');
      expect(await ok(current(), '/violations')).toMatchObject({ total: 0 });
    },
    TIMEOUT,
  );

  it(
    'dispatch-review-loop: a new head goes back to Review and on to Ready to Merge',
    async () => {
      await up();
      await seed('dispatch-review-loop');
      const dev = await mustTurn(as('worker'));
      await ack(as('worker'), dev.id);
      await github('push', { sha: B });
      await github('ci-green');
      expect((await submit(as('worker'), dev.id, B)).task.column).toBe('review');
      const review = await mustTurn(as('orchestrator'));
      expect(review).toMatchObject({
        column: 'review',
        reason: 'review: no_review_on_head',
        head: B,
      });
      await ack(as('orchestrator'), review.id);
      expect((await submit(as('orchestrator'), review.id, B)).task.column).toBe('ready-to-merge');
    },
    TIMEOUT,
  );

  /** Every `task_submitted` payload, oldest first. */
  const submitted = () =>
    withStore(async (store) =>
      (
        await store.db
          .selectFrom('event')
          .select('payload')
          .where('kind', '=', 'task_submitted')
          .orderBy('id')
          .execute()
      ).map(({ payload }) => JSON.parse(payload) as Record<string, unknown>),
    );
  const submissions = () =>
    withStore((store) =>
      store.db.selectFrom('submission').select(['column', 'commit_sha']).orderBy('id').execute(),
    );
  interface GraphqlRequest {
    seq: number;
    operation: string;
    numbers: number[];
  }
  // Through `ok`: the `github` helper adds repo and number, which inspect refuses.
  const githubRequests = async () =>
    (
      (await ok(current(), '/fake', { system: 'github', verb: 'inspect', args: {} })) as {
        requests: GraphqlRequest[];
      }
    ).requests;
  const turnNumber = (turn: string) => Number(turn.slice(1));

  it(
    'dispatch-review-loop: a submit reads the head again after a one-off GitHub failure',
    async () => {
      await up();
      await seed('dispatch-review-loop');
      const dev = await mustTurn(as('worker'));
      await ack(as('worker'), dev.id);
      await github('push', { sha: B });
      await poll();
      const last = Math.max(0, ...(await githubRequests()).map(({ seq }) => seq));
      await github('fail', { mode: 'server-error', times: 1 });

      await submit(as('worker'), dev.id, B);

      expect((await submitted()).at(-1)).toEqual({
        turn: dev.id,
        column: 'dev',
        sha: B,
        basis: 'tested',
      });
      expect((await turnRow(turnNumber(dev.id))).closed_at).not.toBeNull();
      // The first read failed; the second read of the same PR answered the submit.
      const after = (await githubRequests()).filter(({ seq }) => seq > last).slice(0, 2);
      expect(after.map(({ operation, numbers }) => [operation, numbers])).toEqual([
        ['PrDetails', [1]],
        ['PrDetails', [1]],
      ]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-review-loop: a submit on the polled head goes through while GitHub is down',
    async () => {
      await up();
      await seed('dispatch-review-loop');
      const dev = await mustTurn(as('worker'));
      await ack(as('worker'), dev.id);
      await poll();
      const before = await submissions();
      await github('fail', { mode: 'server-error' });

      await submit(as('worker'), dev.id, A);

      expect((await submitted()).at(-1)).toEqual({
        basis: 'tested',
        turn: dev.id,
        column: 'dev',
        sha: A,
        confirmedByPoll: true,
      });
      expect(await submissions()).toEqual([...before, { column: 'dev', commit_sha: A }]);
      expect((await turnRow(turnNumber(dev.id))).closed_at).not.toBeNull();
      const history = await op<{ events: { kind: string; summary: string }[] }>(
        current(),
        'task.history',
        { task: ISSUE },
      );
      expect(history.events.filter(({ kind }) => kind === 'task_submitted').at(-1)).toMatchObject({
        summary: `Turn submitted on the head of the last poll: ${A}, basis tested`,
      });
      await github('fail', { mode: 'clear' });
    },
    TIMEOUT,
  );

  it(
    'dispatch-review-loop: a head no poll saw is accepted pending while GitHub is down',
    async () => {
      await up();
      await seed('dispatch-review-loop');
      const dev = await mustTurn(as('worker'));
      await ack(as('worker'), dev.id);
      await github('fail', { mode: 'server-error' });
      await github('push', { sha: B });

      const response = await fetch(`${current().daemonUrl}/v1/ops/task.submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board-session': as('worker') },
        body: JSON.stringify({ input: { turn: dev.id, sha: B }, key: randomUUID() }),
      });
      const body = (await response.json()) as { value: { status: string } };

      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.value.status).toBe('pending');
      expect((await turnRow(turnNumber(dev.id))).closed_reason).toBe('submitted');
      const pending = () =>
        withStore((store) =>
          store.db
            .selectFrom('submission')
            .select(['commit_sha', 'pending_until'])
            .where('commit_sha', '=', B)
            .executeTakeFirstOrThrow(),
        );
      expect((await pending()).pending_until).not.toBeNull();

      await github('fail', { mode: 'clear' });
      await poll();
      expect((await pending()).pending_until).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'dispatch-ci-red-after-submit: the red checks turn, then a green new head passes Dev',
    async () => {
      await up();
      await seed('dispatch-ci-red-after-submit');
      expect((await moves()).filter(({ from }) => from === 'dev')).toEqual([]);
      expect(await turnRow(1)).toMatchObject({ column: 'dev', closed_reason: 'submitted' });
      const red = await mustTurn(as('worker'));
      expect(red).toMatchObject({ reason: 'dev: checks_red', taken: null });
      await ack(as('worker'), red.id);
      await github('push', { sha: C });
      await github('ci-green');
      expect((await submit(as('worker'), red.id, C)).task.column).toBe('review');
    },
    TIMEOUT,
  );

  it(
    "dispatch-conflict-in-review: the conductor's submit sends the task to Dev",
    async () => {
      await up();
      await seed('dispatch-conflict-in-review');
      const review = await mustTurn(as('orchestrator'));
      expect((await submit(as('orchestrator'), review.id, A)).task.column).toBe('dev');
      expect((await moves()).at(-1)).toEqual({
        from: 'review',
        to: 'dev',
        reason: 'gate_broken',
        gate: ['conflict'],
      });
      expect(await mustTurn(as('worker'))).toMatchObject({
        column: 'dev',
        reason: 'dev: conflict, no_submit_on_head',
      });
    },
    TIMEOUT,
  );

  it(
    'dispatch-conflict-in-ready-to-merge: a new head passes Dev into a new Review turn',
    async () => {
      await up();
      await seed('dispatch-conflict-in-ready-to-merge');
      expect((await moves()).at(-1)).toEqual({
        from: 'ready-to-merge',
        to: 'dev',
        reason: 'gate_broken',
        gate: ['conflict'],
      });
      const dev = await mustTurn(as('worker'));
      await ack(as('worker'), dev.id);
      await github('push', { sha: B });
      await github('ci-green');
      expect((await submit(as('worker'), dev.id, B)).task.column).toBe('review');
      expect(await mustTurn(as('orchestrator'))).toMatchObject({
        column: 'review',
        reason: 'review: no_review_on_head',
        head: B,
        taken: null,
      });
    },
    TIMEOUT,
  );

  it(
    'dispatch-reentry-same-head: a submit on the reviewed head passes Review without a turn',
    async () => {
      await up();
      await seed('dispatch-reentry-same-head');
      const before = (await moves()).length;
      const dev = await mustTurn(as('worker'));
      await ack(as('worker'), dev.id);
      expect((await submit(as('worker'), dev.id, A)).task.column).toBe('ready-to-merge');
      expect((await fromTo()).slice(before)).toEqual([
        ['dev', 'review', 'gate_passed'],
        ['review', 'ready-to-merge', 'gate_passed'],
      ]);
      const columns = await withStore((store) =>
        store.db.selectFrom('turn').select('column').orderBy('id').execute(),
      );
      // Dev, Review, Ready to Merge, the re-entry's Dev, then Ready to Merge again: no second Review.
      expect(columns.map((row) => row.column)).toEqual([
        'dev',
        'review',
        'ready-to-merge',
        'dev',
        'ready-to-merge',
      ]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-unresolved-thread: a submit after resolving reaches Ready to Merge without a Review turn',
    async () => {
      await up();
      await seed('dispatch-unresolved-thread');
      expect((await moves()).at(-1)).toEqual({
        from: 'ready-to-merge',
        to: 'dev',
        reason: 'gate_broken',
        gate: ['unresolved_threads'],
      });
      const dev = await mustTurn(as('worker'));
      expect(dev.reason).toBe('dev: unresolved_threads, no_submit_on_head');
      expect(dev.threads).toEqual([
        {
          id: 'PRRT_1_0',
          url: expect.stringMatching(/#discussion_r0$/) as unknown,
          outdated: false,
        },
      ]);
      const before = (await moves()).length;
      const reviews = (await turnsIn('review')).length;

      await github('resolve');
      await ack(as('worker'), dev.id);
      expect((await submit(as('worker'), dev.id, A)).task.column).toBe('ready-to-merge');
      expect((await fromTo()).slice(before)).toEqual([
        ['dev', 'review', 'gate_passed'],
        ['review', 'ready-to-merge', 'gate_passed'],
      ]);
      expect(await turnsIn('review')).toHaveLength(reviews);
    },
    TIMEOUT,
  );

  it(
    'dispatch-approval-with-notes: both notes resolved, a Dev submit reaches Ready to Merge with no new approval',
    async () => {
      await up();
      await seed('dispatch-approval-with-notes');
      expect((await fromTo()).slice(-2)).toEqual([
        ['external-review', 'ready-to-merge', 'gate_passed'],
        ['ready-to-merge', 'dev', 'gate_broken'],
      ]);
      const dev = await mustTurn(as('worker'));
      expect(dev.threads?.map(({ id }) => id)).toEqual(['PRRT_1_0', 'PRRT_1_1']);
      const before = (await moves()).length;

      await github('resolve', { thread: 'PRRT_1_0' });
      await github('resolve', { thread: 'PRRT_1_1' });
      await ack(as('worker'), dev.id);
      expect((await submit(as('worker'), dev.id, A)).task.column).toBe('ready-to-merge');
      expect((await fromTo()).slice(before)).toEqual([
        ['dev', 'review', 'gate_passed'],
        ['review', 'external-review', 'gate_passed'],
        ['external-review', 'ready-to-merge', 'gate_passed'],
      ]);
      const reviews = await withStore(async (store) => {
        const row = await store.db
          .selectFrom('pr_snapshot')
          .select('detail')
          .where('number', '=', 1)
          .executeTakeFirstOrThrow();
        return (JSON.parse(row.detail) as { reviews: unknown[] }).reviews;
      });
      expect(reviews).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'dispatch-reviewer-status-comment: status comments leave the task, a free-form comment returns it',
    async () => {
      await up();
      await seed('dispatch-reviewer-status-comment');
      expect(await column()).toBe('ready-to-merge');
      expect(await turnOf(as('worker'))).toBeUndefined();

      await github('comment');
      await poll();
      const turn = await mustTurn(as('worker'));
      expect(turn).toMatchObject({ reason: 'dev: external_comments, no_submit_on_head' });
      expect(turn.handed.map(({ kind, id }) => [kind, id])).toEqual([['comment', 'IC_1_2']]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-external-comment: the after-submit turn hands only the external feedback',
    async () => {
      await up();
      await seed('dispatch-external-comment');
      const dev = await mustTurn(as('worker'));
      expect(await submit(as('worker'), dev.id, A)).toMatchObject({ task: { column: 'dev' } });
      const handing = await mustTurn(as('worker'));
      expect(handing.reason).toBe('dev: external_comments');
      expect(handing.handed).toHaveLength(2);
      expect(handing.handed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'comment', id: 'IC_1_150' }),
          expect.objectContaining({ kind: 'review', id: 'PRR_1_0' }),
        ]),
      );
      await ack(as('worker'), handing.id);
      expect((await submit(as('worker'), handing.id, A)).task.column).toBe('review');
    },
    TIMEOUT,
  );

  it(
    'dispatch-long-comment-history: an old external comment is handed by the turned submit and the task leaves Dev',
    async () => {
      await up();
      await seed('dispatch-long-comment-history');
      interface Why {
        why: {
          gates: {
            column: string;
            conditions: { condition: string; state: string; reason?: string }[];
          }[];
        };
      }
      const devConditions = async () =>
        (await op<Why>(current(), 'task.get', { task: ISSUE, why: true })).why.gates.find(
          (gate) => gate.column === 'dev',
        )?.conditions ?? [];
      const history = async () =>
        (await devConditions()).find(({ condition }) => condition === 'comment_history_read');
      const waiting = {
        condition: 'comment_history_read',
        state: 'waiting',
        reason: 'comment_history_incomplete',
      };
      // The seed's poll read the newest 300 of 650 comments; each poll reads 3 pages of 100.
      expect(await history()).toEqual(waiting);
      await poll();
      expect(await history()).toEqual(waiting);
      await poll();
      expect(await history()).toMatchObject({ state: 'met' });
      expect(await devConditions()).toContainEqual({
        condition: 'external_comments_handled',
        state: 'failed',
        reason: 'external_comments',
      });

      await github('comment');
      const dev = await mustTurn(as('worker'));
      expect(dev).toMatchObject({ id: 'T1', reason: 'dev: no_pr' });
      expect((await submit(as('worker'), dev.id, A)).task.column).toBe('dev');
      // No regular poll since the comment: the submit's on-demand read used the held history.
      const handing = await mustTurn(as('worker'));
      expect(handing.reason).toBe('dev: external_comments');
      expect(handing.handed.map(({ id }) => id).sort()).toEqual(['IC_1_10', 'IC_1_650']);
      await ack(as('worker'), handing.id);
      expect((await submit(as('worker'), handing.id, A)).task.column).toBe('review');
      expect((await fromTo()).at(-1)).toEqual(['dev', 'review', 'gate_passed']);

      await poll();
      const held = await withStore((store) =>
        store.db.selectFrom('pr_continuation').select('ref_key').execute(),
      );
      expect(held).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-ci-pending-after-submit: no Review turn and no ring while CI runs on the submitted head, then a Review turn on A',
    async () => {
      await up();
      await seed('dispatch-ci-pending-after-submit');
      expect((await turnsIn('dev')).map(({ closed_reason }) => closed_reason)).toContain(
        'submitted',
      );
      const reviews = await turnsIn('review');
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ head_sha: A });
      expect(await mustTurn(as('orchestrator'))).toMatchObject({
        reason: 'review: no_review_on_head',
        head: A,
      });
    },
    TIMEOUT,
  );

  it(
    'dispatch-submit-before-pr-linked: the next poll confirms a pending submit and Review opens',
    async () => {
      await up();
      await seed('dispatch-submit-before-pr-linked');
      expect((await turnsIn('dev')).map(({ closed_reason }) => closed_reason)).toContain(
        'submitted',
      );
      expect(await mustTurn(as('orchestrator'))).toMatchObject({
        reason: 'review: no_review_on_head',
        head: A,
      });
      expect(await turnOf(as('worker'))).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    'dispatch-submit-head-moved: a pending submit on a moved head returns the Dev turn',
    async () => {
      await up();
      await seed('dispatch-submit-head-moved');
      expect((await mustTurn(as('worker'))).reason).toContain('head moved to bbbbbbb');
    },
    TIMEOUT,
  );

  it(
    'dispatch-submit-no-pr: a pending submit with no PR past the bound returns the Dev turn',
    async () => {
      await up();
      await seed('dispatch-submit-no-pr');
      expect((await mustTurn(as('worker'))).reason).toBe(
        'dev: no_pr (submit of aaaaaaa: no PR found for stand-worker)',
      );
    },
    TIMEOUT,
  );

  it(
    'dispatch-new-head-in-ready-to-merge: a new head closes the taken Ready to Merge turn and sends the task to Dev',
    async () => {
      await up();
      await seed('dispatch-new-head-in-ready-to-merge');
      expect(await fromTo()).toContainEqual(['ready-to-merge', 'dev', 'gate_broken']);
      const [ready, ...more] = await turnsIn('ready-to-merge');
      expect(more).toEqual([]);
      expect(ready?.acked_at).not.toBeNull();
      expect(ready).toMatchObject({ closed_reason: 'moved' });
      const reviews = await turnsIn('review');
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).toMatchObject({ head_sha: A, closed_reason: 'submitted' });
      expect(reviews[1]).toMatchObject({ head_sha: B, closed_at: null });
      expect(await mustTurn(as('orchestrator'))).toMatchObject({ head: B, taken: null });
    },
    TIMEOUT,
  );

  it(
    'dispatch-ci-red-new-head-in-product-review: red CI on a new head closes the taken Product Review turn and sends the task to Dev',
    async () => {
      await up();
      await seed('dispatch-ci-red-new-head-in-product-review');
      const last = (await moves()).at(-1);
      expect(last).toMatchObject({ from: 'product-review', to: 'dev', reason: 'gate_broken' });
      expect(last?.gate).toEqual(expect.arrayContaining(['checks_red', 'no_submit_on_head']));
      const [product, ...more] = await turnsIn('product-review');
      expect(more).toEqual([]);
      expect(product?.acked_at).not.toBeNull();
      expect(product).toMatchObject({ closed_reason: 'moved' });
      expect(await mustTurn(as('worker'))).toMatchObject({
        reason: 'dev: checks_red, no_submit_on_head',
        taken: null,
      });
    },
    TIMEOUT,
  );

  it(
    'dispatch-ring-closed-turn: the ring for a turn a new head closed dies as no longer current',
    async () => {
      await up();
      await seed('dispatch-ring-closed-turn');
      const [review, ...more] = await turnsIn('review');
      expect(more).toEqual([]);
      expect(review).toMatchObject({ closed_reason: 'moved' });
      const rings = (
        await withStore((store) =>
          store.db.selectFrom('outbox').selectAll().where('kind', '=', 'doorbell').execute(),
        )
      ).filter(
        ({ payload }) =>
          (JSON.parse(payload) as { session?: string }).session === as('orchestrator'),
      );
      expect(rings).toHaveLength(1);
      expect(rings[0]).toMatchObject({
        state: 'dead',
        last_error: 'notification no longer current',
      });
      expect((await fromTo()).at(-1)).toEqual(['review', 'dev', 'gate_broken']);
    },
    TIMEOUT,
  );

  it(
    'dispatch-dead-executor: an operator relink reroutes the turn to a new worker',
    async () => {
      await up();
      const { scenario } = await seed('dispatch-dead-executor');
      const item = scenario.items?.['turn'] ?? '';
      const id = Number(item.replace('turn:', ''));
      expect(await turnRow(id)).toMatchObject({ role: 'operator', closed_at: null });

      const next = 'stand-worker-2';
      await spur('session', {
        id: next,
        project: 'stand-worker',
        status: 'running',
        state: 'working',
      });
      await poll();
      await vi.waitFor(
        async () => {
          const live = await withStore((store) =>
            store.db
              .selectFrom('session_snapshot')
              .select('ended_at')
              .where('id', '=', next)
              .executeTakeFirst(),
          );
          expect(live).toEqual({ ended_at: null });
        },
        { timeout: 10_000, interval: 200 },
      );
      const relink = { mode: 'session', task: ISSUE, reason: 'The worker was killed.' };
      await op(current(), 'link.remove', { ...relink, session: as('worker') });
      await op(current(), 'link.add', { ...relink, session: next });
      expect(await sessionLink(as('worker'))).toEqual({ role: 'worker', banned: 1 });
      expect(await sessionLink(next)).toEqual({ role: 'worker', banned: 0 });
      await vi.waitFor(
        async () => {
          await poll();
          expect(await itemKeys()).not.toContain(item);
        },
        { timeout: 30_000, interval: 500 },
      );
      expect(await turnRow(id)).toMatchObject({ closed_reason: 'rerouted' });
      const { turns } = await sessionOp<Inbox>(next, 'inbox.get');
      expect(turns).toEqual([
        expect.objectContaining({
          task: ISSUE,
          column: 'dev',
          addressee: 'worker',
          reason: 'dev: no_submit_on_head',
          taken: null,
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'dispatch-source-blind: the Dev turn opens once GitHub answers again',
    async () => {
      await up();
      await seed('dispatch-source-blind');
      expect(await turnOf(as('worker'))).toBeUndefined();
      await github('fail', { mode: 'clear' });
      await poll();
      expect(await mustTurn(as('worker'))).toMatchObject({
        column: 'dev',
        reason: 'dev: no_submit_on_head',
      });
    },
    TIMEOUT,
  );

  it(
    'dispatch-cycle-limit: closing the limit item opens the Dev turn',
    async () => {
      await up();
      const { scenario } = await seed('dispatch-cycle-limit');
      const key = scenario.items?.['limit'];
      expect(key).toMatch(/^cycle-limit:\d+:review$/);
      const item = (await status(current())).items.find((candidate) => candidate.key === key) as
        { id: string } | undefined;
      if (item === undefined) throw new Error(`no item ${String(key)}`);
      await op(current(), 'item.close', { item: item.id });
      await poll();
      expect(await mustTurn(as('worker'))).toMatchObject({
        column: 'dev',
        reason: 'dev: no_submit_on_head',
      });
    },
    TIMEOUT,
  );

  it(
    "dispatch-course-check: the curator's answer rings the note, the held block, then one Dev turn",
    async () => {
      await up();
      const { scenario } = await seed('dispatch-course-check');
      expect(configText(current())).toContain(
        "# Scenario dispatch-course-check sets the stand project's Spur projects here.\n",
      );
      const block = scenario.blocks?.['course'];
      const code = scenario.blocks?.['code'];
      const key = scenario.items?.['course'];
      expect(key).toMatch(/^course-check:\d+:review$/);
      if (block === undefined || code === undefined) throw new Error('no course or code block');
      /** What each worker send on the task names: `B<n>` for a block, `T<n>` for a turn. */
      const workerRings = async () =>
        (await inspect(current())).sends
          .filter(
            ({ session, message }) => session === as('worker') && message.includes(`${ISSUE} `),
          )
          .map(({ message }) => /(?:block|turn) ([BT]\d+)[: ]/.exec(message)?.[1] ?? message);
      const why = async () =>
        (
          await op<{ why: { heldBy?: string[] } }>(current(), 'task.get', {
            task: ISSUE,
            why: true,
          })
        ).why;
      expect(await workerRings()).toEqual([]);
      expect((await why()).heldBy).toEqual([block]);

      const note = 'Keep the parser as it is and finish the empty-list case.';
      await sessionOp(as('curator'), 'block.answer', { block, text: note }, randomUUID());
      await poll();
      const turn = await mustTurn(as('worker'));
      expect(turn).toMatchObject({ column: 'dev', reason: 'dev: no_submit_on_head' });
      await vi.waitFor(
        async () => {
          expect(await workerRings()).toEqual([block, code, turn.id]);
        },
        { timeout: 20_000, interval: 100 },
      );

      await poll();
      await ok(current(), '/wait', { condition: 'outbox-drained', timeoutMs: 10_000 });
      expect(await workerRings()).toEqual([block, code, turn.id]);
      expect((await mustTurn(as('worker'))).id).toBe(turn.id);
      const { comments } = await sessionOp<{ comments: { block: string | null; text: string }[] }>(
        as('worker'),
        'inbox.get',
      );
      expect(comments.filter((comment) => comment.text === note)).toEqual([
        expect.objectContaining({ block: null, text: note }),
      ]);
      expect(await why()).not.toHaveProperty('heldBy');
      expect((await status(current())).items.map((item) => item.key)).not.toContain(key);
    },
    TIMEOUT,
  );

  it(
    "dispatch-course-check-to: the conductor's answer rings the worker the note and resumes Dev",
    async () => {
      await up();
      const { scenario } = await seed('dispatch-course-check-to');
      const block = scenario.blocks?.['course'];
      const code = scenario.blocks?.['code'];
      const key = scenario.items?.['course'];
      expect(key).toMatch(/^course-check:\d+:review$/);
      if (block === undefined || code === undefined) throw new Error('no course or code block');
      const sends = async (role: 'worker' | 'orchestrator' | 'curator', text: string) =>
        (await inspect(current())).sends.filter(
          ({ session, message }) => session === as(role) && message.includes(text),
        );
      const workerRings = async () =>
        (await sends('worker', `${ISSUE} `)).map(
          ({ message }) => /(?:block|turn) ([BT]\d+)[: ]/.exec(message)?.[1] ?? message,
        );
      const { blocks } = await op<{ blocks: { id: string; addressee: string }[] }>(
        current(),
        'task.get',
        { task: ISSUE },
      );
      expect(blocks.find(({ id }) => id === block)?.addressee).toBe('orchestrator:review');
      expect(await sends('orchestrator', `block ${block}:`)).not.toEqual([]);
      expect(await sends('curator', `block ${block}:`)).toEqual([]);
      expect(await workerRings()).toEqual([]);

      const note = 'Keep the parser as it is and finish the empty-list case.';
      await sessionOp(as('orchestrator'), 'block.answer', { block, text: note }, randomUUID());
      await poll();
      const turn = await mustTurn(as('worker'));
      expect(turn).toMatchObject({ column: 'dev', reason: 'dev: no_submit_on_head' });
      await vi.waitFor(
        async () => {
          expect(await workerRings()).toEqual([block, code, turn.id]);
        },
        { timeout: 20_000, interval: 100 },
      );
      expect((await status(current())).items.map((item) => item.key)).not.toContain(key);
    },
    TIMEOUT,
  );
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

  it('reset restores the Jira tickets and failure plan of the snapshot, without seeding again', async () => {
    const { scenario, seeds } = counted(
      SCENARIOS.find(({ name }) => name === 'columns-basic-jira') as Scenario,
    );
    await up({ scenarios: [scenario] });
    const seeded = (await ok(current(), '/seed', { scenario: scenario.name })) as ResetAnswer;
    expect(seeded.snapshot).toBe('taken');
    await ok(current(), '/wait', SEED_WAIT);
    const before = await capture(current());

    const jira = (args: object) =>
      control(current(), '/fake', { system: 'jira', verb: 'issue', args });
    expect((await jira({ key: 'STAND-1', status: 'Done' })).status).toBe(200);
    expect((await jira({ key: 'STAND-11' })).status).toBe(200);
    await ok(current(), '/fake', { system: 'jira', verb: 'fail', args: { mode: 'auth' } });
    await ok(current(), '/poll');

    const reset = (await ok(current(), '/reset')) as ResetAnswer;
    expect(reset.snapshot).toBe('restored');
    expect(seeds()).toBe(1);
    await ok(current(), '/wait', SEED_WAIT);
    expect((await capture(current())).tasks).toEqual(before.tasks);
    // STAND-1 is back at its seeded status, STAND-11 is gone and takes the id it took before.
    expect((await jira({ key: 'STAND-1' })).status).toBe(409);
    expect(await jira({ key: 'STAND-1', title: 'probe' })).toMatchObject({
      status: 200,
      body: { id: '10001', status: 'To Do' },
    });
    expect(await jira({ key: 'STAND-11' })).toMatchObject({ status: 200, body: { id: '10011' } });
    // The snapshot's failure plan had no Jira failure.
    await ok(current(), '/poll');
    const { sources } = await status(current());
    expect(sources).toContainEqual(
      expect.objectContaining({ source: 'jira:stand-jira', blindReason: null }),
    );
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

  it('a missing snapshot file of a matching record stops the stand', async () => {
    const { scenario, seeds } = counted(SCENARIOS.find(({ name }) => name === 'empty') as Scenario);
    const manifest = await up({ scenarios: [scenario] });
    await seed('empty');
    const [file] = snapshotFiles(manifest, 'empty');
    if (file === undefined) throw new Error('no snapshot');
    rmSync(join(manifest.home, 'snapshots', file));
    const reset = await control(current(), '/reset');
    checked = undefined;
    expect(reset.status).toBe(500);
    expect(reset.body).toMatchObject({ error: expect.any(String) as unknown });
    expect(seeds()).toBe(1);
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

  it('a restore never reissues a Slack ts the retiring fake already issued', async () => {
    // A clock that moves only when the test steps it: the sender takes one send per space per
    // second of it, and the fake stamps a ts from it.
    let at = Date.now();
    await up({ clock: { now: () => at } });
    const { scenario } = await seed('question-to-operator');
    const task = scenario.tasks?.['question'];
    if (task === undefined) throw new Error('no question task');
    const stamps = async (): Promise<bigint[]> => {
      const { messages } = (await ok(current(), '/fake/slack/outbox')) as {
        messages: { message: string }[];
      };
      return messages.map(({ message }) => {
        const { ts } = JSON.parse(message) as { ts: string };
        return BigInt(ts.replace('.', ''));
      });
    };
    const ask = async (text: string): Promise<void> => {
      const manifest = current();
      const response = await fetch(`${manifest.daemonUrl}/v1/ops/block.ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board-session': manifest.roles.worker },
        body: JSON.stringify({ input: { task, text }, key: text }),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    const drain = async (): Promise<void> => {
      for (let step = 0; step < 20; step += 1) {
        const drained = await control(current(), '/wait', {
          condition: 'outbox-drained',
          timeoutMs: 1_500,
        });
        if (drained.status === 200) return;
        at += 1_000;
      }
      throw new Error('the outbox did not drain');
    };
    const seeded = new Set(await stamps());
    await ask('Posted after the snapshot?');
    await drain();
    const before = await stamps();
    const highest = before.reduce((a, b) => (a > b ? a : b));
    expect(before.length).toBeGreaterThan(seeded.size);

    // The clock holds still across the reset, so only the fake's high-water mark keeps the next
    // ts above the ones the retiring fake issued.
    expect(((await ok(current(), '/reset')) as ResetAnswer).snapshot).toBe('restored');
    await ok(current(), '/wait', SEED_WAIT);
    await ask('Posted after the restore?');
    await drain();
    const after = (await stamps()).filter((ts) => !seeded.has(ts));
    expect(after.length).toBeGreaterThan(0);
    for (const ts of after) expect(ts > highest, `${String(ts)} > ${String(highest)}`).toBe(true);
  }, 90_000);

  it('a snapshot whose token request expired by the clock re-seeds at reset', async () => {
    const { scenario, seeds } = counted(
      SCENARIOS.find(({ name }) => name === 'token-approval') as Scenario,
    );
    await up({ scenarios: [scenario] });
    await seed('token-approval');
    // Past the request's 15-minute lifetime: a restored request would come back expired.
    await ok(current(), '/clock', { shiftMs: 16 * 60_000 });
    const reset = (await ok(current(), '/reset')) as ResetAnswer;
    expect(reset.snapshot).toBe('taken');
    expect(seeds()).toBe(2);
    await ok(current(), '/wait', SEED_WAIT);
    const n = Number(reset.scenario.messages?.['approval']);
    const message = (await outbox(current())).find((candidate) => candidate.n === n);
    const approve = message?.actions.find((action) => /^token:\d+:approve$/.test(action));
    if (approve === undefined) throw new Error('no approve button');
    expect(await ok(current(), '/fake/slack/click', { message: n, button: approve })).toEqual({
      ok: true,
      responses: ['stand-tester: approved'],
    });
    const { tokens } = await op<{ tokens: { name: string; status: string }[] }>(
      current(),
      'token.list',
      {},
    );
    expect(tokens).toContainEqual(
      expect.objectContaining({ name: 'stand-tester', status: 'approved' }),
    );
    // The new snapshot is fresh again: the next reset restores it.
    expect(((await ok(current(), '/reset')) as ResetAnswer).snapshot).toBe('restored');
    expect(seeds()).toBe(2);
  }, 120_000);

  it('the stand clock does not move back across a restore-reset', async () => {
    await up();
    await seed('empty');
    const shifted = (await ok(current(), '/clock', { shiftMs: 3_600_000 })) as { now: string };
    expect(((await ok(current(), '/reset')) as ResetAnswer).snapshot).toBe('restored');
    const after = (await ok(current(), '/clock', { shiftMs: 1 })) as { now: string };
    expect(Date.parse(after.now)).toBeGreaterThanOrEqual(Date.parse(shifted.now) + 1);
  }, 60_000);
});

it('pr-finality: final PRs cost discovery only, closed probes honor persisted deadlines, reopen and refresh read current facts', async () => {
  const repo = 'stand-org/board';
  const merged = `${repo}#1`;
  const initial = Date.parse('2026-11-14T12:00:00.000Z');
  await up({ clock: { now: () => initial } });
  await seed('pr-finality');
  interface RequestRecord {
    seq: number;
    at: string;
    operation: string;
    repo: string;
    numbers: number[];
    points: number;
  }
  const requests = async () =>
    (
      (await ok(current(), '/fake', { system: 'github', verb: 'inspect', args: {} })) as {
        requests: RequestRecord[];
      }
    ).requests.filter((request) => request.repo === repo);
  const change = (verb: string, number: number, extra: object = {}) =>
    ok(current(), '/fake', { system: 'github', verb, args: { repo, number, ...extra } });
  const poll = async () => {
    const result = (await ok(current(), '/poll')) as { outcomes: { outcome: string }[] };
    expect(result.outcomes.every(({ outcome }) => outcome === 'delivered')).toBe(true);
  };
  const shift = async (shiftMs: number) => {
    const result = (await ok(current(), '/clock', { shiftMs })) as { now: string };
    return Date.parse(result.now);
  };
  const snapshot = async (number: number) => {
    const store = openStore(join(current().home, 'board.sqlite'));
    try {
      return await store.db
        .selectFrom('pr_snapshot')
        .selectAll()
        .where('repo', '=', repo)
        .where('number', '=', number)
        .executeTakeFirstOrThrow();
    } finally {
      await store.close();
    }
  };
  const history = async () => {
    const store = openStore(join(current().home, 'board.sqlite'));
    try {
      const task = await store.db
        .selectFrom('task')
        .select('id')
        .where('key', '=', `${repo}#2`)
        .executeTakeFirstOrThrow();
      return await store.db
        .selectFrom('event')
        .selectAll()
        .where('task_id', '=', task.id)
        .where('kind', '=', 'pr_facts_changed')
        .execute();
    } finally {
      await store.close();
    }
  };
  const points = async (now: number) => {
    const status = await op<{
      sources: {
        source: string;
        pointsLastHour?: number;
        budget: { remaining: number; limit: number | null; resetAt: string } | null;
      }[];
    }>(current(), 'status.get');
    const expected = (await requests())
      .filter(
        (request) => Date.parse(request.at) > now - 3_600_000 && Date.parse(request.at) <= now,
      )
      .reduce((sum, request) => sum + request.points, 0);
    const source = status.sources.find((entry) => entry.source === `github:stand:${repo}`);
    expect(source?.pointsLastHour).toBe(expected);
    // The fake GitHub reports its full budget on every response, so the stored one is the last.
    const resetAt = source?.budget?.resetAt;
    expect(resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(source?.budget).toEqual({ remaining: 5000, limit: 5000, resetAt });
  };
  let now = Date.parse((await snapshot(2)).observed_at);
  const closed = await snapshot(2);
  const events = await history();
  let baseline = (await requests()).at(-1)?.seq ?? 0;
  for (let i = 0; i < 3; i++) await poll();
  let added = (await requests()).filter((request) => request.seq > baseline);
  expect(added).toHaveLength(3);
  expect(
    added.every(
      (request) =>
        request.operation === 'PrBatch' && request.numbers.length === 0 && request.points === 1,
    ),
  ).toBe(true);
  await points(now);

  // Explicit reads reach final PRs; a stored manual key adds no request, a new key does.
  baseline = (await requests()).at(-1)?.seq ?? 0;
  const refreshed = await standCli([
    'board',
    '--home',
    current().home,
    'task',
    merged,
    '--refresh',
    '--json',
  ]);
  expect(refreshed.code, refreshed.stderr).toBe(0);
  const input = {
    mode: 'pr',
    task: merged,
    pr: `https://github.com/${repo}/pull/1`,
    reason: 'Refresh the final linked pull request.',
  };
  await op(current(), 'link.add', input, 'finality-link-first');
  await op(current(), 'link.add', input, 'finality-link-first');
  await op(current(), 'link.add', input, 'finality-link-second');
  added = (await requests()).filter((request) => request.seq > baseline);
  expect(added.map(({ operation, numbers, points }) => ({ operation, numbers, points }))).toEqual(
    Array.from({ length: 3 }, () => ({ operation: 'PrDetails', numbers: [1], points: 5 })),
  );
  await points(now);

  baseline = (await requests()).at(-1)?.seq ?? 0;
  now = await shift(6 * 3_600_000 - 1);
  await poll();
  expect(
    (await requests())
      .filter((request) => request.seq > baseline)
      .every((request) => request.numbers.length === 0),
  ).toBe(true);
  expect(await snapshot(2)).toEqual(closed);

  // OPEN discovery bypasses the not-yet-due closed deadline.
  await change('reopen', 3);
  baseline = (await requests()).at(-1)?.seq ?? 0;
  await poll();
  added = (await requests()).filter((request) => request.seq > baseline);
  expect(
    added.filter((request) => request.numbers.includes(3)).map((request) => request.operation),
  ).toEqual(['PrDetails']);
  expect((await snapshot(3)).state).toBe('open');
  expect(added.some((request) => request.numbers.includes(2))).toBe(false);

  baseline = (await requests()).at(-1)?.seq ?? 0;
  now = await shift(1);
  await poll();
  added = (await requests()).filter((request) => request.seq > baseline);
  expect(
    added
      .filter((request) => request.numbers.includes(2))
      .map((request) => ({ operation: request.operation, points: request.points })),
  ).toEqual([{ operation: 'PrStates', points: 1 }]);
  const probed = await snapshot(2);
  expect({ ...probed, closed_recheck_at: closed.closed_recheck_at }).toEqual(closed);
  expect(Date.parse(probed.closed_recheck_at ?? '')).toBe(now + 6 * 3_600_000);
  expect(await history()).toEqual(events);
  expect(added.some((request) => request.numbers.includes(1) || request.numbers.includes(4))).toBe(
    false,
  );
  await points(now);

  // Put another author's reopen below the discovery cursor, so only its due state probe finds it.
  await change('create', 5, {
    seed: {
      author: { login: 'another-author' },
      updatedAt: new Date(now + 2 * 86_400_000).toISOString(),
    },
  });
  await poll();
  await change('reopen', 2);
  baseline = (await requests()).at(-1)?.seq ?? 0;
  await poll();
  expect(
    (await requests())
      .filter((request) => request.seq > baseline)
      .some((request) => request.numbers.includes(2)),
  ).toBe(false);
  baseline = (await requests()).at(-1)?.seq ?? 0;
  now = await shift(6 * 3_600_000);
  await poll();
  added = (await requests()).filter((request) => request.seq > baseline);
  expect(
    added.filter((request) => request.numbers.includes(2)).map((request) => request.operation),
  ).toEqual(['PrStates', 'PrDetails']);
  expect((await snapshot(2)).state).toBe('open');
  expect((await snapshot(2)).closed_recheck_at).toBeNull();
  expect(added.some((request) => request.numbers.includes(1) || request.numbers.includes(4))).toBe(
    false,
  );
  await points(now);
  expect(await ok(current(), '/violations')).toEqual({ total: 0, items: [] });
}, 90_000);

describe('card scenario', () => {
  it('card-long: one row carries a long title, the operator and code blocks, returned findings and two PRs', async () => {
    await up();
    const { scenario } = await seed('card-long');
    const task = 'stand-org/board#1';
    expect(scenario.prs).toEqual({ flow: task, second: 'stand-org/board#2' });
    interface Row {
      key: string;
      column: string;
      ticket?: { title: string } | null;
      turn: { addressee: string; taken: { by: string } | null } | null;
      returned?: { from: string; findings: number | null };
      blocks: { id: string; addressee: string }[];
      links: { prs: { number: number }[]; sessions: { id: string }[] };
      prSummary: {
        number: number;
        mergeable: string;
        threads: { unresolved: number; total: number };
        reviewsOnHead: { changesRequested: string[] };
      }[];
    }
    const { tasks } = await op<{ tasks: Row[] }>(current(), 'status.get', {
      project: 'stand',
      detail: true,
    });
    const row = tasks.find(({ key }) => key === task);
    expect(row?.column).toBe('dev');
    expect(row?.ticket?.title.length).toBeGreaterThan(100);
    expect(row?.turn).toMatchObject({
      addressee: 'worker',
      taken: { by: expect.stringContaining(current().roles.worker) as unknown },
    });
    expect(row?.returned).toMatchObject({ from: 'review', findings: 5 });
    expect(row?.blocks.map(({ id, addressee }) => [id, addressee]).sort()).toEqual(
      [
        [scenario.blocks?.['code'], 'worker'],
        [scenario.blocks?.['question'], 'operator'],
      ].sort(),
    );
    expect(row?.links.prs.map(({ number }) => number)).toEqual([1, 2]);
    expect(row?.links.sessions.map(({ id }) => id)).toContain(current().roles.worker);
    expect(row?.prSummary.map(({ number, mergeable }) => [number, mergeable])).toEqual([
      [1, 'conflicting'],
      [2, 'mergeable'],
    ]);
    expect(row?.prSummary[0]).toMatchObject({
      threads: { unresolved: 3, total: 3 },
      reviewsOnHead: { changesRequested: ['stand-reviewer'] },
    });
  }, 90_000);
});

describe('readme scenario', () => {
  it('readme-board: real closed issues fill every column with the Dev, Review and Ready to Merge turns', async () => {
    await up({ clock: { now: () => Date.parse('2026-11-14T12:00:00.000Z') } });
    const { scenario } = await seed('readme-board');
    interface Row {
      key: string;
      column: string;
      columnEnteredAt: string;
      ticket?: { title: string } | null;
      turn: { addressee: string; column: string; taken: { by: string } | null } | null;
      blocks: { id: string; addressee: string }[];
    }
    const { tasks } = await op<{ tasks: Row[] }>(current(), 'status.get', {
      project: 'stand',
      detail: true,
    });
    const counts: Record<string, number> = {};
    for (const { column } of tasks) counts[column] = (counts[column] ?? 0) + 1;
    expect(counts).toEqual({ todo: 2, dev: 1, review: 1, 'ready-to-merge': 1, done: 7 });
    const numbers = [627, 631, 621, 620, 611, 558, 559, 560, 561, 562, 563, 564];
    const named = Object.entries(scenario.tasks ?? {});
    expect(named).toHaveLength(numbers.length);
    for (const [name, key] of named) {
      const [column, number] = [name.slice(0, name.lastIndexOf('-')), name.split('-').at(-1)];
      expect(key).toBe(`stand-org/board#${number ?? ''}`);
      expect(numbers).toContain(Number(number));
      expect(tasks.find((row) => row.key === key)?.column, key).toBe(column);
    }
    for (const row of tasks) expect(row.ticket?.title, row.key).not.toMatch(/^Stand issue/);
    const at = (column: string) => tasks.filter((row) => row.column === column);
    const [dev] = at('dev');
    expect(dev?.turn).toMatchObject({
      addressee: 'worker',
      taken: { by: expect.stringContaining(current().roles.worker) as unknown },
    });
    expect(dev?.blocks.map(({ id, addressee }) => [id, addressee])).toEqual([
      [scenario.blocks?.['question'], 'operator'],
    ]);
    expect(at('review')[0]?.turn?.addressee).toBe('orchestrator:review');
    expect(at('ready-to-merge')[0]?.turn).toMatchObject({ column: 'ready-to-merge' });
    for (const row of at('todo')) expect(row.turn, row.key).toBeNull();
    // The seed's 10 ms shift puts its clock at 12:00:00.010; each task entered enteredAgo before.
    expect(
      Object.fromEntries(tasks.map((row) => [row.key.split('#')[1], row.columnEnteredAt])),
    ).toEqual({
      '627': '2026-11-06T12:00:00.010Z',
      '631': '2026-11-13T16:00:00.010Z',
      '621': '2026-11-14T11:18:00.010Z',
      '620': '2026-11-14T09:30:00.010Z',
      '611': '2026-11-14T07:00:00.010Z',
      '558': '2026-11-08T12:00:00.010Z',
      '559': '2026-11-09T12:00:00.010Z',
      '560': '2026-11-10T12:00:00.010Z',
      '561': '2026-11-11T12:00:00.010Z',
      '562': '2026-11-12T12:00:00.010Z',
      '563': '2026-11-13T09:00:00.010Z',
      '564': '2026-11-14T03:00:00.010Z',
    });
    expect(scenario.direct).toEqual([
      'column entry times backdated: no operation sets when a task entered its column (#712)',
    ]);
    expect(await ok(current(), '/violations')).toMatchObject({ total: 0 });
  }, 90_000);
});
