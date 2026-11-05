import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import type {
  ConversationRef,
  DeliverRequest,
  DeliveryResult,
  Gateway,
  InboundEvent,
  MessageRef,
  RecoverRequest,
  UserId,
} from '@spur-board/contracts';
import {
  assertExactLiveResults,
  assertSupportedLiveCaseSet,
  liveCaseIds,
  type LiveCaseId,
} from '@spur-board/gateway-testkit/cases';
import { createApi, isAlreadyReacted, readMessages } from '../src/api.ts';
import { createSlackGateway } from '../src/index.ts';
import { parseInteractionRef } from '../src/normalize.ts';
import { parseRef } from '../src/ref.ts';
import { markerFromBlocks, MAX_PART_TEXT } from '../src/render.ts';

const persona = { name: 'Conformance', role: 'board' } as const;
const promptTimeoutMs = 90_000;
const eventTimeoutMs = 10_000;

export interface LivePrompt {
  (
    id: LiveCaseId,
    instruction: string,
    context: { conversation: ConversationRef; message?: MessageRef },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface LiveRunOptions {
  token: string;
  appToken: string;
  channel: string;
  operator: UserId;
  prompt: LivePrompt;
  /** Local fake API only. The process command refuses API overrides. */
  apiUrl?: string;
  beforeCase?: (id: LiveCaseId) => Promise<void>;
  caseIds?: readonly LiveCaseId[];
  promptTimeoutMs?: number;
}

interface LiveCaseResult {
  id: LiveCaseId;
  status: 'pass' | 'fail';
  observation: string;
}

export interface LiveRunReport {
  date: string;
  results: readonly LiveCaseResult[];
  rateLimit: { status: 'pass' | 'fail' | 'not-run'; observation: string };
}

class CaseError extends Error {}

function requireResult(result: DeliveryResult): Extract<DeliveryResult, { status: 'delivered' }> {
  if (result.status !== 'delivered') throw new CaseError('delivery was not confirmed');
  return result;
}

function textBody(text: string): DeliverRequest['body'] {
  return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }];
}

function marker(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('blocks' in message)) return undefined;
  return markerFromBlocks(message.blocks);
}

function countMarker(messages: readonly unknown[], key: string): number {
  return messages.filter((message) => marker(message) === key).length;
}

function need(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new CaseError(reason);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  events: readonly InboundEvent[],
  start: number,
  match: (event: InboundEvent) => boolean,
  timeoutMs = eventTimeoutMs,
): Promise<InboundEvent> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = events.slice(start).find(match);
    if (found !== undefined) return found;
    if (Date.now() >= until) throw new CaseError('expected interaction was not received');
    await wait(100);
  }
}

async function promptWithTimeout(
  options: LiveRunOptions,
  id: LiveCaseId,
  instruction: string,
  context: { conversation: ConversationRef; message?: MessageRef },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    options.promptTimeoutMs ?? (id === 'guided-mention' ? 300_000 : promptTimeoutMs),
  );
  try {
    await options.prompt(id, instruction, context, controller.signal);
    if (controller.signal.aborted) throw new CaseError('guided action timed out');
  } catch {
    throw new CaseError('guided action timed out or was cancelled');
  } finally {
    clearTimeout(timer);
  }
}

interface RunContext {
  options: LiveRunOptions;
  gateway: Gateway;
  api: WebClient;
  events: InboundEvent[];
  key: string;
  botUser: string;
  root?: ConversationRef;
  rootMessage?: MessageRef;
  humanMessage?: MessageRef;
  rateLimit: LiveRunReport['rateLimit'];
  rateWaitedMs: number;
}

function rootOf(ctx: RunContext): ConversationRef {
  if (ctx.root === undefined) throw new CaseError('root delivery is unavailable');
  return ctx.root;
}

function rootMessageOf(ctx: RunContext): MessageRef {
  if (ctx.rootMessage === undefined) throw new CaseError('root delivery is unavailable');
  return ctx.rootMessage;
}

function thread(ctx: RunContext): { channel: string; threadTs: string } {
  const parsed = parseRef(rootOf(ctx));
  if (parsed === null) throw new CaseError('root reference is invalid');
  return { channel: parsed.channel, threadTs: parsed.threadTs };
}

async function history(ctx: RunContext): Promise<unknown[]> {
  return readMessages(ctx.api, thread(ctx));
}

async function deliver(
  ctx: RunContext,
  request: Omit<DeliverRequest, 'persona'>,
): Promise<DeliveryResult> {
  let result = await ctx.gateway.deliver({ ...request, persona });
  if (result.status !== 'retry') return result;
  if (result.afterMs === undefined) {
    if (result.uncertain) return result;
    ctx.rateLimit = { status: 'fail', observation: '429 lacked a usable Retry-After.' };
    return result;
  }
  const failedBefore = ctx.rateLimit.status === 'fail';
  for (let retry = 0; retry < 5; retry++) {
    if (result.status !== 'retry' || result.afterMs === undefined) {
      ctx.rateLimit = { status: 'fail', observation: '429 retry lacked a usable Retry-After.' };
      return result;
    }
    ctx.rateLimit = { status: 'fail', observation: '429 retry was not confirmed.' };
    if (ctx.rateWaitedMs + result.afterMs > 120_000) {
      ctx.rateLimit.observation = 'Retry-After exceeded the wait budget.';
      return result;
    }
    ctx.rateWaitedMs += result.afterMs;
    await wait(result.afterMs);
    result = await ctx.gateway.deliver({ ...request, maybeSent: true, persona });
    if (result.status === 'delivered') {
      if (!failedBefore) {
        ctx.rateLimit = { status: 'pass', observation: 'Incidental 429 waited and retried.' };
      }
      return result;
    }
  }
  return result;
}

async function openRoot(ctx: RunContext): Promise<void> {
  const key = `${ctx.key}:root`;
  const opened = requireResult(
    await deliver(ctx, {
      key,
      maybeSent: false,
      target: { kind: 'open', space: 'feed', title: 'Live conformance' },
      body: textBody(`Live conformance ${ctx.key}: use this thread for the guided checks.`),
      actions: [{ id: 'live_check', label: 'Confirm' }],
    }),
  );
  need(opened.conversation !== undefined, 'open returned no conversation');
  ctx.root = opened.conversation;
  ctx.rootMessage = opened.message;
}

async function deliveryCase(ctx: RunContext): Promise<string> {
  await openRoot(ctx);
  const key = `${ctx.key}:root`;
  const replied = requireResult(
    await deliver(ctx, {
      key: `${ctx.key}:reply`,
      maybeSent: false,
      target: { kind: 'reply', conversation: rootOf(ctx) },
      body: textBody('Live conformance reply.'),
    }),
  );
  requireResult(
    await deliver(ctx, {
      key: `${ctx.key}:edit`,
      maybeSent: false,
      target: { kind: 'edit', message: replied.message },
      body: textBody('Live conformance edited reply.'),
    }),
  );
  requireResult(
    await deliver(ctx, {
      key: `${ctx.key}:close`,
      maybeSent: false,
      target: { kind: 'close', conversation: rootOf(ctx) },
      body: textBody('Live conformance complete.'),
    }),
  );
  const messages = await history(ctx);
  for (const item of [key, `${ctx.key}:edit`, `${ctx.key}:close`]) {
    need(countMarker(messages, item) === 1, 'delivery marker was missing or duplicated');
  }
  const { channel, threadTs } = thread(ctx);
  let alreadyReacted = false;
  try {
    await ctx.api.reactions.add({ channel, timestamp: threadTs, name: 'white_check_mark' });
  } catch (error) {
    alreadyReacted = isAlreadyReacted(error);
  }
  need(alreadyReacted, 'close mark was not confirmed');
  return 'open, reply, edit, close and done mark confirmed';
}

async function multipartCase(ctx: RunContext): Promise<string> {
  const key = `${ctx.key}:multipart`;
  requireResult(
    await deliver(ctx, {
      key,
      maybeSent: false,
      target: { kind: 'reply', conversation: rootOf(ctx) },
      body: textBody('part '.repeat(Math.ceil((MAX_PART_TEXT + 300) / 5))),
    }),
  );
  const messages = await history(ctx);
  need(countMarker(messages, `${key}#1`) === 1, 'first part was missing or duplicated');
  need(countMarker(messages, `${key}#2`) === 1, 'second part was missing or duplicated');
  return 'both marked parts confirmed';
}

async function maybeSentCase(ctx: RunContext): Promise<string> {
  const key = `${ctx.key}:maybe`;
  const request = {
    key,
    target: { kind: 'reply' as const, conversation: rootOf(ctx) },
    body: textBody('Live conformance recent post.'),
  };
  requireResult(await deliver(ctx, { ...request, maybeSent: false }));
  let unknown = false;
  const until = Date.now() + 15_000;
  for (;;) {
    const result = await deliver(ctx, { ...request, maybeSent: true });
    if (result.status === 'delivered') break;
    if (result.status !== 'retry' || Date.now() >= until) {
      throw new CaseError('recent post could not be confirmed');
    }
    unknown = true;
    await wait(Math.min(result.afterMs ?? 500, 1000));
  }
  need(countMarker(await history(ctx), key) === 1, 'recent post was duplicated');
  return unknown ? 'search was initially unknown, then found one post' : 'search found one post';
}

async function recoveryCase(ctx: RunContext): Promise<string> {
  const root = rootOf(ctx);
  const before = ctx.events.length;
  const since = new Date(Date.now() - 3000);
  const token = `${ctx.key}:recovery`;
  await ctx.gateway.stop();
  try {
    await promptWithTimeout(
      ctx.options,
      'recovery',
      `While the gateway is disconnected, reply in the test thread with ${token}, then press Enter.`,
      { conversation: root },
    );
    need(ctx.events.length === before, 'an event arrived while the socket was stopped');
    const request: RecoverRequest = { conversations: [{ ref: root }], since };
    const recovered: InboundEvent[] = [];
    for await (const event of ctx.gateway.recover(request)) recovered.push(event);
    need(
      recovered.some(
        (event) =>
          event.kind === 'message' &&
          event.text.includes(token) &&
          event.conversation === root &&
          event.author === ctx.options.operator,
      ),
      'missed reply was not recovered from thread history',
    );
    return 'missed human reply recovered before reconnect';
  } finally {
    await ctx.gateway.start((event) => {
      ctx.events.push(event);
      return Promise.resolve();
    });
  }
}

async function botPostsCase(ctx: RunContext): Promise<string> {
  const start = ctx.events.length;
  const key = `${ctx.key}:echo`;
  requireResult(
    await deliver(ctx, {
      key,
      maybeSent: false,
      target: { kind: 'reply', conversation: rootOf(ctx) },
      body: textBody(key),
    }),
  );
  need(countMarker(await history(ctx), key) === 1, 'bot post was not visible');
  await wait(1000);
  need(
    !ctx.events.slice(start).some((event) => event.kind === 'message' && event.text.includes(key)),
    'bot post entered the inbound sink',
  );
  return 'visible bot post did not enter the inbound sink';
}

async function guidedCase(ctx: RunContext, id: LiveCaseId): Promise<string> {
  const root = rootOf(ctx);
  const token = `${ctx.key}:${id}`;
  const start = ctx.events.length;
  let instruction: string;
  let message: MessageRef | undefined;
  switch (id) {
    case 'guided-reply':
      instruction = `Reply in the test thread with ${token}, then press Enter.`;
      break;
    case 'guided-edit':
      if (ctx.humanMessage === undefined) throw new CaseError('guided reply is unavailable');
      message = ctx.humanMessage;
      instruction = `Edit your earlier reply to include ${token}, then press Enter.`;
      break;
    case 'guided-button':
      message = rootMessageOf(ctx);
      instruction = 'Press the Confirm button on the run root, then press Enter.';
      break;
    case 'guided-slash':
      instruction = `Run /board ${token} in the test channel, then press Enter.`;
      break;
    case 'guided-mention':
      instruction = `On the run root message, select Reply in thread. In the thread composer, type @ and select the app from autocomplete, include ${token}, then press Enter.`;
      break;
    default:
      throw new CaseError('unknown guided case');
  }
  await promptWithTimeout(
    ctx.options,
    id,
    instruction,
    message === undefined ? { conversation: root } : { conversation: root, message },
  );
  const match = (event: InboundEvent): boolean => {
    if (id === 'guided-button') {
      return (
        event.kind === 'action' &&
        event.actionId === 'live_check' &&
        event.conversation === root &&
        event.author === ctx.options.operator
      );
    }
    if (id === 'guided-slash') {
      return (
        event.kind === 'command' &&
        event.text.includes(token) &&
        parseInteractionRef(event.interaction)?.channel === ctx.options.channel &&
        event.author === ctx.options.operator
      );
    }
    if (id === 'guided-edit') {
      return (
        event.kind === 'message_edited' &&
        event.message === ctx.humanMessage &&
        event.conversation === root &&
        event.text.includes(token) &&
        event.author === ctx.options.operator
      );
    }
    if (id === 'guided-mention') {
      return (
        event.kind === 'message' &&
        event.conversation === root &&
        event.text.includes(token) &&
        event.text.includes(`<@${ctx.botUser}>`) &&
        event.author === ctx.options.operator
      );
    }
    return (
      event.kind === 'message' &&
      event.conversation === root &&
      event.text.includes(token) &&
      event.author === ctx.options.operator
    );
  };
  const found = await waitForEvent(ctx.events, start, match);
  if (id === 'guided-reply' && found.kind === 'message') ctx.humanMessage = found.message;
  if (id === 'guided-mention') {
    await wait(300);
    const keys = new Set(
      ctx.events
        .slice(start)
        .filter(match)
        .map((event) => event.dedupeKey),
    );
    need(keys.size === 1, 'mention produced more than one logical event');
  }
  return 'guided interaction confirmed';
}

async function execute(ctx: RunContext, id: LiveCaseId): Promise<string> {
  switch (id) {
    case 'delivery':
      return deliveryCase(ctx);
    case 'multipart':
      return multipartCase(ctx);
    case 'maybe-sent':
      return maybeSentCase(ctx);
    case 'recovery':
      return recoveryCase(ctx);
    case 'bot-posts':
      return botPostsCase(ctx);
    default:
      return guidedCase(ctx, id);
  }
}

/** Runs every declared case and records failures without exposing SDK errors or private values. */
export async function runLiveConformance(options: LiveRunOptions): Promise<LiveRunReport> {
  const caseIds = options.caseIds ?? liveCaseIds;
  assertSupportedLiveCaseSet(caseIds);
  const gateway = createSlackGateway({
    token: options.token,
    appToken: options.appToken,
    channels: { orchestrators: options.channel, feed: options.channel },
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
  });
  const api = createApi({
    token: options.token,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
  });
  const events: InboundEvent[] = [];
  const bot = await api.auth.test();
  if (typeof bot.user_id !== 'string' || bot.user_id.length === 0) {
    throw new CaseError('bot identity unavailable');
  }
  const ctx: RunContext = {
    options,
    gateway,
    api,
    events,
    key: `live-${randomUUID()}`,
    botUser: bot.user_id,
    rateLimit: { status: 'not-run', observation: 'No incidental 429 observed.' },
    rateWaitedMs: 0,
  };
  const results: LiveCaseResult[] = [];
  try {
    await gateway.start((event) => {
      events.push(event);
      return Promise.resolve();
    });
    for (const id of caseIds) {
      try {
        await options.beforeCase?.(id);
        if (id === 'guided-mention' && ctx.root === undefined) await openRoot(ctx);
        const observation = await execute(ctx, id);
        results.push({ id, status: 'pass', observation });
      } catch (error) {
        results.push({
          id,
          status: 'fail',
          observation: error instanceof CaseError ? error.message : 'unexpected case failure',
        });
      }
    }
  } finally {
    await gateway.stop();
  }
  assertExactLiveResults(caseIds, results);
  return { date: new Date().toISOString().slice(0, 10), results, rateLimit: ctx.rateLimit };
}
