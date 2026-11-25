import type { Gateway, InboundEvent } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackGateway } from '../src/index.ts';
import { createSdkLogger, reconnectDelay, type SocketRecord } from '../src/socket.ts';
import { startFakeSlackApi, type FakeSlackApi } from '@spur-board/gateway-slack/testing';
import {
  command,
  fast,
  lines,
  opens,
  reconnecting,
  stopReconnecting,
  unhandledSpy,
} from './support/socket.ts';

const fakes: FakeSlackApi[] = [];
const gateways: Gateway[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const fake of fakes.splice(0)) await fake.close();
  await stopReconnecting();
});

type OnError = (err: unknown, work: 'connection' | 'envelope') => void;

async function started(onError: OnError, sink: (event: InboundEvent) => Promise<void>) {
  const fake = await startFakeSlackApi();
  fakes.push(fake);
  const gateway = createSlackGateway({
    token: 'xoxb-test',
    now: () => Date.now(),
    appToken: 'xapp-test',
    channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
    apiUrl: fake.url,
    onError,
  });
  await gateway.start(sink);
  return { fake, gateway };
}

function rejectConnectionsAndCommands(event: InboundEvent): Promise<void> {
  return event.kind === 'connection' || event.kind === 'command'
    ? Promise.reject(new Error('sink down'))
    : Promise.resolve();
}

describe('Socket Mode background errors', () => {
  it('reports a rejected connection event as connection work', async () => {
    const onError = vi.fn<OnError>();
    const { gateway } = await started(onError, rejectConnectionsAndCommands);
    try {
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'sink down' }),
          'connection',
        );
      });
    } finally {
      await gateway.stop();
    }
  });

  it('reports a sink rejection inside an envelope as envelope work', async () => {
    const onError = vi.fn<OnError>();
    const { fake, gateway } = await started(onError, rejectConnectionsAndCommands);
    try {
      void fake.emitEnvelope('slash_commands', command);
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'sink down' }),
          'envelope',
        );
      });
    } finally {
      await gateway.stop();
    }
  });

  it('reports a failed thread root lookup as envelope work', async () => {
    const onError = vi.fn<OnError>();
    const { fake, gateway } = await started(onError, () => Promise.resolve());
    try {
      void fake.emitEnvelope('events_api', {
        event: {
          type: 'message',
          channel: 'C_ORCH',
          user: 'U1',
          text: 'x',
          ts: '200.000002',
          thread_ts: '100.000001',
        },
      });
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: 'Slack thread root unavailable' }),
          'envelope',
        );
      });
    } finally {
      await gateway.stop();
    }
  });

  it('keeps reporting and stops cleanly when onError throws', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const onError = vi.fn<OnError>(() => {
      if (onError.mock.calls.length === 1) throw new Error('callback broke');
    });
    const { fake, gateway } = await started(onError, rejectConnectionsAndCommands);
    try {
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledOnce();
      });
      void fake.emitEnvelope('slash_commands', command);
      await vi.waitFor(() => {
        expect(onError).toHaveBeenLastCalledWith(
          expect.objectContaining({ message: 'sink down' }),
          'envelope',
        );
      });
      await expect(gateway.stop()).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await gateway.stop();
    }
  });
});

describe('Socket Mode reconnect', () => {
  it('reconnectDelay doubles from 1 s to a 60 s cap with equal jitter', () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 60_000 };
    const low = (attempt: number) => reconnectDelay(attempt, options, () => 0);
    const high = (attempt: number) => reconnectDelay(attempt, options, () => 0.999);
    expect([low(1), low(2), low(7), low(60)]).toEqual([500, 1000, 30_000, 30_000]);
    for (const [attempt, ceiling] of [
      [1, 1000],
      [2, 2000],
      [7, 60_000],
      [60, 60_000],
    ] as const) {
      expect(high(attempt)).toBeGreaterThanOrEqual(ceiling / 2);
      expect(high(attempt)).toBeLessThanOrEqual(ceiling);
      expect(high(attempt)).toBeGreaterThan(low(attempt));
    }
  });

  it('the SDK logger joins string arguments and drops lines a gateway line already carries', () => {
    const record: SocketRecord = {};
    const forward = vi.fn<(level: 'warn' | 'error', detail: string) => void>();
    const logger = createSdkLogger(record, forward);
    logger.warn('a', 1, ['b']);
    logger.warn('a', 'b');
    expect(forward.mock.calls).toEqual([
      ['warn', 'a'],
      ['warn', 'a b'],
    ]);
    forward.mockClear();
    logger.error('Failed to retrieve a new WSS URL (error: x)');
    logger.warn('http request failed', 'x');
    logger.error('WebSocket error! x');
    logger.error('WebSocket error occurred: ');
    expect(record).toEqual({});
    logger.error('WebSocket error occurred: boom');
    expect(record).toEqual({ socketError: 'boom' });
    logger.debug('WebSocket close frame received (code: 1000, reason: bye)');
    expect(record).toEqual({ socketError: 'boom', closeCode: 1000, closeReason: 'bye' });
    logger.debug('Received a message on the WebSocket: {"type":"hello"}');
    logger.info('anything');
    expect(record).toEqual({ socketError: 'boom', closeCode: 1000, closeReason: 'bye' });
    expect(forward).not.toHaveBeenCalled();
    expect(logger.getLevel()).toBe('info');
  });

  it('reconnects after a link_disabled disconnect and logs its reason and close code', async () => {
    const { fake, events, logs } = await reconnecting({ reconnect: fast });
    const before = opens(fake);
    await fake.disconnectWith('link_disabled');
    await vi.waitFor(() => {
      expect(events).toEqual(['up', 'down', 'up']);
    });
    expect(opens(fake)).toBe(before + 1);
    expect(lines(logs, 'slack socket down')).toEqual([
      {
        level: 'warn',
        fields: { disconnectReason: 'link_disabled', closeCode: 1000 },
        msg: 'slack socket down',
      },
    ]);
    expect(lines(logs, 'slack socket up').map((line) => line.fields)).toEqual([
      { attempt: 0 },
      { attempt: 1 },
    ]);
  });

  it('reconnects after an abrupt close and logs close code 1006', async () => {
    const { fake, events, logs } = await reconnecting({ reconnect: fast });
    await fake.terminateConnection();
    await vi.waitFor(() => {
      expect(events).toEqual(['up', 'down', 'up']);
    });
    const [down] = lines(logs, 'slack socket down');
    expect(down?.fields).toEqual({ closeCode: 1006 });
    expect(lines(logs, 'slack socket-mode sdk')).toEqual([]);
  });

  it('retries a failed apps.connections.open with growing delays until it connects', async () => {
    const spy = unhandledSpy();
    try {
      const { fake, events, logs } = await reconnecting({ reconnect: fast });
      await fake.platform.dropConnection();
      fake.failConnectionsOpen([
        'network',
        { status: 500 },
        { status: 200, body: { ok: false, error: 'invalid_auth' } },
      ]);
      await fake.platform.restoreConnection();
      await vi.waitFor(() => {
        expect(events).toEqual(['up', 'down', 'up']);
      });
      const waits = lines(logs, 'slack socket reconnecting').map((line) => line.fields);
      expect(waits.map((fields) => fields.attempt)).toEqual([1, 2, 3, 4]);
      for (const fields of waits) {
        const ceiling = Math.min(80, 20 * 2 ** (Number(fields.attempt) - 1));
        expect(fields.delayMs).toBeGreaterThanOrEqual(ceiling / 2);
        expect(fields.delayMs).toBeLessThanOrEqual(ceiling);
      }
      const failed = lines(logs, 'slack socket attempt failed');
      expect(failed.map((line) => [line.level, line.fields.attempt, line.fields.failure])).toEqual([
        ['warn', 1, 'connections_open'],
        ['warn', 2, 'connections_open'],
        ['error', 3, 'connections_open'],
      ]);
      for (const line of failed) expect(line.fields.err).toBeInstanceOf(Error);
      expect(
        lines(logs, 'slack socket-mode sdk').filter((line) =>
          /^(Failed to retrieve a new WSS URL|http request failed)/.test(
            String(line.fields.detail),
          ),
        ),
      ).toEqual([]);
      expect(lines(logs, 'slack socket up').at(-1)?.fields).toEqual({ attempt: 4 });
      expect(spy.unhandled).not.toHaveBeenCalled();
    } finally {
      spy.off();
    }
  });

  it('retries an attempt that gets no hello within the hello timeout', async () => {
    const { fake, events, logs } = await reconnecting({
      reconnect: { baseDelayMs: 20, maxDelayMs: 20, helloTimeoutMs: 300 },
    });
    await fake.platform.dropConnection();
    await vi.waitFor(
      () => {
        expect(lines(logs, 'slack socket attempt failed').map((line) => line.fields)).toEqual([
          expect.objectContaining({ attempt: 1, failure: 'hello_timeout' }),
        ]);
        expect(
          lines(logs, 'slack socket reconnecting').map((line) => line.fields.attempt),
        ).toContain(2);
      },
      { interval: 5 },
    );
    const eventsBefore = events.length;
    const upsBefore = lines(logs, 'slack socket up').length;
    await fake.platform.restoreConnection();
    await vi.waitFor(() => {
      expect(events.slice(eventsBefore)).toEqual(['up']);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.slice(eventsBefore)).toEqual(['up']);
    expect(lines(logs, 'slack socket up').slice(upsBefore)).toHaveLength(1);
  });

  it('schedules a reconnect after every down', async () => {
    const spy = unhandledSpy();
    try {
      const { fake, events, logs } = await reconnecting({ reconnect: fast });
      const upAgain = async (count: number) => {
        await vi.waitFor(() => {
          expect(events).toHaveLength(count);
        });
      };
      await fake.disconnectWith('refresh_requested');
      await vi.waitFor(() => {
        expect(lines(logs, 'slack socket refreshed')).toHaveLength(1);
      });
      await fake.disconnectWith('link_disabled');
      await upAgain(3);
      await fake.terminateConnection();
      await upAgain(5);
      await fake.platform.dropConnection();
      await fake.platform.restoreConnection();
      await upAgain(7);
      expect(events).toEqual(['up', 'down', 'up', 'down', 'up', 'down', 'up']);
      expect(opens(fake)).toBe(
        1 +
          lines(logs, 'slack socket reconnecting').length +
          lines(logs, 'slack socket refreshing').length,
      );
      expect(spy.unhandled).not.toHaveBeenCalled();
    } finally {
      spy.off();
    }
  });

  it('stop during a backoff sends no further apps.connections.open', async () => {
    const { fake, gateway, logs } = await reconnecting({
      reconnect: { baseDelayMs: 600_000, maxDelayMs: 600_000 },
    });
    await fake.terminateConnection();
    await vi.waitFor(() => {
      expect(lines(logs, 'slack socket reconnecting')).toHaveLength(1);
    });
    const before = opens(fake);
    await gateway.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(opens(fake)).toBe(before);
  });

  it('stop never waits for an in-flight apps.connections.open', async () => {
    const spy = unhandledSpy();
    try {
      const { fake, gateway, events, logs } = await reconnecting({ requestTimeoutMs: 600_000 });
      const hold = fake.failConnectionsOpen(['hold']);
      await fake.terminateConnection();
      await hold.entered;
      await gateway.stop();
      const seen = { events: events.length, logs: logs.length, opens: opens(fake) };
      hold.release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect({ events: events.length, logs: logs.length, opens: opens(fake) }).toEqual(seen);
      expect(spy.unhandled).not.toHaveBeenCalled();
    } finally {
      spy.off();
    }
  });

  it('forwards no SDK debug line', async () => {
    const { fake, logs } = await reconnecting({ reconnect: fast });
    await fake.emitEnvelope('slash_commands', { ...command, text: 'secret-payload-903' });
    await fake.terminateConnection();
    await vi.waitFor(() => {
      expect(lines(logs, 'slack socket up')).toHaveLength(2);
    });
    for (const line of logs) {
      expect(JSON.stringify(line.fields) + line.msg).not.toContain('secret-payload-903');
    }
  });
});
