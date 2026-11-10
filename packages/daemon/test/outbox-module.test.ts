import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { createSender, openStore, requestToken, type Store } from '@spur-board/core';
import { createSlackGateway } from '@spur-board/gateway-slack';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { startFakeSlackApi } from '../../gateway-slack/test/fake-api.ts';
import { loadConfig, resolvePaths } from '../src/config.ts';
import type { ModuleContext } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';
import { createOutboxModule, slackSettings } from '../src/outbox-module.ts';
import { makeHome } from './home.ts';

describe('outbox scheduler', () => {
  it('expires pending token approvals on a tick after fifteen minutes', async () => {
    const home = makeHome();
    const store = openStore(join(home, 'board.sqlite'));
    const requestedAt = new Date('2026-11-04T10:00:00.000Z');
    const late = requestedAt.getTime() + 15 * 60 * 1000;
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    await requestToken(
      store,
      loaded.config,
      { name: 'desk', folder: 'workspace/desk', host: 'local', hash: 'a'.repeat(64) },
      requestedAt,
    );
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log: pino({ level: 'silent' }),
      clock: { now: () => late },
      logCall: (_call, fn) => fn(),
      state: () => 'ready',
    };
    const module = createOutboxModule(ctx);
    const controller = new AbortController();
    try {
      await module.start(controller.signal);
      await expect
        .poll(
          async () =>
            (await store.db.selectFrom('operator_token').select('status').executeTakeFirst())
              ?.status,
        )
        .toBe('expired');
      expect(
        await store.db.selectFrom('operator_item').select('cleared_at').executeTakeFirst(),
      ).toEqual({ cleared_at: new Date(late).toISOString() });
    } finally {
      controller.abort();
      await module.stop();
      await store.close();
    }
  });
  it('passes an optional app token only when inbound is configured', () => {
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: makeHome() }, ''));
    const config = {
      ...loaded.config,
      slack: {
        ...loaded.config.slack,
        channels: { orchestrators: 'C000000001', feed: 'C000000002' },
      },
    };
    const outbound = slackSettings(config, { SLACK_BOT_TOKEN: 'xoxb-test' });
    expect(outbound?.appToken).toBeUndefined();
    expect(outbound?.command).toBe('/board');
    const inbound = slackSettings(config, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
    });
    expect(inbound?.appToken).toBe('xapp-test');
    expect(
      slackSettings(
        { ...config, slack: { ...config.slack, command: '/ops' } },
        {
          SLACK_BOT_TOKEN: 'xoxb-test',
        },
      )?.command,
    ).toBe('/ops');
  });
  it('logs one failed tick and schedules a later successful tick', async () => {
    const home = makeHome();
    const base = openStore(join(home, 'board.sqlite'));
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      {
        write(line) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
      {},
    );
    const clock = { now: () => Date.now() };
    let transactions = 0;
    const store: Store = {
      ...base,
      transaction(fn) {
        transactions += 1;
        if (transactions === 2) return Promise.reject(new Error('transient claim failure'));
        return base.transaction(fn);
      },
    };
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    };
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      channels: { orchestrators: 'C000000001', feed: 'C000000002' },
    });
    const module = createOutboxModule(ctx, gateway, { tickMs: 10, jitterMs: 0 });
    const controller = new AbortController();
    try {
      await module.start(controller.signal);
      await vi.waitFor(
        () => {
          expect(transactions).toBeGreaterThanOrEqual(3);
        },
        { interval: 5 },
      );
      controller.abort();
      await module.stop();
      expect(records.filter((record) => record['err'] !== undefined)).toHaveLength(1);
      expect(records).toContainEqual(
        expect.objectContaining({ call: 'outbox.tick', outcome: 'error' }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({ call: 'outbox.tick', outcome: 'ok' }),
      );
    } finally {
      controller.abort();
      await module.stop();
      await base.close();
    }
  });

  it('skips timer ticks while a delivery is active and waits for that delivery on stop', async () => {
    const api = await startFakeSlackApi();
    const hold = api.holdNextWrite();
    const home = makeHome();
    const base = openStore(join(home, 'board.sqlite'));
    let transactions = 0;
    const store: Store = {
      ...base,
      transaction(fn) {
        transactions += 1;
        return base.transaction(fn);
      },
    };
    await base.transaction(async (trx) => {
      await trx
        .insertInto('outbox')
        .values({
          kind: 'feed.line',
          dedupe_key: 'feed.line:slow',
          payload: JSON.stringify({
            key: 'board#46',
            title: 'board#46 slow',
            text: 'slow delivery',
            persona: { name: 'worker', role: 'worker' },
            itemKey: 'slow',
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
      await trx
        .insertInto('outbox')
        .values({
          kind: 'doorbell',
          dedupe_key: 'doorbell:after-slow',
          payload: JSON.stringify({ session: 'test', text: 'later delivery' }),
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
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const loggedCalls: string[] = [];
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log: pino({ level: 'silent' }),
      clock: { now: () => Date.now() },
      logCall: (call, fn) => {
        loggedCalls.push(call);
        return fn();
      },
      state: () => 'ready',
    };
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      channels: { orchestrators: 'C000000001', feed: 'C000000002' },
      apiUrl: api.url,
    });
    const module = createOutboxModule(ctx, gateway, {
      spur: { send: () => Promise.reject(new Error('unexpected doorbell')) },
      tickMs: 20,
      jitterMs: 0,
    });
    const controller = new AbortController();
    try {
      await module.start(controller.signal);
      await hold.entered;
      // Ten tick intervals with the delivery held: no timer tick may start.
      await sleep(200);
      expect(loggedCalls).toEqual(['outbox.tick']);
      controller.abort();
      const stopping = module.stop();
      hold.release();
      await stopping;
      expect(loggedCalls).toEqual(['outbox.tick']);
      expect(transactions).toBe(5); // recovery, claim, send stamp, result, skipped-claim requeue
      const skipped = await base.db
        .selectFrom('outbox')
        .select(['state', 'uncertain', 'attempts'])
        .where('dedupe_key', '=', 'doorbell:after-slow')
        .executeTakeFirstOrThrow();
      expect(skipped).toMatchObject({ state: 'pending', uncertain: 0, attempts: 0 });
      const restarted = createSender({
        store: base,
        config: loaded.config,
        gateway,
        spur: { send: () => Promise.resolve() },
      });
      await restarted.recover();
      expect(
        await base.db
          .selectFrom('outbox')
          .select(['state', 'uncertain', 'attempts'])
          .where('dedupe_key', '=', 'doorbell:after-slow')
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ state: 'pending', uncertain: 0, attempts: 0 });
    } finally {
      hold.release();
      controller.abort();
      await module.stop();
      await base.close();
      await api.close();
    }
  });

  it('keeps delivering while every token expiry fails', async () => {
    const home = makeHome();
    const base = openStore(join(home, 'board.sqlite'));
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const requestedAt = new Date('2026-11-04T10:00:00.000Z');
    const late = requestedAt.getTime() + 15 * 60 * 1000;
    await requestToken(
      base,
      loaded.config,
      { name: 'desk', folder: 'workspace/desk', host: 'local', hash: 'a'.repeat(64) },
      requestedAt,
    );
    // Every token-expiry run fails: its first read of operator_token throws.
    const db = new Proxy(base.db, {
      get(target, prop) {
        if (prop === 'selectFrom')
          return (table: string) => {
            if (table === 'operator_token') throw new Error('injected token failure');
            return target.selectFrom(table as 'outbox');
          };
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const store: Store = { ...base, db };
    await store.transaction(async (trx) => {
      await trx
        .insertInto('outbox')
        .values({
          kind: 'doorbell',
          dedupe_key: 'doorbell:despite-tokens',
          payload: JSON.stringify({ session: 'test', text: 'still delivered' }),
          state: 'pending',
          next_at: new Date(late).toISOString(),
          last_error: null,
          external_ref: null,
          parent_outbox_id: null,
          first_attempt_at: null,
          first_delivery_at: null,
        })
        .execute();
    });
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      {
        write(line) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
      {},
    );
    const clock = { now: () => late };
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    };
    const sends: { session: string; text: string }[] = [];
    const module = createOutboxModule(ctx, undefined, {
      spur: {
        send(session, text) {
          sends.push({ session, text });
          return Promise.resolve();
        },
      },
      tickMs: 10,
      jitterMs: 0,
    });
    const controller = new AbortController();
    const expiryFailures = () =>
      records.filter((record) => record['msg'] === 'token expiry failed');
    try {
      await module.start(controller.signal);
      await vi.waitFor(
        () => {
          expect(sends).toEqual([{ session: 'test', text: 'still delivered' }]);
          expect(expiryFailures().length).toBeGreaterThanOrEqual(2);
        },
        { interval: 5 },
      );
      expect(
        (await base.db.selectFrom('operator_token').select('status').executeTakeFirst())?.status,
      ).toBe('pending');
    } finally {
      controller.abort();
      await module.stop();
      await base.close();
    }
  });

  it('ignores connection updates after stop and waits for one in flight', async () => {
    const home = makeHome();
    const base = openStore(join(home, 'board.sqlite'));
    const gateway = createFakeGateway({ profile: 'slack-like' });
    const at = new Date().toISOString();
    const seedDown = (space: 'feed' | 'orchestrators') =>
      base.transaction((trx) =>
        trx
          .insertInto('transport_health')
          .values({ gateway: gateway.kind, space, reason: 'down', since: at, probe_at: at })
          .execute(),
      );
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let transactions = 0;
    const store: Store = {
      ...base,
      async transaction(fn) {
        transactions += 1;
        entered();
        await held;
        return base.transaction(fn);
      },
    };
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log: pino({ level: 'silent' }),
      clock: { now: () => Date.now() },
      logCall: (_call, fn) => fn(),
      state: () => 'ready',
    };
    const module = createOutboxModule(ctx, gateway);
    try {
      await seedDown('feed');
      const update = module.connection('up');
      await holding;
      let stopped = false;
      const stopping = module.stop().then(() => {
        stopped = true;
      });
      await sleep(50);
      expect(stopped).toBe(false);
      release();
      await stopping;
      await update;
      expect(await base.db.selectFrom('transport_health').select('space').execute()).toEqual([]);
      const before = transactions;
      await seedDown('orchestrators');
      await module.connection('up');
      expect(transactions).toBe(before);
      expect(await base.db.selectFrom('transport_health').select('space').execute()).toEqual([
        { space: 'orchestrators' },
      ]);
    } finally {
      release();
      await module.stop();
      await base.close();
    }
  });
});
