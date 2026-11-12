import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  conversationRefSchema,
  messageRefSchema,
  type ConversationRef,
  type MessageRef,
} from '@spur-board/contracts';
import type {
  ConformanceInput,
  ConformancePlatform,
  VisibleConversation,
  VisibleMessage,
} from '@spur-board/gateway-testkit';
import { parseRef } from './ref.ts';
import { markerFromBlocks } from './render.ts';

interface StoredMessage {
  channel: string;
  ts: string;
  threadTs: string;
  text: string;
  blocks: unknown;
  username?: string;
  iconEmoji?: string;
  user?: string;
  edited?: { ts: string; user: string };
  botId?: string;
}

interface FakeRequest {
  method: string;
  params: Record<string, string>;
}

export interface FakeSlackApi {
  url: string;
  platform: ConformancePlatform;
  requests(): readonly FakeRequest[];
  /** Requests for a Slack method the fake does not implement. */
  violations(): readonly FakeRequest[];
  respondNext(status: number, body?: object, headers?: Record<string, string>): void;
  networkErrorNext(): void;
  searchUnknownNext(): void;
  holdNextWrite(): { entered: Promise<void>; release(): void };
  close(): Promise<void>;
  /** Send a raw Socket Mode envelope and wait for its acknowledgement when connected. */
  emitEnvelope(type: string, payload: object, retryAttempt?: number): Promise<void>;
  /** A deep copy of the stored messages, the reactions and the last ts; no request logs. */
  state(): FakeSlackState;
  /** Replaces the messages and reactions with a copy of `state`; ts never moves backward. */
  restore(state: FakeSlackState): void;
}

/** What `FakeSlackApi.state` returns. */
export interface FakeSlackState {
  stored: StoredMessage[];
  done: string[];
  lastMicros: number;
}

type Fault =
  | { kind: 'response'; status: number; body: object; headers: Record<string, string> }
  | { kind: 'network' };

function parseBlocks(value: string | undefined): unknown {
  if (value === undefined) return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function formValue(form: URLSearchParams, key: string): string {
  return form.get(key) ?? '';
}

function ref(message: StoredMessage): MessageRef {
  return messageRefSchema.parse(
    JSON.stringify({ channel: message.channel, ts: message.ts, threadTs: message.threadTs }),
  );
}

function conversation(message: StoredMessage): ConversationRef {
  return conversationRefSchema.parse(
    JSON.stringify({ channel: message.channel, ts: message.threadTs, threadTs: message.threadTs }),
  );
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else throw new Error('unexpected request body chunk');
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startFakeSlackApi(
  options: { pageSize?: number; now?: () => number; port?: number } = {},
): Promise<FakeSlackApi> {
  const pageSize = options.pageSize ?? 100;
  const now = options.now ?? (() => Date.now());
  const requests: FakeRequest[] = [];
  const violations: FakeRequest[] = [];
  const stored: StoredMessage[] = [];
  const done = new Set<string>();
  let nextFault: Fault | undefined;
  let nextNetworkError = false;
  let nextSearchUnknown = false;
  let timeout: { remaining: number; visible: boolean } | undefined;
  let hold: { entered: () => void; waiting: Promise<void> } | undefined;
  let lastMicros = 0;
  let nextEnvelope = 0;
  let connected: WebSocket | undefined;
  let waitingSocket: WebSocket | undefined;
  let acceptSocket = true;
  const acknowledgements = new Map<string, () => void>();
  const inFlight = new Set<Promise<void>>();
  const connectedWaiters = new Set<() => void>();

  // Slack ts is seconds.microseconds. Stamp the injected millisecond itself and keep ts unique
  // by stepping microseconds, so a message posted at a frozen instant stays inside that
  // millisecond instead of moving to a later one or back to the whole second.
  function ts(): string {
    const micros = Math.max(Math.floor(now()) * 1000, lastMicros + 1);
    lastMicros = micros;
    const seconds = Math.floor(micros / 1_000_000);
    return `${String(seconds)}.${String(micros % 1_000_000).padStart(6, '0')}`;
  }

  function reply(
    res: ServerResponse,
    status: number,
    body: object,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function send(type: string, payload: object, retryAttempt?: number): Promise<void> {
    if (connected?.readyState !== WebSocket.OPEN) return Promise.resolve();
    nextEnvelope += 1;
    const envelopeId = `E${String(nextEnvelope)}`;
    const ack = Promise.withResolvers<undefined>();
    acknowledgements.set(envelopeId, () => {
      ack.resolve(undefined);
    });
    const envelope = {
      envelope_id: envelopeId,
      type,
      payload,
      ...(retryAttempt === undefined ? {} : { retry_attempt: retryAttempt }),
    };
    connected.send(JSON.stringify(envelope));
    inFlight.add(ack.promise);
    void ack.promise.finally(() => inFlight.delete(ack.promise));
    return ack.promise;
  }

  function emitEnvelope(type: string, payload: object, retryAttempt?: number): Promise<void> {
    if (connected?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Socket Mode connection is not open'));
    }
    return send(type, payload, retryAttempt);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\//, '');
    const form =
      req.method === 'GET'
        ? new URLSearchParams(new URL(req.url ?? '', 'http://localhost').search)
        : await readForm(req);
    const params = Object.fromEntries(form);
    requests.push({ method, params });
    const write =
      method === 'chat.postMessage' || method === 'chat.update' || method === 'reactions.add';
    const fault = nextFault;
    if (fault !== undefined) {
      nextFault = undefined;
      if (fault.kind === 'network') {
        req.socket.destroy();
        return;
      }
      reply(res, fault.status, fault.body, fault.headers);
      return;
    }
    if (nextNetworkError) {
      nextNetworkError = false;
      req.socket.destroy();
      return;
    }
    if (
      nextSearchUnknown &&
      (method === 'conversations.history' || method === 'conversations.replies')
    ) {
      nextSearchUnknown = false;
      reply(res, 200, { ok: true });
      return;
    }

    let timedOut = false;
    let visible = true;
    if (write && timeout !== undefined) {
      timeout.remaining -= 1;
      if (timeout.remaining === 0) {
        timedOut = true;
        visible = timeout.visible;
        timeout = undefined;
      }
    }
    if (write && hold !== undefined) {
      const current = hold;
      hold = undefined;
      current.entered();
      await current.waiting;
    }
    if (timedOut && !visible) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!res.destroyed) reply(res, 200, { ok: true });
      return;
    }

    let result: object;
    switch (method) {
      case 'chat.postMessage': {
        const channel = formValue(form, 'channel');
        const messageTs = ts();
        const message: StoredMessage = {
          channel,
          ts: messageTs,
          threadTs: form.get('thread_ts') ?? messageTs,
          text: formValue(form, 'text'),
          blocks: parseBlocks(form.get('blocks') ?? undefined),
          ...(form.has('username') ? { username: formValue(form, 'username') } : {}),
          ...(form.has('icon_emoji') ? { iconEmoji: formValue(form, 'icon_emoji') } : {}),
          botId: 'B_FAKE',
        };
        stored.push(message);
        result = { ok: true, channel, ts: messageTs, message: { ts: messageTs } };
        break;
      }
      case 'chat.update': {
        const found = stored.find(
          (message) => message.channel === form.get('channel') && message.ts === form.get('ts'),
        );
        if (found === undefined) result = { ok: false, error: 'message_not_found' };
        else {
          found.text = formValue(form, 'text');
          found.blocks = parseBlocks(form.get('blocks') ?? undefined);
          found.edited = { ts: ts(), user: 'U_BOT' };
          result = { ok: true, channel: found.channel, ts: found.ts };
        }
        break;
      }
      case 'reactions.add': {
        const key = `${formValue(form, 'channel')}:${formValue(form, 'timestamp')}`;
        if (done.has(key)) result = { ok: false, error: 'already_reacted' };
        else {
          done.add(key);
          result = { ok: true };
        }
        break;
      }
      case 'chat.getPermalink':
        result = {
          ok: true,
          permalink: `https://slack.test/archives/${formValue(form, 'channel')}/p${formValue(form, 'message_ts').replace('.', '')}`,
        };
        break;
      case 'conversations.history':
      case 'conversations.replies': {
        const channel = formValue(form, 'channel');
        const oldest = Number(form.get('oldest') ?? 0);
        const latest = Number(form.get('latest') ?? Infinity);
        const filtered = stored.filter(
          (message) =>
            message.channel === channel &&
            (method === 'conversations.history'
              ? message.ts === message.threadTs
              : message.threadTs === form.get('ts')) &&
            Number(message.ts) >= oldest &&
            Number(message.ts) < latest,
        );
        if (method === 'conversations.history') filtered.reverse();
        const cursor = Number(form.get('cursor') ?? 0);
        const page = filtered.slice(cursor, cursor + pageSize);
        const more = cursor + pageSize < filtered.length;
        result = {
          ok: true,
          messages: page.map((message) => ({
            ts: message.ts,
            text: message.text,
            blocks: message.blocks,
            thread_ts: message.threadTs,
            ...(message.user === undefined ? {} : { user: message.user }),
            ...(message.edited === undefined ? {} : { edited: message.edited }),
            ...(message.botId === undefined
              ? {}
              : { bot_id: message.botId, subtype: 'bot_message' }),
          })),
          has_more: more,
          response_metadata: { next_cursor: more ? String(cursor + pageSize) : '' },
        };
        break;
      }
      case 'auth.test':
        result = { ok: true, user_id: 'U_BOT', bot_id: 'B_FAKE', team_id: 'T_FAKE' };
        break;
      case 'apps.connections.open':
        result = { ok: true, url: `ws://127.0.0.1:${String(address.port)}/socket` };
        break;
      case 'chat.postEphemeral':
        result = { ok: true, message_ts: ts() };
        break;
      case 'conversations.info':
        // The bot is a member of every channel, as chat.postMessage accepts any channel.
        result = { ok: true, channel: { id: formValue(form, 'channel'), is_member: true } };
        break;
      default:
        violations.push({ method, params });
        result = { ok: false, error: 'unknown_method' };
    }
    if (timedOut) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!res.destroyed) reply(res, 200, result);
      return;
    }
    reply(res, 200, result);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) reply(res, 500, { ok: false, error: String(error) });
    });
  });
  const sockets = new WebSocketServer({ server, path: '/socket' });
  // The server re-emits the HTTP server's errors and would throw without a listener; a failed
  // listen still rejects through `once` below.
  sockets.on('error', () => undefined);
  function activate(ws: WebSocket): void {
    connected = ws;
    waitingSocket = undefined;
    ws.send(JSON.stringify({ type: 'hello' }));
    for (const resolve of connectedWaiters) resolve();
    connectedWaiters.clear();
  }
  sockets.on('connection', (ws) => {
    // A malformed frame raises `error`; `close` still follows and clears the connection.
    ws.on('error', () => undefined);
    ws.on('message', (raw) => {
      try {
        const wire = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(new Uint8Array(raw)).toString('utf8');
        const payload = JSON.parse(wire) as unknown;
        if (typeof payload !== 'object' || payload === null || !('envelope_id' in payload)) return;
        const envelopeId = payload.envelope_id;
        if (typeof envelopeId !== 'string') return;
        acknowledgements.get(envelopeId)?.();
        acknowledgements.delete(envelopeId);
      } catch {
        // A malformed acknowledgement cannot settle the pending envelope.
      }
    });
    ws.on('close', () => {
      if (connected === ws) connected = undefined;
      if (waitingSocket === ws) waitingSocket = undefined;
    });
    if (acceptSocket) activate(ws);
    else waitingSocket = ws;
  });
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  async function inject(input: ConformanceInput): Promise<{
    conversation?: ConversationRef;
    message?: MessageRef;
  }> {
    if (input.kind === 'message') {
      const addressed = 'conversation' in input ? parseRef(input.conversation) : null;
      const channel =
        addressed?.channel ??
        ('space' in input && input.space === 'orchestrators' ? 'C_ORCH' : 'C_FEED');
      const messageTs = ts();
      const threadTs = addressed?.threadTs ?? messageTs;
      const message: StoredMessage = {
        channel,
        ts: messageTs,
        threadTs,
        text: input.text,
        blocks: [],
        user: input.author,
      };
      stored.push(message);
      await send('events_api', {
        event: {
          type: 'message',
          channel,
          ts: messageTs,
          thread_ts: threadTs,
          text: message.text,
          user: message.user,
        },
      });
      return { conversation: conversation(message), message: ref(message) };
    }
    const addressed = parseRef(input.message);
    if (addressed === null) throw new Error('invalid fake message reference');
    const index = stored.findIndex(
      (message) => message.channel === addressed.channel && message.ts === addressed.ts,
    );
    const current = stored[index];
    if (current === undefined) throw new Error('fake message not found');
    if (input.kind === 'edit') {
      const previous = { ...current };
      current.text = input.text;
      current.edited = { ts: ts(), user: current.user ?? 'U_BOT' };
      await send('events_api', {
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: current.channel,
          message: {
            ts: current.ts,
            thread_ts: current.threadTs,
            text: current.text,
            user: current.user,
            edited: current.edited,
          },
          previous_message: previous,
        },
      });
      return { conversation: conversation(current), message: ref(current) };
    }
    if (input.kind === 'delete') {
      stored.splice(index, 1);
      await send('events_api', {
        event: {
          type: 'message',
          subtype: 'message_deleted',
          channel: current.channel,
          deleted_ts: current.ts,
          previous_message: {
            ts: current.ts,
            thread_ts: current.threadTs,
            text: current.text,
            user: current.user,
            blocks: current.blocks,
          },
        },
      });
      return { conversation: conversation(current), message: ref(current) };
    }
    await send('interactive', {
      type: 'block_actions',
      trigger_id: `T${ts()}`,
      user: { id: input.author },
      channel: { id: current.channel },
      message: { ts: current.ts, thread_ts: current.threadTs, blocks: current.blocks },
      actions: [{ action_id: input.actionId }],
    });
    return { conversation: conversation(current), message: ref(current) };
  }

  function actionIds(blocks: unknown): string[] {
    if (!Array.isArray(blocks)) return [];
    const values: readonly unknown[] = blocks;
    return values.flatMap((block) => {
      if (typeof block !== 'object' || block === null) return [];
      if (!('type' in block) || block.type !== 'actions' || !('elements' in block)) return [];
      const elements: unknown = block.elements;
      if (!Array.isArray(elements)) return [];
      const items: readonly unknown[] = elements;
      return items.flatMap((element) =>
        typeof element === 'object' &&
        element !== null &&
        'action_id' in element &&
        typeof element.action_id === 'string'
          ? [element.action_id]
          : [],
      );
    });
  }

  const platform: ConformancePlatform = {
    inject,
    async settle() {
      await Promise.all([...inFlight]);
      await new Promise((resolve) => setImmediate(resolve));
    },
    messages(): readonly VisibleMessage[] {
      return stored.map((message) => {
        const marker = markerFromBlocks(message.blocks);
        return {
          conversation: conversation(message),
          message: ref(message),
          text: message.text,
          ...(marker === undefined ? {} : { marker }),
          repeat: false,
          root: message.ts === message.threadTs,
          actions: actionIds(message.blocks),
        };
      });
    },
    conversations(): readonly VisibleConversation[] {
      return stored
        .filter((message) => message.ts === message.threadTs)
        .map((message) => {
          const marker = markerFromBlocks(message.blocks);
          return {
            ref: conversation(message),
            ...(marker === undefined ? {} : { marker }),
            done: done.has(`${message.channel}:${message.ts}`),
          };
        });
    },
    timeoutNext({ step = 1, visible }) {
      timeout = { remaining: step, visible };
    },
    rateLimitNext(retryAfterMs) {
      nextFault = {
        kind: 'response',
        status: 429,
        body: { ok: false, error: 'ratelimited' },
        headers: { 'Retry-After': String(retryAfterMs / 1000) },
      };
    },
    failNextPermanently({ scope, reason }) {
      nextFault = {
        kind: 'response',
        status: 200,
        body: {
          ok: false,
          error: reason ?? (scope === 'transport' ? 'invalid_auth' : 'invalid_blocks'),
        },
        headers: {},
      };
    },
    attempts() {
      return requests.length;
    },
    unacknowledged() {
      return acknowledgements.size;
    },
    async dropConnection() {
      acceptSocket = false;
      if (connected === undefined) throw new Error('no Socket Mode connection to drop');
      const ws = connected;
      ws.close();
      await once(ws, 'close');
    },
    async restoreConnection() {
      acceptSocket = true;
      if (connected?.readyState !== WebSocket.OPEN) {
        const readyPromise = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            connectedWaiters.delete(ready);
            reject(new Error('Socket Mode did not reconnect'));
          }, 10_000);
          const ready = () => {
            clearTimeout(timer);
            resolve();
          };
          connectedWaiters.add(ready);
        });
        if (waitingSocket?.readyState === WebSocket.OPEN) activate(waitingSocket);
        await readyPromise;
      }
      // The server's open event can precede the gateway's hello handler.
      await emitEnvelope('probe', {});
    },
  };

  return {
    url: `http://127.0.0.1:${String(address.port)}/api/`,
    platform,
    requests: () => requests,
    violations: () => violations,
    respondNext(status, body = { ok: false, error: 'fake_error' }, headers = {}) {
      nextFault = { kind: 'response', status, body, headers };
    },
    networkErrorNext() {
      nextNetworkError = true;
    },
    searchUnknownNext() {
      nextSearchUnknown = true;
    },
    holdNextWrite() {
      const entered = Promise.withResolvers<undefined>();
      const released = Promise.withResolvers<undefined>();
      const release = () => {
        released.resolve(undefined);
      };
      hold = {
        entered: () => {
          entered.resolve(undefined);
        },
        waiting: released.promise,
      };
      return { entered: entered.promise, release };
    },
    async close() {
      acceptSocket = false;
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => {
        sockets.close(() => {
          resolve();
        });
      });
      server.closeAllConnections();
      await new Promise<undefined>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve(undefined);
          else reject(error);
        });
      });
    },
    emitEnvelope,
    state: () => structuredClone({ stored, done: [...done], lastMicros }),
    restore(state) {
      const copy = structuredClone(state);
      stored.splice(0, stored.length, ...copy.stored);
      done.clear();
      for (const key of copy.done) done.add(key);
      lastMicros = Math.max(lastMicros, copy.lastMicros);
    },
  };
}
