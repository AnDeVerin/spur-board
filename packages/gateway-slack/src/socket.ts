import { randomUUID } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import type { WebClient } from '@slack/web-api';
import type { InboundEvent, InboundSink } from '@spur-board/contracts';
import type { ApiConfig } from './api.ts';
import { normalizeInteraction, normalizeMessage, type BotIdentity } from './normalize.ts';
import type { SlackChannels } from './deliver.ts';
import { fieldsOf, textOf } from './wire.ts';

interface Envelope {
  type?: unknown;
  body?: unknown;
  ack?: (response?: unknown) => Promise<void>;
}

async function rootFor(client: WebClient, channel: string, threadTs: string): Promise<unknown> {
  const page = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
  const root = page.messages?.[0];
  if (root === undefined) throw new Error('Slack thread root unavailable');
  return root;
}

export interface SocketConfig extends ApiConfig {
  appToken?: string;
  channels: SlackChannels;
  command?: string;
  /** Receives every rejection of Socket Mode background work; without it the rejection is dropped. */
  onError?: (err: unknown, work: 'connection' | 'envelope') => void;
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

  function track(work: Promise<void>, kind: 'connection' | 'envelope'): void {
    pending.add(work);
    void work
      .catch((err: unknown) => config.onError?.(err, kind))
      .finally(() => pending.delete(work))
      .catch(() => {});
  }

  function emit(event: InboundEvent): Promise<void> {
    if (sink === undefined) return Promise.resolve();
    return sink(event);
  }

  async function handle(envelope: Envelope): Promise<void> {
    if (stopping || sink === undefined) return;
    const type = textOf(envelope.type);
    const body = fieldsOf(envelope.body);
    if (type === undefined || body === null) return;
    let events: InboundEvent[] = [];
    if (type === 'events_api') {
      const event = fieldsOf(body.event);
      const eventType = textOf(event?.type);
      const channel = textOf(event?.channel);
      if (
        event !== null &&
        channel !== undefined &&
        (eventType === 'message' || eventType === 'app_mention')
      ) {
        const bot = await botIdentity();
        const message = eventType === 'app_mention' ? { ...event, type: 'message' } : event;
        const nested = fieldsOf(message.message);
        const previous = fieldsOf(message.previous_message);
        const threadTs =
          textOf(message.thread_ts) ?? textOf(nested?.thread_ts) ?? textOf(previous?.thread_ts);
        const messageTs = textOf(message.ts) ?? textOf(nested?.ts);
        const deletedRoot =
          message.subtype === 'message_deleted' && threadTs === textOf(message.deleted_ts);
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
    } else if (type === 'interactive' || type === 'block_actions') {
      const actionMessage = fieldsOf(body.message);
      const channel = textOf(fieldsOf(body.channel)?.id);
      const ts = textOf(actionMessage?.ts);
      const threadTs = textOf(actionMessage?.thread_ts) ?? ts;
      const root =
        channel !== undefined && threadTs !== undefined && threadTs !== ts
          ? await rootFor(api, channel, threadTs)
          : actionMessage;
      events = normalizeInteraction(type, body, config.channels, root);
    } else if (type === 'slash_commands') {
      events = normalizeInteraction(type, body, config.channels, undefined, config.command);
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
          'connection',
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
          'connection',
        );
      });
      client.on('slack_event', (envelope: Envelope) => {
        track(handle(envelope), 'envelope');
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
