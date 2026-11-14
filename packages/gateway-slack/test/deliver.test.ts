import { WebClient, type WebClientOptions } from '@slack/web-api';
import { afterEach, describe, expect, it } from 'vitest';
import { userIdSchema, type DeliverRequest, type RichText } from '@spur-board/contracts';
import { createApi } from '../src/api.ts';
import { createSlackGateway } from '../src/index.ts';
import {
  MAX_PART_TEXT,
  markerFromBlocks,
  originKeyFromBlocks,
  renderText,
  splitText,
} from '../src/render.ts';
import { startFakeSlackApi, type FakeSlackApi } from '@spur-board/gateway-slack/testing';

const fakes: FakeSlackApi[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

async function setup(options: { pageSize?: number; requestTimeoutMs?: number } = {}) {
  const fake = await startFakeSlackApi({
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  fakes.push(fake);
  const gateway = createSlackGateway({
    token: 'xoxb-test',
    now: () => Date.now(),
    channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
    apiUrl: fake.url,
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
  });
  return { fake, gateway };
}

function body(text: string): RichText {
  return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }];
}

function request(key: string, text = key): DeliverRequest {
  return {
    key,
    maybeSent: false,
    target: { kind: 'open', space: 'feed', title: 'A message' },
    persona: { name: 'Test', role: 'board' },
    body: body(text),
  };
}

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

describe('rendering and surface', () => {
  it('splits long mrkdwn without cutting entities or links', () => {
    const link = '<https://example.com|open>';
    const encoded = renderText(body(`${'x'.repeat(MAX_PART_TEXT - 2)}<${'y'.repeat(30)}`));
    const entityParts = splitText(encoded);
    expect(entityParts).not.toBeNull();
    expect(entityParts?.join('')).toBe(encoded);
    expect(entityParts?.every((part) => part.length > 0 && part.length <= MAX_PART_TEXT)).toBe(
      true,
    );
    expect(entityParts?.some((part) => part.includes('&lt;'))).toBe(true);
    const linkParts = splitText(`${'x'.repeat(MAX_PART_TEXT - 8)}${link}${'z'.repeat(30)}`);
    expect(linkParts?.join('')).toBe(`${'x'.repeat(MAX_PART_TEXT - 8)}${link}${'z'.repeat(30)}`);
    expect(linkParts?.some((part) => part.includes(link))).toBe(true);
    expect(linkParts?.every((part) => part.length > 0 && part.length <= MAX_PART_TEXT)).toBe(true);
  });

  it('splits a long unbroken input into nonempty sections', () => {
    const text = 'x'.repeat(MAX_PART_TEXT * 2 + 17);
    const parts = splitText(text);
    expect(parts?.join('')).toBe(text);
    expect(parts?.every((part) => part.length > 0 && part.length <= MAX_PART_TEXT)).toBe(true);
  });

  it.each([
    ['orchestrator', ':compass:'],
    ['curator', ':classical_building:'],
    ['worker', ':hammer:'],
    ['board', ':clipboard:'],
  ] as const)('sets persona %s username and icon', async (role, icon) => {
    const { fake, gateway } = await setup();
    await gateway.deliver({ ...request(role), persona: { name: 'Custom name', role } });
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(posted?.params.username).toBe('Custom name');
    expect(posted?.params.icon_emoji).toBe(icon);
  });

  it('uses the persona icon over the role icon', async () => {
    const { fake, gateway } = await setup();
    await gateway.deliver({
      ...request('persona-icon'),
      persona: { name: 'Cur Bot', role: 'curator', icon: ':owl:' },
    });
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(posted?.params.username).toBe('Cur Bot');
    expect(posted?.params.icon_emoji).toBe(':owl:');
  });

  it('renders mrkdwn and buttons while keeping the marker out of visible text', async () => {
    const { fake, gateway } = await setup();
    await gateway.deliver({
      ...request('button-key'),
      body: [
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'choose' },
            { kind: 'text', text: ' ' },
            { kind: 'link', url: 'https://example.com', text: 'open' },
          ],
        },
      ],
      actions: [{ id: 'approve', label: 'Approve' }],
    });
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    const blocks: unknown = JSON.parse(posted?.params.blocks ?? 'null');
    expect(markerFromBlocks(blocks)).toBe('button-key');
    expect(posted?.params.text).toContain('*choose*');
    expect(posted?.params.text).not.toContain('button-key');
    expect(JSON.stringify(blocks)).toContain('approve');
  });

  it('renders a resolved edit as struck summary and resolved line without buttons', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver({
      ...request('resolved-key'),
      actions: [{ id: 'item.close', label: 'Close' }],
    });
    if (opened.status !== 'delivered') throw new Error('open failed');
    const edited = await gateway.deliver({
      ...request('resolved-key-edit'),
      target: { kind: 'edit', message: opened.message },
      body: [
        {
          kind: 'paragraph',
          children: [{ kind: 'link', url: 'https://example.com/7', text: 'o/r#7' }],
        },
        { kind: 'quote', children: [{ kind: 'strike', text: 'Review <PR> 7' }] },
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: '✓ Resolved by ' },
            { kind: 'mention', user: userIdSchema.parse('U1') },
            { kind: 'text', text: ' at 21:16' },
          ],
        },
      ],
    });
    expect(edited.status).toBe('delivered');
    const update = fake.requests().find((entry) => entry.method === 'chat.update');
    expect(update?.params.text).toContain('> ~Review &lt;PR&gt; 7~');
    expect(update?.params.text).toContain('✓ Resolved by <@U1> at 21:16');
    const blocks: unknown = JSON.parse(update?.params.blocks ?? 'null');
    expect(JSON.stringify(blocks)).not.toContain('"actions"');
    const messages = await fake.platform.messages();
    expect(messages.find((m) => m.message === opened.message)?.actions).toEqual([]);
  });

  it('strikes each line apart, trims it and replaces a tilde inside', () => {
    expect(
      renderText([{ kind: 'quote', children: [{ kind: 'strike', text: ' a~b \n\n  c ' }] }]),
    ).toBe('> ~a∼b~\n> \n> ~c~');
  });

  it('renders a question and answer line as a section and a context element', async () => {
    const { fake, gateway } = await setup();
    const delivered = await gateway.deliver({
      ...request('curator-answer'),
      persona: { name: 'Cur Bot', role: 'curator', icon: ':owl:' },
      body: [
        {
          kind: 'paragraph',
          children: [
            { kind: 'link', url: 'https://example.com/T1', text: 'T1' },
            { kind: 'text', text: ' Fix login' },
          ],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'Question:' },
            { kind: 'text', text: ' Q?' },
          ],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'Answer:' },
            { kind: 'text', text: ' A.' },
          ],
        },
        { kind: 'paragraph', children: [{ kind: 'italic', text: 'Checked.' }] },
        {
          kind: 'context',
          children: [{ kind: 'text', text: 'B1 · asked by p/s1 · answered by cur/s2 · unblocked' }],
        },
      ],
    });
    expect(delivered.status).toBe('delivered');
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    const text =
      '<https://example.com/T1|T1> Fix login\n\n*Question:* Q?\n\n*Answer:* A.\n\n_Checked._';
    expect(posted?.params.text).toBe(text);
    expect(posted?.params.text).not.toContain('asked by');
    expect(JSON.parse(posted?.params.blocks ?? 'null')).toEqual([
      { type: 'section', block_id: 'spur:curator-answer', text: { type: 'mrkdwn', text } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'B1 · asked by p/s1 · answered by cur/s2 · unblocked' }],
      },
    ]);
  });

  it('renders a context element on an edit', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver(request('edit-context'));
    if (opened.status !== 'delivered') throw new Error('open failed');
    const edited = await gateway.deliver({
      ...request('edit-context-edit', 'Answered'),
      target: { kind: 'edit', message: opened.message },
      body: [
        ...body('Answered'),
        { kind: 'context', children: [{ kind: 'text', text: 'B1 · unblocked' }] },
      ],
    });
    expect(edited.status).toBe('delivered');
    const update = fake.requests().find((entry) => entry.method === 'chat.update');
    expect(update?.params.text).toBe('Answered');
    expect(JSON.parse(update?.params.blocks ?? 'null')).toEqual([
      {
        type: 'section',
        block_id: 'spur:edit-context-edit',
        text: { type: 'mrkdwn', text: 'Answered' },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'B1 · unblocked' }] },
    ]);
  });

  it('puts the context element on the first part of a multipart post only', async () => {
    const { fake, gateway } = await setup();
    const long = 'x'.repeat(MAX_PART_TEXT + 100);
    const delivered = await gateway.deliver({
      ...request('multi-context'),
      body: [...body(long), { kind: 'context', children: [{ kind: 'text', text: 'B1' }] }],
    });
    expect(delivered.status).toBe('delivered');
    const posts = fake.requests().filter((entry) => entry.method === 'chat.postMessage');
    expect(posts.map((entry): unknown => JSON.parse(entry.params.blocks ?? 'null'))).toEqual([
      [
        {
          type: 'section',
          block_id: 'spur:multi-context%231',
          text: { type: 'mrkdwn', text: long.slice(0, MAX_PART_TEXT) },
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'B1' }] },
        {
          type: 'context',
          block_id: 'spur-origin:multi-context',
          elements: [{ type: 'plain_text', text: '​' }],
        },
      ],
      [
        {
          type: 'section',
          block_id: 'spur:multi-context%232',
          text: { type: 'mrkdwn', text: long.slice(MAX_PART_TEXT) },
        },
      ],
    ]);
  });

  it('renders a body of only context blocks as section text', async () => {
    const { fake, gateway } = await setup();
    const delivered = await gateway.deliver({
      ...request('context-only'),
      body: [{ kind: 'context', children: [{ kind: 'text', text: 'B1 · unblocked' }] }],
    });
    expect(delivered.status).toBe('delivered');
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(posted?.params.text).toBe('B1 · unblocked');
    expect(JSON.parse(posted?.params.blocks ?? 'null')).toEqual([
      {
        type: 'section',
        block_id: 'spur:context-only',
        text: { type: 'mrkdwn', text: 'B1 · unblocked' },
      },
    ]);
  });

  it('renders italic per line inside underscores', () => {
    expect(
      renderText([{ kind: 'paragraph', children: [{ kind: 'italic', text: ' a<b \n\n  c ' }] }]),
    ).toBe('_a&lt;b_\n\n_c_');
  });

  it('keeps underscores inside italic text from closing the span', () => {
    expect(
      renderText([
        { kind: 'paragraph', children: [{ kind: 'italic', text: 'checked _again_ today' }] },
      ]),
    ).toBe('_checked ˍagainˍ today_');
  });

  it('puts many context blocks into one context block of at most ten elements', async () => {
    const { fake, gateway } = await setup();
    const values = Array.from({ length: 50 }, (_, index) => `c${String(index + 1)}`);
    const delivered = await gateway.deliver({
      ...request('many-context'),
      body: [
        ...body('Line'),
        ...values.map((text) => ({
          kind: 'context' as const,
          children: [{ kind: 'text' as const, text }],
        })),
      ],
    });
    expect(delivered.status).toBe('delivered');
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(JSON.parse(posted?.params.blocks ?? 'null')).toEqual([
      { type: 'section', block_id: 'spur:many-context', text: { type: 'mrkdwn', text: 'Line' } },
      {
        type: 'context',
        elements: [
          ...values.slice(0, 9).map((text) => ({ type: 'mrkdwn', text })),
          { type: 'mrkdwn', text: values.slice(9).join('\n') },
        ],
      },
    ]);
  });

  it('keeps a context longer than one element as section text', async () => {
    const { fake, gateway } = await setup();
    const long = Array.from({ length: 1100 }, (_, index) => `w${String(index % 10)}`).join(' ');
    expect(long.length).toBeGreaterThan(MAX_PART_TEXT);
    const delivered = await gateway.deliver({
      ...request('long-context'),
      body: [...body('Line'), { kind: 'context', children: [{ kind: 'text', text: long }] }],
    });
    expect(delivered.status).toBe('delivered');
    const blocks = postedBlocks(fake.requests());
    expect(blocks.some((block) => block.type === 'context' && !block.block_id)).toBe(false);
    const sections = blocks.filter((block) => block.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
    const joined = sections.map((block) => block.text?.text ?? '').join(' ');
    expect(joined.replace(/\s+/g, ' ')).toBe(`Line ${long}`);
  });

  it('keeps many contexts as section text when the joined tenth element overflows', async () => {
    const { fake, gateway } = await setup();
    const values = Array.from({ length: 40 }, (_, index) => String(index).padEnd(100, 'c'));
    const delivered = await gateway.deliver({
      ...request('overflow-context'),
      body: [
        ...body('Line'),
        ...values.map((text) => ({
          kind: 'context' as const,
          children: [{ kind: 'text' as const, text }],
        })),
      ],
    });
    expect(delivered.status).toBe('delivered');
    const blocks = postedBlocks(fake.requests());
    expect(blocks.some((block) => block.type === 'context' && !block.block_id)).toBe(false);
    const all = blocks
      .filter((block) => block.type === 'section')
      .map((block) => block.text?.text ?? '')
      .join('\n\n');
    expect(all).toBe(['Line', ...values].join('\n\n'));
  });

  it('fails a marker longer than Block Kit allows without an HTTP request', async () => {
    const { fake, gateway } = await setup();
    expect(await gateway.deliver(request('x'.repeat(260)))).toEqual({
      status: 'failed',
      permanent: true,
      scope: 'message',
      reason: 'marker_too_long',
    });
    expect(fake.requests()).toHaveLength(0);
  });

  it('fails an overlong multipart root origin marker before an HTTP request', async () => {
    const { fake, gateway } = await setup();
    expect(
      await gateway.deliver(request('x'.repeat(244), 'x'.repeat(MAX_PART_TEXT + 100))),
    ).toEqual({
      status: 'failed',
      permanent: true,
      scope: 'message',
      reason: 'marker_too_long',
    });
    expect(fake.requests()).toHaveLength(0);
  });

  it('accepts the adjacent valid multipart root origin marker length', async () => {
    const { fake, gateway } = await setup();
    const key = 'x'.repeat(243);
    expect((await gateway.deliver(request(key, 'x'.repeat(MAX_PART_TEXT + 100)))).status).toBe(
      'delivered',
    );
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    const blocks: unknown = JSON.parse(posted?.params.blocks ?? 'null');
    expect(originKeyFromBlocks(blocks)).toBe(key);
  });

  it('exports only createSlackGateway from the package root', async () => {
    expect(Object.keys(await import('../src/index.ts'))).toEqual(['createSlackGateway']);
  });
});

type PostedBlock = { type: string; block_id?: string; text?: { text: string } };

/** Every block of every posted part, in order. */
function postedBlocks(
  requests: readonly { method: string; params: { blocks?: string } }[],
): PostedBlock[] {
  return requests
    .filter((entry) => entry.method === 'chat.postMessage')
    .flatMap((entry) => JSON.parse(entry.params.blocks ?? '[]') as PostedBlock[]);
}
