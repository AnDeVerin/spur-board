import { WebClient, type WebClientOptions } from '@slack/web-api';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliverRequest } from '@spur-board/contracts';
import { createApi } from '../src/api.ts';
import { MAX_PART_TEXT } from '../src/render.ts';
import { closeFakes, request, setup } from './support/deliver.ts';

afterEach(closeFakes);

describe('WebClient construction', () => {
  it('sets no SDK retries, rejects rate limits, and bounds requests', () => {
    let received: { token: string | undefined; options: WebClientOptions | undefined } | undefined;
    class CapturingClient extends WebClient {
      constructor(token?: string, options?: WebClientOptions) {
        super(token, options);
        received = { token, options };
      }
    }
    createApi(
      { token: 'xoxb-test', apiUrl: 'http://localhost/api/', requestTimeoutMs: 80 },
      CapturingClient,
    );
    expect(received).toMatchObject({
      token: 'xoxb-test',
      options: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 80,
        slackApiUrl: 'http://localhost/api/',
      },
    });
  });
});

describe('one HTTP attempt and error mapping', () => {
  it('does not retry HTTP 500', async () => {
    const { fake, gateway } = await setup();
    fake.respondNext(500, { ok: false, error: 'server_error' });
    expect(await gateway.deliver(request('server-500'))).toEqual({
      status: 'retry',
      uncertain: true,
    });
    expect(fake.requests()).toHaveLength(1);
  });

  it('does not retry HTTP 429 and converts Retry-After to milliseconds', async () => {
    const { fake, gateway } = await setup();
    fake.respondNext(429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '2' });
    expect(await gateway.deliver(request('rate-429'))).toEqual({
      status: 'retry',
      uncertain: false,
      afterMs: 2000,
    });
    expect(fake.requests()).toHaveLength(1);
  });

  it('treats a timeout and a network drop as uncertain', async () => {
    const { fake, gateway } = await setup();
    await fake.platform.timeoutNext({ visible: false });
    expect(await gateway.deliver(request('timed-out'))).toEqual({
      status: 'retry',
      uncertain: true,
    });
    fake.networkErrorNext();
    expect(await gateway.deliver(request('network-drop'))).toEqual({
      status: 'retry',
      uncertain: true,
    });
    expect(fake.requests()).toHaveLength(2);
  });

  it.each([
    ['not_in_channel', 'transport'],
    ['channel_not_found', 'transport'],
    ['is_archived', 'transport'],
    ['invalid_auth', 'transport'],
    ['not_authed', 'transport'],
    ['account_inactive', 'transport'],
    ['token_revoked', 'transport'],
    ['missing_scope', 'transport'],
    ['invalid_blocks', 'message'],
    ['msg_too_long', 'message'],
    ['no_text', 'message'],
    ['cant_update_message', 'message'],
    ['message_not_found', 'message'],
  ] as const)('maps %s to permanent %s failure', async (error, scope) => {
    const { fake, gateway } = await setup();
    fake.respondNext(200, { ok: false, error });
    expect(await gateway.deliver(request(error))).toEqual({
      status: 'failed',
      permanent: true,
      scope,
      reason: error,
    });
    expect(fake.requests()).toHaveLength(1);
  });
});

describe('marker search and steps', () => {
  it.each(['history', 'replies'] as const)(
    'preserves permanent API errors from %s marker search',
    async (search) => {
      for (const error of ['invalid_auth', 'not_in_channel', 'missing_scope']) {
        const { fake, gateway } = await setup();
        const root = await gateway.deliver(request(`root-${search}-${error}`));
        if (root.status !== 'delivered' || root.conversation === undefined)
          throw new Error('root failed');
        const target =
          search === 'history'
            ? request(`search-${error}`)
            : {
                ...request(`search-${error}`),
                target: { kind: 'reply' as const, conversation: root.conversation },
              };
        const before = fake.requests().length;
        fake.respondNext(200, { ok: false, error });
        expect(await gateway.deliver({ ...target, maybeSent: true })).toEqual({
          status: 'failed',
          permanent: true,
          scope: 'transport',
          reason: error,
        });
        expect(
          fake
            .requests()
            .slice(before)
            .map((entry) => entry.method),
        ).toEqual([`conversations.${search}`]);
      }
    },
  );

  it.each(['history', 'replies'] as const)(
    'preserves Retry-After from %s marker search',
    async (search) => {
      const { fake, gateway } = await setup();
      const root = await gateway.deliver(request(`root-rate-${search}`));
      if (root.status !== 'delivered' || root.conversation === undefined)
        throw new Error('root failed');
      const target =
        search === 'history'
          ? request(`rate-${search}`)
          : {
              ...request(`rate-${search}`),
              target: { kind: 'reply' as const, conversation: root.conversation },
            };
      const before = fake.requests().length;
      fake.respondNext(429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '2' });
      expect(await gateway.deliver({ ...target, maybeSent: true })).toEqual({
        status: 'retry',
        uncertain: false,
        afterMs: 2000,
      });
      expect(
        fake
          .requests()
          .slice(before)
          .map((entry) => entry.method),
      ).toEqual([`conversations.${search}`]);
    },
  );

  it('finds a visible uncertain root across paginated history', async () => {
    const { fake, gateway } = await setup({ pageSize: 1 });
    await fake.platform.timeoutNext({ visible: true });
    expect(await gateway.deliver(request('root-found'))).toMatchObject({
      status: 'retry',
      uncertain: true,
    });
    await gateway.deliver(request('newer-root'));
    const result = await gateway.deliver({ ...request('root-found'), maybeSent: true });
    expect(result.status).toBe('delivered');
    expect(
      (await fake.platform.messages()).filter((message) => message.marker === 'root-found'),
    ).toHaveLength(1);
    expect(
      fake.requests().filter((entry) => entry.method === 'conversations.history'),
    ).toHaveLength(2);
  });

  it('sends only after a complete absent search and never sends after an unknown search', async () => {
    const { fake, gateway } = await setup();
    const absent = await gateway.deliver({ ...request('absent'), maybeSent: true });
    expect(absent.status).toBe('delivered');
    expect(
      (await fake.platform.messages()).filter((message) => message.marker === 'absent'),
    ).toHaveLength(1);
    fake.searchUnknownNext();
    const unknown = await gateway.deliver({ ...request('unknown'), maybeSent: true });
    expect(unknown).toEqual({ status: 'retry', uncertain: true });
    expect(
      (await fake.platform.messages()).filter((message) => message.marker === 'unknown'),
    ).toHaveLength(0);
  });

  it('recovers a break between parts without repeating any part', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver(request('parts-root'));
    if (opened.status !== 'delivered' || opened.conversation === undefined)
      throw new Error('root failed');
    const long = request(
      'parts-reply',
      `first ${'a'.repeat(MAX_PART_TEXT)} second ${'b'.repeat(MAX_PART_TEXT)}`,
    );
    long.target = { kind: 'reply', conversation: opened.conversation };
    await fake.platform.timeoutNext({ step: 2, visible: true });
    expect(await gateway.deliver(long)).toMatchObject({ status: 'retry', uncertain: true });
    expect(await gateway.deliver({ ...long, maybeSent: true })).toMatchObject({
      status: 'delivered',
    });
    const parts = (await fake.platform.messages()).filter((message) =>
      message.marker?.startsWith('parts-reply#'),
    );
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(parts.map((part) => part.marker)).size).toBe(parts.length);
  });

  it.each([
    { scope: 'message', reason: 'invalid_blocks' },
    { scope: 'transport', reason: 'invalid_auth' },
  ] as const)(
    'retries a multi-part post that fails after part 1 with a $scope failure as uncertain',
    async ({ scope, reason }) => {
      const { fake, gateway } = await setup();
      const opened = await gateway.deliver(request('parts-root'));
      if (opened.status !== 'delivered' || opened.conversation === undefined)
        throw new Error('root failed');
      const long = request(
        'parts-failed',
        `first ${'a'.repeat(MAX_PART_TEXT)} second ${'b'.repeat(MAX_PART_TEXT)}`,
      );
      long.target = { kind: 'reply', conversation: opened.conversation };
      const hold = fake.holdNextWrite();
      const first = gateway.deliver(long);
      await hold.entered;
      await fake.platform.failNextPermanently({ scope, reason });
      hold.release();
      expect(await first).toEqual({ status: 'retry', uncertain: true });
      expect(await gateway.deliver({ ...long, maybeSent: true })).toMatchObject({
        status: 'delivered',
      });
      expect(
        (await fake.platform.messages()).filter((message) => message.marker === 'parts-failed#1'),
      ).toHaveLength(1);
    },
  );

  it('recovers a break between close line and reaction', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver(request('close-root'));
    if (opened.status !== 'delivered' || opened.conversation === undefined)
      throw new Error('root failed');
    const close: DeliverRequest = {
      ...request('close-line', 'resolved'),
      target: { kind: 'close', conversation: opened.conversation },
    };
    await fake.platform.timeoutNext({ step: 2, visible: true });
    expect(await gateway.deliver(close)).toMatchObject({ status: 'retry', uncertain: true });
    expect(await gateway.deliver({ ...close, maybeSent: true })).toMatchObject({
      status: 'delivered',
    });
    expect(
      (await fake.platform.messages()).filter((message) => message.marker === 'close-line'),
    ).toHaveLength(1);
    expect(
      (await fake.platform.conversations()).find((entry) => entry.ref === opened.conversation)
        ?.done,
    ).toBe(true);
  });
});
