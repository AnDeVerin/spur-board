import { randomUUID } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import type { WebClient } from '@slack/web-api';
import type { InboundEvent, InboundSink } from '@spur-board/contracts';
import type { ApiConfig } from './api.ts';
import { normalizeInteraction, normalizeMessage, type BotIdentity } from './normalize.ts';

interface Envelope {
  type?: unknown;
  body?: unknown;
  ack?: (response?: unknown) => Promise<void>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function value(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function rootFor(client: WebClient, channel: string, threadTs: string): Promise<unknown> {
  const page = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
  const root = page.messages?.[0];
  if (root === undefined) throw new Error('Slack thread root unavailable');
  return root;
}

export interface SocketConfig extends ApiConfig {
  appToken?: string;
}

/** Socket Mode owns transport reconnects; this layer owns sink-before-ack ordering. */
export function createSocket(
  api: WebClient,
  config: SocketConfig,
  botIdentity: () => Promise<BotIdentity>,
): Pick<import('@spur-board/contracts').Gateway, 'start' | 'stop'> {
  let socket: SocketModeClient | undefined;
  let sink: InboundSink | undefined;
  let stopping = false;
  let connected = false;
  const pending = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
  }

  function emit(event: InboundEvent): Promise<void> {
    if (sink === undefined) return Promise.resolve();
    return sink(event);
  }

  async function handle(envelope: Envelope): Promise<void> {
    if (stopping || sink === undefined) return;
    const type = value(envelope.type);
    const body = object(envelope.body);
    if (type === undefined || body === null) return;
    let events: InboundEvent[] = [];
    if (type === 'events_api') {
      const event = object(body.event);
      const eventType = value(event?.type);
      const channel = value(event?.channel);
      if (
        event !== null &&
        channel !== undefined &&
        (eventType === 'message' || eventType === 'app_mention')
      ) {
        const bot = await botIdentity();
        const message = eventType === 'app_mention' ? { ...event, type: 'message' } : event;
        const nested = object(message.message);
        const previous = object(message.previous_message);
        const threadTs =
          value(message.thread_ts) ?? value(nested?.thread_ts) ?? value(previous?.thread_ts);
        const messageTs = value(message.ts) ?? value(nested?.ts);
        const deletedRoot =
          message.subtype === 'message_deleted' && threadTs === value(message.deleted_ts);
        const root =
          threadTs === undefined || threadTs === messageTs || deletedRoot
            ? message
            : await rootFor(api, channel, threadTs);
        events = normalizeMessage(channel, message, {
          bot,
          root,
          ...(threadTs === undefined ? {} : { rootTs: threadTs }),
        });
      }
    } else if (type === 'interactive' || type === 'block_actions' || type === 'slash_commands') {
      events = normalizeInteraction(type, body);
    }
    for (const event of events) await emit(event);
    await envelope.ack?.();
  }

  return {
    async start(nextSink) {
      if (socket !== undefined) throw new Error('Slack gateway already started');
      sink = nextSink;
      stopping = false;
      if (config.appToken === undefined) return;
      await botIdentity();
      const client = new SocketModeClient({
        appToken: config.appToken,
        autoReconnectEnabled: true,
        clientOptions: {
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
          timeout: config.requestTimeoutMs ?? 10_000,
          ...(config.apiUrl === undefined ? {} : { slackApiUrl: config.apiUrl }),
        },
      });
      socket = client;
      client.on('connected', () => {
        connected = true;
        track(
          emit({ kind: 'connection', state: 'up', dedupeKey: `slack:connection:${randomUUID()}` }),
        );
      });
      client.on('close', () => {
        if (!connected || stopping) return;
        connected = false;
        track(
          emit({
            kind: 'connection',
            state: 'down',
            dedupeKey: `slack:connection:${randomUUID()}`,
          }),
        );
      });
      client.on('slack_event', (envelope: Envelope) => {
        track(handle(envelope));
      });
      try {
        await client.start();
      } catch {
        socket = undefined;
        sink = undefined;
        throw new Error('Slack Socket Mode start failed');
      }
    },
    async stop() {
      stopping = true;
      const client = socket;
      socket = undefined;
      if (client !== undefined) await client.disconnect();
      while (pending.size > 0) await Promise.allSettled([...pending]);
      sink = undefined;
      connected = false;
    },
  };
}
