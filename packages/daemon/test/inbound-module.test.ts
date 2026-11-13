import { join } from 'node:path';
import { openStore, type Store } from '@spur-board/core';
import type { Gateway } from '@spur-board/contracts';
import { createSlackGateway } from '@spur-board/gateway-slack';
import { startFakeSlackApi } from '@spur-board/gateway-slack/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolvePaths } from '../src/config.ts';
import type { ModuleContext } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';
import { createInboundModule } from '../src/inbound-module.ts';
import { makeHome } from './home.ts';

const stores: Store[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) await store.close();
});

function context(): ModuleContext<Store> {
  const home = makeHome();
  const store = openStore(join(home, 'board.sqlite'));
  stores.push(store);
  const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
  const log = createLogger({ write() {} }, {});
  const clock = { now: () => Date.now() };
  return {
    ...loaded,
    store,
    log,
    clock,
    logCall: (call, fn) => logCall(log, clock, call, fn),
    state: () => 'ready',
  };
}

function fakeGateway(): Gateway {
  return createSlackGateway({
    token: 'xoxb-test',
    now: () => Date.now(),
    channels: { orchestrators: 'C000000001', feed: 'C000000002' },
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected recovery call');
}

describe('inbound recovery scheduler', () => {
  it('scans at start and every five minutes without overlapping scans', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctx = context();
    const fake = fakeGateway();
    let calls = 0;
    const gateway: Gateway = {
      ...fake,
      recover() {
        calls += 1;
        return (async function* () {})();
      },
    };
    const module = createInboundModule(ctx, gateway);
    const controller = new AbortController();
    await module.start(controller.signal);
    await until(() => calls === 1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await until(() => calls === 2);
    controller.abort();
    await module.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(2);
  });

  it('waits for an active recovery before stopping', async () => {
    const ctx = context();
    const fake = fakeGateway();
    let calls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway: Gateway = {
      ...fake,
      recover() {
        calls += 1;
        return (async function* () {
          await held;
        })();
      },
    };
    const module = createInboundModule(ctx, gateway);
    const controller = new AbortController();
    await module.start(controller.signal);
    await until(() => calls === 1);
    controller.abort();
    let stopped = false;
    const stopping = module.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stops within the deadline while a scan sleeps on a rate limit', async () => {
    const ctx = context();
    const fake = await startFakeSlackApi();
    try {
      const gateway = createSlackGateway({
        token: 'xoxb-test',
        now: () => Date.now(),
        channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
        apiUrl: fake.url,
        requestTimeoutMs: 500,
      });
      const opened = await gateway.deliver({
        key: 'module-root',
        maybeSent: false,
        target: { kind: 'open', space: 'orchestrators', title: 'question' },
        persona: { name: 'test', role: 'board' },
        body: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'question' }] }],
      });
      if (opened.status !== 'delivered' || opened.conversation === undefined) {
        throw new Error('fake conversation failed to open');
      }
      await ctx.store.transaction(async (trx) => {
        await trx
          .insertInto('conversation')
          .values({
            gateway: gateway.kind,
            ref: opened.conversation ?? '',
            space: 'orchestrators',
            task_id: null,
            block_id: null,
            purpose: 'block',
            state: 'open',
            root_message_ref: opened.message,
            after_message_ref: null,
            created_at: new Date(Date.now() - 1000).toISOString(),
            closed_at: null,
          })
          .execute();
      });
      // Cache the bot identity first: an armed fault answers the next request of any method.
      for await (const event of gateway.recover({ conversations: [], since: new Date(0) })) {
        throw new Error(`unexpected ${event.kind}`);
      }
      fake.respondNext(429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '3' });
      const replies = () =>
        fake.requests().filter((request) => request.method === 'conversations.replies').length;
      const before = replies();
      const module = createInboundModule(ctx, gateway);
      const controller = new AbortController();
      await module.start(controller.signal);
      await vi.waitFor(() => {
        expect(replies()).toBe(before + 1);
      });
      controller.abort();
      const stoppingAt = performance.now();
      await module.stop();
      expect(performance.now() - stoppingAt).toBeLessThan(1000);
      expect(await ctx.store.db.selectFrom('operator_item').select('id').execute()).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
