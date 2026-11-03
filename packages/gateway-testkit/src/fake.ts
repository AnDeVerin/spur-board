// An in-memory gateway and platform with two profiles, for core tests and the conformance suite.
// Deterministic: a manual clock, no timers, no network.
import { randomUUID } from 'node:crypto';
import {
  conversationRefSchema,
  interactionRefSchema,
  messageRefSchema,
  type Capabilities,
  type ConversationRef,
  type DeliverRequest,
  type DeliveryResult,
  type FailureScope,
  type Gateway,
  type InboundEvent,
  type InboundSink,
  type InteractionRef,
  type MessageRef,
  type RecoverRequest,
  type RespondResult,
  type RichText,
  type RichTextBlock,
  type RichTextInline,
  type SpaceId,
  type UserId,
} from '@spur-board/contracts';
import type {
  ConformanceInput,
  ConformancePlatform,
  VisibleConversation,
  VisibleMessage,
} from './conformance.ts';

export type FakeProfile = 'slack-like' | 'telegram-like';

export interface FakeGatewayOptions {
  profile: FakeProfile;
  /** How long the telegram-like platform keeps events for a stopped gateway. Default 24 h. */
  queueWindowMs?: number;
  /** Upper bound on one part's text. Default 4000 (slack-like) or 4096 (telegram-like). */
  maxTextLength?: number;
  /** The clock's start time. Default `2026-01-01T00:00:00.000Z`. */
  start?: Date;
}

/** Conformance inputs plus a slash command and a mention. */
export type FakeInput =
  | ConformanceInput
  | { kind: 'command'; author: UserId; text: string }
  | { kind: 'mention'; conversation: ConversationRef; author: UserId; text: string };

export interface FakePlatform extends ConformancePlatform {
  inject(input: FakeInput): Promise<{
    conversation?: ConversationRef;
    message?: MessageRef;
    interaction?: InteractionRef;
  }>;
  settle(): Promise<void>;
  messages(): readonly VisibleMessage[];
  conversations(): readonly VisibleConversation[];
  timeoutNext(fault: { step?: number; visible: boolean }): void;
  /** The next `deliver` returns `retry {afterMs, uncertain: false}` and posts nothing. */
  rateLimitNext(retryAfterMs: number): void;
  /** The next `deliver` returns `failed {permanent: true}` with this scope and posts nothing. */
  failNextPermanently(fault: { scope: FailureScope; reason?: string }): void;
  /** Slack-like only: the next marker search is inconclusive, so `deliver` returns an uncertain retry. */
  searchNotVisibleYet(): void;
  /** Counts every post, edit, done mark, marker search and rejected call, and public responses. */
  attempts(): number;
  unacknowledged(): number;
  now(): Date;
  advance(ms: number): void;
}

export interface FakeGateway extends Gateway {
  readonly platform: FakePlatform;
}

const profiles = {
  'slack-like': {
    kind: 'fake-slack-like',
    capabilities: { history: true, markerSearch: true, privateResponses: true },
    maxTextLength: 4000,
  },
  'telegram-like': {
    kind: 'fake-telegram-like',
    capabilities: { history: false, markerSearch: false, privateResponses: false },
    maxTextLength: 4096,
  },
} as const satisfies Record<
  FakeProfile,
  { kind: string; capabilities: Capabilities; maxTextLength: number }
>;

const defaultStart = new Date('2026-01-01T00:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

interface UserRecord {
  author: UserId;
  kind: 'message' | 'mention';
  text: string;
  at: string;
  edits: { n: number; at: string }[];
}

interface StoredMessage {
  seq: number;
  conversation: StoredConversation;
  message: MessageRef;
  text: string;
  marker?: string;
  repeat: boolean;
  root: boolean;
  deletedAt?: string;
  /** Set for messages a user posted through `inject`; only these produce inbound events. */
  user?: UserRecord;
}

interface StoredConversation {
  ref: ConversationRef;
  space?: SpaceId;
  root?: StoredMessage;
  done: boolean;
}

/** A step timed out; the delivery returns an uncertain retry. */
class StepTimeout extends Error {}
/** A marker search could not tell; the delivery returns an uncertain retry. */
class SearchUnknown extends Error {}

function inlineText(inline: RichTextInline): string {
  return inline.kind === 'mention' ? `@${inline.user}` : inline.text;
}

function blockText(block: RichTextBlock): string {
  return block.kind === 'code_block' ? block.text : block.children.map(inlineText).join('');
}

function blockTexts(body: RichText): string[] {
  return body.map(blockText).filter((t) => t.length > 0);
}

/**
 * Splits a body into parts of at most `max` characters. A part takes whole blocks joined by
 * `\n\n`; a block longer than `max` starts a new part and is cut into chunks of `max`.
 */
function split(body: RichText, max: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const text of blockTexts(body)) {
    if (text.length > max) {
      if (current !== '') parts.push(current);
      for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
      current = parts.pop() ?? '';
    } else if (current === '') {
      current = text;
    } else if (current.length + 2 + text.length <= max) {
      current = `${current}\n\n${text}`;
    } else {
      parts.push(current);
      current = text;
    }
  }
  parts.push(current);
  return parts;
}

function render(body: RichText): string {
  return blockTexts(body).join('\n\n');
}

type PartMode = 'plain' | 'search' | 'repeat';

export function createFakeGateway(options: FakeGatewayOptions): FakeGateway {
  const { profile } = options;
  const config = profiles[profile];
  const capabilities: Capabilities = { ...config.capabilities };
  const maxTextLength = options.maxTextLength ?? config.maxTextLength;
  const queueWindowMs = options.queueWindowMs ?? day;
  const { history } = config.capabilities;

  let clock = (options.start ?? defaultStart).getTime();
  let seq = 0;
  let conversationCount = 0;
  let interactionCount = 0;
  const conversations: StoredConversation[] = [];
  const messages: StoredMessage[] = [];
  const interactions = new Map<InteractionRef, { conversation?: StoredConversation }>();

  let sink: InboundSink | undefined;
  let pending: Promise<void> = Promise.resolve();
  let backgroundFailure: Error | undefined;
  const queue: { event: InboundEvent; atMs: number }[] = [];

  let timeout: { remaining: number; visible: boolean } | undefined;
  let rateLimit: number | undefined;
  let permanent: { scope: FailureScope; reason: string } | undefined;
  let searchUnknown = false;
  let attempts = 0;
  let unacknowledged = 0;

  const iso = (): string => new Date(clock).toISOString();
  const permalink = (conversation: StoredConversation, message: MessageRef): string =>
    `fake://${profile}/${conversation.ref}/${message}`;

  /** Runs one observable step, unless the armed timeout fires on it. */
  function step<T>(apply: () => T): T {
    attempts += 1;
    if (timeout !== undefined) {
      timeout.remaining -= 1;
      if (timeout.remaining <= 0) {
        const { visible } = timeout;
        timeout = undefined;
        if (visible) apply();
        throw new StepTimeout();
      }
    }
    return apply();
  }

  function search<T>(find: () => T | undefined): T | undefined {
    attempts += 1;
    if (searchUnknown) {
      searchUnknown = false;
      throw new SearchUnknown();
    }
    return find();
  }

  function newConversation(space?: SpaceId): StoredConversation {
    conversationCount += 1;
    const conversation: StoredConversation = {
      ref: conversationRefSchema.parse(`c${String(conversationCount)}`),
      done: false,
      ...(space === undefined ? {} : { space }),
    };
    conversations.push(conversation);
    return conversation;
  }

  function post(
    conversation: StoredConversation,
    text: string,
    extra: { marker?: string; repeat?: boolean; user?: UserRecord } = {},
  ): StoredMessage {
    seq += 1;
    const message: StoredMessage = {
      seq,
      conversation,
      message: messageRefSchema.parse(`m${String(seq)}`),
      text,
      repeat: extra.repeat ?? false,
      root: conversation.root === undefined,
      ...(extra.marker === undefined ? {} : { marker: extra.marker }),
      ...(extra.user === undefined ? {} : { user: extra.user }),
    };
    conversation.root ??= message;
    messages.push(message);
    return message;
  }

  function findConversation(ref: ConversationRef): StoredConversation {
    const found = conversations.find((c) => c.ref === ref);
    if (found === undefined) throw new Error(`fake: unknown conversation ${ref}`);
    return found;
  }

  function findMessage(ref: MessageRef): StoredMessage {
    const found = messages.find((m) => m.message === ref);
    if (found === undefined) throw new Error(`fake: unknown message ${ref}`);
    return found;
  }

  /** Posts parts `from..` into `conversation` and returns every part's message. */
  function postParts(
    conversation: StoredConversation,
    parts: readonly string[],
    markers: readonly string[],
    mode: PartMode,
    done: StoredMessage[] = [],
  ): StoredMessage[] {
    const posted = [...done];
    for (let i = posted.length; i < parts.length; i++) {
      const marker = markers[i] ?? '';
      const text = parts[i] ?? '';
      const found =
        mode === 'search'
          ? search(() =>
              messages.find(
                (m) => m.conversation === conversation && m.marker === marker && !m.deletedAt,
              ),
            )
          : undefined;
      posted.push(
        found ?? step(() => post(conversation, text, { marker, repeat: mode === 'repeat' })),
      );
    }
    return posted;
  }

  function deliverSteps(request: DeliverRequest): DeliveryResult {
    const parts = split(request.body, maxTextLength);
    const markers =
      parts.length === 1 ? [request.key] : parts.map((_, i) => `${request.key}#${String(i + 1)}`);
    const useSearch = request.maybeSent && capabilities.markerSearch;
    const mode: PartMode = !request.maybeSent ? 'plain' : useSearch ? 'search' : 'repeat';
    const { target } = request;
    switch (target.kind) {
      case 'open': {
        const existing = useSearch
          ? searchRoot(target.space, markers[0] ?? request.key)
          : undefined;
        const conversation = existing?.conversation ?? newConversation(target.space);
        const root =
          existing ??
          step(() => post(conversation, parts[0] ?? '', { marker: markers[0] ?? request.key }));
        // A new conversation holds no earlier copy, so its later parts are plain.
        postParts(conversation, parts, markers, existing ? 'search' : 'plain', [root]);
        return {
          status: 'delivered',
          conversation: conversation.ref,
          message: root.message,
          permalink: permalink(conversation, root.message),
        };
      }
      case 'reply':
      case 'close': {
        const conversation = conversations.find((c) => c.ref === target.conversation);
        if (conversation === undefined) {
          return {
            status: 'failed',
            permanent: true,
            scope: 'message',
            reason: 'unknown conversation',
          };
        }
        const posted = postParts(conversation, parts, markers, mode);
        if (target.kind === 'close' && !conversation.done) {
          step(() => {
            conversation.done = true;
          });
        }
        const first = posted[0];
        if (first === undefined) throw new Error('fake: a delivery has at least one part');
        return {
          status: 'delivered',
          message: first.message,
          permalink: permalink(conversation, first.message),
        };
      }
      case 'edit': {
        const message = messages.find((m) => m.message === target.message);
        if (message === undefined || message.deletedAt !== undefined) {
          return { status: 'failed', permanent: true, scope: 'message', reason: 'unknown message' };
        }
        step(() => {
          message.text = render(request.body);
        });
        return {
          status: 'delivered',
          message: message.message,
          permalink: permalink(message.conversation, message.message),
        };
      }
    }
  }

  function searchRoot(space: SpaceId, marker: string): StoredMessage | undefined {
    return search(() => conversations.find((c) => c.space === space && c.root?.marker === marker))
      ?.root;
  }

  function originKey(conversation: StoredConversation): { originKey?: string } {
    const marker = conversation.root?.marker;
    return marker === undefined ? {} : { originKey: marker.replace(/#\d+$/, '') };
  }

  function messageKey(message: StoredMessage): string {
    return `fake:${message.conversation.ref}:${message.message}`;
  }

  function userEvent(message: StoredMessage, user: UserRecord): InboundEvent {
    return {
      kind: user.kind,
      dedupeKey: messageKey(message),
      conversation: message.conversation.ref,
      message: message.message,
      author: user.author,
      text: user.text,
      at: user.at,
      ...originKey(message.conversation),
    };
  }

  function editEvent(
    message: StoredMessage,
    user: UserRecord,
    edit: UserRecord['edits'][number],
  ): InboundEvent {
    return {
      kind: 'message_edited',
      dedupeKey: `${messageKey(message)}:edit:${String(edit.n)}`,
      conversation: message.conversation.ref,
      message: message.message,
      author: user.author,
      text: message.text,
      at: edit.at,
      ...originKey(message.conversation),
    };
  }

  function deleteEvent(message: StoredMessage): InboundEvent {
    return {
      kind: 'message_deleted',
      dedupeKey: `${messageKey(message)}:deleted`,
      conversation: message.conversation.ref,
      message: message.message,
      ...originKey(message.conversation),
    };
  }

  /** Runs `deliverToSink` after everything already queued for the sink. */
  function enqueue(deliverToSink: () => Promise<void>): Promise<void> {
    const run = pending.then(deliverToSink);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Hands one input's event to the gateway and acknowledges it once the sink resolved (G11). */
  async function handOver(next: InboundSink, event: InboundEvent): Promise<void> {
    unacknowledged += 1;
    await next(event);
    unacknowledged -= 1;
  }

  /** Hands an event for `inject` input to the gateway: live, queued, or lost. */
  function emit(event: InboundEvent): Promise<void> {
    const current = sink;
    if (current !== undefined) return enqueue(() => handOver(current, event));
    if (!history) queue.push({ event, atMs: clock });
    return Promise.resolve();
  }

  function newInteraction(conversation?: StoredConversation): InteractionRef {
    interactionCount += 1;
    const ref = interactionRefSchema.parse(`i${String(interactionCount)}`);
    interactions.set(ref, conversation === undefined ? {} : { conversation });
    return ref;
  }

  async function inject(input: FakeInput): ReturnType<FakePlatform['inject']> {
    switch (input.kind) {
      case 'message':
      case 'mention': {
        const conversation =
          'space' in input ? newConversation(input.space) : findConversation(input.conversation);
        const user: UserRecord = {
          author: input.author,
          kind: input.kind,
          text: input.text,
          at: iso(),
          edits: [],
        };
        const message = post(conversation, input.text, { user });
        await emit(userEvent(message, user));
        return { conversation: conversation.ref, message: message.message };
      }
      case 'edit': {
        const message = findMessage(input.message);
        const { user } = message;
        if (user === undefined) throw new Error('fake: only user messages can be edited by a user');
        const edit = { n: user.edits.length + 1, at: iso() };
        user.edits.push(edit);
        message.text = input.text;
        await emit(editEvent(message, user, edit));
        return { conversation: message.conversation.ref, message: message.message };
      }
      case 'delete': {
        const message = findMessage(input.message);
        message.deletedAt = iso();
        // Telegram-like platforms never report deletions.
        if (history) await emit(deleteEvent(message));
        return { conversation: message.conversation.ref, message: message.message };
      }
      case 'action': {
        const message = findMessage(input.message);
        const interaction = newInteraction(message.conversation);
        await emit({
          kind: 'action',
          dedupeKey: `fake:${interaction}:action`,
          interaction,
          actionId: input.actionId,
          author: input.author,
          conversation: message.conversation.ref,
          message: message.message,
          ...originKey(message.conversation),
        });
        return { conversation: message.conversation.ref, message: message.message, interaction };
      }
      case 'command': {
        const interaction = newInteraction();
        await emit({
          kind: 'command',
          dedupeKey: `fake:${interaction}:command`,
          interaction,
          author: input.author,
          text: input.text,
        });
        return { interaction };
      }
    }
  }

  function recovered(request: RecoverRequest): InboundEvent[] {
    const since = request.since.getTime();
    if (!history) {
      if (clock - since <= queueWindowMs) return [];
      return [{ kind: 'gap', dedupeKey: `fake:gap:${randomUUID()}` }];
    }
    const events: InboundEvent[] = [];
    const inRange = (at: string): boolean => Date.parse(at) >= since;
    for (const { ref, after } of request.conversations) {
      const afterSeq =
        after === undefined ? 0 : (messages.find((m) => m.message === after)?.seq ?? 0);
      for (const message of messages) {
        const { user } = message;
        if (message.conversation.ref !== ref || user === undefined) continue;
        // `after` bounds only the message events; edits and deletions of earlier messages count.
        if (message.seq > afterSeq && inRange(user.at)) events.push(userEvent(message, user));
        // History returns the current state: only the latest edit.
        const latest = user.edits.at(-1);
        if (latest !== undefined && inRange(latest.at)) {
          events.push(editEvent(message, user, latest));
        }
        if (message.deletedAt !== undefined && inRange(message.deletedAt)) {
          events.push(deleteEvent(message));
        }
      }
    }
    return events;
  }

  const platform: FakePlatform = {
    inject,
    async settle() {
      await pending;
      if (backgroundFailure !== undefined) {
        const failure = backgroundFailure;
        backgroundFailure = undefined;
        throw failure;
      }
    },
    messages: () =>
      messages
        .filter((m) => m.deletedAt === undefined)
        .map((m) => ({
          conversation: m.conversation.ref,
          message: m.message,
          text: m.text,
          ...(m.marker === undefined ? {} : { marker: m.marker }),
          repeat: m.repeat,
          root: m.root,
        })),
    conversations: () =>
      conversations.map((c) => ({
        ref: c.ref,
        ...(c.root?.marker === undefined ? {} : { marker: c.root.marker }),
        done: c.done,
      })),
    timeoutNext({ step: at = 1, visible }) {
      timeout = { remaining: at, visible };
    },
    rateLimitNext(retryAfterMs) {
      rateLimit = retryAfterMs;
    },
    failNextPermanently({ scope, reason = 'fake permanent failure' }) {
      permanent = { scope, reason };
    },
    attempts: () => attempts,
    unacknowledged: () => unacknowledged,
    searchNotVisibleYet() {
      if (!capabilities.markerSearch) {
        throw new Error('fake: searchNotVisibleYet needs a profile with marker search');
      }
      searchUnknown = true;
    },
    now: () => new Date(clock),
    advance(ms) {
      clock += ms;
    },
  };

  return {
    kind: config.kind,
    capabilities,
    platform,
    start(next) {
      sink = next;
      const startedAt = clock;
      const queued = queue.splice(0);
      enqueue(async () => {
        await next({
          kind: 'connection',
          dedupeKey: `fake:connection:${randomUUID()}`,
          state: 'up',
        });
        for (const { event, atMs } of queued) {
          if (startedAt - atMs <= queueWindowMs) await handOver(next, event);
        }
      }).catch((error: unknown) => {
        backgroundFailure ??= error instanceof Error ? error : new Error(String(error));
      });
      return Promise.resolve();
    },
    async stop() {
      sink = undefined;
      await pending;
    },
    deliver(request) {
      if (rateLimit !== undefined) {
        attempts += 1;
        const afterMs = rateLimit;
        rateLimit = undefined;
        return Promise.resolve({ status: 'retry', afterMs, uncertain: false });
      }
      if (permanent !== undefined) {
        attempts += 1;
        const { scope, reason } = permanent;
        permanent = undefined;
        return Promise.resolve({ status: 'failed', permanent: true, scope, reason });
      }
      try {
        return Promise.resolve(deliverSteps(request));
      } catch (error) {
        if (error instanceof StepTimeout || error instanceof SearchUnknown) {
          return Promise.resolve({ status: 'retry', uncertain: true });
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    recover(request) {
      const events = recovered(request);
      return (async function* () {
        for (const event of events) yield await Promise.resolve(event);
      })();
    },
    respond(interaction, text, { private: isPrivate }) {
      const found = interactions.get(interaction);
      if (found === undefined) return Promise.resolve<RespondResult>('dropped');
      if (isPrivate) {
        return Promise.resolve<RespondResult>(capabilities.privateResponses ? 'sent' : 'dropped');
      }
      if (found.conversation !== undefined) {
        attempts += 1;
        post(found.conversation, render(text));
      }
      return Promise.resolve<RespondResult>('sent');
    },
  };
}
