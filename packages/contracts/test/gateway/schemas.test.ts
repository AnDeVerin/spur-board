import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  INBOUND_EVENT_KINDS,
  deliveryResultSchema,
  inboundEventSchema,
  type DeliveryResult,
  type DeliveryStatus,
  type InboundEvent,
  type InboundEventKind,
} from '../../src/index.ts';

interface Fixtures {
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>;
}

const at = '2026-11-02T10:00:00Z';
const conversation = 'c-1';
const message = 'm-1';
const author = 'u-1';
const sourceUrl = 'https://example.test/message';
const rootMessage = 'root-1';

const events: Record<InboundEventKind, Fixtures> = {
  message: {
    valid: {
      kind: 'message',
      dedupeKey: 'k',
      conversation,
      message,
      rootMessage,
      sourceUrl,
      author,
      text: 'hi',
      at,
    },
    invalid: { kind: 'message', dedupeKey: 'k', conversation, message, author, text: 'hi' },
  },
  message_edited: {
    valid: {
      kind: 'message_edited',
      dedupeKey: 'k',
      conversation,
      message,
      rootMessage,
      sourceUrl,
      author,
      text: 'new',
      at,
      originKey: 'o',
    },
    invalid: {
      kind: 'message_edited',
      dedupeKey: 'k',
      conversation,
      message,
      author,
      text: 'new',
      at: 'yesterday',
    },
  },
  message_deleted: {
    valid: {
      kind: 'message_deleted',
      dedupeKey: 'k',
      conversation,
      message,
      rootMessage,
      sourceUrl,
    },
    invalid: { kind: 'message_deleted', dedupeKey: '', conversation, message },
  },
  action: {
    valid: {
      kind: 'action',
      dedupeKey: 'k',
      interaction: 'i-1',
      actionId: 'approve',
      author,
      conversation,
      message,
      rootMessage,
      sourceUrl,
    },
    invalid: { kind: 'action', dedupeKey: 'k', actionId: 'approve', author, conversation, message },
  },
  command: {
    valid: {
      kind: 'command',
      dedupeKey: 'k',
      interaction: 'i-1',
      author,
      text: 'status',
      sourceUrl,
    },
    invalid: {
      kind: 'command',
      dedupeKey: 'k',
      interaction: 'i-1',
      author,
      text: 'status',
      originKey: 'o',
    },
  },
  mention: {
    valid: {
      kind: 'mention',
      dedupeKey: 'k',
      conversation,
      message,
      rootMessage,
      sourceUrl,
      author,
      text: 'hey',
      at,
    },
    invalid: { kind: 'mention', dedupeKey: 'k', conversation, message, author: '', text: '', at },
  },
  gap: {
    valid: { kind: 'gap', dedupeKey: 'k' },
    invalid: { kind: 'gap', dedupeKey: 'k', conversation: '' },
  },
  connection: {
    valid: { kind: 'connection', dedupeKey: 'k', state: 'up' },
    invalid: { kind: 'connection', dedupeKey: 'k', state: 'reconnecting' },
  },
};

const results: Record<DeliveryStatus, Fixtures> = {
  delivered: {
    valid: { status: 'delivered', conversation, message, permalink: 'https://example.test/m-1' },
    invalid: { status: 'delivered', message, permalink: '' },
  },
  retry: {
    valid: { status: 'retry', afterMs: 1500, uncertain: false },
    invalid: { status: 'retry', afterMs: -1, uncertain: true },
  },
  failed: {
    valid: { status: 'failed', permanent: true, reason: 'token revoked', scope: 'transport' },
    invalid: { status: 'failed', permanent: false, reason: 'rejected', scope: 'message' },
  },
};

describe('inboundEventSchema', () => {
  it('has a fixture pair for every kind', () => {
    expect(Object.keys(events).sort()).toEqual([...INBOUND_EVENT_KINDS].sort());
    expectTypeOf<InboundEvent['kind']>().toEqualTypeOf<InboundEventKind>();
  });

  it.each(Object.entries(events))('%s: accepts the valid fixture', (_kind, { valid }) => {
    expect(inboundEventSchema.safeParse(valid).success).toBe(true);
  });

  it.each(Object.entries(events))('%s: rejects the invalid fixture', (_kind, { invalid }) => {
    expect(inboundEventSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(inboundEventSchema.safeParse({ kind: 'reaction', dedupeKey: 'k' }).success).toBe(false);
  });

  it('rejects an extra platform key', () => {
    const extra = { ...events.message.valid, thread_ts: '1.2' };
    expect(inboundEventSchema.safeParse(extra).success).toBe(false);
  });

  it.each([
    'message',
    'message_edited',
    'message_deleted',
    'action',
    'command',
    'mention',
  ] as const)('%s: requires a source link', (kind) => {
    const withoutSourceUrl = { ...events[kind].valid };
    delete withoutSourceUrl.sourceUrl;
    expect(inboundEventSchema.safeParse(withoutSourceUrl).success).toBe(false);
  });

  it.each(['message', 'message_edited', 'message_deleted', 'action', 'mention'] as const)(
    '%s: requires the conversation root message',
    (kind) => {
      const withoutRootMessage = { ...events[kind].valid };
      delete withoutRootMessage.rootMessage;
      expect(inboundEventSchema.safeParse(withoutRootMessage).success).toBe(false);
    },
  );
});

describe('deliveryResultSchema', () => {
  it('has a fixture pair for every status', () => {
    expect(Object.keys(results).sort()).toEqual([...DELIVERY_STATUSES].sort());
    expectTypeOf<DeliveryResult['status']>().toEqualTypeOf<DeliveryStatus>();
  });

  it.each(Object.entries(results))('%s: accepts the valid fixture', (_status, { valid }) => {
    expect(deliveryResultSchema.safeParse(valid).success).toBe(true);
  });

  it.each(Object.entries(results))('%s: rejects the invalid fixture', (_status, { invalid }) => {
    expect(deliveryResultSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(deliveryResultSchema.safeParse({ status: 'queued' }).success).toBe(false);
  });

  it('rejects an extra key', () => {
    const extra = { ...results.retry.valid, attempts: 2 };
    expect(deliveryResultSchema.safeParse(extra).success).toBe(false);
  });

  it('rejects a retry delay that is not an integer', () => {
    const fractional = { status: 'retry', afterMs: 1.5, uncertain: false };
    expect(deliveryResultSchema.safeParse(fractional).success).toBe(false);
  });

  it('rejects a failure that is not permanent', () => {
    expect(deliveryResultSchema.safeParse(results.failed.invalid).success).toBe(false);
  });
});
