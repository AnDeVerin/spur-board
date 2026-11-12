import type { InboundEvent } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackGateway } from '../src/index.ts';
import { startFakeSlackApi, type FakeSlackApi } from '@spur-board/gateway-slack/testing';

const fakes: FakeSlackApi[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
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

const command = {
  user_id: 'U_OPERATOR',
  channel_id: 'C_ORCH',
  text: 'status',
  trigger_id: 'T-1',
  command: '/board',
};

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
