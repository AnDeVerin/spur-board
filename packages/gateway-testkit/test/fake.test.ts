import {
  deliveryResultSchema,
  inboundEventSchema,
  interactionRefSchema,
  userIdSchema,
  type ConversationRef,
  type DeliverRequest,
  type Gateway,
  type InboundEvent,
  type RichText,
} from '@spur-board/contracts';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createFakeGateway,
  type FakeGateway,
  type FakeGatewayOptions,
  type FakeProfile,
} from '../src/index.ts';

const author = userIdSchema.parse('u1');
const persona = { name: 'tester', role: 'board' } as const;
const hour = 60 * 60 * 1000;
const profiles: FakeProfile[] = ['slack-like', 'telegram-like'];

function text(value: string): RichText {
  return [{ kind: 'paragraph', children: [{ kind: 'text', text: value }] }];
}

function paragraphTexts(count: number, length: number): string[] {
  return Array.from({ length: count }, (_, i) => String(i).padStart(length, 'p'));
}

function paragraphs(count: number, length: number): RichText {
  return paragraphTexts(count, length).map((value) => ({
    kind: 'paragraph' as const,
    children: [{ kind: 'text' as const, text: value }],
  }));
}

async function started(
  options: FakeGatewayOptions,
): Promise<{ fake: FakeGateway; events: InboundEvent[] }> {
  const fake = createFakeGateway(options);
  const events: InboundEvent[] = [];
  await fake.start((event) => {
    events.push(inboundEventSchema.parse(event));
    return Promise.resolve();
  });
  await fake.platform.settle();
  return { fake, events };
}

function deliver(
  fake: FakeGateway,
  request: Omit<DeliverRequest, 'persona' | 'maybeSent'> & {
    maybeSent?: boolean;
  },
) {
  return fake
    .deliver({ persona, maybeSent: false, ...request })
    .then((result) => deliveryResultSchema.parse(result));
}

async function openConversation(fake: FakeGateway, key = 'open'): Promise<ConversationRef> {
  const result = await deliver(fake, {
    key,
    target: { kind: 'open', space: 'feed', title: 't' },
    body: text(key),
  });
  if (result.status !== 'delivered' || result.conversation === undefined) {
    throw new Error('open did not deliver');
  }
  return result.conversation;
}

function marked(fake: FakeGateway, pattern: RegExp) {
  return fake.platform.messages().filter((m) => m.marker !== undefined && pattern.test(m.marker));
}

async function recoverAll(
  fake: FakeGateway,
  conversations: ConversationRef[],
  since = new Date(0),
) {
  const events: InboundEvent[] = [];
  for await (const event of fake.recover({
    conversations: conversations.map((ref) => ({ ref })),
    since,
  })) {
    events.push(inboundEventSchema.parse(event));
  }
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('package surface', () => {
  it('exports only the fake and the suite', async () => {
    expect(Object.keys(await import('../src/index.ts')).sort()).toEqual([
      'createFakeGateway',
      'runGatewayConformance',
    ]);
  });

  it('is a Gateway with the capabilities of its profile', () => {
    expectTypeOf(createFakeGateway({ profile: 'slack-like' })).toExtend<Gateway>();
    const slack = createFakeGateway({ profile: 'slack-like' });
    expect(slack.kind).toBe('fake-slack-like');
    expect(slack.capabilities).toEqual({
      history: true,
      markerSearch: true,
      privateResponses: true,
    });
    const telegram = createFakeGateway({ profile: 'telegram-like' });
    expect(telegram.kind).toBe('fake-telegram-like');
    expect(telegram.capabilities).toEqual({
      history: false,
      markerSearch: false,
      privateResponses: false,
    });
  });
});

describe('delivery faults', () => {
  for (const profile of profiles) {
    it(`rateLimitNext returns retry afterMs and posts nothing (${profile})`, async () => {
      const { fake } = await started({ profile });
      fake.platform.rateLimitNext(1500);
      const result = await deliver(fake, {
        key: 'k',
        target: { kind: 'open', space: 'feed', title: 't' },
        body: text('x'),
      });
      expect(result).toEqual({ status: 'retry', afterMs: 1500, uncertain: false });
      expect(fake.platform.messages()).toHaveLength(0);
    });

    it(`failNextPermanently returns failed with its scope (${profile})`, async () => {
      const { fake } = await started({ profile });
      for (const scope of ['transport', 'message'] as const) {
        fake.platform.failNextPermanently({ scope, reason: `no ${scope}` });
        const result = await deliver(fake, {
          key: 'k',
          target: { kind: 'open', space: 'feed', title: 't' },
          body: text('x'),
        });
        expect(result).toEqual({ status: 'failed', permanent: true, scope, reason: `no ${scope}` });
        expect(fake.platform.messages()).toHaveLength(0);
      }
    });

    it(`timeoutNext returns an uncertain retry, visible or not (${profile})`, async () => {
      const { fake } = await started({ profile });
      const conversation = await openConversation(fake);
      const target = { kind: 'reply', conversation } as const;
      fake.platform.timeoutNext({ visible: false });
      expect(await deliver(fake, { key: 'a', target, body: text('a') })).toEqual({
        status: 'retry',
        uncertain: true,
      });
      expect(marked(fake, /^a$/)).toHaveLength(0);
      fake.platform.timeoutNext({ visible: true });
      expect(await deliver(fake, { key: 'b', target, body: text('b') })).toEqual({
        status: 'retry',
        uncertain: true,
      });
      expect(marked(fake, /^b$/)).toHaveLength(1);
    });

    it(`timeoutNext step 2 breaks a multi-part reply after part 2 (${profile})`, async () => {
      const max = profile === 'slack-like' ? 4000 : 4096;
      const { fake } = await started({ profile });
      const conversation = await openConversation(fake);
      fake.platform.timeoutNext({ step: 2, visible: true });
      const result = await deliver(fake, {
        key: 'K',
        target: { kind: 'reply', conversation },
        body: paragraphs(30, Math.floor(max / 10)),
      });
      expect(result).toEqual({ status: 'retry', uncertain: true });
      const parts = marked(fake, /^K#\d+$/).filter((m) => m.conversation === conversation);
      expect(parts.map((m) => m.marker)).toEqual(['K#1', 'K#2']);
    });

    it(`maybeSent false never de-duplicates (${profile})`, async () => {
      const { fake } = await started({ profile });
      const conversation = await openConversation(fake);
      const request = {
        key: 'k',
        target: { kind: 'reply', conversation } as const,
        body: text('x'),
      };
      expect((await deliver(fake, request)).status).toBe('delivered');
      expect((await deliver(fake, request)).status).toBe('delivered');
      expect(marked(fake, /^k$/)).toHaveLength(2);
    });
  }

  it('searchNotVisibleYet makes the next marker search inconclusive (slack-like)', async () => {
    const { fake } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake);
    const request = { key: 'k', target: { kind: 'reply', conversation } as const, body: text('x') };
    expect((await deliver(fake, request)).status).toBe('delivered');
    fake.platform.searchNotVisibleYet();
    expect(await deliver(fake, { ...request, maybeSent: true })).toEqual({
      status: 'retry',
      uncertain: true,
    });
    expect(marked(fake, /^k$/)).toHaveLength(1);
    expect((await deliver(fake, { ...request, maybeSent: true })).status).toBe('delivered');
    expect(marked(fake, /^k$/)).toHaveLength(1);
  });

  it('searchNotVisibleYet throws on telegram-like', () => {
    const fake = createFakeGateway({ profile: 'telegram-like' });
    expect(() => {
      fake.platform.searchNotVisibleYet();
    }).toThrow(/marker search/);
  });
});

describe('splitting', () => {
  it('packs whole paragraphs into parts within maxTextLength', async () => {
    const { fake } = await started({ profile: 'slack-like', maxTextLength: 100 });
    const conversation = await openConversation(fake);
    await deliver(fake, {
      key: 'S',
      target: { kind: 'reply', conversation },
      body: paragraphs(9, 30),
    });
    const parts = marked(fake, /^S#\d+$/);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(100);
      expect(part.text).toContain('\n\n');
      expect(part.text).not.toMatch(/^\n|\n$/);
      expect(part.text).not.toContain('S#');
    }
    expect(parts.map((part) => part.text).join('\n\n')).toBe(paragraphTexts(9, 30).join('\n\n'));
  });

  it('cuts an over-long paragraph into chunks of maxTextLength', async () => {
    const { fake } = await started({ profile: 'telegram-like', maxTextLength: 100 });
    const conversation = await openConversation(fake);
    await deliver(fake, {
      key: 'L',
      target: { kind: 'reply', conversation },
      body: text('y'.repeat(250)),
    });
    const parts = marked(fake, /^L#\d+$/);
    expect(parts.map((part) => part.text.length)).toEqual([100, 100, 50]);
    expect(parts.map((part) => part.text)).not.toContainEqual(expect.stringContaining('L#'));
  });

  it('renders mentions and code blocks as plain text', async () => {
    const { fake } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake);
    await deliver(fake, {
      key: 'R',
      target: { kind: 'reply', conversation },
      body: [
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: 'hi ' },
            { kind: 'mention', user: author },
          ],
        },
        { kind: 'code_block', text: 'code' },
      ],
    });
    expect(marked(fake, /^R$/)[0]?.text).toBe('hi @u1\n\ncode');
  });
});

describe('inbound events', () => {
  it('emits one schema-valid event per inject kind before inject resolves (slack-like)', async () => {
    const { fake, events } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake, 'K');
    const before = events.length;
    const kinds: string[] = [];
    const record = () => {
      kinds.push(...events.slice(before + kinds.length).map((event) => event.kind));
    };
    const message = await fake.platform.inject({
      kind: 'message',
      conversation,
      author,
      text: 'a',
    });
    record();
    if (message.message === undefined) throw new Error('no message');
    await fake.platform.inject({ kind: 'message', space: 'feed', author, text: 'started' });
    record();
    await fake.platform.inject({ kind: 'edit', message: message.message, text: 'a2' });
    record();
    await fake.platform.inject({
      kind: 'action',
      message: message.message,
      actionId: 'go',
      author,
    });
    record();
    await fake.platform.inject({ kind: 'command', author, text: 'status' });
    record();
    await fake.platform.inject({ kind: 'mention', conversation, author, text: '@bot' });
    record();
    await fake.platform.inject({ kind: 'delete', message: message.message });
    record();
    expect(kinds).toEqual([
      'message',
      'message',
      'message_edited',
      'action',
      'command',
      'mention',
      'message_deleted',
    ]);
    const emitted = events.slice(before);
    expect(emitted[0]).toMatchObject({ originKey: 'K' });
    expect(emitted[0]?.dedupeKey).toMatch(/^fake:/);
    expect(emitted[1]).not.toHaveProperty('originKey');
    expect(emitted[2]?.dedupeKey).toBe(`${String(emitted[0]?.dedupeKey)}:edit:1`);
    expect(emitted[6]?.dedupeKey).toBe(`${String(emitted[0]?.dedupeKey)}:deleted`);
  });

  it('never emits deletes on telegram-like; inject still resolves', async () => {
    const { fake, events } = await started({ profile: 'telegram-like' });
    const conversation = await openConversation(fake);
    const { message } = await fake.platform.inject({
      kind: 'message',
      conversation,
      author,
      text: 'a',
    });
    if (message === undefined) throw new Error('no message');
    const before = events.length;
    await fake.platform.inject({ kind: 'delete', message });
    await fake.platform.settle();
    expect(events.slice(before)).toEqual([]);
    expect(fake.platform.messages().map((m) => m.message)).not.toContain(message);
  });

  for (const profile of profiles) {
    it(`own deliveries produce no inbound event (${profile})`, async () => {
      const { fake, events } = await started({ profile });
      const conversation = await openConversation(fake);
      const reply = await deliver(fake, {
        key: 'r',
        target: { kind: 'reply', conversation },
        body: text('r'),
      });
      if (reply.status !== 'delivered') throw new Error('reply did not deliver');
      await deliver(fake, {
        key: 'e',
        target: { kind: 'edit', message: reply.message },
        body: text('e'),
      });
      await deliver(fake, { key: 'c', target: { kind: 'close', conversation }, body: text('c') });
      await fake.platform.settle();
      expect(events.map((event) => event.kind)).toEqual(['connection']);
      if (profile === 'slack-like') expect(await recoverAll(fake, [conversation])).toEqual([]);
    });
  }
});

describe('respond', () => {
  it('drops unknown interactions and posts public answers', async () => {
    const { fake } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake);
    expect(
      await fake.respond(interactionRefSchema.parse('nope'), text('x'), { private: false }),
    ).toBe('dropped');
    const reply = await deliver(fake, {
      key: 'r',
      target: { kind: 'reply', conversation },
      body: text('r'),
    });
    if (reply.status !== 'delivered') throw new Error('reply did not deliver');
    const { interaction } = await fake.platform.inject({
      kind: 'action',
      message: reply.message,
      actionId: 'go',
      author,
    });
    if (interaction === undefined) throw new Error('no interaction');
    const visible = fake.platform.messages().length;
    expect(await fake.respond(interaction, text('private'), { private: true })).toBe('sent');
    expect(fake.platform.messages()).toHaveLength(visible);
    expect(await fake.respond(interaction, text('public'), { private: false })).toBe('sent');
    expect(fake.platform.messages().at(-1)?.text).toBe('public');
  });
});

describe('stop and start', () => {
  it('slack-like: events while stopped are not delivered on start; recover returns the latest edit', async () => {
    const { fake, events } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake);
    await fake.stop();
    const { message } = await fake.platform.inject({
      kind: 'message',
      conversation,
      author,
      text: 'a',
    });
    if (message === undefined) throw new Error('no message');
    await fake.platform.inject({ kind: 'edit', message, text: 'a1' });
    await fake.platform.inject({ kind: 'edit', message, text: 'a2' });
    const before = events.length;
    await fake.start((event) => {
      events.push(event);
      return Promise.resolve();
    });
    await fake.platform.settle();
    expect(events.slice(before).map((event) => event.kind)).toEqual(['connection']);
    const recovered = await recoverAll(fake, [conversation]);
    expect(recovered.map((event) => event.kind)).toEqual(['message', 'message_edited']);
    expect(recovered[1]).toMatchObject({ text: 'a2' });
    expect(recovered[1]?.dedupeKey).toMatch(/:edit:2$/);
  });

  it('slack-like: recover after a message still returns edits and deletions of earlier ones', async () => {
    const { fake } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake);
    const a = await fake.platform.inject({ kind: 'message', conversation, author, text: 'a' });
    const b = await fake.platform.inject({ kind: 'message', conversation, author, text: 'b' });
    const c = await fake.platform.inject({ kind: 'message', conversation, author, text: 'c' });
    if (a.message === undefined || b.message === undefined || c.message === undefined) {
      throw new Error('no message');
    }
    await fake.platform.inject({ kind: 'edit', message: a.message, text: 'a1' });
    await fake.platform.inject({ kind: 'delete', message: b.message });
    const events: InboundEvent[] = [];
    for await (const event of fake.recover({
      conversations: [{ ref: conversation, after: b.message }],
      since: new Date(0),
    })) {
      events.push(inboundEventSchema.parse(event));
    }
    expect(events.map((e) => [e.kind, 'message' in e ? e.message : undefined])).toEqual([
      ['message_edited', a.message],
      ['message_deleted', b.message],
      ['message', c.message],
    ]);
  });

  it('telegram-like: queued events arrive after connection up within the window', async () => {
    const { fake, events } = await started({ profile: 'telegram-like' });
    const conversation = await openConversation(fake);
    await fake.stop();
    await fake.platform.inject({ kind: 'message', conversation, author, text: 'queued' });
    fake.platform.advance(23 * hour);
    const before = events.length;
    await fake.start((event) => {
      events.push(event);
      return Promise.resolve();
    });
    await fake.platform.settle();
    expect(events.slice(before).map((event) => event.kind)).toEqual(['connection', 'message']);
    expect(events.at(-1)).toMatchObject({ text: 'queued', originKey: 'open' });
  });

  it('telegram-like: queued events older than the window are dropped and recover yields gap', async () => {
    const { fake, events } = await started({ profile: 'telegram-like' });
    const conversation = await openConversation(fake);
    const stoppedAt = fake.platform.now();
    await fake.stop();
    await fake.platform.inject({ kind: 'message', conversation, author, text: 'stale' });
    fake.platform.advance(25 * hour);
    const before = events.length;
    await fake.start((event) => {
      events.push(event);
      return Promise.resolve();
    });
    await fake.platform.settle();
    expect(events.slice(before).map((event) => event.kind)).toEqual(['connection']);
    const gaps = await recoverAll(fake, [], stoppedAt);
    expect(gaps.map((event) => event.kind)).toEqual(['gap']);
    expect(gaps[0]?.dedupeKey).toMatch(/^fake:gap:/);
    expect(await recoverAll(fake, [], fake.platform.now())).toEqual([]);
  });

  for (const profile of profiles) {
    it(`no sink call after stop resolves (${profile})`, async () => {
      const { fake, events } = await started({ profile });
      const conversation = await openConversation(fake);
      await fake.stop();
      const before = events.length;
      await fake.platform.inject({ kind: 'message', conversation, author, text: 'late' });
      await fake.platform.settle();
      expect(events).toHaveLength(before);
    });
  }

  it('settle waits for the connection event and reports a sink failure from start', async () => {
    const fake = createFakeGateway({ profile: 'slack-like' });
    await fake.start(() => Promise.reject(new Error('sink down')));
    await expect(fake.platform.settle()).rejects.toThrow('sink down');
    await expect(fake.platform.settle()).resolves.toBeUndefined();
  });
});

describe('determinism', () => {
  it('runs a full flow under fake timers on the manual clock', async () => {
    vi.useFakeTimers();
    const { fake, events } = await started({ profile: 'slack-like' });
    const conversation = await openConversation(fake);
    await fake.platform.inject({ kind: 'message', conversation, author, text: 'a' });
    expect(events.at(-1)).toMatchObject({ kind: 'message', at: '2026-01-01T00:00:00.000Z' });
    expect(fake.platform.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    await fake.stop();
  });

  it('starts the clock at the start option', () => {
    const start = new Date('2030-05-05T00:00:00.000Z');
    const fake = createFakeGateway({ profile: 'telegram-like', start });
    fake.platform.advance(1000);
    expect(fake.platform.now().toISOString()).toBe('2030-05-05T00:00:01.000Z');
  });
});
