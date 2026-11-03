import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  conversationRefSchema,
  messageRefSchema,
  type ConversationRef,
  type MessageRef,
} from '@spur-board/contracts';
import type {
  ConformancePlatform,
  VisibleConversation,
  VisibleMessage,
} from '@spur-board/gateway-testkit';
import { markerFromBlocks } from '../src/render.ts';

interface StoredMessage {
  channel: string;
  ts: string;
  threadTs: string;
  text: string;
  blocks: unknown;
  username?: string;
  iconEmoji?: string;
}

interface FakeRequest {
  method: string;
  params: Record<string, string>;
}

export interface FakeSlackApi {
  url: string;
  platform: ConformancePlatform;
  requests(): readonly FakeRequest[];
  respondNext(status: number, body?: object, headers?: Record<string, string>): void;
  networkErrorNext(): void;
  searchUnknownNext(): void;
  holdNextWrite(): { entered: Promise<void>; release(): void };
  close(): Promise<void>;
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
  options: { pageSize?: number } = {},
): Promise<FakeSlackApi> {
  const pageSize = options.pageSize ?? 100;
  const requests: FakeRequest[] = [];
  const stored: StoredMessage[] = [];
  const done = new Set<string>();
  let nextFault: Fault | undefined;
  let nextNetworkError = false;
  let nextSearchUnknown = false;
  let timeout: { remaining: number; visible: boolean } | undefined;
  let hold: { entered: () => void; waiting: Promise<void>; release: () => void } | undefined;
  let sequence = 0;

  function ts(): string {
    sequence += 1;
    const seconds = Math.floor(Date.now() / 1000);
    return `${String(seconds)}.${String(sequence).padStart(6, '0')}`;
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\//, '');
    const form =
      req.method === 'GET'
        ? new URLSearchParams(new URL(req.url ?? '', 'http://localhost').search)
        : await readForm(req);
    requests.push({ method, params: Object.fromEntries(form) });
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
          })),
          has_more: more,
          response_metadata: { next_cursor: more ? String(cursor + pageSize) : '' },
        };
        break;
      }
      default:
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
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  const platform: ConformancePlatform = {
    inject() {
      return Promise.reject(new Error('inbound events are not available in the outbound fake'));
    },
    settle() {
      return Promise.resolve();
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
      return 0;
    },
    dropConnection() {
      throw new Error('Socket Mode is not available in the outbound fake');
    },
    restoreConnection() {
      throw new Error('Socket Mode is not available in the outbound fake');
    },
  };

  return {
    url: `http://127.0.0.1:${String(address.port)}/api/`,
    platform,
    requests: () => requests,
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
        release,
      };
      return { entered: entered.promise, release };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<undefined>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve(undefined);
          else reject(error);
        });
      });
    },
  };
}
