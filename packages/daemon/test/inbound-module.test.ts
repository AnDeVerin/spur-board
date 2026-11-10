import { join } from 'node:path';
import { openStore, type Store } from '@spur-board/core';
import type { Gateway } from '@spur-board/contracts';
import { createSlackGateway } from '@spur-board/gateway-slack';
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
});
