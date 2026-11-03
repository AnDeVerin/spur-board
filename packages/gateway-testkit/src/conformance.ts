// The gateway conformance suite: one case per group of obligations in the `Gateway` TSDoc.
import {
  deliveryResultSchema,
  inboundEventSchema,
  userIdSchema,
  type Action,
  type ConversationRef,
  type DeliverRequest,
  type DeliveryResult,
  type DeliveryTarget,
  type Gateway,
  type InboundEvent,
  type InboundSink,
  type MessageRef,
  type RecoverRequest,
  type RichText,
  type SpaceId,
  type UserId,
} from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';

type Awaitable<T> = T | Promise<T>;

/** A gateway under test, with a way to drive and inspect the platform behind it. */
export interface ConformanceTarget {
  name: string;
  /**
   * Upper bound on one part's `VisibleMessage.text.length`. A gateway whose platform renders the
   * marker or repeat mark inside the message text counts them against the platform limit when it
   * splits; its target sets this to the platform limit minus that overhead.
   */
  maxTextLength: number;
  /** A fresh gateway and platform for one case. */
  create(): Awaitable<ConformanceHarness>;
}

export interface ConformanceHarness {
  gateway: Gateway;
  platform: ConformancePlatform;
  dispose?(): Awaitable<void>;
}

/**
 * The platform side of a target. A step is one change the inspector can observe: a message, a
 * part, an edit or the done mark. A gateway's own deliveries produce no inbound event, neither
 * live through the sink nor from `recover`; only `inject` input does.
 */
export interface ConformancePlatform {
  /**
   * A user acts on the platform. Resolves after the platform processed the input, whether or not
   * the gateway emitted an event; while the gateway runs, any event it emits for the input has
   * reached the sink by then. Works while the gateway is stopped.
   */
  inject(
    input: ConformanceInput,
  ): Awaitable<{ conversation?: ConversationRef; message?: MessageRef }>;
  /**
   * Resolves once every event the gateway will emit for what happened so far has reached the
   * sink, connection events and events queued while stopped included.
   */
  settle(): Awaitable<void>;
  /** Every visible message and part in creation order; deleted messages are excluded. */
  messages(): Awaitable<readonly VisibleMessage[]>;
  conversations(): Awaitable<readonly VisibleConversation[]>;
  /**
   * The `step`-th observable step from now (default 1) times out. `visible`: the step took effect
   * on the platform before the timeout.
   */
  timeoutNext(fault: { step?: number; visible: boolean }): Awaitable<void>;
}

export type ConformanceInput =
  | { kind: 'message'; conversation: ConversationRef; author: UserId; text: string }
  /** A user starts a conversation in a space. */
  | { kind: 'message'; space: SpaceId; author: UserId; text: string }
  | { kind: 'edit'; message: MessageRef; text: string }
  | { kind: 'delete'; message: MessageRef }
  | { kind: 'action'; message: MessageRef; actionId: string; author: UserId };

export interface VisibleMessage {
  conversation: ConversationRef;
  message: MessageRef;
  /**
   * Rendered body text of this message or part: its blocks' text joined by `\n\n`, without the
   * marker and without the repeat mark.
   */
  text: string;
  /** `<key>` for a single message, `<key>#<n>` for part n of a long body. */
  marker?: string;
  /** Marked as a repeat of an earlier attempt (G3, G4). */
  repeat: boolean;
  /** The conversation's first message. */
  root: boolean;
}

export interface VisibleConversation {
  ref: ConversationRef;
  /** The root's marker, verbatim. */
  marker?: string;
  done: boolean;
}

type ConformanceCaseId =
  | 'deliver-targets'
  | 'maybe-sent-reply'
  | 'maybe-sent-open'
  | 'parts'
  | 'close-steps'
  | 'recover-keys'
  | 'origin-key'
  | 'respond';

interface Harness {
  readonly gateway: Gateway;
  readonly platform: ConformancePlatform;
  readonly maxTextLength: number;
  /** Every event the sink received, in order. */
  readonly events: InboundEvent[];
  readonly sink: InboundSink;
  deliver(request: Delivery): Promise<DeliveryResult>;
  recover(request: RecoverRequest): Promise<InboundEvent[]>;
}

type Delivery = Pick<DeliverRequest, 'key' | 'target' | 'body'> & {
  maybeSent?: boolean;
  actions?: readonly Action[];
};

interface ConformanceCase {
  id: ConformanceCaseId;
  title: string;
  run(h: Harness): Promise<void>;
}

type Delivered = Extract<DeliveryResult, { status: 'delivered' }>;
type EventOf<K extends InboundEvent['kind']> = Extract<InboundEvent, { kind: K }>;

const persona = { name: 'conformance', role: 'board' } as const;
const author = userIdSchema.parse('conformance-user');
const space: SpaceId = 'feed';
const open: DeliveryTarget = { kind: 'open', space, title: 'conformance' };

function text(value: string): RichText {
  return [{ kind: 'paragraph', children: [{ kind: 'text', text: value }] }];
}

function token(i: number): string {
  return `T${String(i).padStart(3, '0')}`;
}

const tokenCount = 30;

/** About 3 x `max` characters: `tokenCount` paragraphs of about `max / 10`, each with a token. */
function longBody(max: number): RichText {
  const length = Math.max(5, Math.floor(max / 10));
  return Array.from({ length: tokenCount }, (_, i) => ({
    kind: 'paragraph' as const,
    children: [{ kind: 'text' as const, text: `${token(i)} ${'x'.repeat(length - 5)}` }],
  }));
}

function tokenHits(parts: readonly VisibleMessage[], i: number): number {
  const pattern = new RegExp(`\\b${token(i)}\\b`, 'g');
  return parts.reduce((sum, part) => sum + (part.text.match(pattern)?.length ?? 0), 0);
}

function delivered(result: DeliveryResult, message: string): Delivered {
  expect(result.status, message).toBe('delivered');
  if (result.status !== 'delivered') throw new Error(message);
  return result;
}

function uncertain(result: DeliveryResult, message: string): void {
  expect(result, message).toMatchObject({ status: 'retry', uncertain: true });
}

function conversationOf(result: Delivered, message: string): ConversationRef {
  expect(result.conversation, message).toBeDefined();
  if (result.conversation === undefined) throw new Error(message);
  return result.conversation;
}

function ofKind<K extends InboundEvent['kind']>(
  events: readonly InboundEvent[],
  kind: K,
): EventOf<K>[] {
  return events.filter((event): event is EventOf<K> => event.kind === kind);
}

function about(events: readonly InboundEvent[], message: MessageRef): InboundEvent[] {
  return events.filter((event) => 'message' in event && event.message === message);
}

function required<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();
  if (value === undefined) throw new Error(message);
  return value;
}

/** Injects input and returns the message it created or touched and the events it produced. */
async function live(
  h: Harness,
  input: ConformanceInput,
): Promise<{ message: MessageRef; events: InboundEvent[] }> {
  const before = h.events.length;
  const result = await h.platform.inject(input);
  const message = required(result.message, 'harness: inject returns the message it touched');
  return { message, events: h.events.slice(before) };
}

async function withMarker(h: Harness, pattern: RegExp): Promise<VisibleMessage[]> {
  return (await h.platform.messages()).filter(
    (message) => message.marker !== undefined && pattern.test(message.marker),
  );
}

function escape(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partsOf(key: string): RegExp {
  return new RegExp(`^${escape(key)}#(\\d+)$`);
}

function partNumber(message: VisibleMessage): number {
  return Number(message.marker?.slice(message.marker.lastIndexOf('#') + 1));
}

async function openConversation(h: Harness, key: string): Promise<ConversationRef> {
  const result = delivered(await h.deliver({ key, target: open, body: text(key) }), 'G6: open');
  return conversationOf(result, 'G6: open returns the new conversation');
}

/** Injects a user message into `conversation` and returns the `originKey` of its event. */
async function originKeyIn(h: Harness, conversation: ConversationRef): Promise<string | undefined> {
  const { message, events } = await live(h, { kind: 'message', conversation, author, text: 'hi' });
  const event = required(
    ofKind(about(events, message), 'message')[0],
    'G7: a user message emits a message event',
  );
  return event.originKey;
}

const ownKinds = new Set<InboundEvent['kind']>([
  'message',
  'message_edited',
  'message_deleted',
  'action',
  'mention',
]);

const deliverTargets: ConformanceCase = {
  id: 'deliver-targets',
  title: 'open, reply, edit and close each deliver',
  async run(h) {
    const opened = delivered(
      await h.deliver({ key: 'dt-open', target: open, body: text('opening') }),
      'G6: open returns delivered',
    );
    const conversation = conversationOf(opened, 'G6: open returns the new conversation');
    let messages = await h.platform.messages();
    const root = messages.find((message) => message.message === opened.message);
    expect(root?.root, 'G6: open returns the root as its message').toBe(true);
    expect(root?.conversation, 'G6: the root is in the new conversation').toBe(conversation);
    expect(root?.marker, 'G7: the root carries a marker of its delivery key').toBe('dt-open');
    const conversations = await h.platform.conversations();
    expect(
      conversations.find((c) => c.ref === conversation)?.marker,
      'G7: the conversation root carries the delivery key',
    ).toBe('dt-open');

    const reply = delivered(
      await h.deliver({
        key: 'dt-reply',
        target: { kind: 'reply', conversation },
        body: text('r'),
      }),
      'G6: reply returns delivered',
    );
    messages = await h.platform.messages();
    expect(
      messages.find((message) => message.message === reply.message)?.conversation,
      'G6: the reply is in the conversation',
    ).toBe(conversation);

    const edit = delivered(
      await h.deliver({
        key: 'dt-edit',
        target: { kind: 'edit', message: reply.message },
        body: text('edited'),
      }),
      'G6: edit returns delivered',
    );
    expect(edit.message, 'G6: edit returns the edited message').toBe(reply.message);
    messages = await h.platform.messages();
    expect(
      messages.find((message) => message.message === reply.message)?.text,
      'G6: the edit replaces the text',
    ).toBe('edited');

    const closed = delivered(
      await h.deliver({
        key: 'dt-close',
        target: { kind: 'close', conversation },
        body: text('closing'),
      }),
      'G5: close returns delivered',
    );
    messages = await h.platform.messages();
    const closing = messages.find((message) => message.message === closed.message);
    expect(closing?.conversation, 'G5: the closing line is in the conversation').toBe(conversation);
    expect(closing?.text, 'G5: the closing line is visible').toBe('closing');
    expect(
      (await h.platform.conversations()).find((c) => c.ref === conversation)?.done,
      'G5: close sets the done mark',
    ).toBe(true);

    await h.platform.settle();
    expect(
      h.events.filter((event) => ownKinds.has(event.kind)),
      'own-delivery: the gateway emits no inbound event for its own deliveries',
    ).toEqual([]);
  },
};

const maybeSentReply: ConformanceCase = {
  id: 'maybe-sent-reply',
  title: 'a maybe-sent reply is not duplicated',
  async run(h) {
    const conversation = await openConversation(h, 'mr-open');
    const key = 'mr-reply';
    const target = { kind: 'reply', conversation } as const;
    await h.platform.timeoutNext({ visible: true });
    uncertain(
      await h.deliver({ key, target, body: text('reply') }),
      'G2: a timeout returns retry {uncertain: true}',
    );
    const result = delivered(
      await h.deliver({ key, target, body: text('reply'), maybeSent: true }),
      'G3: the maybeSent retry returns delivered',
    );
    const copies = await withMarker(h, new RegExp(`^${escape(key)}$`));
    if (h.gateway.capabilities.markerSearch) {
      expect(copies.length, 'G3: exactly one message carries the key').toBe(1);
      expect(result.message, 'G3: delivered returns the found message').toBe(copies[0]?.message);
    } else {
      expect(copies.length, 'G3: a message carries the key').toBeGreaterThanOrEqual(1);
      for (const copy of copies) {
        expect(copy.conversation, 'G3: every copy is in the conversation').toBe(conversation);
      }
      expect(
        copies.slice(1).map((copy) => copy.repeat),
        'G3: every copy after the first carries a repeat mark',
      ).not.toContain(false);
      expect(
        copies.map((copy) => copy.message),
        'G3: delivered returns one of the copies',
      ).toContain(result.message);
    }
  },
};

const maybeSentOpen: ConformanceCase = {
  id: 'maybe-sent-open',
  title: 'a maybe-sent open is not duplicated',
  async run(h) {
    const key = 'mo-open';
    await h.platform.timeoutNext({ visible: true });
    uncertain(
      await h.deliver({ key, target: open, body: text('open') }),
      'G2: a timeout returns retry {uncertain: true}',
    );
    const result = delivered(
      await h.deliver({ key, target: open, body: text('open'), maybeSent: true }),
      'G3: the maybeSent retry returns delivered',
    );
    const conversation = conversationOf(result, 'G6: open returns the conversation');
    const marked = (await h.platform.conversations()).filter((c) => c.marker === key);
    if (h.gateway.capabilities.markerSearch) {
      expect(marked.length, 'G3: exactly one conversation carries the key').toBe(1);
    } else {
      expect(marked.length, 'G3: a conversation carries the key').toBeGreaterThanOrEqual(1);
    }
    expect(
      marked.map((c) => c.ref),
      'G3: delivered returns a conversation that carries the key',
    ).toContain(conversation);
    const root = (await h.platform.messages()).find((m) => m.message === result.message);
    expect(root?.root, 'G6: open returns the root as its message').toBe(true);
    expect(root?.conversation, 'G6: the root is in the returned conversation').toBe(conversation);
    for (const c of marked) {
      expect(await originKeyIn(h, c.ref), 'G7: events in a keyed conversation set originKey').toBe(
        key,
      );
    }
  },
};

const parts: ConformanceCase = {
  id: 'parts',
  title: 'a long body is split into keyed parts',
  async run(h) {
    const max = h.maxTextLength;
    const body = longBody(max);
    const conversation = await openConversation(h, 'pt-open');
    const target = { kind: 'reply', conversation } as const;

    // 4a: unbroken reply.
    const first = delivered(await h.deliver({ key: 'K1', target, body }), 'G6: a long reply');
    const k1 = await withMarker(h, partsOf('K1'));
    expect(k1.length, 'G4: a long body is split into two or more parts').toBeGreaterThanOrEqual(2);
    expect(
      k1.map((part) => part.marker),
      'G4: parts K1#1..K1#n appear in order',
    ).toEqual(k1.map((_, i) => `K1#${String(i + 1)}`));
    for (const part of k1) {
      expect(part.text.length, 'G4: each part fits maxTextLength').toBeLessThanOrEqual(max);
    }
    for (let i = 0; i < tokenCount; i++) {
      expect(tokenHits(k1, i), `G4: token ${token(i)} is visible exactly once`).toBe(1);
    }
    expect(first.message, 'G6: delivered returns part 1').toBe(k1[0]?.message);

    // 4b: a break between parts, then the maybeSent retry.
    await h.platform.timeoutNext({ step: 2, visible: true });
    uncertain(
      await h.deliver({ key: 'K2', target, body }),
      'G2: a timeout between parts returns retry {uncertain: true}',
    );
    const second = delivered(
      await h.deliver({ key: 'K2', target, body, maybeSent: true }),
      'G4: the maybeSent retry of a broken multi-part reply returns delivered',
    );
    const k2 = await withMarker(h, partsOf('K2'));
    const n = Math.max(0, ...k2.map(partNumber));
    expect(n, 'G4: the retry sends a multi-part body').toBeGreaterThanOrEqual(2);
    for (let i = 1; i <= n; i++) {
      const copies = k2.filter((part) => part.marker === `K2#${String(i)}`);
      if (h.gateway.capabilities.markerSearch) {
        expect(copies.length, `G4: part K2#${String(i)} is visible exactly once`).toBe(1);
      } else {
        expect(copies.length, `G4: part K2#${String(i)} is visible`).toBeGreaterThanOrEqual(1);
        expect(
          copies.slice(1).map((copy) => copy.repeat),
          `G4: every copy of K2#${String(i)} after the first carries a repeat mark`,
        ).not.toContain(false);
      }
    }
    for (let i = 0; i < tokenCount; i++) {
      expect(tokenHits(k2, i), `G4: token ${token(i)} is visible`).toBeGreaterThanOrEqual(1);
    }
    expect(
      k2.find((part) => part.message === second.message)?.marker,
      'G6: delivered returns part 1',
    ).toBe('K2#1');

    // 4c: a multi-part open.
    const opened = delivered(await h.deliver({ key: 'K3', target: open, body }), 'G6: a long open');
    const k3 = conversationOf(opened, 'G6: open returns the conversation');
    const root = (await h.platform.messages()).find((m) => m.root && m.conversation === k3);
    expect(root?.marker, 'G7: the root of a multi-part open carries K3#1').toBe('K3#1');
    expect(opened.message, 'G6: open returns the root').toBe(root?.message);
    expect(await originKeyIn(h, k3), 'G7: originKey is the key without the part suffix').toBe('K3');
  },
};

async function doneOf(h: Harness, conversation: ConversationRef): Promise<boolean | undefined> {
  return (await h.platform.conversations()).find((c) => c.ref === conversation)?.done;
}

async function closingLines(
  h: Harness,
  conversation: ConversationRef,
  key: string,
): Promise<number> {
  return (await h.platform.messages()).filter(
    (m) => m.conversation === conversation && m.marker === key,
  ).length;
}

const closeSteps: ConformanceCase = {
  id: 'close-steps',
  title: 'close is idempotent by step',
  async run(h) {
    const { markerSearch } = h.gateway.capabilities;
    const closing = text('closing');

    // 5a: the done mark times out without taking effect.
    const c1 = await openConversation(h, 'O1');
    await h.platform.timeoutNext({ step: 2, visible: false });
    const target1 = { kind: 'close', conversation: c1 } as const;
    const broken = await h.deliver({ key: 'L1', target: target1, body: closing });
    expect(broken.status, 'G6: close is not delivered before the done mark is set').not.toBe(
      'delivered',
    );
    uncertain(broken, 'G2: a timeout returns retry {uncertain: true}');
    expect(await doneOf(h, c1), 'G6: the done mark is not set').toBe(false);
    delivered(
      await h.deliver({ key: 'L1', target: target1, body: closing, maybeSent: true }),
      'G5: the maybeSent retry of close returns delivered',
    );
    expect(await doneOf(h, c1), 'G5: the retry sets the done mark').toBe(true);
    if (markerSearch) {
      expect(await closingLines(h, c1, 'L1'), 'G5: exactly one closing line').toBe(1);
    }

    // 5b: the done mark times out after taking effect.
    const c2 = await openConversation(h, 'O2');
    await h.platform.timeoutNext({ step: 2, visible: true });
    const target2 = { kind: 'close', conversation: c2 } as const;
    uncertain(
      await h.deliver({ key: 'L2', target: target2, body: closing }),
      'G2: a timeout returns retry {uncertain: true}',
    );
    expect(await doneOf(h, c2), 'G5: the done mark took effect').toBe(true);
    delivered(
      await h.deliver({ key: 'L2', target: target2, body: closing, maybeSent: true }),
      'G5: a done mark already present counts as success',
    );
    expect(await doneOf(h, c2), 'G5: the conversation stays done').toBe(true);
    if (markerSearch) {
      expect(await closingLines(h, c2, 'L2'), 'G5: exactly one closing line').toBe(1);
    }
  },
};

const recoverKeys: ConformanceCase = {
  id: 'recover-keys',
  title: 'recovered events keep their keys; restarts get fresh connection keys',
  async run(h) {
    const { history } = h.gateway.capabilities;

    // 1. Setup.
    const up1 = required(
      ofKind(h.events, 'connection').find((event) => event.state === 'up'),
      'G13: start emits connection up',
    );
    const key = 'rk-open';
    const conversation = await openConversation(h, key);

    // 2. Live phase.
    const a = await live(h, { kind: 'message', conversation, author, text: 'A' });
    const keyA = required(ofKind(a.events, 'message')[0], 'G8: message A emits an event').dedupeKey;
    const e1 = await live(h, { kind: 'edit', message: a.message, text: 'A1' });
    const keyE1 = required(
      ofKind(e1.events, 'message_edited')[0],
      'G9: edit e1 emits an event',
    ).dedupeKey;
    const e2 = await live(h, { kind: 'edit', message: a.message, text: 'A2' });
    const keyE2 = required(
      ofKind(e2.events, 'message_edited')[0],
      'G9: edit e2 emits an event',
    ).dedupeKey;
    expect(new Set([keyA, keyE1, keyE2]).size, 'G9: a message and each edit differ in key').toBe(3);
    const b = await live(h, { kind: 'message', conversation, author, text: 'B' });
    const keyB = required(ofKind(b.events, 'message')[0], 'G8: message B emits an event').dedupeKey;
    await h.platform.inject({ kind: 'delete', message: b.message });
    const deleteKey = ofKind(h.events, 'message_deleted').find(
      (e) => e.message === b.message,
    )?.dedupeKey;
    if (deleteKey !== undefined) {
      expect(deleteKey, 'G9: a deletion has a key of its own').not.toBe(keyB);
    }
    const request = { conversations: [{ ref: conversation }], since: new Date(0) };

    // 3. Recover #1.
    if (history) {
      const recovered = await h.recover(request);
      const messages = ofKind(recovered, 'message');
      const edits = ofKind(recovered, 'message_edited');
      expect(
        messages.filter((e) => e.message === a.message).map((e) => e.dedupeKey),
        'G8: a recovered message keeps its live dedupeKey',
      ).toContain(keyA);
      expect(
        edits.filter((e) => e.message === a.message).map((e) => e.dedupeKey),
        'G8: the latest edit is recovered with its live dedupeKey',
      ).toContain(keyE2);
      for (const event of messages) {
        expect([keyA, keyB], 'G8: every recovered message has its live dedupeKey').toContain(
          event.dedupeKey,
        );
      }
      for (const event of edits) {
        expect([keyE1, keyE2], 'G9: every recovered edit has its live dedupeKey').toContain(
          event.dedupeKey,
        );
      }
      for (const event of ofKind(recovered, 'message_deleted')) {
        if (deleteKey === undefined) {
          expect(event.dedupeKey, 'G9: a recovered deletion has a key of its own').not.toBe(keyB);
        } else {
          expect(event.dedupeKey, 'G8: a recovered deletion keeps its live key').toBe(deleteKey);
        }
      }
    }

    // 4. Restart.
    await h.gateway.stop();
    const d = await h.platform.inject({ kind: 'message', conversation, author, text: 'D' });
    const dMessage = required(d.message, 'harness: inject returns the message it touched');
    if (history) await h.platform.inject({ kind: 'edit', message: a.message, text: 'A3' });
    const before = h.events.length;
    await h.gateway.start(h.sink);
    await h.platform.settle();
    const after = h.events.slice(before);
    const upIndex = after.findIndex((e) => e.kind === 'connection' && e.state === 'up');
    expect(upIndex, 'G13: a restart emits connection up').toBeGreaterThanOrEqual(0);
    expect(after[upIndex]?.dedupeKey, 'G14: a restart gets a fresh connection key').not.toBe(
      up1.dedupeKey,
    );
    const dLive = ofKind(after, 'message').filter((e) => e.message === dMessage);

    if (history) {
      // 5a. Recover #2.
      const recovered = await h.recover(request);
      const dRecovered = ofKind(recovered, 'message').filter((e) => e.message === dMessage);
      expect(
        dRecovered.map((e) => e.originKey),
        'G7: a message missed while stopped is recovered with originKey',
      ).toContain(key);
      expect(
        ofKind(recovered, 'message')
          .filter((e) => e.message === a.message)
          .map((e) => e.dedupeKey),
        'G8: a recovered message keeps its live dedupeKey',
      ).toContain(keyA);
      const aEdits = ofKind(recovered, 'message_edited')
        .filter((e) => e.message === a.message)
        .map((e) => e.dedupeKey);
      expect(
        aEdits.filter((k) => ![keyA, keyE1, keyE2].includes(k)),
        'G9: an edit made while stopped is recovered with a key of its own',
      ).not.toEqual([]);
      const dLiveKey = dLive[0]?.dedupeKey;
      if (dLiveKey !== undefined) {
        expect(
          dRecovered.map((e) => e.dedupeKey),
          'G8: a message keeps its dedupeKey live and recovered',
        ).toContain(dLiveKey);
      }
    } else {
      // 5b. No history: the queued message arrives after the new connection up.
      const dIndex = after.findIndex((e) => e.kind === 'message' && e.message === dMessage);
      expect(
        dIndex,
        'G13: a message sent while stopped arrives after connection up',
      ).toBeGreaterThan(upIndex);
      expect(dLive[0]?.originKey, 'G7: the queued message sets originKey').toBe(key);
      const empty = { conversations: [], since: new Date(0) };
      const gaps1 = ofKind(await h.recover(empty), 'gap');
      expect(gaps1.length, 'G10: recover without history yields gap').toBeGreaterThanOrEqual(1);
      const gaps2 = ofKind(await h.recover(empty), 'gap');
      expect(gaps2.length, 'G12: recover without history yields gap').toBeGreaterThanOrEqual(1);
      for (const gap of gaps2) {
        expect(
          gaps1.map((g) => g.dedupeKey),
          'G14: every gap has a fresh dedupeKey',
        ).not.toContain(gap.dedupeKey);
      }
    }
  },
};

const originKey: ConformanceCase = {
  id: 'origin-key',
  title: 'events carry originKey only in delivered conversations',
  async run(h) {
    const conversation = await openConversation(h, 'ok-open');
    expect(await originKeyIn(h, conversation), 'G7: an event in a delivered conversation').toBe(
      'ok-open',
    );
    const started = await live(h, { kind: 'message', space, author, text: 'user-started' });
    const event = required(
      ofKind(about(started.events, started.message), 'message')[0],
      'G7: a user-started conversation emits a message event',
    );
    expect(event.originKey, 'G7: a user-started conversation has no originKey').toBeUndefined();
  },
};

const respond: ConformanceCase = {
  id: 'respond',
  title: 'an action can be answered; private answers follow capabilities',
  async run(h) {
    const conversation = await openConversation(h, 'rs-open');
    const reply = delivered(
      await h.deliver({
        key: 'rs-reply',
        target: { kind: 'reply', conversation },
        body: text('choose'),
        actions: [{ id: 'approve', label: 'Approve' }],
      }),
      'G6: a reply with actions',
    );
    const pressed = await live(h, {
      kind: 'action',
      message: reply.message,
      actionId: 'approve',
      author,
    });
    const action = required(
      ofKind(pressed.events, 'action')[0],
      'G15: an action press emits an action event',
    );
    expect(action.actionId, 'G15: the action event names the action').toBe('approve');
    const visible = (await h.platform.messages()).length;
    const result = await h.gateway.respond(action.interaction, text('private'), { private: true });
    expect(result, 'G15: a private answer follows capabilities.privateResponses').toBe(
      h.gateway.capabilities.privateResponses ? 'sent' : 'dropped',
    );
    expect((await h.platform.messages()).length, 'G15: a private answer posts nothing public').toBe(
      visible,
    );
  },
};

/** The suite's cases, in run order. */
export const conformanceCases: readonly ConformanceCase[] = [
  deliverTargets,
  maybeSentReply,
  maybeSentOpen,
  parts,
  closeSteps,
  recoverKeys,
  originKey,
  respond,
];

function harness(target: ConformanceTarget, created: ConformanceHarness): Harness {
  const events: InboundEvent[] = [];
  const sink: InboundSink = (event) => {
    const parsed = inboundEventSchema.safeParse(event);
    if (!parsed.success) {
      return Promise.reject(
        new Error(`contract: an inbound event fails its schema: ${parsed.error.message}`),
      );
    }
    events.push(parsed.data);
    return Promise.resolve();
  };
  return {
    gateway: created.gateway,
    platform: created.platform,
    maxTextLength: target.maxTextLength,
    events,
    sink,
    async deliver(request) {
      const result = await created.gateway.deliver({ persona, maybeSent: false, ...request });
      const parsed = deliveryResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(`contract: a deliver result fails its schema: ${parsed.error.message}`);
      }
      return parsed.data;
    },
    async recover(request) {
      const recovered: InboundEvent[] = [];
      for await (const event of created.gateway.recover(request)) {
        const parsed = inboundEventSchema.safeParse(event);
        if (!parsed.success) {
          throw new Error(`contract: a recovered event fails its schema: ${parsed.error.message}`);
        }
        recovered.push(parsed.data);
      }
      return recovered;
    },
  };
}

/**
 * Runs one case against a fresh gateway from `target`: starts it, waits for `settle()`, runs the
 * case, then stops and disposes it. Rejects with the first failed assertion.
 */
export async function runConformanceCase(
  target: ConformanceTarget,
  id: ConformanceCaseId,
): Promise<void> {
  const found = conformanceCases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`unknown conformance case: ${id}`);
  const created = await target.create();
  const h = harness(target, created);
  try {
    await h.gateway.start(h.sink);
    await h.platform.settle();
    await found.run(h);
  } finally {
    await h.gateway.stop();
    await created.dispose?.();
  }
}

/** Registers the conformance suite for `target`: one `it` per case. */
export function runGatewayConformance(target: ConformanceTarget): void {
  describe(`gateway conformance: ${target.name}`, () => {
    for (const c of conformanceCases) {
      it(`${c.id}: ${c.title}`, () => runConformanceCase(target, c.id));
    }
  });
}
