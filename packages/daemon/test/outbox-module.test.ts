import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { createSender, openStore, type Store } from '@spur-board/core';
import { createSlackGateway } from '@spur-board/gateway-slack';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { startFakeSlackApi } from '../../gateway-slack/test/fake-api.ts';
import { loadConfig, resolvePaths } from '../src/config.ts';
import type { ModuleContext } from '../src/lifecycle.ts';
import { createOutboxModule } from '../src/outbox-module.ts';
import { makeHome } from './home.ts';

describe('outbox scheduler', () => {
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
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log: pino({ level: 'silent' }),
      clock: { now: () => Date.now() },
      logCall: (_call, fn) => fn(),
      state: () => 'ready',
    };
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      channels: { orchestrators: 'C000000001', feed: 'C000000002' },
      apiUrl: api.url,
    });
    const module = createOutboxModule(ctx, gateway);
    const controller = new AbortController();
    try {
      await module.start(controller.signal);
      await hold.entered;
      await sleep(2200);
      controller.abort();
      const stopping = module.stop();
      hold.release();
      await stopping;
      expect(transactions).toBe(5); // recovery, claim, send stamp, result, skipped-claim requeue
      const skipped = await base.db
        .selectFrom('outbox')
        .select(['state', 'uncertain', 'attempts'])
        .where('dedupe_key', '=', 'doorbell:after-slow')
        .executeTakeFirstOrThrow();
      expect(skipped).toMatchObject({ state: 'pending', uncertain: 0, attempts: 0 });
      const restarted = createSender({
        store: base,
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
  }, 30_000);
});
