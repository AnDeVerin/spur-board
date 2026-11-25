import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeSlackApi } from '@spur-board/gateway-slack/testing';
import {
  command,
  fast,
  lines,
  opens,
  reconnecting,
  stopReconnecting,
  unhandledSpy,
  type LogCall,
} from './support/socket.ts';

afterEach(stopReconnecting);

/** What one refresh handover case gets once the replacement's apps.connections.open is faulted. */
interface Handover {
  fake: FakeSlackApi;
  hold: { release(): void };
  events: readonly ('up' | 'down')[];
  logs: readonly LogCall[];
}

describe('Socket Mode refresh handover', () => {
  it.each([
    ...(['refresh_requested', 'warning'] as const).map((reason) => ({
      reason,
      path: 'the replacement connects: the old socket serves meanwhile and closes after',
      fault: 'hold' as const,
      async run({ fake, hold, logs }: Handover) {
        await expect(fake.emitEnvelope('slash_commands', command)).resolves.toBeUndefined();
        hold.release();
        await vi.waitFor(() => {
          expect(lines(logs, 'slack socket refreshed')).toHaveLength(1);
          expect(fake.openSockets()).toBe(1);
        });
      },
      events: ['up'] as const,
      opens: 1,
    })),
    {
      reason: 'refresh_requested',
      path: 'the replacement fails: the old socket serves until the server closes it',
      fault: 'network',
      async run({ fake, events, logs }: Handover) {
        await vi.waitFor(() => {
          expect(lines(logs, 'slack socket attempt failed')).toHaveLength(1);
        });
        await expect(fake.emitEnvelope('slash_commands', command)).resolves.toBeUndefined();
        expect(events).toEqual(['up']);
        await fake.terminateConnection();
      },
      events: ['up', 'down', 'up'],
      opens: 2,
    },
    {
      reason: 'refresh_requested',
      path: 'the old socket drops first: the replacement in flight becomes the next attempt',
      fault: 'hold',
      async run({ fake, hold, events }: Handover) {
        await fake.terminateConnection();
        await vi.waitFor(() => {
          expect(events).toEqual(['up', 'down']);
        });
        hold.release();
      },
      events: ['up', 'down', 'up'],
      opens: 1,
    },
  ] as const)('on a $reason disconnect, $path', async (row) => {
    const { fake, events, inbound, logs } = await reconnecting({ reconnect: fast });
    const before = opens(fake);
    const hold = fake.failConnectionsOpen([row.fault]);
    await fake.disconnectWith(row.reason, { wait: false });
    if (row.fault === 'hold') await hold.entered;
    await row.run({ fake, hold, events, logs });
    await vi.waitFor(() => {
      expect(events).toEqual(row.events);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(row.events);
    expect(opens(fake)).toBe(before + row.opens);
    expect(lines(logs, 'slack socket refreshing').map((line) => line.fields)).toEqual([
      { disconnectReason: row.reason },
    ]);
    await expect(fake.emitEnvelope('slash_commands', command)).resolves.toBeUndefined();
    expect(inbound.filter((kind) => kind === 'command').length).toBe(
      row.path.startsWith('the old socket drops') ? 1 : 2,
    );
  });

  it('acks an envelope that reaches the old socket while it drains after a handover', async () => {
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    let commands = 0;
    const { fake, logs } = await reconnecting({
      reconnect: fast,
      onInbound: (event) => {
        if (event.kind !== 'command') return Promise.resolve();
        commands += 1;
        return commands === 1 ? first.promise : second.promise;
      },
    });
    const hold = fake.failConnectionsOpen(['hold']);
    const old = await fake.disconnectWith('refresh_requested', { wait: false });
    await hold.entered;
    const acked: string[] = [];
    void old.emitEnvelope('slash_commands', command).then(() => acked.push('first'));
    await vi.waitFor(() => {
      expect(commands).toBe(1);
    });
    hold.release();
    await vi.waitFor(() => {
      expect(lines(logs, 'slack socket refreshed')).toHaveLength(1);
    });
    void old
      .emitEnvelope('slash_commands', { ...command, trigger_id: 'T-2' })
      .then(() => acked.push('second'));
    await vi.waitFor(() => {
      expect(commands).toBe(2);
    });
    first.resolve(undefined);
    await vi.waitFor(() => {
      expect(acked).toEqual(['first']);
    });
    expect(fake.openSockets()).toBe(2);
    second.resolve(undefined);
    await vi.waitFor(() => {
      expect(acked).toEqual(['first', 'second']);
      expect(fake.openSockets()).toBe(1);
    });
  });

  it('stop during a refresh handover abandons both clients', async () => {
    const spy = unhandledSpy();
    try {
      const { fake, gateway, events, logs } = await reconnecting({ requestTimeoutMs: 600_000 });
      const hold = fake.failConnectionsOpen(['hold']);
      await fake.disconnectWith('refresh_requested', { wait: false });
      await hold.entered;
      await gateway.stop();
      const seen = { events: events.length, logs: logs.length, opens: opens(fake) };
      hold.release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect({ events: events.length, logs: logs.length, opens: opens(fake) }).toEqual(seen);
      expect(events).toEqual(['up']);
      await vi.waitFor(() => {
        expect(fake.openSockets()).toBe(0);
      });
      expect(spy.unhandled).not.toHaveBeenCalled();
    } finally {
      spy.off();
    }
  });

  it('keeps the gateway up after a refresh handover closes the old socket', async () => {
    const { fake, events, logs } = await reconnecting({ reconnect: fast });
    await fake.disconnectWith('refresh_requested');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(['up']);
    expect(lines(logs, 'slack socket down')).toEqual([]);
    expect(lines(logs, 'slack socket refreshed')).toEqual([
      {
        level: 'info',
        fields: { disconnectReason: 'refresh_requested' },
        msg: 'slack socket refreshed',
      },
    ]);
    await expect(fake.emitEnvelope('slash_commands', command)).resolves.toBeUndefined();
  });
});
