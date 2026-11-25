import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusOutputSchema } from '@spur-board/contracts/browser';
import { startFakeSlackApi } from '@spur-board/gateway-slack/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startInProcessDaemon, type InProcessDaemon } from '../src/in-process.ts';
import { configFor, daemonOptions, type DaemonOptionsInput } from './in-process-fixture.ts';
import { readOp, webConfig } from './in-process-web.ts';

let home: string;
let daemon: InProcessDaemon | undefined;
const optionsFor = (input: DaemonOptionsInput) => daemonOptions(home, input);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'in-process-slack-'));
});

afterEach(async () => {
  await daemon?.stop();
  await daemon?.teardown;
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('in-process Slack socket', () => {
  it('reconnects the Slack socket after a drop, raises one transport item past five minutes and reports lastGoodAt', async () => {
    const fake = await startFakeSlackApi();
    const lines: string[] = [];
    const config = await webConfig(configFor);
    let now = Date.parse('2026-11-25T08:00:00.000Z');
    const input = optionsFor({
      tick: () => Promise.resolve(),
      lines,
      config: {
        ...config,
        slack: { ...config.slack, channels: { orchestrators: 'C000000001', feed: 'C000000002' } },
      },
      secrets: {
        SLACK_BOT_TOKEN: 'xoxb-in-process',
        SLACK_APP_TOKEN: 'xapp-in-process',
        SLACK_API_URL: fake.url,
      },
    });
    let webAddress = '';
    try {
      const running = await startInProcessDaemon({
        ...input,
        clock: { now: () => now },
        ports: { ...input.ports, onWebListening: (address) => void (webAddress = address) },
      });
      daemon = running;
      const socketLines = (msg: string) =>
        lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((record) => record.module === 'gateway-slack' && record.msg === msg);
      const slack = async () =>
        statusOutputSchema
          .parse(await readOp(webAddress, 'status.get'))
          .services.find((row) => row.service === 'slack');
      const items = () =>
        running.store.db
          .selectFrom('operator_item')
          .select('cleared_at')
          .where('item_key', '=', 'transport:slack')
          .execute();
      const record = async () => {
        const row = await running.store.db
          .selectFrom('meta')
          .select('value')
          .where('key', '=', 'transport_connection:slack')
          .executeTakeFirst();
        return row === undefined ? undefined : (JSON.parse(row.value) as unknown);
      };
      const iso = () => new Date(now).toISOString();
      await vi.waitFor(() => {
        expect(socketLines('slack socket up')).toHaveLength(1);
      });
      expect(await slack()).toMatchObject({ state: 'healthy', lastGoodAt: iso() });

      const droppedAt = iso();
      await fake.platform.dropConnection();
      // The fake closes without a code, which the client reads as 1005.
      await vi.waitFor(() => {
        expect(socketLines('slack socket down')).toEqual([
          expect.objectContaining({ level: 40, closeCode: 1005 }),
        ]);
      });
      await vi.waitFor(async () => {
        expect(await record()).toEqual({ state: 'down', at: droppedAt });
      });
      now += 1000;
      expect(await slack()).toMatchObject({ state: 'healthy', lastGoodAt: droppedAt });

      now += 5 * 60_000 + 1000;
      await running.outbox.pulse();
      expect(await items()).toEqual([{ cleared_at: null }]);
      await running.outbox.pulse();
      expect(await items()).toEqual([{ cleared_at: null }]);
      expect(await slack()).toMatchObject({ state: 'failing', lastGoodAt: droppedAt });

      await fake.platform.restoreConnection();
      await vi.waitFor(async () => {
        expect(await items()).toEqual([{ cleared_at: expect.any(String) as unknown }]);
        expect(socketLines('slack socket up')).toHaveLength(2);
      });
      expect(socketLines('slack socket reconnecting').length).toBeGreaterThan(0);
      now += 1000;
      expect(await slack()).toMatchObject({ state: 'healthy', lastGoodAt: iso() });
      expect(await running.stop()).toBe(0);
    } finally {
      await fake.close();
    }
  });
});
