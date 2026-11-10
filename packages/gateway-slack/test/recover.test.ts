import {
  userIdSchema,
  type InboundEvent,
  type RecoverRequest,
  type RichText,
} from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createSlackGateway } from '../src/index.ts';
import { startFakeSlackApi } from './fake-api.ts';

// The Socket Mode SDK waits five seconds before its first automatic reconnect.
vi.setConfig({ testTimeout: 15_000 });

const author = userIdSchema.parse('U_OPERATOR');
const body: RichText = [{ kind: 'paragraph', children: [{ kind: 'text', text: 'question' }] }];

async function collect(events: AsyncIterable<InboundEvent>): Promise<InboundEvent[]> {
  const found: InboundEvent[] = [];
  for await (const event of events) found.push(event);
  return found;
}

async function setup(pageSize = 100) {
  const fake = await startFakeSlackApi({ pageSize });
  const gateway = createSlackGateway({
    token: 'xoxb-test',
    now: () => Date.now(),
    appToken: 'xapp-test',
    channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
    apiUrl: fake.url,
    requestTimeoutMs: 500,
  });
  const opened = await gateway.deliver({
    key: 'recover-root',
    maybeSent: false,
    target: { kind: 'open', space: 'orchestrators', title: 'question' },
    persona: { name: 'test', role: 'board' },
    body,
  });
  if (opened.status !== 'delivered' || opened.conversation === undefined) {
    throw new Error('fake conversation failed to open');
  }
  return { fake, gateway, conversation: opened.conversation };
}

describe('Slack thread recovery', () => {
  it('lets an up event trigger recovery of a disconnected edit and every reply page once', async () => {
    const { fake, gateway, conversation } = await setup(2);
    const live: InboundEvent[] = [];
    const recovered: InboundEvent[] = [];
    let after: RecoverRequest['conversations'][number]['after'];
    let upCount = 0;
    try {
      await gateway.start(async (event) => {
        live.push(event);
        if (event.kind === 'connection' && event.state === 'up') {
          upCount += 1;
          recovered.push(
            ...(await collect(
              gateway.recover({
                conversations: [{ ref: conversation, ...(after === undefined ? {} : { after }) }],
                since: new Date(0),
              }),
            )),
          );
        }
      });
      const first = await fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'first',
      });
      after = first.message;
      if (after === undefined) throw new Error('fake did not return message reference');
      await fake.platform.dropConnection();
      await fake.platform.inject({ kind: 'edit', message: after, text: 'first edited' });
      const missed = [];
      for (const text of ['second', 'third', 'fourth']) {
        missed.push(await fake.platform.inject({ kind: 'message', conversation, author, text }));
      }
      await fake.platform.restoreConnection();
      await vi.waitFor(
        () => {
          expect(upCount).toBe(2);
        },
        { timeout: 2000 },
      );
      await vi.waitFor(
        () => {
          expect(recovered.filter((event) => event.kind === 'message_edited').length).toBe(1);
        },
        { timeout: 2000 },
      );
      const replies = recovered.filter(
        (event): event is Extract<InboundEvent, { kind: 'message' }> => event.kind === 'message',
      );
      const missedRefs = missed.map((item) => item.message);
      expect(replies.filter((event) => missedRefs.includes(event.message))).toHaveLength(3);
      expect(new Set(replies.map((event) => event.dedupeKey)).size).toBe(replies.length);
      expect(
        live.filter((event) => event.kind === 'connection' && event.state === 'down'),
      ).toHaveLength(1);
    } finally {
      await gateway.stop();
      await fake.close();
    }
  });

  it('includes an event at since, keeps older edits beyond after, and gaps on a missing anchor', async () => {
    const { fake, gateway, conversation } = await setup(2);
    try {
      await gateway.start(async () => {});
      const first = await fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'old',
      });
      const second = await fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'new',
      });
      if (first.message === undefined || second.message === undefined)
        throw new Error('missing ref');
      const initial = await collect(
        gateway.recover({ conversations: [{ ref: conversation }], since: new Date(0) }),
      );
      const secondEvent = initial.find(
        (event) => event.kind === 'message' && event.message === second.message,
      );
      if (secondEvent?.kind !== 'message') throw new Error('missing second event');
      const atBoundary = await collect(
        gateway.recover({
          conversations: [{ ref: conversation }],
          since: new Date(secondEvent.at),
        }),
      );
      expect(
        atBoundary.some((event) => event.kind === 'message' && event.message === second.message),
      ).toBe(true);
      await fake.platform.inject({ kind: 'edit', message: first.message, text: 'old edited' });
      const afterLater = await collect(
        gateway.recover({
          conversations: [{ ref: conversation, after: second.message }],
          since: new Date(0),
        }),
      );
      expect(afterLater).toContainEqual(
        expect.objectContaining({ kind: 'message_edited', message: first.message }),
      );
      await fake.platform.inject({ kind: 'delete', message: second.message });
      const request = {
        conversations: [{ ref: conversation, after: second.message }],
        since: new Date(0),
      };
      const gap1 = (await collect(gateway.recover(request))).find((event) => event.kind === 'gap');
      const gap2 = (await collect(gateway.recover(request))).find((event) => event.kind === 'gap');
      expect(gap1).toMatchObject({ kind: 'gap', conversation });
      expect(gap2?.dedupeKey).not.toBe(gap1?.dedupeKey);
    } finally {
      await gateway.stop();
      await fake.close();
    }
  });

  it('waits for Retry-After while scanning thread history', async () => {
    const { fake, gateway, conversation } = await setup();
    try {
      await gateway.start(async () => {});
      const reply = await fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'held',
      });
      await fake.platform.rateLimitNext(20);
      const before = fake
        .requests()
        .filter((request) => request.method === 'conversations.replies').length;
      const recovered = await collect(
        gateway.recover({ conversations: [{ ref: conversation }], since: new Date(0) }),
      );
      const after = fake
        .requests()
        .filter((request) => request.method === 'conversations.replies').length;
      expect(after - before).toBe(2);
      expect(recovered).toContainEqual(
        expect.objectContaining({ kind: 'message', message: reply.message }),
      );
    } finally {
      await gateway.stop();
      await fake.close();
    }
  });

  it('does not acknowledge a Socket Mode envelope while the sink is held', async () => {
    const { fake, gateway, conversation } = await setup();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    try {
      await gateway.start(async (event) => {
        if (event.kind !== 'message') return;
        entered.resolve(undefined);
        await release.promise;
      });
      const injection = fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'pending',
      });
      await entered.promise;
      expect(await fake.platform.unacknowledged()).toBe(1);
      release.resolve(undefined);
      await injection;
      expect(await fake.platform.unacknowledged()).toBe(0);
    } finally {
      release.resolve(undefined);
      await gateway.stop();
      await fake.close();
    }
  });

  it('uses the conversation root key for a button on a reply', async () => {
    const { fake, gateway, conversation } = await setup();
    const seen: InboundEvent[] = [];
    try {
      const posted = await gateway.deliver({
        key: 'reply-key',
        maybeSent: false,
        target: { kind: 'reply', conversation },
        persona: { name: 'test', role: 'board' },
        body,
        actions: [{ id: 'approve', label: 'Approve' }],
      });
      if (posted.status !== 'delivered') throw new Error('fake reply failed');
      await gateway.start((event) => {
        seen.push(event);
        return Promise.resolve();
      });
      await fake.platform.inject({
        kind: 'action',
        message: posted.message,
        actionId: 'approve',
        author,
      });
      expect(seen).toContainEqual(
        expect.objectContaining({ kind: 'action', originKey: 'recover-root' }),
      );
    } finally {
      await gateway.stop();
      await fake.close();
    }
  });

  it('stamps fake messages and bounds recovery with the injected clock', async () => {
    // A sub-second clock: the fake puts its sequence in the sub-millisecond digits of ts.
    let t = Date.parse('2031-01-01T00:00:00.500Z');
    const clock = () => t;
    const fake = await startFakeSlackApi({ now: clock });
    try {
      const gateway = createSlackGateway({
        token: 'xoxb-test',
        channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
        apiUrl: fake.url,
        requestTimeoutMs: 500,
        now: clock,
      });
      const opened = await gateway.deliver({
        key: 'clock-root',
        maybeSent: false,
        target: { kind: 'open', space: 'orchestrators', title: 'question' },
        persona: { name: 'test', role: 'board' },
        body,
      });
      if (opened.status !== 'delivered' || opened.conversation === undefined) {
        throw new Error('fake conversation failed to open');
      }
      const conversation = opened.conversation;
      const recoverSince = async (since: Date) =>
        (await collect(gateway.recover({ conversations: [{ ref: conversation }], since }))).filter(
          (event): event is Extract<InboundEvent, { kind: 'message' }> => event.kind === 'message',
        );

      const first = await fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'first',
      });
      const firstRound = await recoverSince(new Date(t - 60_000));
      expect(firstRound.find((event) => event.message === first.message)?.at).toBe(
        '2031-01-01T00:00:00.000Z',
      );

      t += 3_600_000;
      const second = await fake.platform.inject({
        kind: 'message',
        conversation,
        author,
        text: 'second',
      });
      const secondRound = await recoverSince(new Date(t - 60_000));
      expect(secondRound.find((event) => event.message === second.message)?.at).toBe(
        '2031-01-01T01:00:00.000Z',
      );
      expect(secondRound.some((event) => event.message === first.message)).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
