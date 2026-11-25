import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  LogLevel,
  SocketModeClient,
  UnrecoverableSocketModeStartError,
  type Logger,
} from '@slack/socket-mode';
import { WebAPIPlatformError, type WebClient } from '@slack/web-api';
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
  /** Receives the connection log lines and the SDK's warn and error lines; without it they are dropped. */
  onLog?: SocketLog;
  /** Reconnect tuning for tests; the defaults are 1 s doubling to 60 s and a 30 s hello wait. */
  reconnect?: ReconnectOptions;
}

export type SocketLog = (
  level: 'info' | 'warn' | 'error',
  fields: Record<string, unknown>,
  msg: string,
) => void;

export interface ReconnectOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  helloTimeoutMs?: number;
}

/** What one connection attempt's SDK logger saw of its socket. */
export interface SocketRecord {
  closeCode?: number;
  closeReason?: string;
  socketError?: string;
}

/**
 * The wait before reconnect attempt `attempt` (1-based): equal jitter over a ceiling that doubles
 * from `baseDelayMs` up to `maxDelayMs`.
 */
export function reconnectDelay(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number },
  random: () => number,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

const closeFrameLine = /^WebSocket close frame received \(code: (\d+), reason: (.*)\)$/s;
const socketErrorLine = /^WebSocket error occurred: (.*)$/s;
// A structured gateway line already carries these facts.
const carriedLines = [
  /^Failed to retrieve a new WSS URL/,
  /^http request failed/,
  /^WebSocket error! /,
];

/**
 * The logger one SDK client gets. Debug and info lines never leave it (they carry payloads and
 * the WSS URL); it records the close frame and socket error into `record`, and forwards every
 * other warn and error line as its string arguments joined by a space.
 */
export function createSdkLogger(
  record: SocketRecord,
  forward: (level: 'warn' | 'error', detail: string) => void,
): Logger {
  const detailOf = (args: unknown[]) =>
    args.filter((arg): arg is string => typeof arg === 'string').join(' ');
  function line(level: 'warn' | 'error', args: unknown[]): void {
    const detail = detailOf(args);
    if (level === 'error') {
      const socketError = socketErrorLine.exec(detail);
      if (socketError !== null) {
        if (socketError[1] !== undefined && socketError[1].length > 0) {
          record.socketError = socketError[1];
        }
        return;
      }
    }
    if (carriedLines.some((pattern) => pattern.test(detail))) return;
    forward(level, detail);
  }
  return {
    debug(...args: unknown[]) {
      const frame = closeFrameLine.exec(detailOf(args));
      if (frame === null) return;
      record.closeCode = Number(frame[1]);
      if (frame[2] === undefined || frame[2] === '') delete record.closeReason;
      else record.closeReason = frame[2];
    },
    info() {
      // Info lines only narrate the connection, which the gateway logs itself.
    },
    warn(...args: unknown[]) {
      line('warn', args);
    },
    error(...args: unknown[]) {
      line('error', args);
    },
    getLevel: () => LogLevel.INFO,
    setLevel() {
      // The gateway fixes the level.
    },
    setName() {
      // Lines go out under the gateway's own module name.
    },
  };
}

/** The `reason` of a Socket Mode `disconnect` message, else undefined. */
function disconnectReasonOf(data: unknown): string | undefined {
  if (typeof data !== 'string' || !data.includes('"disconnect"')) return undefined;
  try {
    const message = fieldsOf(JSON.parse(data));
    return textOf(message?.type) === 'disconnect' ? textOf(message?.reason) : undefined;
  } catch {
    return undefined;
  }
}

function unrecoverable(err: unknown): boolean {
  const codes: readonly string[] = Object.values(UnrecoverableSocketModeStartError);
  return err instanceof WebAPIPlatformError && codes.includes(err.data.error);
}

/** Slack's `disconnect` reasons that ask for a new connection while the old one still serves. */
const refreshReasons: readonly string[] = ['refresh_requested', 'warning'];

/**
 * An SDK client that hands a refresh `disconnect` to the gateway. With its reconnect off the SDK
 * would close the socket at once; this client keeps it open when `onRefresh` takes the notice.
 */
class RefreshingClient extends SocketModeClient {
  onRefresh: (reason: string) => boolean = () => false;

  protected override async onWebSocketMessage(
    ...args: Parameters<SocketModeClient['onWebSocketMessage']>
  ): Promise<void> {
    const [data, isBinary] = args;
    const reason = isBinary ? undefined : disconnectReasonOf(data);
    if (reason !== undefined && refreshReasons.includes(reason) && this.onRefresh(reason)) return;
    await super.onWebSocketMessage(...args);
  }
}

type Outcome = 'up' | 'failed' | 'abandoned';

interface Attempt {
  outcome: Promise<Outcome>;
  /**
   * Resolves when an `up` attempt drops or stop cuts it off, or with its replacement once that
   * replacement got its hello.
   */
  ended: Promise<Attempt | undefined>;
  /** Settles a connecting attempt as abandoned and ends an up one, emitting nothing. */
  abandon(): void;
  /**
   * Ends an up attempt in favour of `next`, emitting nothing, and closes its socket once its
   * envelopes in flight settle; false when it was no longer up.
   */
  retire(next: Attempt): boolean;
  /** Resolves once the client holds no socket. */
  closed(): Promise<void>;
}

/**
 * The gateway owns transport reconnects: every drop after an `up` schedules attempts with
 * jittered backoff until `stop()`, each on a fresh SDK client with its reconnect turned off. A
 * refresh `disconnect` opens the replacement at once while the old socket keeps serving; the old
 * one closes after the replacement's hello. This layer also owns sink-before-ack ordering.
 */
export function createSocket(
  api: WebClient,
  config: SocketConfig,
  botIdentity: () => Promise<BotIdentity>,
): Pick<import('@spur-board/contracts').Gateway, 'start' | 'stop'> {
  const baseDelayMs = config.reconnect?.baseDelayMs ?? 1000;
  const maxDelayMs = config.reconnect?.maxDelayMs ?? 60_000;
  const helloTimeoutMs = config.reconnect?.helloTimeoutMs ?? 30_000;
  let started = false;
  let current: Attempt | undefined;
  // During a handover: the replacement connecting, then the old attempt closing.
  let replacement: Attempt | undefined;
  let retiring: Attempt | undefined;
  let supervisor: Promise<void> | undefined;
  let halt = new AbortController();
  let sink: InboundSink | undefined;
  let stopping = false;
  const pending = new Set<Promise<void>>();

  function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) {
    try {
      config.onLog?.(level, fields, msg);
    } catch {
      // A broken log callback must not break the connection loop.
    }
  }

  function connectionEvent(state: 'up' | 'down'): void {
    track(
      emit({ kind: 'connection', state, dedupeKey: `slack:connection:${randomUUID()}` }),
      'connection',
    );
  }

  /**
   * One connection attempt on a fresh client; `number` is 0 for the first start. A handover
   * attempt names the up attempt it `replaces` and the reason Slack gave.
   */
  function connect(
    appToken: string,
    number: number,
    replaces?: { attempt: Attempt; reason: string },
  ): Attempt {
    const record: SocketRecord = {};
    let disconnectReason: string | undefined;
    const outcome = Promise.withResolvers<Outcome>();
    const ended = Promise.withResolvers<Attempt | undefined>();
    const inFlight = new Set<Promise<void>>();
    let closing: Promise<void> = Promise.resolve();
    let disconnecting: Promise<void> | undefined;
    // `connecting` until hello or failure; `up` until its drop is logged, stop cuts it off or its
    // replacement takes over (`retired`).
    let state: 'connecting' | Outcome | 'down' | 'retired' = 'connecting';
    // A failed, abandoned or retired attempt, or an up one whose drop is logged, says nothing more.
    const quiet = () => state !== 'connecting' && state !== 'up';
    const client = new RefreshingClient({
      appToken,
      autoReconnectEnabled: false,
      logger: createSdkLogger(record, (level, detail) => {
        if (!quiet()) log(level, { detail }, 'slack socket-mode sdk');
      }),
      clientOptions: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: config.requestTimeoutMs ?? 10_000,
        ...(config.apiUrl === undefined ? {} : { slackApiUrl: config.apiUrl }),
      },
    });
    const disconnect = () => (disconnecting ??= client.disconnect());
    const socketFields = () => ({
      ...(disconnectReason === undefined ? {} : { disconnectReason }),
      closeCode: record.closeCode ?? 1006,
      ...(record.closeReason === undefined ? {} : { closeReason: record.closeReason }),
      ...(record.socketError === undefined ? {} : { socketError: record.socketError }),
    });
    function fail(fields: Record<string, unknown>, err?: unknown): void {
      if (state !== 'connecting') return;
      state = 'failed';
      clearTimeout(helloTimer);
      log(
        unrecoverable(err) ? 'error' : 'warn',
        { attempt: number, ...fields, ...(err === undefined ? {} : { err }) },
        'slack socket attempt failed',
      );
      outcome.resolve('failed');
    }
    const attempt: Attempt = {
      outcome: outcome.promise,
      ended: ended.promise,
      abandon() {
        if (state === 'connecting') {
          clearTimeout(helloTimer);
          outcome.resolve('abandoned');
        }
        if (state === 'connecting' || state === 'up' || state === 'retired') {
          state = 'abandoned';
          closing = disconnect();
        }
        ended.resolve(undefined);
      },
      retire(next) {
        if (state !== 'up') return false;
        state = 'retired';
        ended.resolve(next);
        // Its envelopes in flight, also those that arrive while it drains, still ack on this socket.
        closing = (async () => {
          while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
          await disconnect();
        })();
        return true;
      },
      closed: () => closing,
    };
    const helloTimer = setTimeout(() => {
      fail({ failure: 'hello_timeout' });
      // The state is failed first, so the `disconnected` this emits is ignored.
      closing = disconnect();
    }, helloTimeoutMs);
    client.onRefresh = (reason) => {
      if (state !== 'up' || stopping) return false;
      disconnectReason = reason;
      handover(appToken, attempt, reason);
      return true;
    };
    client.on('ws_message', (data: unknown) => {
      disconnectReason = disconnectReasonOf(data) ?? disconnectReason;
    });
    client.on('connected', () => {
      if (state !== 'connecting') return;
      state = 'up';
      clearTimeout(helloTimer);
      const old = replaces?.attempt;
      if (old?.retire(attempt) === true) {
        // The replacement serves from here; the old socket closes behind it.
        current = attempt;
        replacement = undefined;
        retiring = old;
        void old.closed().then(() => {
          if (retiring === old) retiring = undefined;
        });
        log('info', { disconnectReason: replaces?.reason }, 'slack socket refreshed');
      } else {
        log('info', { attempt: number }, 'slack socket up');
        connectionEvent('up');
      }
      outcome.resolve('up');
    });
    client.on('disconnected', () => {
      if (state === 'connecting') {
        fail({ failure: 'closed_before_hello', ...socketFields() });
        return;
      }
      if (state !== 'up') return;
      log('warn', socketFields(), 'slack socket down');
      state = 'down';
      connectionEvent('down');
      ended.resolve(undefined);
    });
    client.on('slack_event', (envelope: Envelope) => {
      if (state !== 'up' && state !== 'retired') return;
      const work = handle(envelope);
      inFlight.add(work);
      void work.catch(() => undefined).finally(() => inFlight.delete(work));
      track(work, 'envelope');
    });
    // Its result is read from the events above; an abandoned start settles unobserved.
    client.start().catch((err: unknown) => {
      fail({ failure: 'connections_open' }, err);
    });
    return attempt;
  }

  /**
   * Opens the replacement of the up attempt `old` at once; `old` keeps serving until the
   * replacement's hello. A replacement that fails leaves `old` serving, and its drop then runs
   * the usual backoff. A refresh notice while a replacement is connecting or closing is ignored:
   * `old` serves until Slack closes it, then the usual loop runs.
   */
  function handover(appToken: string, old: Attempt, reason: string): void {
    if (replacement !== undefined) return;
    log('info', { disconnectReason: reason }, 'slack socket refreshing');
    const next = connect(appToken, 1, { attempt: old, reason });
    replacement = next;
    void next.outcome.then(async (outcome) => {
      if (outcome === 'up') return;
      // One handover at a time: a refresh notice is ignored until this client holds no socket.
      await next.closed();
      if (replacement === next) replacement = undefined;
    });
  }

  /** Reconnects after every drop until stop; stopping is its only exit. */
  async function supervise(appToken: string, first: Attempt): Promise<void> {
    let serving = first;
    let attempt = 0;
    for (;;) {
      const handedTo = await serving.ended;
      if (stopping) return;
      if (handedTo !== undefined) {
        serving = handedTo;
        continue;
      }
      // A replacement still connecting when the old socket dropped becomes the next attempt.
      let next = replacement;
      replacement = undefined;
      if (next !== undefined) attempt = 1;
      for (;;) {
        if (next === undefined) {
          attempt += 1;
          const delayMs = reconnectDelay(attempt, { baseDelayMs, maxDelayMs }, Math.random);
          log('info', { attempt, delayMs }, 'slack socket reconnecting');
          try {
            await sleep(delayMs, undefined, { signal: halt.signal, ref: false });
          } catch {
            return;
          }
          // The sleep may have finished in the turn stop() aborted it.
          if (halt.signal.aborted) return;
          next = connect(appToken, attempt);
        }
        current = next;
        if ((await next.outcome) === 'up') {
          // Stop ends an up attempt, so the wait on it cannot outlive it.
          attempt = 0;
          serving = next;
          break;
        }
        // At most one live socket: a timed-out attempt closes before the next one opens.
        await next.closed();
        next = undefined;
      }
    }
  }

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
          channels: config.channels,
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
      if (started) throw new Error('Slack gateway already started');
      sink = nextSink;
      stopping = false;
      const appToken = config.appToken;
      if (appToken === undefined) return;
      await botIdentity();
      started = true;
      halt = new AbortController();
      const first = connect(appToken, 0);
      current = first;
      // The first start fails fast; only later drops are retried.
      if ((await first.outcome) !== 'up') {
        await first.closed();
        started = false;
        current = undefined;
        sink = undefined;
        throw new Error('Slack Socket Mode start failed');
      }
      supervisor = supervise(appToken, first);
    },
    async stop() {
      stopping = true;
      halt.abort();
      const attempts = [current, replacement, retiring].filter((attempt) => attempt !== undefined);
      current = undefined;
      replacement = undefined;
      retiring = undefined;
      // Never waits for an in-flight apps.connections.open: an abandoned client opens no socket.
      for (const attempt of attempts) attempt.abandon();
      await Promise.all(attempts.map((attempt) => attempt.closed()));
      await supervisor;
      supervisor = undefined;
      while (pending.size > 0) await Promise.allSettled([...pending]);
      sink = undefined;
      started = false;
    },
  };
}
