import type { Gateway, InboundEvent } from '@spur-board/contracts';
import { vi } from 'vitest';
import { createSlackGateway } from '../../src/index.ts';
import { startFakeSlackApi, type FakeSlackApi } from '@spur-board/gateway-slack/testing';

const fakes: FakeSlackApi[] = [];
const gateways: Gateway[] = [];

/** Stops every gateway `reconnecting` started, then closes its fakes; call it from `afterEach`. */
export async function stopReconnecting(): Promise<void> {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const fake of fakes.splice(0)) await fake.close();
}

export const command = {
  user_id: 'U_OPERATOR',
  channel_id: 'C_ORCH',
  text: 'status',
  trigger_id: 'T-1',
  command: '/board',
};

export interface LogCall {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

/** A started gateway that records its connection events and log lines. */
export async function reconnecting(
  options: {
    reconnect?: { baseDelayMs?: number; maxDelayMs?: number; helloTimeoutMs?: number };
    requestTimeoutMs?: number;
    /** Answers each event other than `connection`; resolves at once without it. */
    onInbound?: (event: InboundEvent) => Promise<void>;
  } = {},
) {
  const { onInbound, ...gatewayOptions } = options;
  const fake = await startFakeSlackApi();
  fakes.push(fake);
  const events: ('up' | 'down')[] = [];
  const inbound: InboundEvent['kind'][] = [];
  const logs: LogCall[] = [];
  const gateway = createSlackGateway({
    token: 'xoxb-test',
    now: () => Date.now(),
    appToken: 'xapp-test',
    channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
    apiUrl: fake.url,
    onLog: (level, fields, msg) => {
      logs.push({ level, fields, msg });
    },
    ...gatewayOptions,
  });
  gateways.push(gateway);
  await gateway.start((event) => {
    if (event.kind === 'connection') events.push(event.state);
    else {
      inbound.push(event.kind);
      if (onInbound !== undefined) return onInbound(event);
    }
    return Promise.resolve();
  });
  return { fake, gateway, events, inbound, logs };
}

export function opens(fake: FakeSlackApi): number {
  return fake.requests().filter((request) => request.method === 'apps.connections.open').length;
}

export function lines(logs: readonly LogCall[], msg: string): LogCall[] {
  return logs.filter((line) => line.msg === msg);
}

export function unhandledSpy() {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  return {
    unhandled,
    off: () => {
      process.off('unhandledRejection', unhandled);
    },
  };
}

export const fast = { baseDelayMs: 20, maxDelayMs: 80 };
