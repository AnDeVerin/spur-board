import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  type Gateway,
  type InboundEvent,
  type InboundSink,
} from '@spur-board/contracts';
import { openStore, type Store } from '@spur-board/core';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonModules } from '../src/composition.ts';
import type { ModuleContext } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';
import { createE2eHarness } from './e2e-harness.ts';

type Harness = Awaited<ReturnType<typeof createE2eHarness>>;
const harnesses: Harness[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface TransportView {
  gateway: string;
  state: 'up' | 'down';
  since: string | null;
  reason: string | null;
  spaces: string[];
}

interface StatusView {
  items: { key: string }[];
  transport: TransportView[];
}

async function status(h: Harness, operator: boolean): Promise<StatusView> {
  const result = await h.cli(['status', '--json'], { operator });
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StatusView;
}

describe('transport outage', () => {
  it('shows a Slack outage in board status and clears it on reconnect', async () => {
    const h = await createE2eHarness();
    harnesses.push(h);
    await h.start();
    const platform = h.gateway.platform;
    const itemKey = `transport:${h.gateway.kind}`;

    platform.dropConnection();
    await platform.settle();
    const droppedAt = platform.now().toISOString();
    // Armed before the ask: whichever tick claims the open first sees the timeout.
    platform.timeoutNext({ visible: false });
    const asked = await h.cli([
      'ask',
      h.taskKey,
      'Which release?',
      '--key',
      'ask-transport-outage',
      '--json',
    ]);
    expect(asked.code, asked.stderr).toBe(0);
    await h.pulse();
    const open = () =>
      h.store.db
        .selectFrom('outbox')
        .select(['state', 'first_attempt_at'])
        .where('kind', '=', 'conversation.open')
        .executeTakeFirstOrThrow();
    expect((await open()).state).toBe('pending');
    const { dedupe_key: askKey } = await h.store.db
      .selectFrom('outbox')
      .select('dedupe_key')
      .where('kind', '=', 'conversation.open')
      .executeTakeFirstOrThrow();
    // A failed open leaves an empty conversation in the fake; posted messages are the proof.
    const posted = () => platform.messages().map((message) => message.marker);

    platform.timeoutNext({ visible: false });
    h.advance(5 * 60_000 + 1000);
    await h.pulse();

    expect(
      await h.store.db
        .selectFrom('transport_health')
        .select(['space', 'reason'])
        .orderBy('space')
        .execute(),
    ).toEqual([
      { space: 'feed', reason: 'down' },
      { space: 'orchestrators', reason: 'down' },
    ]);
    expect(await open()).toEqual({ state: 'pending', first_attempt_at: null });
    const operator = await status(h, true);
    expect(operator.transport).toEqual([
      {
        gateway: h.gateway.kind,
        state: 'down',
        since: droppedAt,
        reason: 'down',
        spaces: ['feed', 'orchestrators'],
      },
    ]);
    expect(operator.items.map((item) => item.key)).toContain(itemKey);
    const agent = await status(h, false);
    expect(agent.transport).toEqual(operator.transport);
    expect(agent.items.map((item) => item.key)).not.toContain(itemKey);
    const text = await h.cli(['status'], { operator: true, tty: true });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('state: down');
    expect(
      await h.store.db.selectFrom('outbox').select('id').where('kind', '=', 'feed.line').execute(),
    ).toEqual([]);
    expect(posted()).toEqual([]);

    platform.restoreConnection();
    await platform.settle();
    expect(await h.store.db.selectFrom('transport_health').select('space').execute()).toEqual([]);
    expect(
      await h.store.db
        .selectFrom('operator_item')
        .select(['cleared_at', 'line_outbox_id'])
        .where('item_key', '=', itemKey)
        .execute(),
    ).toEqual([{ cleared_at: expect.any(String) as unknown, line_outbox_id: null }]);
    expect((await status(h, true)).transport).toEqual([
      { gateway: h.gateway.kind, state: 'up', since: null, reason: null, spaces: [] },
    ]);

    h.advance(60_000);
    await h.pulse();
    expect((await open()).state).toBe('done');
    expect(posted()).toEqual([askKey]);
    expect(platform.conversations().filter((c) => c.marker === askKey)).toHaveLength(1);
  });
});

const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'example/repo', milestone: 'M1' },
      repos: ['example/repo'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  http: { port: 0 },
});
const UP: InboundEvent = { kind: 'connection', dedupeKey: 'test:connection:up', state: 'up' };

/** Composes the daemon around a gateway that keeps its sink, and starts only the gateway. */
async function compose(
  options: { outboxStore?: (store: Store) => Store; failRecover?: boolean } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'board-transport-'));
  const store = openStore(join(home, 'board.sqlite'));
  cleanups.push(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const fake = createFakeGateway({ profile: 'slack-like' });
  let sink: InboundSink | undefined;
  let recovered = 0;
  const gateway: Gateway = {
    ...fake,
    start(next) {
      sink = next;
      return Promise.resolve();
    },
    recover(request) {
      recovered += 1;
      if (options.failRecover) throw new Error('recovery failed');
      return fake.recover(request);
    },
  };
  const records: Record<string, unknown>[] = [];
  const clock = { now: () => fake.platform.now().getTime() };
  const ctxFor = (name: string): ModuleContext<Store> => {
    const log = createLogger(
      {
        write(line) {
          records.push({ ...(JSON.parse(line) as Record<string, unknown>), name });
        },
      },
      {},
    );
    return {
      config,
      secrets: {},
      store: name === 'outbox' && options.outboxStore ? options.outboxStore(store) : store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    };
  };
  const composed = createDaemonModules(ctxFor, {
    gateway,
    spur: { send: () => Promise.resolve() },
  });
  const entry = composed.entries.find((candidate) => candidate.name === 'gateway-slack');
  if (entry === undefined) throw new Error('no gateway entry');
  await entry.module.start(new AbortController().signal);
  if (sink === undefined) throw new Error('the gateway did not receive a sink');
  const at = fake.platform.now().toISOString();
  await store.transaction(async (trx) => {
    await trx
      .insertInto('transport_health')
      .values({ gateway: fake.kind, space: 'feed', reason: 'down', since: at, probe_at: at })
      .execute();
    await trx
      .insertInto('operator_item')
      .values({
        item_key: `transport:${fake.kind}`,
        raise_no: 1,
        kind: 'transport_health',
        text: 'delivery down',
        url: '',
        task_id: null,
        block_id: null,
        raised_at: at,
        cleared_at: null,
        line_outbox_id: null,
        fingerprint: null,
        fact_at: null,
        source: null,
        priority: 1,
        inbound_event_json: null,
      })
      .execute();
  });
  const health = () => store.db.selectFrom('transport_health').select('space').execute();
  const item = () =>
    store.db.selectFrom('operator_item').select('cleared_at').executeTakeFirstOrThrow();
  return { sink, composed, records, health, item, recovered: () => recovered };
}

describe('gateway sink wiring', () => {
  it('passes a connection event to inbound and to the outbox', async () => {
    const wired = await compose();
    await wired.sink(UP);
    expect(wired.recovered()).toBe(1);
    expect(await wired.health()).toEqual([]);
    expect((await wired.item()).cleared_at).not.toBeNull();
  });

  it('logs a failed outbox update and still acknowledges the event', async () => {
    const wired = await compose({
      outboxStore: (store) => ({
        ...store,
        transaction: () => Promise.reject(new Error('store unavailable')),
      }),
    });
    await expect(wired.sink(UP)).resolves.toBeUndefined();
    expect(wired.recovered()).toBe(1);
    expect(wired.records).toContainEqual(
      expect.objectContaining({ name: 'outbox', msg: 'transport state update failed' }),
    );
    expect(await wired.health()).toHaveLength(1);
  });

  it('rejects the event when inbound recovery fails and still applies the outbox update', async () => {
    const wired = await compose({ failRecover: true });
    await expect(wired.sink(UP)).rejects.toThrow('recovery failed');
    await wired.composed.outbox.stop();
    expect(await wired.health()).toEqual([]);
    expect((await wired.item()).cleared_at).not.toBeNull();
  });
});
